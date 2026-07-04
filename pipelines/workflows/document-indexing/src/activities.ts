import { Pool } from "pg";
import { config, getOpenAIClient, getReadyNeo4jInstance, openNeo4jDriver } from "@pipelines/core";
import { toCypherIdentifier } from "./cypherUtil.js";

export type DocumentSource =
  | { type: "markdown"; content: string }
  | { type: "google-doc"; documentId: string; accessToken: string };

export interface ExtractedNode {
  id: string;
  label: string;
  /**
   * Canonical display name. Kept as its own field (not folded into a
   * freeform properties bag) because the normalization sweep
   * (normalizationActivities.ts) compares nodes by name similarity.
   */
  name: string;
}

export interface ExtractedRelationship {
  fromId: string;
  toId: string;
  type: string;
}

export interface ExtractedGraph {
  nodes: ExtractedNode[];
  relationships: ExtractedRelationship[];
}

/**
 * Normalizes the upload into plain text. Google Docs are exported as
 * markdown via the Drive/Docs export API; a directly uploaded .md file is
 * passed through as-is.
 */
export async function fetchDocumentText(source: DocumentSource): Promise<string> {
  if (source.type === "markdown") {
    return source.content;
  }

  throw new Error(
    `TODO: export Google Doc ${source.documentId} to markdown via the Drive API ` +
      "using the user's OAuth access token",
  );
}

const EXTRACTION_MODEL = "gpt-4o-mini";

const EXTRACTED_GRAPH_SCHEMA = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "A short, stable id derived from the entity name (lowercase, hyphenated), " +
              "e.g. 'ada-lovelace'. The same entity must always get the same id within " +
              "this document so relationships can reference it.",
          },
          label: {
            type: "string",
            description: "The entity type, e.g. Person, Organization, Place, Concept.",
          },
          name: {
            type: "string",
            description: "The entity's canonical display name as it appears in the text.",
          },
        },
        required: ["id", "label", "name"],
        additionalProperties: false,
      },
    },
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fromId: { type: "string" },
          toId: { type: "string" },
          type: {
            type: "string",
            description: "A short relationship label in SCREAMING_SNAKE_CASE, e.g. INSPIRED, WORKED_WITH.",
          },
        },
        required: ["fromId", "toId", "type"],
        additionalProperties: false,
      },
    },
  },
  required: ["nodes", "relationships"],
  additionalProperties: false,
} as const;

/**
 * The extraction step: GPT-4o-mini reads the document text and returns
 * structured entities + relationships via OpenAI's strict JSON schema mode,
 * so this doesn't need its own hand-written parser for the model's output.
 */
export async function extractEntitiesAndRelationships(text: string): Promise<ExtractedGraph> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: EXTRACTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extract a knowledge graph from the user's document. Identify distinct " +
          "real-world entities (people, organizations, places, concepts) as nodes, and " +
          "the relationships between them. Only extract entities and relationships " +
          "that are actually stated or clearly implied in the text.",
      },
      { role: "user", content: text },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "extracted_graph", schema: EXTRACTED_GRAPH_SCHEMA, strict: true },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI extraction returned no content");
  }

  return JSON.parse(content) as ExtractedGraph;
}

export async function writeGraphToInstance(
  instanceId: string,
  graph: ExtractedGraph,
): Promise<void> {
  const instance = await getReadyNeo4jInstance(instanceId);
  const driver = await openNeo4jDriver(instance);

  try {
    const session = driver.session();
    try {
      for (const node of graph.nodes) {
        const label = toCypherIdentifier(node.label);
        // ON CREATE only, not on every MERGE match: createdAt marks when a
        // node first appeared, which is what the normalization sweep
        // (normalizationActivities.ts: hasNewNodesSince) checks for.
        await session.run(
          `MERGE (n:${label} {id: $id})
             ON CREATE SET n.createdAt = datetime()
             SET n.name = $name`,
          { id: node.id, name: node.name },
        );
      }
      for (const rel of graph.relationships) {
        const type = toCypherIdentifier(rel.type);
        await session.run(
          `MATCH (a {id: $fromId}), (b {id: $toId}) MERGE (a)-[:${type}]->(b)`,
          { fromId: rel.fromId, toId: rel.toId },
        );
      }
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

let documentIndexingRunsPool: Pool | undefined;

function getDocumentIndexingRunsPool(): Pool {
  if (!documentIndexingRunsPool) {
    documentIndexingRunsPool = new Pool({ connectionString: config.controlPlaneDatabaseUrl });
  }
  return documentIndexingRunsPool;
}

export async function recordIndexingResult(
  instanceId: string,
  status: "succeeded" | "failed",
  detail?: string,
): Promise<void> {
  await getDocumentIndexingRunsPool().query(
    `insert into document_indexing_runs (instance_id, status, detail) values ($1, $2, $3)`,
    [instanceId, status, detail ?? null],
  );
}
