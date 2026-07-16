// #503 MCP 侧：party_decision_ask 与 party_send attach 必须复用 CLI 的同一份业务核心
// （decision.ts askDecision / send.ts uploadAttachmentPaths），MCP 只做参数/输出适配。
// 这里验证 MCP 入口的载荷形状与状态映射（对照 CLI 路径 cli/test/send-attach.test.ts 与
// decision ask 的 runAsk 行为）。
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

// 每个用例可切换的服务端即时 resolution：pending（默认）或 auto_resolved（无人值守自动放行）。
let decisionResolution: Record<string, unknown> = { state: "pending" };

function startRest(): void {
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const isUpload = url.pathname === "/api/channels/dev/attachments";
      const body =
        req.method === "GET" ? null : isUpload ? await req.text() : await req.json().catch(() => null);
      seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/api/me") {
        return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
      }
      if (isUpload && req.method === "POST") {
        const filename = url.searchParams.get("filename") ?? "unknown";
        return Response.json(
          {
            key: `dev/sha256/${filename}`,
            filename,
            content_type: req.headers.get("content-type") ?? "application/octet-stream",
            size: (body as string).length,
            url: `/api/channels/dev/attachments/sha256/${filename}`,
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/api/channels/dev/messages" && req.method === "POST") {
        const frame = body as Record<string, unknown>;
        return Response.json({
          seq: 7,
          ...(frame.decision_request !== undefined
            ? { decision_request: frame.decision_request, decision_resolution: decisionResolution }
            : {}),
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

// 测试进程可能被 serve/runner 环境包着跑：剥掉 continuation 相关变量，
// 让「无 lineage」用例真的是无 lineage；需要 lineage 的用例用 extraEnv 显式注入。
const CONTINUATION_ENV = new Set([
  "AP_WORK_ID",
  "AP_CONTINUATION_REF",
  "AP_DELIVERY_ID",
  "AP_RUNNER_HARNESS",
  "AP_RUNNER_WORKDIR",
  "AP_RUNNER_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CODEX_THREAD_ID",
]);

async function connect(extraEnv: Record<string, string> = {}): Promise<Client> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "AGENTPARTY_CONFIG" && !CONTINUATION_ENV.has(k)) env[k] = v;
  }
  env.AGENTPARTY_HOME = home;
  Object.assign(env, extraEnv);
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", indexPath, "mcp", "--channel", "dev"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "agentparty-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function messagePosts(): { method: string; path: string; body: unknown }[] {
  return seen.filter((s) => s.method === "POST" && s.path === "/api/channels/dev/messages");
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.[0]?.text ?? "";
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-mcp-decision-"));
  seen.length = 0;
  decisionResolution = { state: "pending" };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

describe("mcp party_decision_ask（#503）", () => {
  // 无 --option 等价物：approval kind；无 runner 环境 → 不带 expected_decision_lineage；
  // 服务端 pending → state 映射为 pending，文本提示引导等人类而非轮询。
  test("approval kind: posts decision_request without lineage and maps pending", async () => {
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_decision_ask", arguments: { prompt: "ship v2?" } });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({ type: "decision", channel: "dev", seq: 7, state: "pending" });
      expect((r.structuredContent as { chosen_option?: string }).chosen_option).toBeUndefined();
      expect(firstText(r)).toContain("party_history");

      const posts = messagePosts();
      expect(posts.length).toBe(1);
      const body = posts[0]!.body as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: "message",
        body: "ship v2?", // body 缺省回落到 prompt
        reply_to: null,
        decision_request: { kind: "approval", prompt: "ship v2?" },
      });
      expect((body.decision_request as Record<string, unknown>).options).toBeUndefined();
      expect("expected_decision_lineage" in body).toBe(false);
    } finally {
      await client.close();
    }
  }, 20000);

  // 带 options → choice kind；custom runner 环境（AP_* 齐备）→ 请求体必须带
  // expected_decision_lineage；服务端 pending + 有 continuation → waiting_owner。
  test("choice kind with runner continuation: sends lineage and maps waiting_owner", async () => {
    startRest();
    const client = await connect({
      AP_RUNNER_HARNESS: "custom",
      AP_WORK_ID: "w-1",
      AP_CONTINUATION_REF: "ref-1",
      AP_DELIVERY_ID: "d-1",
    });
    try {
      const r = await client.callTool({
        name: "party_decision_ask",
        arguments: { prompt: "pick a plan", options: ["plan A", "plan B"], body: "details of both plans", mentions: ["leo"] },
      });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({ type: "decision", channel: "dev", seq: 7, state: "waiting_owner" });

      const body = messagePosts()[0]!.body as Record<string, unknown>;
      expect(body).toMatchObject({
        body: "details of both plans",
        mentions: ["leo"],
        decision_request: { kind: "choice", prompt: "pick a plan", options: ["plan A", "plan B"] },
        expected_decision_lineage: { delivery_id: "d-1", work_id: "w-1", continuation_ref: "ref-1" },
      });
    } finally {
      await client.close();
    }
  }, 20000);

  // 频道无人值守模式：服务端即时 auto_resolved → state/chosen_option 原样透出。
  test("maps auto_resolved with the chosen option", async () => {
    decisionResolution = { state: "auto_resolved", chosen_index: 0, chosen_option: "approve" };
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_decision_ask", arguments: { prompt: "ok to merge?" } });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({
        type: "decision",
        channel: "dev",
        seq: 7,
        state: "auto_resolved",
        chosen_option: "approve",
      });
    } finally {
      await client.close();
    }
  }, 20000);
});

