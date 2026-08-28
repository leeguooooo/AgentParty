import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CHANNEL_OPT_IN_ENV,
  CLAUDE_CHANNEL_PLUGIN,
  CLAUDE_DEV_CHANNELS_FLAG,
  CLAUDE_LIFECYCLE_OPT_IN_ENV,
  claudeChannelLaunchNotices,
  claudeChannelLoadArgs,
  claudeLaunchPlan,
  run,
  type ClaudeLaunchDependencies,
} from "../src/commands/claude-launch";
import { buildClaudeBridgeLaunch } from "../src/commands/bridge";

// #984：插件频道只能按 development channel 加载（allowedChannelPlugins 是 managed-only）。
// 字面量、不引用 claudeChannelLoadArgs：去掉 flag 或改回 --channels，这里必须红。
const CHANNEL_LOAD = ["--dangerously-load-development-channels", "plugin:agentparty@agentparty"];

describe("party claude launcher", () => {
  test("arms exactly one Marketplace Channel launch and forwards Claude args", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    // 隔离本机偏好：这台机可能配过 `party claude --default-args`（#978），不能影响这里的精确断言。
    const home = mkdtempSync(join(tmpdir(), "agentparty-claude-launch-"));
    const deps: ClaudeLaunchDependencies = {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch(args, env) {
        calls.push({ args, env });
        return { status: 7 };
      },
      home,
      env: {},
    };

    expect(await run(["dev", "--", "--model", "sonnet"], deps)).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      ...CHANNEL_LOAD,
      "--model",
      "sonnet",
    ]);
    expect(calls[0]!.args).not.toContain("--channels");
    expect(calls[0]!.env[CLAUDE_CHANNEL_OPT_IN_ENV]).toBe("1");
    expect(calls[0]!.env[CLAUDE_LIFECYCLE_OPT_IN_ENV]).toBe("1");
    expect(calls[0]!.env.AGENTPARTY_CHANNEL).toBe("dev");
  });

  test("does not invent a channel when the bound channel should be used", () => {
    const plan = claudeLaunchPlan(undefined, [], { KEEP: "yes" });
    expect(plan.args).toEqual([...CHANNEL_LOAD]);
    expect(plan.env).toMatchObject({
      KEEP: "yes",
      [CLAUDE_CHANNEL_OPT_IN_ENV]: "1",
      [CLAUDE_LIFECYCLE_OPT_IN_ENV]: "1",
    });
    expect(plan.env.AGENTPARTY_CHANNEL).toBeUndefined();
  });

  test("rejects ambiguous launcher flags before starting Claude", async () => {
    let launched = false;
    const code = await run(["--model", "sonnet"], {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch() {
        launched = true;
        return { status: 0 };
      },
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
  });

  test("refuses to open Claude when the plugin path would not listen", async () => {
    let launched = false;
    const code = await run(["dev"], {
      preflight: async () => ({ blockers: ["plugin_disabled", "listener_not_observed"], listener: "not_observed" }),
      launch() {
        launched = true;
        return { status: 0 };
      },
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
  });

  test("refuses a second listener for the same identity and channel", async () => {
    let launched = false;
    const code = await run(["dev"], {
      preflight: async () => ({ blockers: [], listener: "healthy" }),
      launch() {
        launched = true;
        return { status: 0 };
      },
    });
    expect(code).toBe(1);
    expect(launched).toBe(false);
  });

  test("an explicit --dangerously-load-development-channels replaces the launcher's, never duplicates it", () => {
    const explicit = [CLAUDE_DEV_CHANNELS_FLAG, "plugin:agentparty@agentparty", "--model", "sonnet"];
    expect(claudeLaunchPlan("dev", explicit, {}).args).toEqual(explicit);
    // 用户在本机默认参数里写了它也一样（默认参数也是用户显式写下的意图）。
    expect(claudeLaunchPlan("dev", [], {}, [CLAUDE_DEV_CHANNELS_FLAG, "server:mine"]).args).toEqual([
      CLAUDE_DEV_CHANNELS_FLAG,
      "server:mine",
    ]);
    expect(
      claudeLaunchPlan("dev", ["--model", "sonnet"], {}, ["--dangerously-skip-permissions"]).args,
    ).toEqual([...CHANNEL_LOAD, "--dangerously-skip-permissions", "--model", "sonnet"]);
  });

  test("launch notices explain the confirmation dialog and warn when the user touches the two channel flags", async () => {
    const plain = claudeChannelLaunchNotices(["--model", "sonnet"]);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toContain(CLAUDE_DEV_CHANNELS_FLAG);
    expect(plain[0]).toContain("Loading development channels");
    expect(plain[0]).toContain("I am using this for local development");

    const own = claudeChannelLaunchNotices([CLAUDE_DEV_CHANNELS_FLAG, "server:mine"]);
    expect(own).toHaveLength(2);
    expect(own[1]).toContain(CLAUDE_CHANNEL_PLUGIN);

    // `--channels plugin:agentparty@agentparty` 会遮住 development 条目（真二进制实测），必须点名。
    const shadow = claudeChannelLaunchNotices(["--channels", CLAUDE_CHANNEL_PLUGIN]);
    expect(shadow).toHaveLength(2);
    expect(shadow[1]).toContain("--channels");
    expect(claudeChannelLaunchNotices([`--channels=${CLAUDE_CHANNEL_PLUGIN}`])).toHaveLength(2);

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const home = mkdtempSync(join(tmpdir(), "agentparty-claude-launch-"));
      const code = await run(["dev"], {
        preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
        launch: () => ({ status: 0 }),
        home,
        env: {},
      });
      expect(code).toBe(0);
    } finally {
      console.log = original;
    }
    expect(logs.some((line) => line.startsWith("频道加载：") && line.includes("Loading development channels"))).toBe(true);
  });

  test("a refused launch prints doctor's fix lines instead of only pointing at doctor", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
    try {
      const code = await run(["dev"], {
        preflight: async () => ({
          blockers: ["plugin_state_unavailable", "listener_not_observed"],
          listener: "not_observed",
          fix_lines: ["  fix: something concrete"],
        }),
        launch: () => ({ status: 0 }),
      });
      expect(code).toBe(1);
    } finally {
      console.error = original;
    }
    expect(errors[0]).toBe("AgentParty Channel is not launch-ready (plugin_state_unavailable)");
    expect(errors).toContain("  fix: something concrete");
    expect(errors.some((line) => line.includes("claude plugin list --json") && line.includes("retry"))).toBe(true);
  });
});

