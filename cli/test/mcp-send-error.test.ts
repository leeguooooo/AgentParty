// #815：MCP 出口曾把 REST 错误压成 `send failed with exit 4`，原因（loop_guard / workflow_guard /
// rate_limited）全丢在 stderr 里，调用方拿不到。对 agent 来说这个差别是「盲目重试」和「知道要等
// 人类发言」的差别。这里守住两件事：错误结果带得动原因，party_who 提前报得出剩余额度。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

const LOOP_GUARD_MESSAGE =
  "leo-welcome-fable5 reached its 15-message fair-share budget since the last human message; " +
  "another agent can continue, or a human/reset can clear it";

describe("party_send / party_who 的 loop guard 可见性（真 stdio server + mock REST）", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  let sendStatus = 200;
  let guardBody: Record<string, unknown> | null = null;
  let guardStatus = 200;

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "leo-welcome-fable5", email: null, kind: "agent", role: "member", owner: null });
        }
        if (url.pathname === "/api/version") {
          return Response.json({
            version: "0.0.1",
            commit: "deadbeef",
            deployed_at: null,
            min_client_version: "0.0.0",
            min_client_enforced: false,
          });
        }
        if (url.pathname.endsWith("/messages") && req.method === "POST") {
          if (sendStatus === 200) return Response.json({ seq: 7 });
          return Response.json(
            { error: { code: "loop_guard", message: LOOP_GUARD_MESSAGE } },
            { status: sendStatus },
          );
        }
        if (url.pathname.endsWith("/presence")) {
          return Response.json({ presence: [{ name: "leo-welcome-fable5", kind: "agent" }] });
        }
        if (url.pathname.endsWith("/loop-guard")) {
          if (guardStatus !== 200) {
            return Response.json({ error: { code: "forbidden", message: "nope" } }, { status: guardStatus });
          }
          return Response.json(guardBody ?? {});
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
    home = mkdtempSync(join(tmpdir(), "ap-mcp-send-error-"));
    sendStatus = 200;
    guardStatus = 200;
    guardBody = {
      enabled: true,
      limit: 30,
      streak: 12,
      remaining: 18,
      resets_on: "human",
      self: { name: "leo-welcome-fable5", limit: 15, used: 13, remaining: 2 },
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  test("撞 loop guard → 错误正文带原因和可执行 hint，不再只有 exit 4", async () => {
    sendStatus = 409;
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_send", arguments: { body: "一条很长的技术回复" } });
      expect(r.isError).toBe(true);
      const text = (r.content as { type: string; text: string }[])[0].text;
      // 退出码还在（调用方可能按它分支），但真正的原因必须同在。
      expect(text).toContain("exit 4");
      expect(text).toContain("loop_guard");
      expect(text).toContain("fair-share budget");
      // hint 要告诉 agent 该等人类，而不是拆短重发——后者是这个 issue 里实际发生的浪费。
      expect(text).toContain("wait for a human message");
    } finally {
      await client.close();
    }
  }, 20000);

  test("错误也带结构化字段，agent 不必解析文本就能分支", async () => {
    sendStatus = 409;
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_send", arguments: { body: "hi" } });
      const data = r.structuredContent as Record<string, unknown>;
      expect(data).toMatchObject({
        type: "error",
        operation: "send",
        exit_code: 4,
        code: "loop_guard",
        status: 409,
      });
      expect(String(data.message)).toContain("fair-share budget");
    } finally {
      await client.close();
    }
  }, 20000);

  test("party_who 提前报出自己的剩余额度（写长消息前就能看到）", async () => {
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_who", arguments: {} });
      expect(r.isError).not.toBe(true);
      const data = r.structuredContent as { send_budget?: Record<string, unknown> };
      expect(data.send_budget).toBeDefined();
      // 报的是自己的 fair-share 余量（2），不是宽松的全局 remaining（18）——后者会误导。
      expect(data.send_budget!.messages_remaining).toBe(2);
      expect(data.send_budget!.loop_guard_enabled).toBe(true);
      expect(data.send_budget!.resets_on).toBe("human");
    } finally {
      await client.close();
    }
  }, 20000);

  test("guard 端点挂了不拖垮 party_who：presence 照常返回，只是没有 send_budget", async () => {
    guardStatus = 403;
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_who", arguments: {} });
      expect(r.isError).not.toBe(true);
      const data = r.structuredContent as { presence?: unknown[]; send_budget?: unknown };
      expect(Array.isArray(data.presence)).toBe(true);
      expect(data.send_budget).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 20000);
});
