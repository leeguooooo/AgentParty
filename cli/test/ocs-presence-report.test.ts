// #1113：serve / mcp 把本机 ocs 会话摘要上报给频道（网页 Presence「本机可介入」）。三块：
//  1. buildOcsReports：`ocs who --json` → 上报摘要（host_kind / session_key / same_project 排序）；
//  2. OcsRosterReporter：异步读取、失败不报、并发去重、stop 后不再发；
//  3. client.ts 白名单逐字镜像 OcsRosterFrame——删掉 case "ocs_roster" 或漏一个 harness/host_kind 本文件必须红。
//  另有 shared 契约（清洗、可见性裁剪）的用例：期望值写「cwd 不在裁剪视图里」，不抄实现。
//
// 变异自检（已手动做过，改回后全绿）：
//  · viewOcsSessions 的 full=false 分支也带 cwd → 「裁剪视图不含 cwd」红；
//  · client.ts 删 case "ocs_roster" → 白名单用例红；
//  · reporter 在 exec 失败时仍发空帧 → 「失败不报」红。
import { afterEach, describe, expect, test } from "bun:test";
import {
  OCS_HARNESSES,
  OCS_HOST_KINDS,
  isOcsRosterFrame,
  matchOcsPartyName,
  ocsDmCommand,
  parseOcsRosterClientFrame,
  viewOcsSessions,
  type OcsRosterClientFrame,
  type ServerFrame,
} from "@agentparty/shared";
import { buildOcsReports } from "../src/ocs-roster";
import { OcsRosterReporter, ocsReportDisabled, readOcsReports } from "../src/ocs-presence-report";
import { connect, type Connection } from "../src/client";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const CWD = "/work/proj";
const THREAD = "01a0a8f9-1111-2222-3333-444455556666";
const ENTRIES = [
  { kind: "claude", name: "other-7c", id: "claude-b4205d0a", pid: 10, status: "idle", cwd: "/work/other", self: false },
  {
    kind: "codex-task", target: "codex-01a0a8f9", threadId: THREAD, summary: "class-entry-welcome",
    cwd: CWD, self: false, livePid: 4242, tty: "ttys002", hostApp: "Orca",
  },
  { kind: "codex-task", target: "codex-desk", threadId: "t2", summary: "desk", cwd: "/x" },
  { kind: "pi", target: "pi-01a08f5e", sessionId: "01a08f5e-aaaa", name: null, pid: 77, cwd: CWD, self: true },
  { kind: "cmux", ref: "surface:1", title: "zsh" },
];

describe("buildOcsReports", () => {
  test("maps ocs entries to report rows, current project first, with host_kind and session_key", () => {
    const reports = buildOcsReports(ENTRIES, CWD);
    expect(reports.map((r) => r.addr)).toEqual(["codex-01a0a8f9", "pi-01a08f5e", "other-7c", "codex-desk"]);
    const codex = reports[0]!;
    expect(codex).toMatchObject({ harness: "codex", host_kind: "terminal", same_project: true, session_key: THREAD, cwd: CWD });
    expect(reports.find((r) => r.addr === "codex-desk")?.host_kind).toBe("desktop");
    expect(reports.find((r) => r.addr === "other-7c")).toMatchObject({ host_kind: "process", session_key: "b4205d0a", status: "idle" });
    expect(reports.find((r) => r.addr === "pi-01a08f5e")?.self).toBe(true);
    // 上报帧能过服务端同一套校验（CLI 产物 = 服务端输入）。
    const parsed = parseOcsRosterClientFrame({ type: "ocs_roster", sessions: reports });
    expect(parsed?.sessions.map((s) => s.addr)).toEqual(reports.map((r) => r.addr));
  });
});

describe("shared ocs-presence contract", () => {
  test("limited view never carries cwd/label/status or session_key; full view does (minus session_key)", () => {
    const [report] = buildOcsReports(ENTRIES, CWD);
    const limited = JSON.stringify(viewOcsSessions([report!], false));
    expect(limited).not.toContain(CWD);
    expect(limited).not.toContain("class-entry-welcome");
    expect(limited).not.toContain(THREAD);
    const full = JSON.stringify(viewOcsSessions([report!], true));
    expect(full).toContain(CWD);
    expect(full).not.toContain(THREAD);
  });

  test("sanitizes text fields and drops sessions with control characters in the address", () => {
    const parsed = parseOcsRosterClientFrame({
      type: "ocs_roster",
      sessions: [
        { addr: "ok-1", harness: "claude", label: "a[2Jb‮", cwd: "/p\nq", same_project: true, host_kind: "nope" },
        { addr: "x\ny", harness: "claude", same_project: false, host_kind: "process" },
        { addr: "ok-1", harness: "claude", same_project: false, host_kind: "process" },
        { addr: "ok-2", harness: "gpt", same_project: false, host_kind: "process" },
      ],
    });
    expect(parsed?.sessions).toEqual([
      { addr: "ok-1", harness: "claude", label: "a [2Jb", cwd: "/p q", same_project: true, host_kind: "unknown" },
    ]);
    expect(parseOcsRosterClientFrame({ type: "ocs_roster" })).toBeNull();
  });

  test("matchOcsPartyName and ocsDmCommand keep the CLI口径", () => {
    const presence = [{ name: "bot", agent_session: { harness: "codex", session_id: THREAD } }];
    expect(matchOcsPartyName("codex", THREAD, presence)).toBe("bot");
    expect(matchOcsPartyName("claude", THREAD, presence)).toBeUndefined();
    expect(ocsDmCommand("codex-1")).toBe('ocs dm codex-1 "…"');
    expect(ocsDmCommand("it's me")).toBe(`ocs dm 'it'\\''s me' "…"`);
  });
});

