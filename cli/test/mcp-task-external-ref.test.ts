// #141 MCP 侧：party_task_create 工具把 external_ref 幂等键透传进请求体，
// 让 agent 走 MCP（主路径）重跑 issue→task 同步时命中既有 task 而不产生重复
// （对照 cli/test/task-external-ref.test.ts 的裸 CLI 路径 + worker 后端幂等）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;
const seen: { method: string; path: string; body: unknown }[] = [];

const EXT_REF = "gh:leeguooooo/agentparty#96";

// 幂等后端：命中已存在的 external_ref 时 worker 返回既有 task（同一个 id），
// 不新建。这里恒定返回 id=9 的 task 来模拟这一契约。
function existingTask(): Record<string, unknown> {
  return {
    type: "task",
    id: 9,
    channel: "dev",
    title: "sync issue #96",
    desc: null,
    state: "triage",
    assignee: null,
    created_by: "me",
    created_by_kind: "agent",
    priority: 0,
    labels: [],
    parent_id: null,
    anchor_seqs: [],
    external_ref: EXT_REF,
    completion_artifact: null,
    workflow_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

function startRest(): void {
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/api/me") {
        return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
      }
      if (url.pathname === "/api/channels/dev/tasks" && req.method === "POST") {
        return Response.json(existingTask(), { status: 201 });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
  );
}

async function connect(channelFlag: string): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
  }
  env.AGENTPARTY_HOME = home;
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", indexPath, "mcp", "--channel", channelFlag],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agentparty-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-mcp-extref-"));
  seen.length = 0;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

describe("mcp party_task_create external_ref（#141）", () => {
  // 工具 schema 必须声明 external_ref，否则 MCP client 传进来的键会被丢弃。
  test("party_task_create advertises external_ref in its input schema", async () => {
    startRest();
    const client = await connect("dev");
    try {
      const tools = await client.listTools();
      const tool = tools.tools.find((t) => t.name === "party_task_create");
      expect(tool).toBeDefined();
      const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      expect(Object.keys(props)).toContain("external_ref");
    } finally {
      await client.close();
    }
  }, 20000);

  // 主路径回归：agent 走 MCP 建 task 时，external_ref 必须进 POST body，
  // 后端命中既有 task 返回同一 id——重跑同步不产生重复。
  test("forwards external_ref in the POST body and returns the existing task", async () => {
    startRest();
    const client = await connect("dev");
    try {
      const first = await client.callTool({
        name: "party_task_create",
        arguments: { title: "sync issue #96", external_ref: EXT_REF },
      });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        type: "task_create",
        channel: "dev",
        task: { id: 9, external_ref: EXT_REF },
      });

      // 重跑同步：同一 external_ref 再建一次，后端仍返回 id=9（幂等），不产生新 task。
      const second = await client.callTool({
        name: "party_task_create",
        arguments: { title: "sync issue #96", external_ref: EXT_REF },
      });
      expect(second.structuredContent).toMatchObject({ task: { id: 9 } });

      const posts = seen.filter((s) => s.method === "POST" && s.path === "/api/channels/dev/tasks");
      expect(posts.length).toBe(2);
      for (const p of posts) {
        expect(p.body).toMatchObject({ title: "sync issue #96", external_ref: EXT_REF });
      }
    } finally {
      await client.close();
    }
  }, 20000);

  // 未传 external_ref 时不得把该键塞进请求体（保持后端 body 干净）。
  test("omits external_ref from the body when the argument is absent", async () => {
    startRest();
    const client = await connect("dev");
    try {
      const r = await client.callTool({
        name: "party_task_create",
        arguments: { title: "plain task" },
      });
      expect(r.isError).not.toBe(true);
      const post = seen.find((s) => s.method === "POST" && s.path === "/api/channels/dev/tasks");
      expect(post?.body).toEqual({ title: "plain task" });
    } finally {
      await client.close();
    }
  }, 20000);
});
