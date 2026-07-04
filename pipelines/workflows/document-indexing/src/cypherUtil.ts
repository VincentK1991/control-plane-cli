/**
 * Neo4j labels and relationship types can't be passed as query parameters —
 * Cypher requires them inline in the query text — so an LLM-produced label
 * or relationship type has to be sanitized before interpolation rather than
 * trusted as-is. Keeps only [A-Za-z0-9_], strips a leading run of anything
 * else (so a label can't start with a digit), and falls back to "Entity"
 * if nothing safe survives.
 *
 * Kept in its own module (not activities.ts) because it's a plain sync
 * function, not a Temporal activity — `import * as activities` in
 * worker.ts is spread directly into the Worker's activities map, and a
 * non-async export there fails startPipelineWorker's activities type.
 */
export function toCypherIdentifier(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "");
  return cleaned || "Entity";
}
