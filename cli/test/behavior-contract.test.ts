// #845 层 1+3：行为契约的持久化——MCP 工具描述（每轮必达）与 charter 输出头部（唤醒补针）
// 都必须携带 shared 的同一份契约文本，杜绝各处复刻漂移。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEHAVIOR_CONTRACT_BODY_LINES, BEHAVIOR_CONTRACT_SUMMARY } from "@agentparty/shared/onboarding";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

describe("行为契约常量（shared 单一来源）", () => {
  test("单行版非空且无换行（要进工具描述/输出头部）", () => {
    expect(BEHAVIOR_CONTRACT_SUMMARY.length).toBeGreaterThan(0);
    expect(BEHAVIOR_CONTRACT_SUMMARY).not.toContain("\n");
    // 契约四要点齐全
    expect(BEHAVIOR_CONTRACT_SUMMARY).toContain("reply_to");
    expect(BEHAVIOR_CONTRACT_SUMMARY).toContain("waiting");
    expect(BEHAVIOR_CONTRACT_SUMMARY).toContain("唯一数据源");
    // #886：结果只发一次，别再发一条复述它的消息（回声汇报会把读者多唤醒一次）
    expect(BEHAVIOR_CONTRACT_SUMMARY).toContain("结果发一次，别再发一条复述它的消息。");
  });

  test("多行版非空、含重读指引、不含控制字节", () => {
    expect(BEHAVIOR_CONTRACT_BODY_LINES.length).toBeGreaterThan(0);
    const joined = BEHAVIOR_CONTRACT_BODY_LINES.join("\n");
    expect(joined).toContain("重读本文件");
    expect(joined).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
    // heredoc delimiter 不许出现在正文里，否则落盘会提前截断
    expect(joined).not.toContain("AGENTPARTY_RULES_EOF");
  });
});

describe("行为契约进 MCP 工具描述与 charter 输出（#845）", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-behavior-contract-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/charter" && req.method === "GET") {
          return Response.json({ charter: "Scope: dev things.", charter_rev: 3, updated_at: null, updated_by: null });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
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

  test("party_send / party_watch_once / party_status 的 description 含契约单行版", async () => {
    startRest();
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
    try {
      const tools = await client.listTools();
      for (const name of ["party_send", "party_watch_once", "party_status"]) {
        const tool = tools.tools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect(tool?.description ?? "").toContain(BEHAVIOR_CONTRACT_SUMMARY);
      }
    } finally {
      await client.close();
    }
  });

  test("party charter 文本输出头部固定带一行契约摘要", async () => {
    startRest();
    const { run } = await import("../src/commands/charter");
    const prevHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      const code = await run(["dev"]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
      if (prevHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = prevHome;
    }
    expect(lines[0]).toBe(`# ${BEHAVIOR_CONTRACT_SUMMARY}`);
    expect(lines.join("\n")).toContain("Scope: dev things.");
  });
});
