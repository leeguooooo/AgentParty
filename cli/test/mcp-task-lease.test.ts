// #834 第 3 项：事故里的两条腿一条是 `party serve` 拉起的 reception runner、一条是 harness 会话,
// 而 harness 那条腿是走 MCP 认领的。只在 CLI 那半落闸 = enforcement 只盖住一半,两个实例照样并发。
//
// 这里用两个各自独立的 MCP server 进程（共享同一个 AGENTPARTY_HOME = 同一身份）复现那个形状。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

describe("party_status 的任务租约（MCP 腿）", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  let posted: { path: string; method: string }[] = [];
  const clients: Client[] = [];

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "king-claude", email: null, kind: "agent", role: "member", owner: null });
        }
        if (url.pathname.endsWith("/messages") && req.method === "POST") {
          posted.push({ path: url.pathname, method: req.method });
          return Response.json({ seq: 11 });
        }
        if (/\/tasks\/\d+$/.test(url.pathname) && req.method === "PATCH") {
          posted.push({ path: url.pathname, method: req.method });
          return Response.json({ id: 9, title: "t", state: "in_progress" });
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

  async function connect(executorId: string): Promise<Client> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
    }
    env.AGENTPARTY_HOME = home;
    env.AGENTPARTY_EXECUTOR_ID = executorId;
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "king"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-mcp-lease-"));
    posted = [];
    startRest();
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  test("第二个执行体经 MCP 认领同一个 task 被拒，且一条帧都没发", async () => {
    const first = await connect("runner:claude:reception");
    const granted = await first.callTool({
      name: "party_status",
      arguments: { state: "working", task_id: 9, note: "on it" },
    });
    expect(granted.isError).toBeFalsy();
    const afterFirst = posted.length;
    expect(afterFirst).toBeGreaterThan(0);

    const second = await connect("session:claude:harness");
    const denied = await second.callTool({
      name: "party_status",
      arguments: { state: "working", task_id: 9, note: "also on it" },
    });
    expect(denied.isError).toBe(true);
    const text = (denied.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/refused/);
    expect(text).toMatch(/task is untouched/);
    expect(text).toMatch(/runner:claude:reception/);
    // 红线:被拒 ≠ 吞任务。没有新的 POST messages、没有新的 PATCH task。
    expect(posted.length).toBe(afterFirst);
    expect((denied.structuredContent as { task_untouched?: boolean }).task_untouched).toBe(true);
  }, 30_000);

  test("不同 task 不受影响", async () => {
    const first = await connect("runner:claude:reception");
    await first.callTool({ name: "party_status", arguments: { state: "working", task_id: 9 } });
    const second = await connect("session:claude:harness");
    const other = await second.callTool({ name: "party_status", arguments: { state: "working", task_id: 10 } });
    expect(other.isError).toBeFalsy();
  }, 30_000);

  test("持有者报 done 后交还租约，另一个执行体可以正常接手", async () => {
    const first = await connect("runner:claude:reception");
    await first.callTool({ name: "party_status", arguments: { state: "working", task_id: 9 } });
    await first.callTool({ name: "party_status", arguments: { state: "done", task_id: 9 } });
    const second = await connect("session:claude:harness");
    const taken = await second.callTool({ name: "party_status", arguments: { state: "working", task_id: 9 } });
    expect(taken.isError).toBeFalsy();
  }, 30_000);
});
