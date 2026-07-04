import { startTrackedWorkflow } from "@pipelines/core";
import { IndexDocumentWorkflow } from "./workflows.js";

/**
 * Manual test entrypoint. In the real app, the upload endpoint (e.g. a new
 * POST /api/api-keys/:apiKeyId/neo4j/:instanceId/documents route) calls
 * startTrackedWorkflow directly after storing the upload and returns
 * { jobId } to the caller; a separate GET /jobs/:jobId route reads job
 * status via getJobStatus (also exported from @pipelines/core).
 *
 * Usage:
 *   npm run start --workspace workflows/document-indexing -- <instanceId> <path-to-markdown-file>
 */
async function main() {
  const [instanceId, markdownPath] = process.argv.slice(2);
  if (!instanceId || !markdownPath) {
    throw new Error("usage: starter.ts <instanceId> <path-to-markdown-file>");
  }

  const { readFile } = await import("node:fs/promises");
  const content = await readFile(markdownPath, "utf8");

  const { jobId } = await startTrackedWorkflow({
    workflowType: IndexDocumentWorkflow,
    taskQueue: "document-indexing",
    args: [{ instanceId, source: { type: "markdown", content } }],
  });

  console.log(`Started job ${jobId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
