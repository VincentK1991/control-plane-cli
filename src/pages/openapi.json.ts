import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const origin = url.origin;

  return new Response(
    JSON.stringify(
      {
        openapi: "3.1.0",
        info: {
          title: "Control Plane API",
          version: "0.1.0",
          description:
            "API key management, user session, and metered mock API endpoints.",
        },
        servers: [{ url: origin }],
        tags: [
          { name: "Auth" },
          { name: "API Keys" },
          { name: "Neo4j DBaaS" },
          { name: "Usage" },
          { name: "Billing" },
          { name: "Mock API" },
        ],
        components: {
          securitySchemes: {
            ApiKeyBearer: {
              type: "http",
              scheme: "bearer",
              description: "Minted API key, for example cp_live_xxx_secret.",
            },
          },
        },
        paths: {
          "/api/auth/google": {
            post: {
              tags: ["Auth"],
              summary: "Create a dashboard session from a Google ID token",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["credential"],
                      properties: {
                        credential: { type: "string" },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": { description: "Authenticated user session created" },
                "401": { description: "Google credential rejected" },
              },
            },
          },
          "/api/me": {
            get: {
              tags: ["Auth"],
              summary: "Return current dashboard user from session cookie",
              responses: {
                "200": { description: "Current user" },
                "401": { description: "No valid session" },
              },
            },
          },
          "/api/api-keys": {
            get: {
              tags: ["API Keys"],
              summary: "List API keys for current dashboard user",
              responses: {
                "200": { description: "API keys" },
                "401": { description: "No valid session" },
              },
            },
            post: {
              tags: ["API Keys"],
              summary: "Mint a new API key for current dashboard user",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["name"],
                      properties: {
                        name: { type: "string", maxLength: 80 },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": { description: "New API key token shown once" },
                "401": { description: "No valid session" },
              },
            },
          },
          "/api/api-keys/{id}": {
            patch: {
              tags: ["API Keys"],
              summary: "Rename or revoke an API key",
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              responses: {
                "200": { description: "Updated API key" },
                "404": { description: "API key not found" },
              },
            },
            delete: {
              tags: ["API Keys"],
              summary: "Revoke an API key",
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              responses: {
                "200": { description: "Revoked API key" },
                "404": { description: "API key not found" },
              },
            },
          },
          "/api/api-keys/{apiKeyId}/neo4j": {
            get: {
              tags: ["Neo4j DBaaS"],
              summary: "List Neo4j databases provisioned for an API key",
              parameters: [
                {
                  name: "apiKeyId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              responses: {
                "200": { description: "Neo4j instances" },
                "401": { description: "No valid session" },
                "404": { description: "API key not found" },
              },
            },
            post: {
              tags: ["Neo4j DBaaS"],
              summary: "Provision a free-tier Neo4j database for an API key",
              parameters: [
                {
                  name: "apiKeyId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              requestBody: {
                required: false,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        name: { type: "string", maxLength: 80 },
                      },
                    },
                  },
                },
              },
              responses: {
                "201": { description: "Neo4j instance is ready; password shown once" },
                "202": { description: "Neo4j instance record created but provisioning failed or is incomplete" },
                "409": { description: "Free-tier instance limit reached" },
              },
            },
          },
          "/api/api-keys/{apiKeyId}/neo4j/{instanceId}": {
            get: {
              tags: ["Neo4j DBaaS"],
              summary: "Get one Neo4j database provisioned for an API key",
              parameters: [
                {
                  name: "apiKeyId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
                {
                  name: "instanceId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              responses: {
                "200": { description: "Neo4j instance" },
                "404": { description: "API key or Neo4j instance not found" },
              },
            },
            delete: {
              tags: ["Neo4j DBaaS"],
              summary: "Delete a Neo4j database provisioned for an API key",
              parameters: [
                {
                  name: "apiKeyId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
                {
                  name: "instanceId",
                  in: "path",
                  required: true,
                  schema: { type: "string", format: "uuid" },
                },
              ],
              responses: {
                "200": { description: "Neo4j instance marked deleted after Kubernetes cleanup" },
                "404": { description: "API key or Neo4j instance not found" },
              },
            },
          },
          "/api/usage": {
            get: {
              tags: ["Usage"],
              summary: "Return usage summary for current dashboard user",
              responses: {
                "200": { description: "Usage summary" },
                "401": { description: "No valid session" },
              },
            },
          },
          "/api/usage/events": {
            post: {
              tags: ["Usage"],
              summary: "Record an idempotent usage event with an API key",
              security: [{ ApiKeyBearer: [] }],
              parameters: [
                {
                  name: "Idempotency-Key",
                  in: "header",
                  required: false,
                  schema: { type: "string", maxLength: 200 },
                  description:
                    "Preferred idempotency key. May also be supplied as idempotency_key in the JSON body.",
                },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["source", "event_type", "billable_metric", "quantity", "unit"],
                      properties: {
                        idempotency_key: { type: "string", maxLength: 200 },
                        source: { type: "string", example: "/api/files/process" },
                        event_type: {
                          type: "string",
                          example: "file.processing.completed",
                        },
                        billable_metric: { type: "string", example: "pages_processed" },
                        quantity: { type: "integer", default: 1 },
                        unit: { type: "string", example: "page" },
                        unit_price_cents: { type: "integer", nullable: true },
                        cost_cents: { type: "integer", default: 0 },
                        request_id: { type: "string", nullable: true },
                        job_id: { type: "string", nullable: true },
                        provider: { type: "string", nullable: true },
                        model: { type: "string", nullable: true },
                        metadata: { type: "object", additionalProperties: true },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": { description: "Usage event recorded" },
                "401": { description: "Invalid API key" },
              },
            },
          },
          "/api/billing/status": {
            get: {
              tags: ["Billing"],
              summary: "Return billing setup, subscription, and meter sync status",
              responses: {
                "200": { description: "Billing status for current user" },
                "401": { description: "No valid session" },
              },
            },
          },
          "/api/billing/checkout": {
            post: {
              tags: ["Billing"],
              summary: "Create a Stripe Checkout subscription session",
              responses: {
                "200": { description: "Checkout URL" },
                "401": { description: "No valid session" },
                "503": { description: "Stripe billing is not configured" },
              },
            },
          },
          "/api/billing/portal": {
            post: {
              tags: ["Billing"],
              summary: "Create a Stripe Billing Portal session",
              responses: {
                "200": { description: "Portal URL" },
                "401": { description: "No valid session" },
                "503": { description: "Stripe billing is not configured" },
              },
            },
          },
          "/api/webhooks/stripe": {
            post: {
              tags: ["Billing"],
              summary: "Receive Stripe subscription webhooks",
              parameters: [
                {
                  name: "Stripe-Signature",
                  in: "header",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                "200": { description: "Webhook processed" },
                "400": { description: "Invalid Stripe signature or payload" },
              },
            },
          },
          "/api/mock/inference": {
            post: {
              tags: ["Mock API"],
              summary: "Call a metered mock inference endpoint with an API key",
              security: [{ ApiKeyBearer: [] }],
              parameters: [
                {
                  name: "Idempotency-Key",
                  in: "header",
                  required: false,
                  schema: { type: "string", maxLength: 200 },
                  description:
                    "Use a stable client request ID to make retries safe. If omitted, the server records a unique event for each call.",
                },
              ],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["prompt"],
                      properties: {
                        prompt: { type: "string", maxLength: 4000 },
                      },
                    },
                  },
                },
              },
              responses: {
                "200": { description: "Mock inference response with usage" },
                "400": { description: "Invalid prompt" },
                "401": { description: "Invalid API key" },
              },
            },
          },
        },
      },
      null,
      2,
    ),
    {
      headers: {
        "content-type": "application/json",
      },
    },
  );
};