describe("OcsRosterReporter", () => {
  const okExec = async () => ({ ok: true, stdout: JSON.stringify({ entries: ENTRIES }) });

  test("reads asynchronously and sends one ocs_roster frame", async () => {
    const sent: OcsRosterClientFrame[] = [];
    const r = new OcsRosterReporter({ send: (f) => (sent.push(f), true), cwd: CWD, exec: okExec });
    await r.reportNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("ocs_roster");
    expect(sent[0]!.sessions[0]!.addr).toBe("codex-01a0a8f9");
  });

  test("does not report when ocs is missing/failing/unparseable, and never throws", async () => {
    const sent: OcsRosterClientFrame[] = [];
    for (const exec of [
      async () => ({ ok: false, stdout: "" }),
      async () => ({ ok: true, stdout: "not json" }),
      async () => { throw new Error("boom"); },
    ]) {
      const r = new OcsRosterReporter({ send: (f) => (sent.push(f), true), cwd: CWD, exec });
      await r.reportNow();
    }
    expect(sent).toEqual([]);
    expect(await readOcsReports({ cwd: CWD, exec: async () => ({ ok: true, stdout: "{}" }) })).toBeNull();
  });

  test("coalesces concurrent reads, ticks on the interval, and stops cleanly", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const exec = async () => {
      calls++;
      await gate;
      return okExec();
    };
    const sent: OcsRosterClientFrame[] = [];
    let tick: (() => void) | null = null;
    let cleared = false;
    const r = new OcsRosterReporter({
      send: (f) => (sent.push(f), true),
      cwd: CWD,
      exec,
      setInterval: (fn) => ((tick = fn), 1),
      clearInterval: () => { cleared = true; },
    });
    r.start();
    const a = r.reportNow();
    const b = r.reportNow();
    expect(calls).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(sent).toHaveLength(1);
    tick!();
    await r.reportNow();
    expect(sent).toHaveLength(2);
    r.stop();
    expect(cleared).toBe(true);
    await r.reportNow();
    expect(sent).toHaveLength(2);
  });

  test("AGENTPARTY_OCS_REPORT=0 disables reporting", () => {
    expect(ocsReportDisabled({ AGENTPARTY_OCS_REPORT: "0" })).toBe(true);
    expect(ocsReportDisabled({ AGENTPARTY_OCS_REPORT: "off" })).toBe(true);
    expect(ocsReportDisabled({})).toBe(false);
  });
});

let server: MockServer | null = null;
let conn: Connection | null = null;
afterEach(() => {
  conn?.close();
  conn = null;
  server?.stop();
  server = null;
});

async function collect(c: Connection, n: number, timeoutMs = 3000): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  const timer = setTimeout(() => c.close(), timeoutMs);
  for await (const f of c.frames) {
    frames.push(f);
    if (frames.length >= n) break;
  }
  clearTimeout(timer);
  return frames;
}

describe("client.ts 白名单镜像 ocs_roster（#1113 / #622）", () => {
  test("every harness / host_kind, limited and full views pass through unchanged", async () => {
    const good = OCS_HARNESSES.flatMap((harness) =>
      OCS_HOST_KINDS.map((host_kind, i) => ({
        type: "ocs_roster",
        name: "worker",
        sessions: [
          i % 2 === 0
            ? { addr: `${harness}-${i}`, harness, same_project: true, host_kind }
            : { addr: `${harness}-${i}`, harness, same_project: false, host_kind, self: true, party_name: "bot", cwd: i === 1 ? null : "/p", label: "l", status: "idle" },
        ],
        ts: 1,
        expires_at: 2,
        full: i % 2 === 1,
      })),
    );
    for (const f of good) expect(isOcsRosterFrame(f)).toBe(true);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        for (const f of good) sock.send(f);
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, good.length + 2);
    expect(frames.map((f) => f.type as string)).toEqual(["welcome", ...good.map(() => "ocs_roster"), "msg"]);
    expect(frames.slice(1, -1)).toEqual(good as unknown as ServerFrame[]);
  });

  test("malformed ocs_roster frames are dropped, later frames still arrive", async () => {
    const base = { type: "ocs_roster", name: "w", sessions: [], ts: 1, expires_at: 2, full: false };
    const s = { addr: "a", harness: "claude", same_project: false, host_kind: "process" };
    const bad = [
      { ...base, name: "" },
      { ...base, full: "yes" },
      { ...base, sessions: [{ ...s, harness: "gpt" }] },
      { ...base, sessions: [{ ...s, host_kind: "vm" }] },
      { ...base, sessions: [{ ...s, self: false }] },
      { ...base, sessions: [{ ...s, cwd: 3 }] },
    ];
    for (const f of bad) expect(isOcsRosterFrame(f)).toBe(false);
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        for (const f of bad) sock.send(f);
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, 2);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "msg"]);
  });
});
