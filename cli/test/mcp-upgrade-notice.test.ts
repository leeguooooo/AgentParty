// #588：party mcp 是长驻进程，磁盘/服务端升级后旧 server 必须能自知并给出可执行指引。
// 单测走 mcpUpgradeNotice 的 deps 注入（磁盘路径、零网络）；集成测走真 MCP stdio server +
// mock /api/version（服务端路径 + 节流）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpUpgradeNotice, resetServerVersionProbeForTest } from "../src/commands/mcp";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

describe("mcpUpgradeNotice 磁盘路径（deps 注入，零网络）", () => {
  test("磁盘二进制更新 → 短路返回 restart 指引，不打服务端", async () => {
    const notice = await mcpUpgradeNotice("http://127.0.0.1:9", {
      runningVersion: "0.2.100",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.101",
    });
    expect(notice).not.toBeNull();
    expect(notice!.installed_version).toBe("0.2.101");
    expect(notice!.running_version).toBe("0.2.100");
    // MCP 语境的关键话术：无需重装、无需重新注册、重启会话即可。
    expect(notice!.mcp_note).toContain("no reinstall needed");
    expect(notice!.mcp_note).toContain("re-registration is NOT needed");
    expect(notice!.mcp_note).toContain("Restart the harness session");
  });

  test("磁盘与运行版一致且服务端不可达 → null（静默，不因提示报错）", async () => {
    resetServerVersionProbeForTest();
    const notice = await mcpUpgradeNotice("http://127.0.0.1:9", {
      runningVersion: "0.2.100",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.100",
    });
    expect(notice).toBeNull();
  });
});

describe("party mcp 服务端版本路径（真 stdio server + mock /api/version）", () => {
  let home: string;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  let versionHits = 0;
  let serverVersion = "9.9.9";

  function startRest(): void {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        if (url.pathname === "/api/version") {
          versionHits += 1;
          return Response.json({
            version: serverVersion,
            commit: "deadbeef",
            deployed_at: null,
            min_client_version: "0.0.0",
            min_client_enforced: false,
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
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    return client;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-mcp-upgrade-"));
    versionHits = 0;
    serverVersion = "9.9.9";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    restServer?.stop(true);
    restServer = null;
  });

  test("服务端已发新版 → whoami 带 cli_upgrade + mcp_note；节流让两次调用只探测一次", async () => {
    startRest();
    const client = await connect();
    try {
      const r1 = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(r1.isError).not.toBe(true);
      const c1 = r1.structuredContent as { cli_version?: string; cli_upgrade?: Record<string, unknown> };
      expect(typeof c1.cli_version).toBe("string");
      expect(c1.cli_upgrade).toBeDefined();
      expect(c1.cli_upgrade!.available_version).toBe("9.9.9");
      expect(String(c1.cli_upgrade!.mcp_note)).toContain("restart the harness session");
      expect(String(c1.cli_upgrade!.mcp_note)).toContain("do NOT re-register");

      const r2 = await client.callTool({ name: "party_whoami", arguments: {} });
      expect((r2.structuredContent as { cli_upgrade?: unknown }).cli_upgrade).toBeDefined();
      // 10 分钟 TTL 内第二次 whoami 用缓存，不再打 /api/version。
      expect(versionHits).toBe(1);
    } finally {
      await client.close();
    }
  }, 20000);

  test("服务端版本不高于运行版 → 无 cli_upgrade", async () => {
    serverVersion = "0.0.1";
    startRest();
    const client = await connect();
    try {
      const r = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(r.isError).not.toBe(true);
      expect((r.structuredContent as { cli_upgrade?: unknown }).cli_upgrade).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 20000);
});
