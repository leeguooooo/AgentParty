// #1104：party who / party agents / MCP party_who 消费 `ocs who --json`，列本机可介入会话。
// 单测走 buildOcsRows / readOcsRoster 的注入；集成测真起 `party who` 子进程 + mock REST +
// 假 ocs 可执行文件（AGENTPARTY_OCS_BIN），证明命令层真的把 ocs 行接出来了。
//
// 变异自检（已手动做过，改回后全绿）：
//  · who.ts 里删掉 emitOcsJson / renderOcsSection 调用（=只剩 #1074 的频道聚合）→ 集成用例红；
//  · partyIdentityOf 恒返回 undefined → 「同一身份」用例红；
//  · rank 去掉 same_project 权重 → 排序用例红；
//  · renderOcsSection 去掉 sanitizeSingleLine → 清洗用例红。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresenceEntry } from "@agentparty/shared";
import { buildOcsRows, OCS_INSTALL_HINT, readOcsRoster, renderOcsSection } from "../src/ocs-roster";

const CWD = "/work/proj";
const THREAD = "01a0a8f9-1111-2222-3333-444455556666";

const ENTRIES = [
  { kind: "claude", name: "other-7c", id: "claude-b4205d0a", pid: 10, status: "idle", cwd: "/work/other", self: false },
  {
    kind: "codex-task", target: "codex-01a0a8f9", threadId: THREAD, summary: "class-entry-welcome",
    cwd: CWD, self: false, livePid: 4242, tty: "ttys002", hostApp: "Orca",
  },
  { kind: "pi", target: "pi-01a08f5e", sessionId: "01a08f5e-aaaa", name: null, pid: 77, cwd: CWD, self: true },
  { kind: "pi", target: "pi-01a0ad1a", sessionId: "01a0ad1a-bbbb", name: null, pid: 78, cwd: CWD, self: false },
  { kind: "cmux", ref: "surface:1", title: "zsh" },
];

function presence(name: string, harness: "codex" | "claude", session_id: string): PresenceEntry {
  return { name, kind: "agent", state: "online", ts: Date.now(), agent_session: { harness, session_id, updated_at: 0 } } as unknown as PresenceEntry;
}

describe("buildOcsRows", () => {
  test("每行都是 source=ocs + 可执行 ocs dm 介入命令；cmux 面板不列", () => {
    const rows = buildOcsRows(ENTRIES, { cwd: CWD });
    expect(rows.map((r) => r.addr).sort()).toEqual(["codex-01a0a8f9", "other-7c", "pi-01a08f5e", "pi-01a0ad1a"]);
    for (const r of rows) {
      expect(r.source).toBe("ocs");
      expect(r.intervene).toBe(`ocs dm ${r.addr} "…"`);
      expect(r.wake).toEqual(["ocs_dm"]);
      expect(r.mention).toBeUndefined();
    }
    const codex = rows.find((r) => r.harness === "codex")!;
    expect(codex.host).toBe("queue pid 4242 · Orca · ttys002");
    expect(codex.same_project).toBe(true);
  });

  test("排序：当前项目在前，别的 cwd 在后；self 标出并沉到同组末尾", () => {
    const rows = buildOcsRows(ENTRIES, { cwd: CWD });
    expect(rows.at(-1)!.addr).toBe("other-7c");
    const sameProject = rows.filter((r) => r.same_project);
    expect(sameProject).toHaveLength(3);
    expect(sameProject.at(-1)!.addr).toBe("pi-01a08f5e");
    expect(sameProject.at(-1)!.self).toBe(true);
    expect(rows.filter((r) => r.self)).toHaveLength(1);
  });

  test("同一身份既在频道又在 ocs：一行，wake 含 party_mention，mention 用频道名而不是 ocs 短 id", () => {
    const rows = buildOcsRows(ENTRIES, {
      cwd: CWD,
      channel: "dev",
      presence: [presence("leipeng-cx", "codex", THREAD), presence("cc-main", "claude", "b4205d0a-9999-0000")],
    });
    expect(rows).toHaveLength(4);
    const codex = rows.find((r) => r.addr === "codex-01a0a8f9")!;
    expect(codex.party_name).toBe("leipeng-cx");
    expect(codex.wake).toEqual(["ocs_dm", "party_mention"]);
    expect(codex.mention).toBe('party send "@leipeng-cx …" --mention leipeng-cx --channel dev');
    expect(codex.mention).not.toContain("codex-01a0a8f9");
    // 可唤醒的排在当前项目最前
    expect(rows[0]!.addr).toBe("codex-01a0a8f9");
    expect(rows.find((r) => r.addr === "other-7c")!.party_name).toBe("cc-main");
  });
});

