import { getOpenAIClient, getReadyNeo4jInstance, openNeo4jDriver } from "@pipelines/core";

export interface MergeDecision {
  label: string;
  keepId: string;
  mergeId: string;
  confidence: "heuristic" | "llm";
  score: number;
}

interface CandidateNode {
  id: string;
  name: string;
}

/**
 * Reads the last-swept-up-to checkpoint from a singleton :_SweepCheckpoint
 * node in the instance's own Neo4j graph. Each scheduled sweep run is a
 * fresh Temporal workflow execution (see normalizeEntitiesWorkflow.ts), so
 * there's no continueAsNew-style workflow state to carry the checkpoint
 * forward — it has to live somewhere external. Storing it in the graph
 * itself avoids needing a new control-plane Postgres table for it.
 */
export async function getSweepCheckpoint(instanceId: string): Promise<string> {
  const instance = await getReadyNeo4jInstance(instanceId);
  const driver = await openNeo4jDriver(instance);

  try {
    const session = driver.session();
    try {
      const result = await session.run(`MATCH (c:_SweepCheckpoint) RETURN c.lastSweepAt AS lastSweepAt LIMIT 1`);
      const value = result.records[0]?.get("lastSweepAt");
      return value ? value.toString() : new Date(0).toISOString();
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

export async function setSweepCheckpoint(instanceId: string, checkpointIso: string): Promise<void> {
  const instance = await getReadyNeo4jInstance(instanceId);
  const driver = await openNeo4jDriver(instance);

  try {
    const session = driver.session();
    try {
      await session.run(`MERGE (c:_SweepCheckpoint) SET c.lastSweepAt = datetime($checkpoint)`, {
        checkpoint: checkpointIso,
      });
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

/**
 * Whether any node has been created since the last sweep. The sweep
 * workflow (normalizeEntitiesWorkflow.ts) only does the more expensive
 * proposeMerges/applyMerges work when this is true — "no new node, don't
 * normalize."
 */
export async function hasNewNodesSince(instanceId: string, sinceIso: string): Promise<boolean> {
  const instance = await getReadyNeo4jInstance(instanceId);
  const driver = await openNeo4jDriver(instance);

  try {
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (n) WHERE n.createdAt > datetime($since) RETURN count(n) > 0 AS hasNew`,
        { since: sinceIso },
      );
      return Boolean(result.records[0]?.get("hasNew"));
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

/**
 * Compares nodes within each label that has at least one node created
 * since `sinceIso`, against ALL nodes of that label (not just the new
 * ones) — a new node can be a duplicate of one indexed long ago. Tiered
 * decision, cheapest check first:
 *
 *   score >= 0.95        -> merge automatically (heuristic alone is confident enough)
 *   0.6 <= score < 0.95   -> ask the LLM to judge; merge only if it agrees
 *   score < 0.6           -> not a candidate, skip (bounds LLM calls to near-misses)
 */
export async function proposeMerges(instanceId: string, sinceIso: string): Promise<MergeDecision[]> {
  const instance = await getReadyNeo4jInstance(instanceId);
  const driver = await openNeo4jDriver(instance);

  try {
    const candidatesByLabel = await fetchCandidatesByLabel(driver, sinceIso);

    const decisions: MergeDecision[] = [];
    for (const [label, nodes] of Object.entries(candidatesByLabel)) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const score = nameSimilarity(a.name, b.name);

          if (score >= 0.95) {
            decisions.push({ label, keepId: a.id, mergeId: b.id, confidence: "heuristic", score });
          } else if (score >= 0.6) {
            const same = await confirmSameEntityWithLlm(label, a.name, b.name);
            if (same) {
              decisions.push({ label, keepId: a.id, mergeId: b.id, confidence: "llm", score });
            }
          }
        }
      }
    }
    return decisions;
  } finally {
    await driver.close();
  }
}

async function fetchCandidatesByLabel(
  driver: Awaited<ReturnType<typeof openNeo4jDriver>>,
  sinceIso: string,
): Promise<Record<string, CandidateNode[]>> {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n) WHERE n.createdAt > datetime($since)
       WITH collect(distinct labels(n)[0]) AS newLabels
       UNWIND newLabels AS label
       CALL {
         WITH label
         MATCH (m) WHERE labels(m)[0] = label
         RETURN collect({id: m.id, name: m.name}) AS nodes
       }
       RETURN label, nodes`,
      { since: sinceIso },
    );

    const candidatesByLabel: Record<string, CandidateNode[]> = {};
    for (const record of result.records) {
      candidatesByLabel[record.get("label") as string] = record.get("nodes") as CandidateNode[];
    }
    return candidatesByLabel;
  } finally {
    await session.close();
  }
}

export async function applyMerges(instanceId: string, decisions: MergeDecision[]): Promise<void> {
  if (decisions.length === 0) {
    return;
  }

  const instance = await getReadyNeo4jInstance(instanceId);
  const driver = await openNeo4jDriver(instance);

  try {
    const session = driver.session();
    try {
      for (const decision of decisions) {
        // Requires APOC, already installed per the Helm values in
        // docs/discussion/database-as-a-service.md.
        await session.run(
          `MATCH (keep {id: $keepId}), (merge {id: $mergeId})
           CALL apoc.refactor.mergeNodes([keep, merge], {properties: "discard", mergeRels: true})
           YIELD node
           SET node.normalizedAt = datetime()
           RETURN node`,
          { keepId: decision.keepId, mergeId: decision.mergeId },
        );
      }
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

/** Normalized Levenshtein similarity in [0, 1]; 1 means identical. */
function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === y) {
    return 1;
  }
  const distance = levenshteinDistance(x, y);
  return 1 - distance / Math.max(x.length, y.length, 1);
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[rows - 1][cols - 1];
}

async function confirmSameEntityWithLlm(label: string, nameA: string, nameB: string): Promise<boolean> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          `Two extracted "${label}" entities from a knowledge graph might refer to the ` +
          "same real-world entity written differently, or might be genuinely different " +
          "entities. Answer with exactly one word: yes or no.",
      },
      { role: "user", content: `Entity A: "${nameA}"\nEntity B: "${nameB}"\nSame entity?` },
    ],
    max_tokens: 5,
  });

  const answer = response.choices[0]?.message?.content?.trim().toLowerCase() ?? "";
  return answer.startsWith("yes");
}
