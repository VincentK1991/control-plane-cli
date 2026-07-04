import { startPipelineWorker } from "@pipelines/core/worker";
import * as activities from "./activities.js";

void startPipelineWorker({
  taskQueue: "dbaas-provisioning",
  workflowsPath: require.resolve("./workflows"),
  activities,
});
