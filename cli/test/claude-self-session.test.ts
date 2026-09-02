import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inbox-inject";
import {
  SELF_CLAUDE_SESSION_MAX_HOPS,
  findSelfClaudeSession,
  resetSelfClaudeSessionCache,
  selfClaudeSessionFromEnv,
  walkToSelfClaudeSession,
} from "../src/claude-self-session";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-self-claude-"));
  env = { [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: dir, CLAUDECODE: "1" };
  resetSelfClaudeSessionCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetSelfClaudeSessionCache();
});

function writeNativeSession(pid: number, fields: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: SESSION_ID,
      name: "agentparty-83",
      messagingSocketPath: join(dir, `${pid}.sock`),
      ...fields,
    }),
    { mode: 0o600 },
  );
}

/** 假 `ps -o ppid= -p <pid>`：按给定的 pid→ppid 表作答；不在表里 ⇒ 非 0 退出。 */
function fakePs(tree: Record<number, number>, calls: number[] = []) {
  return ((_cmd: string, args: readonly string[]) => {
    const pid = Number(args[args.length - 1]);
    calls.push(pid);
    const parent = tree[pid];
    if (parent === undefined) return { status: 1, stdout: "", stderr: "" };
    return { status: 0, stdout: `${parent}\n`, stderr: "" };
  }) as unknown as typeof import("node:child_process").spawnSync;
}

