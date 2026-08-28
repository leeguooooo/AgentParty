// #978：`party claude` 的本机默认启动参数（opt-in 一次）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_DEFAULT_ARGS_ENV,
  claudeDefaultArgsPath,
  clearClaudeDefaultArgs,
  mergeClaudeArgs,
  readClaudeDefaultArgs,
  resolveClaudeDefaultArgs,
  writeClaudeDefaultArgs,
} from "../src/claude-default-args";
import {
  CLAUDE_CHANNEL_PLUGIN,
  claudeLaunchPlan,
  run,
  type ClaudeLaunchDependencies,
} from "../src/commands/claude-launch";

const SKIP = "--dangerously-skip-permissions";

let home: string;
let logs: string[];
let errors: string[];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentparty-claude-defaults-"));
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  rmSync(home, { recursive: true, force: true });
});

function launcher(env: NodeJS.ProcessEnv = {}) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const deps: ClaudeLaunchDependencies = {
    preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
    launch(args, launchEnv) {
      calls.push({ args, env: launchEnv });
      return { status: 0 };
    },
    home,
    env,
  };
  return { deps, calls };
}

describe("claude default args storage", () => {
  test("lives next to codex-auto-wake.json under the agentparty home and is opt-in only", () => {
    expect(claudeDefaultArgsPath(home)).toBe(join(home, "claude-default-args.json"));
    expect(existsSync(claudeDefaultArgsPath(home))).toBe(false);
    expect(readClaudeDefaultArgs(home)).toBeNull();
    // 无配置、无环境变量 ⇒ 空；绝不给高危 flag 一个硬编码默认。
    expect(resolveClaudeDefaultArgs({}, home)).toEqual({
      args: [],
      source: "none",
      origin: claudeDefaultArgsPath(home),
    });
  });

  test("round-trips through the config file and reports the file as the source", () => {
    writeClaudeDefaultArgs(home, [SKIP, "--model", "sonnet"]);
    const raw = JSON.parse(readFileSync(claudeDefaultArgsPath(home), "utf8")) as unknown;
    expect(raw).toEqual({ version: 1, args: [SKIP, "--model", "sonnet"] });
    expect(resolveClaudeDefaultArgs({}, home)).toEqual({
      args: [SKIP, "--model", "sonnet"],
      source: "config",
      origin: claudeDefaultArgsPath(home),
    });
  });

  test("env var is a fallback with lower priority than the file", () => {
    const env = { [CLAUDE_DEFAULT_ARGS_ENV]: `${SKIP} --model opus` };
    expect(resolveClaudeDefaultArgs(env, home)).toMatchObject({
      args: [SKIP, "--model", "opus"],
      source: "env",
    });
    writeClaudeDefaultArgs(home, ["--model", "sonnet"]);
    expect(resolveClaudeDefaultArgs(env, home)).toMatchObject({
      args: ["--model", "sonnet"],
      source: "config",
    });
  });

  test("clearing removes the file so the machine is back to its original state", () => {
    writeClaudeDefaultArgs(home, [SKIP]);
    clearClaudeDefaultArgs(home);
    expect(existsSync(claudeDefaultArgsPath(home))).toBe(false);
    expect(resolveClaudeDefaultArgs({}, home).args).toEqual([]);
    // 再清一次不报错
    clearClaudeDefaultArgs(home);
  });

  test("a corrupt or malformed file is treated as unset, never as arbitrary args", () => {
    writeFileSync(claudeDefaultArgsPath(home), "{ not json");
    expect(readClaudeDefaultArgs(home)).toBeNull();
    writeFileSync(claudeDefaultArgsPath(home), JSON.stringify({ version: 1, args: [SKIP, 3] }));
    expect(readClaudeDefaultArgs(home)).toBeNull();
    writeFileSync(claudeDefaultArgsPath(home), JSON.stringify([SKIP]));
    expect(readClaudeDefaultArgs(home)).toBeNull();
  });
});

describe("mergeClaudeArgs", () => {
  test("defaults first, explicit after; nothing to merge leaves explicit untouched", () => {
    expect(mergeClaudeArgs([], ["--model", "sonnet"])).toEqual(["--model", "sonnet"]);
    expect(mergeClaudeArgs([SKIP], ["--model", "sonnet"])).toEqual([SKIP, "--model", "sonnet"]);
  });

  test("a default flag already given explicitly is not inserted twice", () => {
    expect(mergeClaudeArgs([SKIP], [SKIP])).toEqual([SKIP]);
    expect(mergeClaudeArgs([SKIP, "--verbose"], ["--model", "opus", SKIP])).toEqual([
      "--verbose",
      "--model",
      "opus",
      SKIP,
    ]);
  });

  test("an explicit valued flag drops the whole default group, not just the flag token", () => {
    expect(mergeClaudeArgs(["--model", "sonnet", SKIP], ["--model", "opus"])).toEqual([
      SKIP,
      "--model",
      "opus",
    ]);
    expect(mergeClaudeArgs(["--model", "sonnet"], ["--model=opus"])).toEqual(["--model=opus"]);
  });
});

