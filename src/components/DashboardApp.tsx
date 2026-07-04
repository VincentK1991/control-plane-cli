import {
  Activity,
  Command,
  Copy,
  CreditCard,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import * as React from "react";
import StatusPill from "./StatusPill";

type GoogleCredentialResponse = {
  credential?: string;
  select_by?: string;
};

type UserProfile = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
};

type ApiKeyRecord = {
  id: string;
  name: string;
  key_prefix: string;
  status: "active" | "revoked";
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

type Neo4jInstanceRecord = {
  id: string;
  api_key_id: string;
  name: string;
  status: "provisioning" | "ready" | "failed" | "deleting" | "deleted";
  tier: "free";
  namespace: string;
  release_name: string;
  service_name: string;
  secret_name: string;
  pvc_name: string | null;
  username: string;
  bolt_url: string | null;
  http_url: string | null;
  external_bolt_url: string | null;
  external_http_url: string | null;
  plugins: string[];
  storage_size_gb: number;
  cpu_limit_millicores: number;
  memory_limit_mb: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type Neo4jCredential = {
  instanceId: string;
  username: string;
  password: string;
  boltUrl: string | null;
  externalBoltUrl: string | null;
  externalHttpUrl: string | null;
};

type UsageSummary = {
  total_events: string;
  total_units: string;
  total_cost_cents: string;
};

type BillingStatus = {
  configured: boolean;
  provider: string;
  subscription: {
    status: string;
    provider_subscription_id: string | null;
    price_id: string | null;
    current_period_end: string | null;
    updated_at: string;
  } | null;
  meter_sync: Record<string, string>;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
            ux_mode?: "popup" | "redirect";
            auto_select?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: "outline" | "filled_blue" | "filled_black";
              size?: "large" | "medium" | "small";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              shape?: "rectangular" | "pill" | "circle" | "square";
              logo_alignment?: "left" | "center";
              width?: number;
            },
          ) => void;
          disableAutoSelect: () => void;
        };
      };
    };
  }
}

const googleClientId = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID as
  | string
  | undefined;

const navItems = [
  { label: "Dashboard", icon: LayoutDashboard, active: true },
];

async function apiRequest<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });

  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? "Request failed.");
  }

  return data;
}

function loadGoogleIdentityScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google sign-in failed to load."));
    document.head.appendChild(script);
  });
}

