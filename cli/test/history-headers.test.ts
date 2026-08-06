// #819：agent 每轮都要重建频道上下文，而 history 只能拉完整正文。技术频道里单条 2000-4000 字符
// 是常态，一次 --limit 10 就是两三万字符进上下文，其中九成上一轮已经读过。轻量视图要能回答
// 「有没有新的 / 谁发的 / 大概讲什么」，再按 seq 精确展开——省的是 agent 还能在频道里待多久。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run } from "../src/commands/history";
import { DEFAULT_HEADER_PREVIEW, msgHeader } from "../src/format";
import type { MsgFrame } from "@agentparty/shared";

let home: string;
let oldHome: string | undefined;
let restServer: ReturnType<typeof Bun.serve> | null = null;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];
let stderr: string[] = [];

const LONG_BODY = "SELECT * FROM messages WHERE seq > 400;\n".repeat(120); // ~4.7k 字符，贴 SQL 的典型长度

function msg(over: Partial<MsgFrame> & { seq: number }): MsgFrame {
  return {
    type: "msg",
    channel: "dev",
    ts: 1_700_000_000_000 + over.seq,
    kind: "message",
    sender: { name: "peer-agent", kind: "agent" },
    body: "",
    mentions: [],
    reply_to: null,
    ...over,
  } as unknown as MsgFrame;
}

const FIXTURE: MsgFrame[] = [
  msg({ seq: 436, body: LONG_BODY, mentions: ["leo"], reply_to: 430 }),
  msg({ seq: 437, kind: "status", body: "", note: "working on the migration", state: "working" } as never),
  msg({ seq: 438, body: "短消息", sender: { name: "leo", kind: "human" } } as never),
];

function serveFixture(messages: MsgFrame[] = FIXTURE): void {
  globalThis.fetch = (async () => Response.json({ messages })) as unknown as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-history-headers-"));
  oldHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: "https://ap.test", token: "ap_tok" }));
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = oldHome;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  restServer?.stop(true);
  restServer = null;
});

describe("msgHeader 纯函数", () => {
  test("长正文被截到 preview 长度，但 chars 报的是完整长度（agent 据此判断值不值得展开）", () => {
    const h = msgHeader(FIXTURE[0], 40);
    expect(h.chars).toBe(LONG_BODY.length);
    expect(h.preview.length).toBe(40);
    expect(h.truncated).toBe(true);
    expect(h.seq).toBe(436);
    expect(h.mentions).toEqual(["leo"]);
    expect(h.reply_to).toBe(430);
  });

  test("preview 折叠换行，一条 header 恒占一行（否则 headers 模式的省字符会被多行吃掉）", () => {
    expect(msgHeader(FIXTURE[0], 200).preview).not.toContain("\n");
  });

  test("status 帧取 note 而不是空 body", () => {
    const h = msgHeader(FIXTURE[1], DEFAULT_HEADER_PREVIEW);
    expect(h.kind).toBe("status");
    expect(h.state).toBe("working");
    expect(h.preview).toContain("working on the migration");
  });

  test("短消息不标 truncated，preview 就是全文", () => {
    const h = msgHeader(FIXTURE[2], DEFAULT_HEADER_PREVIEW);
    expect(h.truncated).toBe(false);
    expect(h.preview).toBe("短消息");
  });

  test("preview_chars=0 → 只剩元数据，一个字正文都不带", () => {
    const h = msgHeader(FIXTURE[0], 0);
    expect(h.preview).toBe("");
    expect(h.truncated).toBe(true);
    expect(h.chars).toBe(LONG_BODY.length);
  });
});

