// #834 第 5 项：turn-based harness 的清账体验。
//
// CLI 上 `party ack --all/--through/--before/--no-reply` 早就有了，但 agent 大多**只有 MCP**，
// 而 party_ack 的入参一直只有 {channel, seq}：深积压只能一条一条 ack，服务端那本账根本够不到。
// 更糟的是 seq 不匹配时它回的错误直接叫人去跑 `party ack --through` —— 一个 MCP-only 的调用方
// 敲不了 CLI，这条提示等于把人指到墙上。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_REPLY_REQUIRES_SEQ_ERROR } from "../src/commands/ack";
import { MCP_NO_REPLY_REQUIRES_SEQ_ERROR } from "../src/commands/mcp";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

interface ToolResult {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}

describe("party_ack 的 MCP/CLI 对等（#834 第 5 项）", () => {
  let home: string;
  let rest: ReturnType<typeof Bun.serve> | null = null;
  let acked: string[] = [];
  const clients: Client[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-mcp-ack-"));
    acked = [];
    rest = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "alice", email: null, kind: "agent", role: "member", owner: null });
        }
        // party ack --all / all:true 用它探频道 head。
        if (url.pathname.endsWith("/messages")) {
          return Response.json({ messages: [{ seq: 77 }] });
        }
        const ack = url.pathname.match(/\/deliveries\/([^/]+)\/ack$/);
        if (ack !== null && req.method === "POST") {
          acked.push(ack[1]!);
          return Response.json({ ok: true, delivery: { id: "d1", state: "acknowledged" } });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${rest.port}`, token: "ap_tok" }),
    );
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
    rest?.stop(true);
    rest = null;
  });

  async function connect(): Promise<Client> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
    }
    env.AGENTPARTY_HOME = home;
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  test("批量排空真的落盘：through=42 之后 through=10 不会把游标退回去", async () => {
    const client = await connect();
    const first = (await client.callTool({ name: "party_ack", arguments: { through: 42 } })) as ToolResult;
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ drained: true, cursor: 42, cleared_seq: null });

    // 第二次刻意传一个更小的 through。若第一次只是把入参回显出来（没真写），这里会得到 10。
    const second = (await client.callTool({ name: "party_ack", arguments: { through: 10 } })) as ToolResult;
    expect(second.structuredContent).toMatchObject({ drained: true, cursor: 42 });
  }, 30_000);

  test("all:true 走服务端 head，不再需要调用方自己知道 head 在哪", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "party_ack", arguments: { all: true } })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ drained: true, cursor: 77 });
  }, 30_000);

  test("before:N 排空严格早于 N 的部分（游标停在 N-1，不吞掉 N 本身）", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "party_ack", arguments: { before: 20 } })) as ToolResult;
    expect(result.structuredContent).toMatchObject({ drained: true, cursor: 19 });
  }, 30_000);

  test("no_reply 结清服务端那本账，并如实报告 server_settled", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "party_ack", arguments: { seq: 7, no_reply: true } })) as ToolResult;
    expect(result.isError).toBeFalsy();
    // 真的打到了服务端 delivery ack 端点——不是只动了本地那本账。
    expect(acked).toEqual(["7"]);
    expect(result.structuredContent).toMatchObject({ server_settled: true });
  }, 30_000);

  test("party_receipt no_reply 复用同一终态，不写 receipt 消息元数据", async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: "party_receipt",
      arguments: { seq: 8, reason: "seen", no_reply: true },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(acked).toEqual(["8"]);
    expect(result.structuredContent).toMatchObject({
      type: "delivery_ack",
      terminal_reason: "acknowledged_no_reply",
      message_created: false,
    });
  }, 30_000);

  test("no_reply 不带 seq 被拒，且错误只提 MCP 参数名、不把 CLI 旗标甩给够不到 CLI 的调用方", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "party_ack", arguments: { no_reply: true } })) as ToolResult;
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain(MCP_NO_REPLY_REQUIRES_SEQ_ERROR);
    expect(text).not.toContain("--seq");
    expect(text).not.toContain("--through");
    // 服务端一次都没被打——参数校验必须在网络调用之前。
    expect(acked).toEqual([]);
  }, 30_000);

  test("选择器互斥：through 与 seq 同时给出直接拒绝，不猜意图", async () => {
    const client = await connect();
    const result = (await client.callTool({ name: "party_ack", arguments: { seq: 3, through: 9 } })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("mutually exclusive");
    expect(acked).toEqual([]);
  }, 30_000);

  test("工具 schema 暴露四个新参数——够不到的能力等于不存在", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const ack = tools.tools.find((tool) => tool.name === "party_ack");
    const receipt = tools.tools.find((tool) => tool.name === "party_receipt");
    expect(ack).toBeDefined();
    const props = Object.keys((ack!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props).toContain("through");
    expect(props).toContain("all");
    expect(props).toContain("before");
    expect(props).toContain("no_reply");
    expect(Object.keys((receipt!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}))
      .toContain("no_reply");
  }, 30_000);

  test("两套措辞各说各的操作面，不互相串旗标", () => {
    expect(NO_REPLY_REQUIRES_SEQ_ERROR).toContain("--seq");
    expect(MCP_NO_REPLY_REQUIRES_SEQ_ERROR).not.toContain("--");
    expect(MCP_NO_REPLY_REQUIRES_SEQ_ERROR).toContain("no_reply");
  });
});
