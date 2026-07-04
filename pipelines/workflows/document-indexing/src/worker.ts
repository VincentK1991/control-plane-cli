import { startPipelineWorker } from "@pipelines/core/worker";
import * as activities from "./activities.js";
import * as normalizationActivities from "./normalizationActivities.js";
import * as scheduleActivities from "./scheduleActivities.js";

void startPipelineWorker({
  taskQueue: "document-indexing",
  workflowsPath: require.resolve("./workflows"),
  activities: { ...activities, ...normalizationActivities, ...scheduleActivities },
});