describe("mcp party_send attach（#503）", () => {
  // attach 走 CLI 同一条 validate+read+upload 链路：先逐个上传拿引用，再发带 attachments 的消息；
  // 纯附件消息允许空正文（与 CLI/网页端一致，#176）。
  test("uploads local files then posts the message with attachment refs", async () => {
    startRest();
    const path = join(home, "note.txt");
    writeFileSync(path, "hello attach");
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_send", arguments: { attach: [path] } });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({
        type: "send",
        channel: "dev",
        seq: 7,
        attachments: [{ filename: "note.txt", size: 12 }],
      });

      const upload = seen.find((s) => s.method === "POST" && s.path.startsWith("/api/channels/dev/attachments"));
      expect(upload).toBeDefined();
      expect(upload!.path).toContain("filename=note.txt");
      expect(upload!.body).toBe("hello attach");

      const body = messagePosts()[0]!.body as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: "message",
        body: "",
        attachments: [{ filename: "note.txt", size: 12, key: "dev/sha256/note.txt" }],
      });
    } finally {
      await client.close();
    }
  }, 20000);

  // 本地校验失败（文件不存在）必须以 isError 结果透出、不发消息，而不是让服务器进程崩掉。
  test("attach validation failure surfaces as isError and posts nothing", async () => {
    startRest();
    const client = await connect();
    try {
      const missing = await client.callTool({
        name: "party_send",
        arguments: { body: "with a ghost file", attach: [join(home, "nope.txt")] },
      });
      expect(missing.isError).toBe(true);
      expect(firstText(missing)).toContain("file not found");

      // 空正文且无附件同样拒绝（镜像 CLI 的 missing body 语义）。
      const empty = await client.callTool({ name: "party_send", arguments: {} });
      expect(empty.isError).toBe(true);
      expect(firstText(empty)).toContain("missing message body");

      expect(messagePosts().length).toBe(0);
      expect(seen.some((s) => s.path.startsWith("/api/channels/dev/attachments"))).toBe(false);

      // 服务器进程还活着：后续正常 send 依然成功。
      const okSend = await client.callTool({ name: "party_send", arguments: { body: "still alive" } });
      expect(okSend.isError).not.toBe(true);
      expect(okSend.structuredContent).toMatchObject({ type: "send", channel: "dev", seq: 7 });
    } finally {
      await client.close();
    }
  }, 20000);
});
