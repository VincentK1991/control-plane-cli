// Node-side entrypoint: safe to import from activities.ts, worker.ts, and
// starter.ts (or a future Astro API route). Do NOT import this from any
// workflows.ts — it pulls in `pg`/`@temporalio/client`, which are not
// deterministic-safe inside the Temporal workflow sandbox. Workflow code
// should import from `@pipelines/core/workflow` instead.

export { config } from "./config.js";
export { getTemporalClient } from "./clients/temporalClient.js";
export {
  getReadyNeo4jInstance,
  type Neo4jInstanceRecord,
  type Neo4jInstanceStatus,
} from "./clients/controlPlaneDb.js";
export { openNeo4jDriver } from "./clients/neo4j.js";
export { getOpenAIClient } from "./clients/openai.js";
export * as jobActivities from "./activities/jobActivities.js";
export {
  startTrackedWorkflow,
  getJobStatus,
  type JobRecord,
  type JobStatus,
} from "./client/startTrackedWorkflow.js";
