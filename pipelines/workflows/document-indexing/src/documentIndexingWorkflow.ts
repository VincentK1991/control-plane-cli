import { log, proxyActivities } from "@temporalio/workflow";
import { reportProgress, withJobTracking } from "@pipelines/core/workflow";
import type * as activities from "./activities.js";
import type { DocumentSource } from "./activities.js";
import type * as scheduleActivities from "./scheduleActivities.js";

const { fetchDocumentText, extractEntitiesAndRelationships, writeGraphToInstance, recordIndexingResult } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "5 minutes",
    retry: { maximumAttempts: 3 },
  });

const { ensureNormalizationScheduleExists } = proxyActivities<typeof scheduleActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export interface IndexDocumentInput {
  instanceId: string;
  source: DocumentSource;
}

/**
 * Started when a user uploads a document against an already-provisioned,
 * ready database. Wrapped in withJobTracking so the upload endpoint can
 * call startTrackedWorkflow, return { jobId } immediately, and let the
 * user poll job status instead of waiting on extraction/write to finish.
 */
export const IndexDocumentWorkflow = withJobTracking(
  "IndexDocumentWorkflow",
  async (input: IndexDocumentInput): Promise<void> => {
    // Idempotent — see scheduleActivities.ts. Only the first upload for a
    // given instance actually creates the Schedule; every later one hits
    // ScheduleAlreadyRunning and no-ops.
    await ensureNormalizationScheduleExists(input.instanceId);

    try {
      await reportProgress("fetching-document");
      const text = await fetchDocumentText(input.source);

      await reportProgress("extracting-entities-and-relationships");
      const graph = await extractEntitiesAndRelationships(text);

      await reportProgress("writing-graph-to-instance", {
        nodeCount: graph.nodes.length,
        relationshipCount: graph.relationships.length,
      });
      await writeGraphToInstance(input.instanceId, graph);

      await reportProgress("recording-result");
      await recordIndexingResult(input.instanceId, "succeeded");
    } catch (err) {
      // recordIndexingResult here is domain-specific (document_indexing_runs,
      // not yet added — see docs/discussion/temporal-pipelines-plan.md),
      // separate from the generic pipeline_jobs status withJobTracking sets
      // after this rethrows. It's still a TODO stub itself right now, which
      // means it throws too — without this inner try/catch, that second
      // throw would replace `err` before `throw err` below ever ran,
      // masking the actual failure (e.g. "Neo4j instance not found") behind
      // "TODO: insert a row into document_indexing_runs" in the workflow's
      // terminal error. Record-failure is best-effort; it must never hide
      // the real cause.
      try {
        await recordIndexingResult(
          input.instanceId,
          "failed",
          err instanceof Error ? err.message : String(err),
        );
      } catch (recordErr) {
        log.error("recordIndexingResult(failed) itself failed", { recordErr });
      }
      throw err;
    }
  },
);
