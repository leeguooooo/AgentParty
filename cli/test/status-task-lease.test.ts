// #834 第 3 项：`party status working --task N` 是认领时刻,也是唯一该落刀的地方。
// wake 路径上拦截太晚——活已经开始了。
//
// 这一层测的是**端到端后果**,不是租约模块的内部返回值:被拒的那次必须一个字节都没发出去
// (没有 POST messages、没有 PATCH task),否则「拒绝第二个 runner」就变成了「把任务吞掉」。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_TASK_LEASE_HELD } from "@agentparty/shared";
import { writeConfig, writeState } from "../src/config";
import { run as statusRun } from "../src/commands/status";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;
const SAVED_ENV = { ...process.env };

function setExecutor(id: string) {
  process.env.AGENTPARTY_EXECUTOR_ID = id;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-status-lease-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  mock = startOidcMock();
  writeConfig({ server: mock.url, token: "ap_runtime" });
  writeState({ channel: "king", cursor: 0 });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

function posts(): number {
  return mock!.requests.filter((r) => r.method === "POST" && r.path === "/api/channels/king/messages").length;
}
function taskPatches(): number {
  return mock!.requests.filter((r) => r.method === "PATCH" && r.path.startsWith("/api/channels/king/tasks/")).length;
}

test("同一 (identity, task) 的第二个执行体认领被拒，且什么都没发出去", async () => {
  setExecutor("runner:claude:reception");
  expect(await statusRun(["working", "--task", "9", "-m", "on it"])).toBe(0);
  expect(posts()).toBe(1);
  expect(taskPatches()).toBe(1);

  setExecutor("session:claude:harness");
  const code = await statusRun(["working", "--task", "9", "-m", "also on it"]);
  expect(code).toBe(EXIT_TASK_LEASE_HELD);
  // 被拒的那次:一条帧都没发,task state 也没被改写——任务原样留给持租约的那个执行体。
  expect(posts()).toBe(1);
  expect(taskPatches()).toBe(1);
  expect(errs.join("\n")).toMatch(/refused/);
  expect(errs.join("\n")).toMatch(/task is untouched/);
});

test("被拒后任务仍可被正确的执行体接手（不丢）", async () => {
  setExecutor("runner:claude:reception");
  await statusRun(["working", "--task", "9"]);
  setExecutor("session:claude:harness");
  await statusRun(["working", "--task", "9"]);
  // 原持有者回来继续推进:照常发帧、照常更新 task。
  setExecutor("runner:claude:reception");
  expect(await statusRun(["working", "--task", "9", "-m", "still mine"])).toBe(0);
  expect(posts()).toBe(2);
  expect(await statusRun(["done", "--task", "9"])).toBe(0);
  // 交还后,原本被拒的那个执行体现在可以合法接手。
  setExecutor("session:claude:harness");
  expect(await statusRun(["working", "--task", "9"])).toBe(0);
  expect(posts()).toBe(4);
});

test("不同 task 不受影响", async () => {
  setExecutor("runner:claude:reception");
  await statusRun(["working", "--task", "9"]);
  setExecutor("session:claude:harness");
  expect(await statusRun(["working", "--task", "10"])).toBe(0);
  expect(posts()).toBe(2);
});

test("不带 --task 的 status 完全不参与租约", async () => {
  setExecutor("runner:claude:reception");
  expect(await statusRun(["working", "-m", "no task"])).toBe(0);
  setExecutor("session:claude:harness");
  expect(await statusRun(["working", "-m", "no task either"])).toBe(0);
  expect(posts()).toBe(2);
});

test("--json 让 agent 程序化读到租约结论", async () => {
  setExecutor("runner:claude:reception");
  await statusRun(["working", "--task", "9", "--json"]);
  const granted = JSON.parse(logs.at(-1)!);
  expect(granted.ok).toBe(true);
  expect(granted.lease.state).toBe("acquired");

  logs.length = 0;
  setExecutor("session:claude:harness");
  const code = await statusRun(["working", "--task", "9", "--json"]);
  expect(code).toBe(EXIT_TASK_LEASE_HELD);
  const denied = JSON.parse(logs.at(-1)!);
  expect(denied).toMatchObject({
    ok: false,
    published: false,
    task_untouched: true,
    exit_code: EXIT_TASK_LEASE_HELD,
    lease: { state: "denied", reason: "held_by_other", holder: { executor_id: "runner:claude:reception" } },
  });
});

test("--force-lease 显式抢占：owner 判定对方已死时的逃生口", async () => {
  setExecutor("runner:claude:reception");
  await statusRun(["working", "--task", "9"]);
  setExecutor("session:claude:harness");
  expect(await statusRun(["working", "--task", "9", "--force-lease"])).toBe(0);
  expect(errs.join("\n")).toMatch(/took over the task lease from runner:claude:reception/);
  expect(posts()).toBe(2);
});

test("blocked --task 交还租约：卡住的执行体不许把任务扣满整个 TTL", async () => {
  setExecutor("runner:claude:reception");
  await statusRun(["working", "--task", "9"]);
  expect(await statusRun(["blocked", "--task", "9", "-m", "stuck"])).toBe(0);
  setExecutor("session:claude:harness");
  expect(await statusRun(["working", "--task", "9"])).toBe(0);
});

test("--lease-ttl-ms 到期后另一个执行体可以接手，任务不会被永久锁死", async () => {
  setExecutor("runner:claude:reception");
  expect(await statusRun(["working", "--task", "9", "--lease-ttl-ms", "1"])).toBe(0);
  await Bun.sleep(5);
  setExecutor("session:claude:harness");
  expect(await statusRun(["working", "--task", "9"])).toBe(0);
  expect(posts()).toBe(2);
});

test("无法识别执行体身份时明说没落刀，而不是假装拦住了", async () => {
  delete process.env.AGENTPARTY_EXECUTOR_ID;
  delete process.env.AP_RUNNER_WORKDIR;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  expect(await statusRun(["working", "--task", "9"])).toBe(0);
  expect(errs.join("\n")).toMatch(/task lease not enforced/);
  expect(errs.join("\n")).toMatch(/AGENTPARTY_EXECUTOR_ID/);
});
