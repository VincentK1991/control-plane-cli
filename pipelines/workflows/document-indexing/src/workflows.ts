// Single entry point the worker's workflowsPath resolves to; both
// workflows below run on the "document-indexing" task queue in the same
// worker process (see worker.ts and startPipelineWorker in @pipelines/core).
export { IndexDocumentWorkflow, type IndexDocumentInput } from "./documentIndexingWorkflow.js";
export { NormalizeEntitiesWorkflow, type NormalizeEntitiesInput } from "./normalizeEntitiesWorkflow.js";
