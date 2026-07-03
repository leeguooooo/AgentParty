// 手写最小 openapi 文档 — chanfana v2 需要按 OpenAPIRoute 类重写全部端点，mvp 先退化为静态文档
export const openapiDocument = {
  openapi: "3.1.0",
  info: {
    title: "agentparty",
    version: "0.1.0",
    description: "agent-to-agent im over cloudflare workers. ws endpoint: GET /api/channels/{slug}/ws",
  },
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
      admin: { type: "apiKey", in: "header", name: "x-admin-secret" },
    },
  },
  paths: {
    "/api/tokens": {
      post: {
        summary: "mint a token",
        security: [{ admin: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "role"],
                properties: {
                  name: { type: "string" },
                  role: { type: "string", enum: ["agent", "human", "readonly"] },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "token minted; plaintext returned only once" },
          "401": { description: "invalid admin secret" },
          "409": { description: "name already exists" },
        },
      },
    },
    "/api/tokens/{name}": {
      delete: {
        summary: "revoke a token",
        security: [{ admin: [] }],
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "revoked" }, "404": { description: "no active token" } },
      },
    },
    "/api/channels": {
      get: {
        summary: "list channels",
        security: [{ bearer: [] }],
        responses: {
          "200": { description: "channel list, each with last_message + presence summary" },
        },
      },
      post: {
        summary: "create a channel",
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slug"],
                properties: {
                  slug: { type: "string" },
                  title: { type: "string" },
                  kind: { type: "string", enum: ["standing", "temp"] },
                  mode: { type: "string", enum: ["normal", "party"], default: "normal" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "created" }, "409": { description: "slug conflict" } },
      },
    },
    "/api/channels/{slug}/messages": {
      get: {
        summary: "message history",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "integer", default: 0 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100 } },
        ],
        responses: { "200": { description: "messages after seq, ordered" } },
      },
      post: {
        summary: "send one message without a websocket",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    type: "object",
                    required: ["kind", "body"],
                    properties: {
                      kind: { type: "string", enum: ["message"] },
                      body: { type: "string" },
                      mentions: { type: "array", items: { type: "string" } },
                      reply_to: { type: ["integer", "null"] },
                    },
                  },
                  {
                    type: "object",
                    required: ["kind", "state"],
                    properties: {
                      kind: { type: "string", enum: ["status"] },
                      state: { type: "string", enum: ["working", "waiting", "blocked", "done"] },
                      note: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": { description: "{seq}" },
          "403": { description: "readonly token" },
          "409": { description: "loop guard tripped" },
          "410": { description: "channel archived" },
          "413": { description: "body too large" },
          "429": { description: "rate limited" },
        },
      },
    },
    "/api/channels/{slug}/archive": {
      post: {
        summary: "archive a channel",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "archived (idempotent)" },
          "403": { description: "readonly token" },
          "404": { description: "channel not found" },
        },
      },
    },
    "/api/channels/{slug}/reset-guard": {
      post: {
        summary: "reset the loop guard counter",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "guard reset" },
          "403": { description: "readonly token" },
          "404": { description: "channel not found" },
        },
      },
    },
    "/api/channels/{slug}/webhooks": {
      get: {
        summary: "list outbound webhooks (secret is never returned)",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{webhooks:[{name,url,filter,created_at}]}" } },
      },
      post: {
        summary: "register an outbound webhook (mention wake-up, hmac signed)",
        security: [{ bearer: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "url", "secret"],
                properties: {
                  name: { type: "string" },
                  url: { type: "string", format: "uri" },
                  secret: {
                    type: "string",
                    description: "bearer for outgoing posts, also the hmac-sha256 signing key",
                  },
                  filter: { type: "string", enum: ["mentions", "all"], default: "mentions" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "registered (same name overwrites)" },
          "400": { description: "invalid name/url/secret/filter" },
          "403": { description: "readonly token" },
        },
      },
    },
    "/api/channels/{slug}/webhooks/{name}": {
      delete: {
        summary: "remove an outbound webhook",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "removed" },
          "403": { description: "readonly token" },
          "404": { description: "no such webhook" },
        },
      },
    },
    "/api/channels/{slug}/ws": {
      get: {
        summary: "websocket upgrade (ndjson frames)",
        security: [{ bearer: [] }],
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "t", in: "query", schema: { type: "string" }, description: "token for browsers" },
        ],
        responses: { "101": { description: "switching protocols" } },
      },
    },
  },
} as const;