describe("party history --headers", () => {
  test("输出一条一行，且总量远小于全文模式（这就是这个 issue 的全部意义）", async () => {
    serveFixture();
    expect(await run(["dev", "--headers"])).toBe(0);
    const headers = stdout.join("\n");
    expect(stdout.length).toBe(3);
    expect(headers).toContain("[436]");
    expect(headers).toContain("@leo");
    expect(headers).toContain("↩#430");

    stdout = [];
    serveFixture();
    expect(await run(["dev"])).toBe(0);
    const full = stdout.join("\n");
    expect(full.length).toBeGreaterThan(LONG_BODY.length);
    // 4.7k 的长消息压成 120 字符预览，整体至少省一个数量级。
    expect(headers.length).toBeLessThan(full.length / 10);
  });

  test("--exclude-status 丢掉状态帧", async () => {
    serveFixture();
    expect(await run(["dev", "--headers", "--exclude-status"])).toBe(0);
    expect(stdout.length).toBe(2);
    expect(stdout.join("\n")).not.toContain("[437]");
  });

  test("--headers --json → 每行一个 header 对象，供工具消费", async () => {
    serveFixture();
    expect(await run(["dev", "--headers", "--json", "--preview", "10"])).toBe(0);
    const first = JSON.parse(stdout[0]) as Record<string, unknown>;
    expect(first.seq).toBe(436);
    expect(first.chars).toBe(LONG_BODY.length);
    expect(String(first.preview).length).toBe(10);
  });

  test("--seq N 精确取全文：header 挑出来的那条能展开", async () => {
    serveFixture([FIXTURE[0]]);
    expect(await run(["dev", "--seq", "436"])).toBe(0);
    expect(stdout.join("\n")).toContain("SELECT * FROM messages");
  });

  test("--seq 指向不存在的消息 → 明确报错，不静默返回空", async () => {
    serveFixture([]);
    expect(await run(["dev", "--seq", "999"])).toBe(1);
    expect(stderr.join("\n")).toContain("no message 999");
  });

  test("--seq 与 --since 互斥；--preview 不配 --headers 时报错", async () => {
    expect(await run(["dev", "--seq", "5", "--since", "1"])).toBe(1);
    expect(stderr.join("\n")).toContain("exclusive");
    stderr = [];
    expect(await run(["dev", "--preview", "10"])).toBe(1);
    expect(stderr.join("\n")).toContain("--preview only applies to --headers");
  });

  test("默认（无 --headers）行为不变：仍打全文", async () => {
    serveFixture();
    expect(await run(["dev"])).toBe(0);
    expect(stdout.join("\n")).toContain("SELECT * FROM messages");
  });
});

describe("party_history（MCP）mode='headers'", () => {
  async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages") return Response.json({ messages: FIXTURE });
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", join(import.meta.dir, "..", "src", "index.ts"), "mcp", "--channel", "dev"],
      env: { ...process.env, AGENTPARTY_HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      await fn(client);
    } finally {
      await client.close();
    }
  }

  test("headers 模式返回 headers 数组而非完整 messages，并说明怎么展开", async () => {
    await withClient(async (client) => {
      const r = await client.callTool({ name: "party_history", arguments: { mode: "headers", preview_chars: 30 } });
      expect(r.isError).not.toBe(true);
      const data = r.structuredContent as { mode?: string; headers?: Record<string, unknown>[]; messages?: unknown; expand_with?: string };
      expect(data.mode).toBe("headers");
      expect(data.messages).toBeUndefined();
      expect(data.headers).toHaveLength(3);
      expect(data.headers![0].chars).toBe(LONG_BODY.length);
      expect(String(data.headers![0].preview).length).toBe(30);
      // 不写清怎么取全文，headers 会被当成「history 坏了」。
      expect(data.expand_with).toContain("seq");
      // 整个响应不该带上任何一份完整长正文。
      expect(JSON.stringify(data).length).toBeLessThan(LONG_BODY.length);
    });
  }, 20_000);

  test("默认仍是 full，老调用方零感知", async () => {
    await withClient(async (client) => {
      const r = await client.callTool({ name: "party_history", arguments: {} });
      const data = r.structuredContent as { mode?: string; messages?: unknown[]; headers?: unknown };
      expect(data.mode).toBe("full");
      expect(data.headers).toBeUndefined();
      expect(data.messages).toHaveLength(3);
    });
  }, 20_000);

  test("exclude_status 生效；seq 与 headers 冲突时明确拒绝", async () => {
    await withClient(async (client) => {
      const r = await client.callTool({ name: "party_history", arguments: { mode: "headers", exclude_status: true } });
      expect((r.structuredContent as { headers: unknown[] }).headers).toHaveLength(2);

      const bad = await client.callTool({ name: "party_history", arguments: { seq: 436, mode: "headers" } });
      expect(bad.isError).toBe(true);
    });
  }, 20_000);
});
