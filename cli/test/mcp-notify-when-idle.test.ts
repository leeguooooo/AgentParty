// #1052 #5：MCP `party_send` 的 `notify_when_idle: true`——与 Claude Code 内置 SendMessage 同名同义。
// 真 stdio server + mock REST：断言先 POST messages、再对每个 mention POST notify-when-idle，且回包带结果。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

describe("party_send notify_when_idle（真 stdio server + mock REST）", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  let posts: { path: string; body: unknown }[] = [];

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "leo-welcome-fable5", email: null, kind: "agent", role: "member", owner: null });
        }
        if (url.pathname === "/api/version") {
          return Response.json({ version: "0.0.1", commit: "deadbeef", deployed_at: null, min_client_version: "0.0.0", min_client_enforced: false });
        }
        if (req.method === "POST") posts.push({ path: url.pathname, body: await req.json().catch(() => null) });
        if (url.pathname.endsWith("/messages") && req.method === "POST") return Response.json({ seq: 7 });
        const idle = url.pathname.match(/\/presence\/([^/]+)\/notify-when-idle$/);
        if (idle && req.method === "POST") {
          const target = decodeURIComponent(idle[1] ?? "");
          if (target === "ghost") {
            return Response.json({ error: { code: "not_found", message: `unknown target ${target}` } }, { status: 404 });
          }
          return Response.json({ ok: true, target, subscriber: "leo-welcome-fable5", outcome: "subscribed", expires_at: 1_800_000_000_000 });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }));
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
    home = mkdtempSync(join(tmpdir(), "ap-mcp-notify-idle-"));
    posts = [];
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  test("工具 schema 暴露 notify_when_idle（boolean）", async () => {
    startRest();
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      const send = tools.find((tool) => tool.name === "party_send");
      expect(send).toBeDefined();
      const props = (send!.inputSchema as { properties?: Record<string, { type?: string }> }).properties ?? {};
      expect(props.notify_when_idle?.type).toBe("boolean");
    } finally {
      await client.close();
    }
  }, 20000);

  test("notify_when_idle: true ⇒ 先发消息、再对每个 mention 订阅；404 的目标只在回包里标 ok:false", async () => {
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({
        name: "party_send",
        arguments: { body: "please run the acceptance", mentions: ["text-to-voice", "ghost"], notify_when_idle: true },
      });
      expect(r.isError).not.toBe(true);
      expect(posts.map((p) => p.path)).toEqual([
        "/api/channels/welcome/messages",
        "/api/channels/welcome/presence/text-to-voice/notify-when-idle",
        "/api/channels/welcome/presence/ghost/notify-when-idle",
      ]);
      const data = r.structuredContent as { seq: number; notify_when_idle: { target: string; ok: boolean; detail: string }[] };
      expect(data.seq).toBe(7);
      expect(data.notify_when_idle).toEqual([
        { target: "text-to-voice", ok: true, detail: expect.stringContaining("you will get one notice when it goes idle") },
        { target: "ghost", ok: false, detail: expect.stringContaining("unknown target ghost") },
      ]);
    } finally {
      await client.close();
    }
  }, 20000);

  test("不传 notify_when_idle ⇒ 不订阅；传了但没有 mentions ⇒ 回包说明被忽略", async () => {
    startRest();
    const client = await connect();
    try {
      await client.callTool({ name: "party_send", arguments: { body: "hi", mentions: ["text-to-voice"] } });
      expect(posts.map((p) => p.path)).toEqual(["/api/channels/welcome/messages"]);
      posts = [];
      const r = await client.callTool({ name: "party_send", arguments: { body: "hi", notify_when_idle: true } });
      expect(posts.map((p) => p.path)).toEqual(["/api/channels/welcome/messages"]);
      const data = r.structuredContent as { notify_when_idle: unknown };
      expect(String(data.notify_when_idle)).toContain("ignored");
    } finally {
      await client.close();
    }
  }, 20000);
});
