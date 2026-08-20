// #859 / #860：`party ack` 只写本地文件，碰不到服务端的 @ 投递账本（pending_mention_seqs）。
// 这里守住三件事：(1) 文案不再教人用 ack 去清服务端账本；(2) ack 全程不联网，物理上不可能清它；
// (3) `ack <seq>` / 重复 `--seq` 不再静默 no-op / 静默丢参数。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresenceEntry } from "@agentparty/shared";
import { NUMERIC_POSITIONAL_ERROR, REPEATED_SEQ_ERROR, run as runAck } from "../src/commands/ack";
import { ONCE_REARM_ADVISORY } from "../src/commands/watch";
import { classify, HELP_TEXT as WHO_HELP } from "../src/commands/who";
import { loadStuck, saveWatchStuck } from "../src/config";

let home: string;
let cwd: string;
let originalCwd: string;
const oldEnv: Record<string, string | undefined> = {};

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  return {
    lines,
    restore: () => {
      console.log = log;
      console.error = err;
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-ack-ledger-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-ack-ledger-cwd-"));
  for (const key of ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_CHANNEL"]) {
    oldEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTPARTY_HOME = home;
  originalCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const watchDebt = (seq: number) => ({ seq, wake_ts: 1, attempts: 1, source: "watch" as const });

describe("#859 两本账不能混为一谈", () => {
  test("ack --help 明说本地账本，且不谎称能清 pending_mention_seqs", async () => {
    const cap = capture();
    expect(await runAck(["--help"])).toBe(0);
    cap.restore();
    const help = cap.lines.join("\n");
    expect(help).toContain("pending_mention_seqs");
    expect(help).toMatch(/LOCAL ONLY/);
    expect(help).toContain("--reply-to");
    // 不能出现「用 ack 清 pending_mention_seqs」这类同句并列。
    expect(help).toMatch(/does NOT clear|can never change it/);
  });

  test("watch --once 的重挂提示不再把 ack 说成清 pending_mention_seqs 的手段", () => {
    expect(ONCE_REARM_ADVISORY).toContain("pending_mention_seqs");
    expect(ONCE_REARM_ADVISORY).toMatch(/SERVER's ledger and only a reply settles it/);
    expect(ONCE_REARM_ADVISORY).toContain("--reply-to N");
  });

  test("who --help 不再把 ack 列为清 unhandled @ 的手段", () => {
    expect(WHO_HELP).toContain("pending_mention_seqs");
    expect(WHO_HELP).toContain("--reply-to S1,S2");
    expect(WHO_HELP).toMatch(/"party ack" does NOT clear it/);
  });

  test("端到端：ack 清掉本地债，但全程零网络请求——服务端账本不可能被它改动", async () => {
    expect(saveWatchStuck("dev", watchDebt(1841))).toBe(true);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (...args: unknown[]) => {
      calls++;
      throw new Error(`party ack must not talk to the server: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    try {
      const cap = capture();
      expect(await runAck(["--channel", "dev", "--seq", "1841"])).toBe(0);
      cap.restore();
    } finally {
      globalThis.fetch = realFetch;
    }
    // 本地债清了……
    expect(loadStuck("dev")).toBeNull();
    // ……服务端那本一次都没被访问过：所以「按提示 ack 后 pending_mention_seqs 会变」在物理上不成立，
    // 提示只能指向真正有效的操作（--reply-to）。
    expect(calls).toBe(0);
  });
});

describe("#860 参数缺陷", () => {
  test("① ack <seq> 不再静默 no-op：非零退出并指向 --seq", async () => {
    expect(saveWatchStuck("dev", watchDebt(1841))).toBe(true);
    process.env.AGENTPARTY_CHANNEL = "dev";
    const cap = capture();
    const code = await runAck(["1841"]);
    cap.restore();
    delete process.env.AGENTPARTY_CHANNEL;
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toBe(NUMERIC_POSITIONAL_ERROR);
    // 债一条都没动。
    expect(loadStuck("dev")?.seq).toBe(1841);
  });

  test("① 正常频道位置参数仍然工作", async () => {
    expect(saveWatchStuck("dev", watchDebt(19))).toBe(true);
    expect(await runAck(["dev"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
  });

  test("② 重复 --seq 报错，不再静默丢弃第一个", async () => {
    expect(saveWatchStuck("dev", watchDebt(5))).toBe(true);
    const cap = capture();
    const code = await runAck(["--channel", "dev", "--seq", "5", "--seq", "7"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toBe(REPEATED_SEQ_ERROR);
    expect(loadStuck("dev")?.seq).toBe(5);
  });

  test("② 单个 --seq 不受影响", async () => {
    expect(saveWatchStuck("dev", watchDebt(5))).toBe(true);
    expect(await runAck(["--channel", "dev", "--seq", "5"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
  });
});

describe("#859 附：who --json 不再丢掉服务端下发的 live / residency", () => {
  const NOW = 1_000_000_000;
  const p = (over: Partial<PresenceEntry> & { name: string }): PresenceEntry => ({
    state: "waiting",
    note: null,
    ts: NOW,
    last_seen: NOW,
    kind: "agent",
    ...over,
  });

  test("live=true / residency 原样投影", () => {
    const row = classify(p({ name: "bot", live: true, residency: "supervised" }), NOW);
    expect(row?.live).toBe(true);
    expect(row?.residency).toBe("supervised");
  });

  test("服务端没给就省略，不无中生有", () => {
    const row = classify(p({ name: "bot" }), NOW);
    expect(row?.live).toBeUndefined();
    expect(row?.residency).toBeUndefined();
  });
});
