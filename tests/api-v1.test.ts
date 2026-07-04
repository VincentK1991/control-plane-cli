import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration tests for the bearer-scoped /api/v1 surface (see
 * docs/discussion/cli-tool.md). These hit a *running* dev server
 * (`just web`, or `npm run dev`) plus the local Postgres/Temporal/kind
 * stack, using the real test key from .env (MY_API_KEY) rather than
 * mocks — the goal is to prove the CLI's backend actually works, not
 * just that handlers are wired up.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, ".env");

function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2];
    }
  }
}

loadEnvFile(envPath);

const BASE_URL = process.env.CP_TEST_API_URL ?? "http://127.0.0.1:4321";
const API_KEY = process.env.MY_API_KEY;

if (!API_KEY) {
  throw new Error(
    "MY_API_KEY is not set (expected in .env) — required for /api/v1 integration tests.",
  );
}

function url(pathname: string) {
  return `${BASE_URL}${pathname}`;
}

function authHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${API_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function waitForServer() {
  try {
    const res = await fetch(url("/api/v1/me"), { headers: authHeaders() });
    return res.status !== 0;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const up = await waitForServer();
  if (!up) {
    throw new Error(
      `Dev server not reachable at ${BASE_URL}. Start it first (\`just web\`) along with ` +
        "postgres/temporal/kind (see docker-compose.yml) before running this suite.",
    );
  }
});

describe("auth", () => {
  it("rejects requests with no bearer token", async () => {
    const res = await fetch(url("/api/v1/me"));
    expect(res.status).toBe(401);
  });

  it("rejects requests with an invalid bearer token", async () => {
    const res = await fetch(url("/api/v1/me"), {
      headers: { authorization: "Bearer cp_live_totally_bogus_key" },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/me", () => {
  it("resolves the caller's own identity from the token, not a path/body param", async () => {
    const res = await fetch(url("/api/v1/me"), { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      user_id: expect.any(String),
      api_key_id: expect.any(String),
      key_prefix: expect.stringMatching(/^cp_live_/),
      name: expect.any(String),
    });
  });
});

describe("database lifecycle", () => {
  let createdInstanceId: string | undefined;

  afterAll(async () => {
    if (createdInstanceId) {
      await fetch(url(`/api/v1/databases/${createdInstanceId}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
    }
  });

  it("lists databases scoped to the authenticated key", async () => {
    const res = await fetch(url("/api/v1/databases"), { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.instances)).toBe(true);
    for (const instance of body.instances) {
      expect(instance.api_key_id).toBe(body.instances[0].api_key_id);
    }
  });

  it("creates asynchronously, returning before provisioning finishes", async () => {
    const name = `cli-v1-test-${randomUUID().slice(0, 8)}`;

    const start = Date.now();
    const createRes = await fetch(url("/api/v1/databases"), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });
    const elapsedMs = Date.now() - start;

    // Always 202 now: createNeo4jInstanceAsync returns as soon as the row
    // exists and runs Kubernetes provisioning in the background, so this
    // response can never observe a terminal "ready"/"failed" status. Real
    // provisioning against the local kind cluster takes tens of seconds
    // (measured ~55-90s), so a fast response here is the actual behavior
    // under test, not an artifact of a fast/slow cluster.
    expect(createRes.status).toBe(202);
    expect(elapsedMs).toBeLessThan(5_000);

    const created = await createRes.json();
    expect(created.instance).toMatchObject({ name, tier: "free", status: "provisioning" });
    createdInstanceId = created.instance.id;

    const getRes = await fetch(url(`/api/v1/databases/${createdInstanceId}`), {
      headers: authHeaders(),
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.instance.id).toBe(createdInstanceId);
  }, 15_000);

  it("deletes a still-provisioning database once background provisioning finishes", async () => {
    if (!createdInstanceId) {
      throw new Error("previous test did not leave an instance to delete");
    }

    // Exercises the in-process lock in src/lib/dbaas/neo4j.ts directly:
    // this DELETE is issued while the background provisioning kicked off
    // by the previous test's create is still running, so it must queue
    // behind it rather than racing `helm uninstall` against the still
    // in-flight `helm install --wait` for the same release.
    const deleteRes = await fetch(url(`/api/v1/databases/${createdInstanceId}`), {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(deleteRes.status).toBe(200);
    const deleted = await deleteRes.json();
    expect(deleted.instance.status).toBe("deleted");

    createdInstanceId = undefined;
  }, 180_000);

  it("404s for an instance ID that doesn't belong to this key", async () => {
    const res = await fetch(url(`/api/v1/databases/${randomUUID()}`), {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });
});

describe("document indexing against an existing ready database", () => {
  async function findReadyInstance() {
    const res = await fetch(url("/api/v1/databases"), { headers: authHeaders() });
    const body = await res.json();
    return body.instances.find((i: { status: string }) => i.status === "ready");
  }

  it("starts a job, lists it, and reads its status", async () => {
    const instance = await findReadyInstance();
    if (!instance) {
      throw new Error(
        "No 'ready' Neo4j instance found for the test key — provision one first.",
      );
    }

    const startRes = await fetch(url(`/api/v1/databases/${instance.id}/documents`), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        content: "# CLI e2e test\n\nJust proving the pipe works end to end.",
      }),
    });
    expect(startRes.status).toBe(202);
    const { jobId } = await startRes.json();
    expect(jobId).toEqual(expect.any(String));

    const statusRes = await fetch(
      url(`/api/v1/databases/${instance.id}/documents/${jobId}`),
      { headers: authHeaders() },
    );
    expect(statusRes.status).toBe(200);
    const { job } = await statusRes.json();
    expect(["queued", "running", "succeeded", "failed"]).toContain(job.status);

    const listRes = await fetch(url(`/api/v1/databases/${instance.id}/documents`), {
      headers: authHeaders(),
    });
    expect(listRes.status).toBe(200);
    const { jobs } = await listRes.json();
    expect(jobs.some((j: { id: string }) => j.id === jobId)).toBe(true);
  }, 30_000);

  it("rejects an empty document body", async () => {
    const instance = await findReadyInstance();
    if (!instance) return;

    const res = await fetch(url(`/api/v1/databases/${instance.id}/documents`), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/usage", () => {
  it("returns a usage summary scoped to the authenticated key", async () => {
    const res = await fetch(url("/api/v1/usage"), { headers: authHeaders() });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.usage).toMatchObject({
      total_events: expect.any(String),
      total_units: expect.any(String),
      total_cost_cents: expect.any(String),
    });
  });
});

describe("POST /api/v1/usage/events", () => {
  it("records an idempotent usage event", async () => {
    const idempotencyKey = `cli-v1-test-${randomUUID()}`;

    const first = await fetch(url("/api/v1/usage/events"), {
      method: "POST",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      body: JSON.stringify({
        source: "cli-v1-test",
        event_type: "cli.smoke_test",
        billable_metric: "calls",
        quantity: 1,
        unit: "call",
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.recorded).toBe(true);

    const second = await fetch(url("/api/v1/usage/events"), {
      method: "POST",
      headers: authHeaders({ "idempotency-key": idempotencyKey }),
      body: JSON.stringify({
        source: "cli-v1-test",
        event_type: "cli.smoke_test",
        billable_metric: "calls",
        quantity: 1,
        unit: "call",
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.recorded).toBe(false);
  });
});