function LoginHome({ onLogin }: { onLogin: (profile: UserProfile) => void }) {
  const buttonRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<
    "idle" | "loading" | "ready" | "missing-client-id" | "failed"
  >("idle");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    if (!googleClientId) {
      setStatus("missing-client-id");
      return;
    }

    setStatus("loading");

    loadGoogleIdentityScript()
      .then(() => {
        if (cancelled || !buttonRef.current || !window.google) {
          return;
        }

        buttonRef.current.innerHTML = "";
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          ux_mode: "popup",
          auto_select: false,
          callback: (response) => {
            if (!response.credential) {
              setError("Google did not return a credential.");
              setStatus("failed");
              return;
            }

            void apiRequest<{ user: UserProfile }>("/api/auth/google", {
              method: "POST",
              body: JSON.stringify({ credential: response.credential }),
            })
              .then(({ user }) => onLogin(user))
              .catch((requestError: unknown) => {
                setError(
                  requestError instanceof Error
                    ? requestError.message
                    : "Google sign-in could not complete.",
                );
                setStatus("failed");
              });
          },
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          text: "signin_with",
          shape: "rectangular",
          logo_alignment: "left",
          width: 296,
        });
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("failed");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onLogin]);

  return (
    <main className="min-h-screen bg-[#f7f8fb]">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white">
              <Command className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-5">Control Plane</p>
              <p className="text-xs text-slate-500">Workspace Console</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-sm text-slate-500 sm:flex">
            <ShieldCheck className="h-4 w-4 text-teal-600" aria-hidden="true" />
            Google Cloud Identity
          </div>
        </div>
      </header>

      <section className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
            <LockKeyhole className="h-3.5 w-3.5 text-teal-600" aria-hidden="true" />
            OAuth access for Gmail-backed accounts
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-normal text-slate-950 sm:text-5xl">
            Sign in to your control plane dashboard
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
            Use your Google account to access API keys, usage totals, billing
            status, and provisioned Neo4j databases.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              ["OAuth provider", "Google Cloud Identity"],
              ["Account type", "Gmail / Google Workspace"],
              ["Session", "Browser ID token"],
            ].map(([label, value]) => (
              <div
                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
                key={label}
              >
                <p className="text-xs font-medium uppercase text-slate-400">
                  {label}
                </p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {value}
                </p>
              </div>
            ))}
          </div>
        </div>

        <article className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-semibold">Login</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Authenticate with Google to continue to the dashboard.
            </p>
          </div>

          <div className="min-h-11" ref={buttonRef} />

          {status === "missing-client-id" && (
            <button
              className="flex h-11 w-full max-w-[296px] items-center justify-center gap-3 rounded-md border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-400"
              disabled
              type="button"
            >
              <span className="text-base font-bold" aria-hidden="true">
                G
              </span>
              Sign in with Google
            </button>
          )}
          {status === "loading" && (
            <p className="mt-4 text-sm text-slate-500">
              Loading Google sign-in...
            </p>
          )}
          {status === "missing-client-id" && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-800">
              Set <code>PUBLIC_GOOGLE_CLIENT_ID</code> in your local environment
              before using Google login.
            </div>
          )}
          {status === "failed" && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">
              {error ??
                "Google sign-in could not complete. Check the OAuth client ID, authorized JavaScript origins, and server environment."}
            </div>
          )}

          <div className="mt-6 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">
            The server verifies the Google ID token, stores the user identity in
            Postgres, and creates an HTTP-only session cookie for dashboard API
            access.
          </div>
        </article>
      </section>
    </main>
  );
}

