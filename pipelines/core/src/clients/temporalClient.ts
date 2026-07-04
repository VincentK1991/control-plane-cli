import { Client, Connection } from "@temporalio/client";
import { config } from "../config.js";

let clientPromise: Promise<Client> | undefined;

/**
 * Shared Temporal client, used by anything that *starts* workflows
 * (API routes in the main app, the starter scripts in each workflow
 * package). Workers connect independently via @temporalio/worker.
 */
export function getTemporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = Connection.connect({ address: config.temporal.address }).then(
      (connection) => new Client({ connection, namespace: config.temporal.namespace }),
    );
  }
  return clientPromise;
}
