// #824：party_task_create 传 body/assignee 时静默丢弃，返回 200 和一个看起来正常的回执，落库却是
// 只有标题的空壳。写任务的 agent 不会回头核对落库结果，读任务的 agent 不知道原本有内容——于是
// 「任务系统存在的意义（接手方不用回去翻聊天记录）」当场失效，而且要等接手方来问才发现。
// 宁可报错也不要静默丢规格。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

describe("party_task_create 不再静默丢字段", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  let lastCreateBody: Record<string, unknown> | null = null;

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        if (url.pathname.endsWith("/tasks") && req.method === "POST") {
          lastCreateBody = (await req.json()) as Record<string, unknown>;
          return Response.json({
            task: { id: 204, title: lastCreateBody.title, desc: lastCreateBody.desc ?? null, assignee: lastCreateBody.assignee ?? null, state: "triage" },
          });
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

  async function connect(): Promise<Client> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
    }
    env.AGENTPARTY_HOME = home;
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "welcome"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-task-strict-"));
    lastCreateBody = null;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  test("传 body（真实字段叫 desc）→ 报错，而不是建出一个空壳任务", async () => {
    startRest();
    const client = await connect();
    try {
      const r = await client
        .callTool({ name: "party_task_create", arguments: { title: "收窄口径", body: "几百字规格，含验收判据" } })
        .catch((e: unknown) => ({ isError: true, thrown: e instanceof Error ? e.message : String(e) }));
      // 无论走 SDK 抛错还是 isError 回执，关键是：调用方知道了，且没有任务被建出来。
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(lastCreateBody).toBeNull();
    } finally {
      await client.close();
    }
  }, 20000);

  test("传 desc → 内容真的落到请求体里", async () => {
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({
        name: "party_task_create",
        arguments: { title: "收窄口径", desc: "几百字规格，含验收判据" },
      });
      expect(r.isError).not.toBe(true);
      expect(lastCreateBody?.desc).toBe("几百字规格，含验收判据");
    } finally {
      await client.close();
    }
  }, 20000);

  test("assignee 收纯字符串（调用方最自然的写法），服务端拿到的是 {name, kind}", async () => {
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({
        name: "party_task_create",
        arguments: { title: "t", assignee: "leo-welcome-fable5" },
      });
      expect(r.isError).not.toBe(true);
      expect(lastCreateBody?.assignee).toEqual({ name: "leo-welcome-fable5", kind: "agent" });
    } finally {
      await client.close();
    }
  }, 20000);

  test("assignee 带 @ 前缀照收；与 assignee_name 冲突时报错而不是猜一个", async () => {
    startRest();
    const client = await connect();
    try {
      const ok = await client.callTool({ name: "party_task_create", arguments: { title: "t", assignee: "@bob" } });
      expect(ok.isError).not.toBe(true);
      expect(lastCreateBody?.assignee).toEqual({ name: "bob", kind: "agent" });

      lastCreateBody = null;
      const clash = await client.callTool({
        name: "party_task_create",
        arguments: { title: "t", assignee: "bob", assignee_name: "carol" },
      });
      expect(clash.isError).toBe(true);
      // 派给错的人比报错贵得多——冲突时一个任务都不该被建出来。
      expect(lastCreateBody).toBeNull();
    } finally {
      await client.close();
    }
  }, 20000);
});
