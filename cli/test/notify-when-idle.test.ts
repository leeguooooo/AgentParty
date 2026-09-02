// #1052 #5：`party send … --notify-when-idle`（先发消息再订阅每个 @ 到的 agent）与
// `party notify-when-idle <agent> [--channel C]`（只订阅不发消息）。REST 走 oidc-mock，
// 断言真正发出的请求路径 / 顺序 / 退出码 / 用户可见的一行提示。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/args";
import { run as notifyRun } from "../src/commands/notify-when-idle";
import { formatIdleSubscribe, resolveSendInput, run as sendRun, sendSpec } from "../src/commands/send";
import { writeConfig, writeState } from "../src/config";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;
const savedConfigEnv = process.env.AGENTPARTY_CONFIG;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-notify-idle-"));
  process.env.AGENTPARTY_HOME = home;
  // 绝不让测试读到真实用户的显式 config。
  delete process.env.AGENTPARTY_CONFIG;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  if (savedConfigEnv !== undefined) process.env.AGENTPARTY_CONFIG = savedConfigEnv;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

function bind(server: string): void {
  writeConfig({ server, token: "ap_runtime" });
  writeState({ channel: "ops", cursor: 0 });
}

describe("party send --notify-when-idle", () => {
  test("解析：旗标进 SendInput；没有任何 @ 时拒绝（订阅无对象）", async () => {
    const withMention = await resolveSendInput(parseArgs(["hi", "--channel", "c", "--mention", "bob", "--notify-when-idle"], sendSpec));
    expect(withMention?.notifyWhenIdle).toBe(true);
    const plain = await resolveSendInput(parseArgs(["hi", "--channel", "c"], sendSpec));
    expect(plain?.notifyWhenIdle).toBe(false);
    const none = await resolveSendInput(parseArgs(["hi", "--channel", "c", "--notify-when-idle"], sendSpec));
    expect(none).toBeNull();
    expect(errs.join("\n")).toContain("--notify-when-idle needs at least one @-mention");
  });

  test("先 POST messages 再对每个 --mention 逐个 POST notify-when-idle；stderr 每目标一行", async () => {
    mock = startOidcMock();
    bind(mock.url);
    const code = await sendRun(["hi", "--mention", "bob", "--mention", "idle-carol", "--notify-when-idle", "--no-reach"]);
    expect(code).toBe(0);
    const posts = mock.requests.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual([
      "/api/channels/ops/messages",
      "/api/channels/ops/presence/bob/notify-when-idle",
      "/api/channels/ops/presence/idle-carol/notify-when-idle",
    ]);
    expect(logs.join("\n")).toContain("sent seq=7");
    const err = errs.join("\n");
    expect(err).toContain("notify-when-idle: @bob — you will get one notice when it goes idle");
    expect(err).toContain("notify-when-idle: @idle-carol is already idle — idle notice delivered to your session now");
  });

  test("正文里的 @token 也订阅；某个目标 404 只打 warn，消息已发、退出码仍 0", async () => {
    mock = startOidcMock({ idleWatchUnknown: ["ghost"] });
    bind(mock.url);
    const code = await sendRun(["@ghost @bob please", "--notify-when-idle", "--no-reach"]);
    expect(code).toBe(0);
    const posts = mock.requests.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual([
      "/api/channels/ops/messages",
      "/api/channels/ops/presence/ghost/notify-when-idle",
      "/api/channels/ops/presence/bob/notify-when-idle",
    ]);
    const err = errs.join("\n");
    expect(err).toContain("warn: notify-when-idle @ghost: unknown target ghost");
    expect(err).toContain("notify-when-idle: @bob — you will get one notice");
  });

  test("不带旗标 ⇒ 一个 notify-when-idle 请求都不发", async () => {
    mock = startOidcMock();
    bind(mock.url);
    expect(await sendRun(["hi", "--mention", "bob", "--no-reach"])).toBe(0);
    expect(mock.requests.some((r) => r.path.includes("notify-when-idle"))).toBe(false);
  });

  test("formatIdleSubscribe：四种结果各一行人话", () => {
    expect(formatIdleSubscribe({ ok: true, target: "bob", subscriber: "me", outcome: "subscribed", expires_at: 0 })).toBe(
      "notify-when-idle: @bob — you will get one notice when it goes idle (expires 1970-01-01T00:00:00.000Z)",
    );
    expect(formatIdleSubscribe({ ok: true, target: "bob", subscriber: "me", outcome: "existing", expires_at: 0 })).toContain("already subscribed");
    expect(formatIdleSubscribe({ ok: true, target: "bob", subscriber: "me", outcome: "fired", fired: "idle" })).toContain("is already idle");
    expect(formatIdleSubscribe({ ok: true, target: "bob", subscriber: "me", outcome: "fired", fired: "exited" })).toContain("is offline");
  });
});

describe("party notify-when-idle <agent>", () => {
  test("只订阅、不发消息；成功打一行、退出 0", async () => {
    mock = startOidcMock();
    bind(mock.url);
    const code = await notifyRun(["bob"]);
    expect(code).toBe(0);
    const posts = mock.requests.filter((r) => r.method === "POST").map((r) => r.path);
    expect(posts).toEqual(["/api/channels/ops/presence/bob/notify-when-idle"]);
    expect(logs.join("\n")).toContain("notify-when-idle: @bob — you will get one notice when it goes idle");
  });

  test("--channel 覆盖绑定频道；--json 输出结构化", async () => {
    mock = startOidcMock();
    bind(mock.url);
    expect(await notifyRun(["idle-bob", "--channel", "dev", "--json"])).toBe(0);
    expect(mock.requests.at(-1)?.path).toBe("/api/channels/dev/presence/idle-bob/notify-when-idle");
    expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({ target: "idle-bob", channel: "dev", ok: true });
  });

  test("目标不存在 ⇒ warn + 退出 1；缺参数 / 非法名 / system ⇒ 本地拒绝不发请求", async () => {
    mock = startOidcMock({ idleWatchUnknown: ["ghost"] });
    bind(mock.url);
    expect(await notifyRun(["ghost"])).toBe(1);
    expect(errs.join("\n")).toContain("warn: notify-when-idle @ghost: unknown target ghost");
    const before = mock.requests.length;
    expect(await notifyRun([])).toBe(1);
    expect(await notifyRun(["bad name!"])).toBe(1);
    expect(await notifyRun(["system"])).toBe(1);
    expect(await notifyRun(["bob", "--bogus"])).toBe(1);
    expect(mock.requests.length).toBe(before);
  });
});