function ApiKeysPanel() {
  const [apiKeys, setApiKeys] = React.useState<ApiKeyRecord[]>([]);
  const [neo4jByApiKey, setNeo4jByApiKey] = React.useState<
    Record<string, Neo4jInstanceRecord[]>
  >({});
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);
  const [newKeyName, setNewKeyName] = React.useState("Local development key");
  const [createdToken, setCreatedToken] = React.useState<string | null>(null);
  const [createdDatabaseCredential, setCreatedDatabaseCredential] =
    React.useState<Neo4jCredential | null>(null);
  const [databaseAction, setDatabaseAction] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<{
    apiKeyId: string;
    instance: Neo4jInstanceRecord;
  } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = React.useState("");
  const [status, setStatus] = React.useState<
    "loading" | "ready" | "creating" | "failed"
  >("loading");
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    setStatus("loading");
    Promise.all([
      apiRequest<{ apiKeys: ApiKeyRecord[] }>("/api/api-keys"),
      apiRequest<{ usage: UsageSummary }>("/api/usage"),
    ])
      .then(async ([keysResponse, usageResponse]) => {
        const activeKeys = keysResponse.apiKeys.filter(
          (apiKey) => apiKey.status === "active",
        );
        const neo4jEntries = await Promise.all(
          activeKeys.map(async (apiKey) => {
            const response = await apiRequest<{ instances: Neo4jInstanceRecord[] }>(
              `/api/api-keys/${apiKey.id}/neo4j`,
            );
            return [apiKey.id, response.instances] as const;
          }),
        );

        setApiKeys(keysResponse.apiKeys);
        setNeo4jByApiKey(Object.fromEntries(neo4jEntries));
        setUsage(usageResponse.usage);
        setStatus("ready");
        setError(null);
      })
      .catch((requestError: unknown) => {
        setStatus("failed");
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load API keys.",
        );
      });
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const createKey = React.useCallback(
    (event: { preventDefault: () => void }) => {
      event.preventDefault();
      setStatus("creating");
      setCreatedToken(null);

      apiRequest<{ apiKey: ApiKeyRecord; token: string }>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: newKeyName }),
      })
        .then(({ apiKey, token }) => {
          setApiKeys((current) => [apiKey, ...current]);
          setCreatedToken(token);
          setStatus("ready");
          setError(null);
        })
        .catch((requestError: unknown) => {
          setStatus("failed");
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Unable to create API key.",
          );
        });
    },
    [newKeyName],
  );

  const revokeKey = React.useCallback((apiKeyId: string) => {
    apiRequest<{ apiKey: ApiKeyRecord }>(`/api/api-keys/${apiKeyId}`, {
      method: "DELETE",
    })
      .then(({ apiKey }) => {
        setApiKeys((current) =>
          current.map((item) => (item.id === apiKey.id ? apiKey : item)),
        );
        setError(null);
      })
      .catch((requestError: unknown) => {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to revoke API key.",
        );
      });
  }, []);

  const createNeo4jDatabase = React.useCallback((apiKey: ApiKeyRecord) => {
    setDatabaseAction(`create:${apiKey.id}`);
    setCreatedDatabaseCredential(null);
    setError(null);

    apiRequest<{
      instance: Neo4jInstanceRecord;
      credentials: { username: string; password: string };
    }>(`/api/api-keys/${apiKey.id}/neo4j`, {
      method: "POST",
      body: JSON.stringify({ name: `${apiKey.name} Neo4j` }),
    })
      .then(({ instance, credentials }) => {
        setNeo4jByApiKey((current) => ({
          ...current,
          [apiKey.id]: [
            instance,
            ...(current[apiKey.id] ?? []).filter((item) => item.id !== instance.id),
          ],
        }));
        setCreatedDatabaseCredential({
          instanceId: instance.id,
          username: credentials.username,
          password: credentials.password,
          boltUrl: instance.bolt_url,
          externalBoltUrl: instance.external_bolt_url,
          externalHttpUrl: instance.external_http_url,
        });
      })
      .catch((requestError: unknown) => {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to create Neo4j database.",
        );
      })
      .finally(() => setDatabaseAction(null));
  }, []);

  const requestDeleteNeo4jDatabase = React.useCallback(
    (apiKeyId: string, instance: Neo4jInstanceRecord) => {
      setDeleteTarget({ apiKeyId, instance });
      setDeleteConfirmation("");
    },
    [],
  );

  const deleteNeo4jDatabase = React.useCallback(() => {
    if (!deleteTarget) {
      return;
    }

    setDatabaseAction(`delete:${deleteTarget.instance.id}`);
    setError(null);

    apiRequest<{ instance: Neo4jInstanceRecord }>(
      `/api/api-keys/${deleteTarget.apiKeyId}/neo4j/${deleteTarget.instance.id}`,
      {
        method: "DELETE",
      },
    )
      .then(({ instance }) => {
        setNeo4jByApiKey((current) => ({
          ...current,
          [deleteTarget.apiKeyId]: (current[deleteTarget.apiKeyId] ?? []).filter(
            (item) => item.id !== instance.id,
          ),
        }));
        setDeleteTarget(null);
        setDeleteConfirmation("");
      })
      .catch((requestError: unknown) => {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to delete Neo4j database.",
        );
      })
      .finally(() => setDatabaseAction(null));
  }, [deleteTarget]);

  const copyCreatedToken = React.useCallback(() => {
    if (createdToken) {
      void navigator.clipboard.writeText(createdToken);
    }
  }, [createdToken]);

  const copyCreatedDatabasePassword = React.useCallback(() => {
    if (createdDatabaseCredential) {
      void navigator.clipboard.writeText(createdDatabaseCredential.password);
    }
  }, [createdDatabaseCredential]);

  return (
    <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <article className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">API Keys</h2>
            <p className="mt-1 text-sm text-slate-500">
              Mint and revoke user-owned keys for metering and billing.
            </p>
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:border-slate-300"
            onClick={refresh}
            type="button"
          >
            <Activity className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
        </div>

        <div className="p-4">
          <form className="flex flex-col gap-3 sm:flex-row" onSubmit={createKey}>
            <input
              className="h-10 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-slate-400"
              maxLength={80}
              onChange={(event) => setNewKeyName(event.target.value)}
              placeholder="API key name"
              value={newKeyName}
            />
            <button
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-teal-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              disabled={status === "creating" || !newKeyName.trim()}
              type="submit"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Mint Key
            </button>
          </form>

          {createdToken && (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-900">
                    Copy this API key now
                  </p>
                  <p className="mt-1 break-all font-mono text-xs leading-5 text-emerald-800">
                    {createdToken}
                  </p>
                </div>
                <button
                  aria-label="Copy API key"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-emerald-200 bg-white text-emerald-700"
                  onClick={copyCreatedToken}
                  title="Copy API key"
                  type="button"
                >
                  <Copy className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Prefix</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Last Used</th>
                  <th className="px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {apiKeys.map((apiKey) => (
                  <tr className="hover:bg-slate-50" key={apiKey.id}>
                    <td className="px-4 py-4 font-medium text-slate-950">
                      {apiKey.name}
                    </td>
                    <td className="px-4 py-4 font-mono text-xs text-slate-600">
                      {apiKey.key_prefix}
                    </td>
                    <td className="px-4 py-4">
                      <StatusPill
                        status={apiKey.status}
                      />
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      {apiKey.last_used_at
                        ? new Date(apiKey.last_used_at).toLocaleString()
                        : "Never"}
                    </td>
                    <td className="px-4 py-4">
                      <button
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-600 transition hover:border-red-200 hover:text-red-700 disabled:cursor-not-allowed disabled:text-slate-300"
                        disabled={apiKey.status === "revoked"}
                        onClick={() => revokeKey(apiKey.id)}
                        type="button"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
                {apiKeys.length === 0 && status !== "loading" && (
                  <tr>
                    <td className="px-4 py-8 text-center text-slate-500" colSpan={5}>
                      No API keys yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-6 border-t border-slate-100 pt-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-950">
                  Neo4j Databases
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Free-tier graph databases provisioned per active API key.
                </p>
              </div>
            </div>

            {createdDatabaseCredential && (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-emerald-900">
                      Copy this Neo4j password now
                    </p>
                    <dl className="mt-2 grid gap-1 text-xs leading-5 text-emerald-800">
                      <div className="grid gap-1 sm:grid-cols-[90px_minmax(0,1fr)]">
                        <dt className="font-semibold">Username</dt>
                        <dd className="font-mono">{createdDatabaseCredential.username}</dd>
                      </div>
                      <div className="grid gap-1 sm:grid-cols-[90px_minmax(0,1fr)]">
                        <dt className="font-semibold">Password</dt>
                        <dd className="break-all font-mono">
                          {createdDatabaseCredential.password}
                        </dd>
                      </div>
                      <div className="grid gap-1 sm:grid-cols-[90px_minmax(0,1fr)]">
                        <dt className="font-semibold">Bolt URL</dt>
                        <dd className="break-all font-mono">
                          {createdDatabaseCredential.boltUrl ?? "Pending"}
                        </dd>
                      </div>
                      <div className="grid gap-1 sm:grid-cols-[90px_minmax(0,1fr)]">
                        <dt className="font-semibold">External Browser</dt>
                        <dd className="break-all font-mono">
                          {createdDatabaseCredential.externalHttpUrl ?? "Not exposed"}
                        </dd>
                      </div>
                      <div className="grid gap-1 sm:grid-cols-[90px_minmax(0,1fr)]">
                        <dt className="font-semibold">External Bolt</dt>
                        <dd className="break-all font-mono">
                          {createdDatabaseCredential.externalBoltUrl ?? "Not exposed"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <button
                    aria-label="Copy Neo4j password"
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-emerald-200 bg-white text-emerald-700"
                    onClick={copyCreatedDatabasePassword}
                    title="Copy Neo4j password"
                    type="button"
                  >
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}

            <div className="mt-4 grid gap-3">
              {apiKeys
                .filter((apiKey) => apiKey.status === "active")
                .map((apiKey) => {
                  const databases = neo4jByApiKey[apiKey.id] ?? [];
                  const creating = databaseAction === `create:${apiKey.id}`;
                  const canCreate = databases.length < 2 && !creating;

                  return (
                    <div
                      className="rounded-md border border-slate-200 bg-slate-50 p-3"
                      key={apiKey.id}
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-950">
                            {apiKey.name}
                          </p>
                          <p className="mt-1 break-all font-mono text-xs text-slate-500">
                            {apiKey.key_prefix}
                          </p>
                        </div>
                        <button
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-teal-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                          disabled={!canCreate}
                          onClick={() => createNeo4jDatabase(apiKey)}
                          type="button"
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          {creating ? "Creating..." : "Create Database"}
                        </button>
                      </div>

                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full min-w-[760px] text-left text-xs">
                          <thead className="text-slate-500">
                            <tr>
                              <th className="py-2 pr-3 font-semibold">Database</th>
                              <th className="py-2 pr-3 font-semibold">Status</th>
                              <th className="py-2 pr-3 font-semibold">Bolt URL</th>
                              <th className="py-2 pr-3 font-semibold">External Access</th>
                              <th className="py-2 pr-3 font-semibold">Resources</th>
                              <th className="py-2 pr-3 font-semibold">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200">
                            {databases.map((database) => {
                              const deleting =
                                databaseAction === `delete:${database.id}`;

                              return (
                                <tr key={database.id}>
                                  <td className="py-3 pr-3">
                                    <p className="font-medium text-slate-900">
                                      {database.name}
                                    </p>
                                    <p className="mt-1 font-mono text-[11px] text-slate-500">
                                      {database.namespace}
                                    </p>
                                  </td>
                                  <td className="py-3 pr-3">
                                    <StatusPill status={database.status} />
                                  </td>
                                  <td className="max-w-[260px] py-3 pr-3">
                                    <p className="break-all font-mono text-[11px] text-slate-600">
                                      {database.bolt_url ?? "Pending"}
                                    </p>
                                  </td>
                                  <td className="max-w-[260px] py-3 pr-3">
                                    {database.external_http_url ? (
                                      <a
                                        className="break-all font-mono text-[11px] text-teal-700 underline"
                                        href={database.external_http_url}
                                        rel="noreferrer"
                                        target="_blank"
                                      >
                                        {database.external_http_url}
                                      </a>
                                    ) : (
                                      <p className="font-mono text-[11px] text-slate-400">
                                        Not exposed
                                      </p>
                                    )}
                                    {database.external_bolt_url && (
                                      <p className="mt-1 break-all font-mono text-[11px] text-slate-600">
                                        {database.external_bolt_url}
                                      </p>
                                    )}
                                  </td>
                                  <td className="py-3 pr-3 text-slate-600">
                                    {database.storage_size_gb}Gi /{" "}
                                    {database.memory_limit_mb}Mi
                                  </td>
                                  <td className="py-3 pr-3">
                                    <div className="flex items-center gap-2">
                                      {database.status === "ready" && (
                                        <a
                                          className="inline-flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 transition hover:border-slate-300"
                                          href={`/databases/${database.id}`}
                                        >
                                          <ExternalLink
                                            className="h-3.5 w-3.5"
                                            aria-hidden="true"
                                          />
                                          Open
                                        </a>
                                      )}
                                      <button
                                        className="inline-flex h-8 items-center gap-2 rounded-md border border-red-200 bg-white px-2 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-slate-300"
                                        disabled={deleting}
                                        onClick={() =>
                                          requestDeleteNeo4jDatabase(
                                            apiKey.id,
                                            database,
                                          )
                                        }
                                        type="button"
                                      >
                                        <Trash2
                                          className="h-3.5 w-3.5"
                                          aria-hidden="true"
                                        />
                                        {deleting ? "Deleting..." : "Delete"}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                            {databases.length === 0 && (
                              <tr>
                                <td
                                  className="py-4 text-center text-sm text-slate-500"
                                  colSpan={6}
                                >
                                  No Neo4j databases provisioned for this key.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </article>

      <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Usage Metering</h2>
            <p className="mt-1 text-sm text-slate-500">
              Totals linked to authenticated API keys.
            </p>
          </div>
          <KeyRound className="h-5 w-5 text-teal-600" aria-hidden="true" />
        </div>
        <div className="mt-5 grid gap-3">
          {[
            ["Usage events", usage?.total_events ?? "0"],
            ["Metered units", usage?.total_units ?? "0"],
            [
              "Estimated cost",
              `$${((Number(usage?.total_cost_cents ?? 0) || 0) / 100).toFixed(2)}`,
            ],
          ].map(([label, value]) => (
            <div
              className="rounded-md border border-slate-200 bg-slate-50 p-3"
              key={label}
            >
              <p className="text-xs font-medium uppercase text-slate-400">
                {label}
              </p>
              <p className="mt-2 text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
      </article>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 px-4">
          <div className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-red-50 text-red-700">
                <Trash2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-950">
                  Delete Neo4j database
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  This removes the Helm release, Kubernetes Secret, and PVC after
                  the final backup hook runs. Type the database name to confirm.
                </p>
                <p className="mt-3 break-all font-mono text-xs text-slate-700">
                  {deleteTarget.instance.name}
                </p>
              </div>
            </div>

            <input
              className="mt-4 h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-red-300"
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              placeholder={deleteTarget.instance.name}
              value={deleteConfirmation}
            />

            <div className="mt-5 flex justify-end gap-2">
              <button
                className="inline-flex h-9 items-center justify-center rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteConfirmation("");
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-red-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                disabled={
                  deleteConfirmation !== deleteTarget.instance.name ||
                  databaseAction === `delete:${deleteTarget.instance.id}`
                }
                onClick={deleteNeo4jDatabase}
                type="button"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete Database
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function BillingPanel() {
  const [billing, setBilling] = React.useState<BillingStatus | null>(null);
  const [status, setStatus] = React.useState<
    "loading" | "ready" | "starting-checkout" | "opening-portal" | "failed"
  >("loading");
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => {
    setStatus("loading");
    apiRequest<{ billing: BillingStatus }>("/api/billing/status")
      .then(({ billing }) => {
        setBilling(billing);
        setStatus("ready");
        setError(null);
      })
      .catch((requestError: unknown) => {
        setStatus("failed");
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to load billing status.",
        );
      });
  }, []);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const startCheckout = React.useCallback(() => {
    setStatus("starting-checkout");
    apiRequest<{ url: string }>("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(({ url }) => {
        window.location.assign(url);
      })
      .catch((requestError: unknown) => {
        setStatus("failed");
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to start Stripe Checkout.",
        );
      });
  }, []);

  const openPortal = React.useCallback(() => {
    setStatus("opening-portal");
    apiRequest<{ url: string }>("/api/billing/portal", {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then(({ url }) => {
        window.location.assign(url);
      })
      .catch((requestError: unknown) => {
        setStatus("failed");
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Unable to open Stripe billing portal.",
        );
      });
  }, []);

  const subscriptionStatus = billing?.subscription?.status ?? "not started";
  const synced = billing?.meter_sync.synced ?? "0";
  const failed = billing?.meter_sync.failed ?? "0";
  const skipped = billing?.meter_sync.skipped ?? "0";

  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold">Billing</h2>
          <p className="mt-1 text-sm text-slate-500">
            Stripe test-mode subscription and metered usage sync.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:border-slate-300"
            onClick={refresh}
            type="button"
          >
            <Activity className="h-4 w-4" aria-hidden="true" />
            Refresh
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md bg-teal-600 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={
              !billing?.configured ||
              status === "starting-checkout" ||
              subscriptionStatus === "active"
            }
            onClick={startCheckout}
            type="button"
          >
            <CreditCard className="h-4 w-4" aria-hidden="true" />
            Start Checkout
          </button>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:border-slate-300 disabled:cursor-not-allowed disabled:text-slate-300"
            disabled={!billing?.configured || !billing?.subscription}
            onClick={openPortal}
            type="button"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Portal
          </button>
        </div>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ["Provider", billing?.provider ?? "stripe"],
          ["Configured", billing?.configured ? "Yes" : "No"],
          ["Subscription", subscriptionStatus],
          ["Meter Sync", `${synced} synced / ${failed} failed / ${skipped} skipped`],
        ].map(([label, value]) => (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-3" key={label}>
            <p className="text-xs font-medium uppercase text-slate-400">{label}</p>
            <p className="mt-2 break-words text-sm font-semibold text-slate-900">
              {value}
            </p>
          </div>
        ))}
      </div>

      {!billing?.configured && status !== "loading" && (
        <div className="mx-4 mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-800">
          Set <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_PRICE_ID</code>, and{" "}
          <code>STRIPE_METER_EVENT_NAME</code> before starting Checkout or syncing
          meter events.
        </div>
      )}

      {error && (
        <div className="mx-4 mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
    </section>
  );
}

export default function DashboardApp() {
  const [profile, setProfile] = React.useState<UserProfile | null>(null);
  const [sessionStatus, setSessionStatus] = React.useState<
    "checking" | "ready"
  >("checking");

  React.useEffect(() => {
    apiRequest<{ user: UserProfile }>("/api/me")
      .then(({ user }) => setProfile(user))
      .catch(() => setProfile(null))
      .finally(() => setSessionStatus("ready"));
  }, []);

  const handleLogout = React.useCallback(() => {
    window.google?.accounts.id.disableAutoSelect();
    void apiRequest<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    }).finally(() => setProfile(null));
  }, []);

  if (sessionStatus === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f7f8fb] px-4 text-center">
        <div>
          <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-md bg-slate-950 text-white">
            <Command className="h-4 w-4" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-slate-600">
            Checking session...
          </p>
        </div>
      </div>
    );
  }

  if (!profile) {
    return <LoginHome onLogin={setProfile} />;
  }

  return (
    <div className="min-h-screen bg-[#f7f8fb] text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-slate-200 bg-white lg:block">
        <div className="flex h-full flex-col">
          <div className="flex h-16 items-center gap-3 border-b border-slate-200 px-5">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-slate-950 text-white">
              <Command className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-5">Control Plane</p>
              <p className="text-xs text-slate-500">Workspace Console</p>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Primary">
            {navItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className={`flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition ${
                  item.active
                    ? "bg-slate-950 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"
                }`}
              >
                <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <p className="truncate text-sm font-medium text-slate-700">
                {profile.email}
              </p>
            </div>
            <button
              type="button"
              className="flex h-10 items-center gap-2 rounded-md border border-slate-200 bg-white px-2 text-sm font-medium shadow-sm transition hover:border-slate-300"
            >
              {profile.avatar_url ? (
                <img
                  alt=""
                  className="h-6 w-6 rounded object-cover"
                  src={profile.avatar_url}
                />
              ) : (
                <span className="grid h-6 w-6 place-items-center rounded bg-teal-600 text-xs font-semibold text-white">
                  {(profile.name ?? profile.email)
                    .split(" ")
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join("")
                    .toUpperCase()}
                </span>
              )}
              <span className="hidden max-w-32 truncate sm:inline">
                {profile.name ?? profile.email}
              </span>
            </button>
            <button
              type="button"
              className="hidden h-10 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-950 sm:block"
              onClick={handleLogout}
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          <section className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-normal text-slate-950 sm:text-4xl">
                User Dashboard
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Manage API keys, metered usage, billing status, and provisioned
                Neo4j databases from the control-plane database.
              </p>
            </div>
          </section>

          <ApiKeysPanel />

          <BillingPanel />
        </main>
      </div>
    </div>
  );
}