describe("readOcsRoster 降级", () => {
  test("ocs 不在 PATH → missing + 一行修法，不抛", () => {
    const r = readOcsRoster({ exec: () => ({ missing: true, status: null, stdout: "" }) });
    expect(r.status).toBe("missing");
    expect(renderOcsSection(r)).toEqual([OCS_INSTALL_HINT]);
  });

  test("ocs 退出非 0 / 输出坏掉 → error 提示 ocs doctor，不抛", () => {
    const bad = readOcsRoster({ exec: () => ({ missing: false, status: 1, stdout: "" }) });
    expect(bad.status).toBe("error");
    const garbled = readOcsRoster({ exec: () => ({ missing: false, status: 0, stdout: "not json" }) });
    expect(garbled.status).toBe("error");
    expect(renderOcsSection(garbled)[0]).toContain("ocs doctor");
  });

  test("真 spawn：AGENTPARTY_OCS_BIN 指向不存在的文件 = missing", () => {
    const prev = process.env.AGENTPARTY_OCS_BIN;
    process.env.AGENTPARTY_OCS_BIN = "/nonexistent/ocs-" + Date.now();
    try {
      expect(readOcsRoster({}).status).toBe("missing");
    } finally {
      if (prev === undefined) delete process.env.AGENTPARTY_OCS_BIN;
      else process.env.AGENTPARTY_OCS_BIN = prev;
    }
  });
});

describe("renderOcsSection 清洗", () => {
  test("地址/标签里的控制序列被剥掉，换行不会拆出伪造行", () => {
    const rows = buildOcsRows(
      [{ kind: "pi", target: "pi-evil[31m", sessionId: "x", name: "a\nFAKE ROW", pid: 1, cwd: CWD, self: false }],
      { cwd: CWD },
    );
    const lines = renderOcsSection({ status: "ok", rows });
    for (const line of lines) {
      expect(line).not.toContain("");
      expect(line).not.toContain("\n");
    }
    expect(lines).toHaveLength(3);
  });
});

describe("party who 集成（子进程 + mock REST + 假 ocs）", () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  const indexPath = join(import.meta.dir, "..", "src", "index.ts");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-ocs-who-"));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/presence") {
          return Response.json({ presence: [{ ...presence("leipeng-cx", "codex", THREAD), last_seen: Date.now() }] });
        }
        return Response.json({ error: { code: "not_found", message: "nf" } }, { status: 404 });
      },
    });
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${server.port}`, token: "ap_tok" }));
  });

  afterEach(() => {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  // 必须异步 spawn：spawnSync 会卡死本进程的事件循环，mock REST 就答不了子进程。
  async function runWho(args: string[], ocsBin: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "AGENTPARTY_CONFIG") env[k] = v;
    env.AGENTPARTY_HOME = home;
    env.AGENTPARTY_OCS_BIN = ocsBin;
    env.AGENTPARTY_NO_AUTO_UPGRADE = "1";
    const proc = Bun.spawn(["bun", "run", indexPath, "who", "--channel", "dev", ...args], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }

  test("--json 出现 source=ocs 行，intervene 是 ocs dm；频道身份合并成 party_mention", async () => {
    const fake = join(home, "ocs");
    writeFileSync(fake, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ entries: ENTRIES })}\nEOF\n`);
    chmodSync(fake, 0o755);
    const { stdout, code } = await runWho(["--json"], fake);
    expect(code).toBe(0);
    const rows = stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.some((r) => r.name === "leipeng-cx")).toBe(true); // 频道行仍在
    const ocs = rows.filter((r) => r.source === "ocs");
    expect(ocs).toHaveLength(4);
    const codex = ocs.find((r) => r.addr === "codex-01a0a8f9")!;
    expect(codex.intervene).toBe('ocs dm codex-01a0a8f9 "…"');
    expect(codex.wake).toEqual(["ocs_dm", "party_mention"]);
  }, 30_000);

  test("ocs 缺席：频道行照常、ocs 组缺席、一行修法、退出 0", async () => {
    const { stdout, code } = await runWho([], join(home, "no-such-ocs"));
    expect(code).toBe(0);
    expect(stdout).toContain("leipeng-cx");
    expect(stdout).toContain(OCS_INSTALL_HINT);
    expect(stdout).not.toContain("local agents (ocs) —");
  }, 30_000);
});