describe("walkToSelfClaudeSession (#1052 #2)", () => {
  test("walks past the intermediate shell to the first ancestor with a native sessions file", () => {
    // party(100) → zsh(200) → claude(process.pid) → launchd(1)
    writeNativeSession(process.pid);
    const calls: number[] = [];
    const found = walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs({ 100: 200, 200: process.pid, [process.pid]: 1 }, calls) });
    expect(found).toEqual({ pid: process.pid, sessionId: SESSION_ID, name: "agentparty-83", hops: 2 });
    // 第一跳（ppid）没有寻址文件，必须继续往上走——只看 process.ppid 是错的。
    expect(calls).toEqual([100, 200]);
  });

  test("returns null at the root, on ps failure, and beyond the hop budget", () => {
    writeNativeSession(process.pid);
    expect(walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs({ 100: 200, 200: 1 }) })).toBeNull();
    expect(walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs({}) })).toBeNull();
    // 宿主在第 11 层：超出预算 ⇒ null（绝不无限往上爬）。
    const tree: Record<number, number> = {};
    let pid = 100;
    for (let hop = 1; hop <= SELF_CLAUDE_SESSION_MAX_HOPS; hop += 1) {
      tree[pid] = pid + 1;
      pid += 1;
    }
    tree[pid] = process.pid;
    expect(walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs(tree) })).toBeNull();
    expect(walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs(tree), maxHops: SELF_CLAUDE_SESSION_MAX_HOPS + 1 })?.pid).toBe(process.pid);
  });

  test("does not spawn ps at all when no native sessions file exists or outside a Claude process tree", () => {
    const calls: number[] = [];
    expect(walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs({ 100: process.pid }, calls) })).toBeNull();
    expect(calls).toEqual([]);
    writeNativeSession(process.pid);
    // 没有 CLAUDECODE 标记＝终端 / serve runner：不爬。
    expect(walkToSelfClaudeSession({ env: { ...env, CLAUDECODE: undefined }, startPid: 100, spawn: fakePs({ 100: process.pid }, calls) })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a malformed sessions file on the ancestor yields null instead of guessing further up", () => {
    // 文件名 pid 与内容 pid 不符 → 坏文件；祖父有好文件也不该被认领（那是别的会话）。
    writeNativeSession(200, { pid: 201 });
    writeNativeSession(300);
    expect(walkToSelfClaudeSession({ env, startPid: 100, spawn: fakePs({ 100: 200, 200: 300, 300: 1 }) })).toBeNull();
  });

  test("findSelfClaudeSession caches per process and never throws", () => {
    writeNativeSession(process.pid);
    const calls: number[] = [];
    const spawn = fakePs({ 100: process.pid, [process.pid]: 1 }, calls);
    expect(findSelfClaudeSession({ env, startPid: 100, spawn })?.pid).toBe(process.pid);
    expect(findSelfClaudeSession({ env, startPid: 100, spawn })?.pid).toBe(process.pid);
    expect(calls).toEqual([100]);
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof import("node:child_process").spawnSync;
    resetSelfClaudeSessionCache();
    expect(findSelfClaudeSession({ env, startPid: 100, spawn: throwing })).toBeNull();
  });

  test("env fast path: complete and consistent CLAUDE_CODE_* variables resolve the host with zero ps spawns", () => {
    writeNativeSession(process.pid);
    const calls: number[] = [];
    const envWithVars = {
      ...env,
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
      CLAUDE_CODE_MESSAGING_SOCKET: join(dir, `${process.pid}.sock`),
    };
    expect(selfClaudeSessionFromEnv(envWithVars)).toEqual({ pid: process.pid, sessionId: SESSION_ID, name: "agentparty-83", hops: 0 });
    // 走 findSelfClaudeSession：ps 桩绝不能被问到（哪怕它能答）。
    expect(findSelfClaudeSession({ env: envWithVars, startPid: 100, spawn: fakePs({ 100: process.pid }, calls) })?.hops).toBe(0);
    expect(calls).toEqual([]);
  });

  test("env fast path: a stale or inconsistent environment is ignored and the ps walk answers instead", () => {
    writeNativeSession(process.pid);
    const socket = join(dir, `${process.pid}.sock`);
    // sessionId 不一致（/clear 换会话、继承来的旧环境）。
    expect(selfClaudeSessionFromEnv({ ...env, CLAUDE_CODE_SESSION_ID: "22222222-2222-4222-8222-222222222222", CLAUDE_CODE_MESSAGING_SOCKET: socket })).toBeNull();
    // socket 路径不一致。
    expect(selfClaudeSessionFromEnv({ ...env, CLAUDE_CODE_SESSION_ID: SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET: join(dir, `${process.pid}.other.sock`) })).toBeNull();
    // socket 文件名不是 <pid>.sock / 相对路径 / 变量缺一个。
    expect(selfClaudeSessionFromEnv({ ...env, CLAUDE_CODE_SESSION_ID: SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/x.sock" })).toBeNull();
    expect(selfClaudeSessionFromEnv({ ...env, CLAUDE_CODE_SESSION_ID: SESSION_ID, CLAUDE_CODE_MESSAGING_SOCKET: "cc-socks/1.sock" })).toBeNull();
    expect(selfClaudeSessionFromEnv({ ...env, CLAUDE_CODE_SESSION_ID: SESSION_ID })).toBeNull();
    expect(selfClaudeSessionFromEnv({ ...env, CLAUDE_CODE_MESSAGING_SOCKET: socket })).toBeNull();
    // 不一致 ⇒ 回落到 ps 链，由真实祖先给答案（这里父进程链上是 process.pid 持有文件）。
    const calls: number[] = [];
    const found = findSelfClaudeSession({
      env: { ...env, CLAUDE_CODE_SESSION_ID: "22222222-2222-4222-8222-222222222222", CLAUDE_CODE_MESSAGING_SOCKET: socket },
      startPid: 100,
      spawn: fakePs({ 100: 200, 200: process.pid }, calls),
    });
    expect(found).toEqual({ pid: process.pid, sessionId: SESSION_ID, name: "agentparty-83", hops: 2 });
    expect(calls).toEqual([100, 200]);
  });

  test("the real ps walk finds a real ancestor that owns a sessions file", () => {
    // bun test 自己扮演宿主：从本进程往上走一跳就是它自己的父进程，所以把寻址文件写给 process.pid，
    // 起点用一个「假想子进程」——startPid=process.pid 的第一跳是 process.ppid，不含自己；
    // 因此这里以本进程为起点写父进程的文件，验证真 `ps` 能解析出 ppid。
    writeNativeSession(process.ppid);
    const found = walkToSelfClaudeSession({ env });
    expect(found?.pid).toBe(process.ppid);
    expect(found?.hops).toBe(1);
  });
});