describe("party claude launch with defaults", () => {
  test("no config ⇒ args unchanged and no defaults line printed", async () => {
    const { deps, calls } = launcher();
    expect(await run(["dev", "--", "--model", "sonnet"], deps)).toBe(0);
    expect(calls[0]!.args).toEqual(["--channels", CLAUDE_CHANNEL_PLUGIN, "--model", "sonnet"]);
    expect(logs.some((line) => line.includes("默认参数"))).toBe(false);
  });

  test("configured defaults go after --channels <plugin> and before explicit -- args", async () => {
    writeClaudeDefaultArgs(home, [SKIP]);
    const { deps, calls } = launcher();
    expect(await run(["dev", "--", "--model", "sonnet"], deps)).toBe(0);
    expect(calls[0]!.args).toEqual([
      "--channels",
      CLAUDE_CHANNEL_PLUGIN,
      SKIP,
      "--model",
      "sonnet",
    ]);
    expect(calls[0]!.env.AGENTPARTY_CHANNEL).toBe("dev");
  });

  test("bare `party claude <chan>` picks up the defaults — the whole point of #978", async () => {
    writeClaudeDefaultArgs(home, [SKIP]);
    const { deps, calls } = launcher();
    expect(await run(["ludo"], deps)).toBe(0);
    expect(calls[0]!.args).toEqual(["--channels", CLAUDE_CHANNEL_PLUGIN, SKIP]);
  });

  test("explicit arg duplicating a default is not inserted twice", async () => {
    writeClaudeDefaultArgs(home, [SKIP]);
    const { deps, calls } = launcher();
    expect(await run(["dev", "--", SKIP, "--model", "sonnet"], deps)).toBe(0);
    expect(calls[0]!.args).toEqual([
      "--channels",
      CLAUDE_CHANNEL_PLUGIN,
      SKIP,
      "--model",
      "sonnet",
    ]);
    expect(calls[0]!.args.filter((arg) => arg === SKIP)).toHaveLength(1);
  });

  test("launch output names the defaults, their source file, and the skip-permissions warning", async () => {
    writeClaudeDefaultArgs(home, [SKIP]);
    const { deps } = launcher();
    await run(["dev"], deps);
    const line = logs.find((entry) => entry.startsWith("默认参数："));
    expect(line).toBe(`默认参数：${SKIP}（来自 ${claudeDefaultArgsPath(home)}）`);
    expect(logs.some((entry) => entry.includes("跳过所有权限确认") && entry.includes("本机显式配置的默认"))).toBe(true);
  });

  test("env fallback applies when no file exists and is reported as the env source", async () => {
    const { deps, calls } = launcher({ [CLAUDE_DEFAULT_ARGS_ENV]: "--model haiku" });
    await run(["dev"], deps);
    expect(calls[0]!.args).toEqual(["--channels", CLAUDE_CHANNEL_PLUGIN, "--model", "haiku"]);
    expect(logs.find((entry) => entry.startsWith("默认参数："))).toBe(
      `默认参数：--model haiku（来自 环境变量 ${CLAUDE_DEFAULT_ARGS_ENV}）`,
    );
  });

  test("claudeLaunchPlan without defaults keeps the original shape", () => {
    expect(claudeLaunchPlan("dev", ["--model", "sonnet"], {}).args).toEqual([
      "--channels",
      CLAUDE_CHANNEL_PLUGIN,
      "--model",
      "sonnet",
    ]);
    expect(claudeLaunchPlan(undefined, [], {}, [SKIP]).args).toEqual(["--channels", CLAUDE_CHANNEL_PLUGIN, SKIP]);
  });
});

describe("party claude --default-args / --show-default-args", () => {
  test("--default-args -- <args> writes the file, says it is a machine-local default, and does not launch", async () => {
    const { deps, calls } = launcher();
    expect(await run(["--default-args", "--", SKIP], deps)).toBe(0);
    expect(calls).toHaveLength(0);
    expect(readClaudeDefaultArgs(home)).toEqual([SKIP]);
    expect(logs.join("\n")).toContain("本机 `party claude` 的默认启动参数");
    expect(logs.join("\n")).toContain("由你显式配置");
    expect(logs.join("\n")).toContain(claudeDefaultArgsPath(home));
    expect(logs.join("\n")).toContain("跳过所有权限确认");
  });

  test("--default-args -- clears and a later launch is back to the original args", async () => {
    writeClaudeDefaultArgs(home, [SKIP]);
    const { deps, calls } = launcher();
    expect(await run(["--default-args", "--"], deps)).toBe(0);
    expect(existsSync(claudeDefaultArgsPath(home))).toBe(false);
    expect(logs.join("\n")).toContain("已清空");

    logs = [];
    expect(await run(["dev", "--", "--model", "sonnet"], deps)).toBe(0);
    expect(calls[0]!.args).toEqual(["--channels", CLAUDE_CHANNEL_PLUGIN, "--model", "sonnet"]);
    expect(logs.some((line) => line.includes("默认参数"))).toBe(false);
  });

  test("--default-args without -- is a usage error and writes nothing", async () => {
    const { deps, calls } = launcher();
    expect(await run(["--default-args"], deps)).toBe(1);
    expect(await run(["--default-args", SKIP], deps)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(existsSync(claudeDefaultArgsPath(home))).toBe(false);
    expect(errors.some((line) => line.includes("--default-args"))).toBe(true);
  });

  test("--show-default-args reports unset, then the configured args with their file", async () => {
    const { deps, calls } = launcher();
    expect(await run(["--show-default-args"], deps)).toBe(0);
    expect(logs.join("\n")).toContain("未配置本机默认启动参数");

    logs = [];
    writeClaudeDefaultArgs(home, [SKIP, "--model", "sonnet"]);
    expect(await run(["--show-default-args"], deps)).toBe(0);
    expect(logs[0]).toBe(`默认参数：${SKIP} --model sonnet（来自 ${claudeDefaultArgsPath(home)}）`);
    expect(calls).toHaveLength(0);
  });

  test("--show-default-args with a channel or -- is still rejected as ambiguous", async () => {
    const { deps, calls } = launcher();
    expect(await run(["dev", "--show-default-args"], deps)).toBe(1);
    expect(await run(["--show-default-args", "--"], deps)).toBe(1);
    expect(calls).toHaveLength(0);
  });
});