describe("channel loading is one shape on both Claude launch paths (#984)", () => {
  // 守卫：`party claude` 与 `party bridge claude` 的频道加载参数必须出自同一个函数。
  // Claude 对 --channels 与 --dangerously-load-development-channels 用同一个解析器，值同形态
  // （plugin:<name>@<marketplace> / server:<name>）；两条入口只传 dev flag、都不传 --channels。
  const subsequence = (haystack: string[], needle: string[]): boolean =>
    haystack.some((_, i) => needle.every((token, j) => haystack[i + j] === token));

  test("party claude loads the plugin entry through claudeChannelLoadArgs and nothing else", () => {
    expect(claudeChannelLoadArgs(CLAUDE_CHANNEL_PLUGIN)).toEqual(CHANNEL_LOAD);
    const plan = claudeLaunchPlan("dev", ["--model", "sonnet"], {});
    expect(plan.args.slice(0, 2)).toEqual(claudeChannelLoadArgs(CLAUDE_CHANNEL_PLUGIN));
    expect(plan.args).not.toContain("--channels");
    expect(plan.args.filter((arg) => arg === CLAUDE_DEV_CHANNELS_FLAG)).toHaveLength(1);
  });

  test("party bridge claude loads its server entry through the same function", () => {
    const launch = buildClaudeBridgeLaunch({
      channel: "dev",
      claudeArgs: ["--model", "opus"],
      execPath: "/opt/homebrew/bin/bun",
      processArgv: ["/opt/homebrew/bin/bun", "/repo/cli/src/index.ts", "bridge", "claude"],
    });
    expect(subsequence(launch.args, claudeChannelLoadArgs("server:agentparty-channel"))).toBe(true);
    expect(subsequence(launch.args, ["--dangerously-load-development-channels", "server:agentparty-channel"])).toBe(true);
    expect(launch.args).not.toContain("--channels");
    expect(launch.args.filter((arg) => arg === CLAUDE_DEV_CHANNELS_FLAG)).toHaveLength(1);
  });
});
