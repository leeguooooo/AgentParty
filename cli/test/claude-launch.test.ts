import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CHANNEL_OPT_IN_ENV,
  CLAUDE_CHANNEL_PLUGIN,
  CLAUDE_LIFECYCLE_OPT_IN_ENV,
  claudeLaunchPlan,
  run,
  type ClaudeLaunchDependencies,
} from "../src/commands/claude-launch";

describe("party claude launcher", () => {
  test("arms exactly one Marketplace Channel launch and forwards Claude args", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const deps: ClaudeLaunchDependencies = {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch(args, env) {
        calls.push({ args, env });
        return { status: 7 };
      },
    };

    expect(await run(["dev", "--", "--model", "sonnet"], deps)).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "--channels",
      CLAUDE_CHANNEL_PLUGIN,
      "--model",
      "sonnet",
    ]);
    expect(calls[0]!.env[CLAUDE_CHANNEL_OPT_IN_ENV]).toBe("1");
    expect(calls[0]!.env[CLAUDE_LIFECYCLE_OPT_IN_ENV]).toBe("1");
    expect(calls[0]!.env.AGENTPARTY_CHANNEL).toBe("dev");
  });

  test("does not invent a channel when the bound channel should be used", () => {
    const plan = claudeLaunchPlan(undefined, [], { KEEP: "yes" });
    expect(plan.args).toEqual(["--channels", CLAUDE_CHANNEL_PLUGIN]);
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
});
