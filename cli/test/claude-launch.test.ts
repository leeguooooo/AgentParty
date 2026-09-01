import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_OPT_IN_ENV } from "../src/mcp-session-binding";
import {
  CLAUDE_CHANNEL_OPT_IN_ENV,
  CLAUDE_CHANNEL_PLUGIN,
  CLAUDE_DEV_CHANNELS_FLAG,
  CLAUDE_LIFECYCLE_OPT_IN_ENV,
  claudeChannelLaunchNotices,
  claudeChannelLoadArgs,
  claudeLaunchPlan,
  rebindInitArgs,
  safeTokenTarget,
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
    // #1018：owner 亲手起的会话必须带上工具面授权，否则这条路会被自己的闸挡死。
    expect(calls[0]!.env[MCP_OPT_IN_ENV]).toBe("1");
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

describe("party claude --lang（#1003）", () => {
  function launchDeps(stored: string[], storeOk = true): ClaudeLaunchDependencies & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch(args) {
        calls.push(args);
        return { status: 0 };
      },
      home: mkdtempSync(join(tmpdir(), "agentparty-claude-launch-lang-")),
      env: {},
      storeLang: (lang) => {
        stored.push(lang);
        return storeOk;
      },
    };
  }

  test("--lang zh 写进 config 后照常启动；--lang=en 内联形式同样认；--lang 不进 claude 参数", async () => {
    const stored: string[] = [];
    const deps = launchDeps(stored);
    expect(await run(["dev", "--lang", "zh", "--", "--model", "sonnet"], deps)).toBe(0);
    expect(await run(["--lang=en", "dev"], deps)).toBe(0);
    expect(stored).toEqual(["zh", "en"]);
    expect(deps.calls).toHaveLength(2);
    for (const args of deps.calls) expect(args.some((arg) => arg.includes("--lang"))).toBe(false);
    expect(deps.calls[0]).toEqual([...CHANNEL_LOAD, "--model", "sonnet"]);
  });

  test("非法值 / 缺值 / 没有 config 可写 ⇒ 退出 1、不启动", async () => {
    const stored: string[] = [];
    const bad = launchDeps(stored);
    expect(await run(["dev", "--lang", "fr"], bad)).toBe(1);
    expect(await run(["dev", "--lang"], bad)).toBe(1);
    expect(bad.calls).toHaveLength(0);
    const noConfig = launchDeps(stored, false);
    expect(await run(["dev", "--lang", "zh"], noConfig)).toBe(1);
    expect(noConfig.calls).toHaveLength(0);
  });
});

// #1029：owner「唤醒会话应该是带 token 的」。web 重连引导发的是
// `AGENTPARTY_TOKEN='<T>' party claude <channel>`——一条命令既换掉被撤销的 token 又起会话。
describe("AGENTPARTY_TOKEN 重绑后再启动（#1029）", () => {
  function base(calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>, env: Record<string, string | undefined>) {
    // 隔离本机 `party claude --default-args` 偏好（#978）
    const home = mkdtempSync(join(tmpdir(), "agentparty-claude-token-"));
    return {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch(args: string[], childEnv: NodeJS.ProcessEnv) {
        calls.push({ args, env: childEnv });
        return { status: 0 };
      },
      home,
      env: { ...env } as NodeJS.ProcessEnv,
      // 必须注入：不给的话默认实现会去读**本机真实 config**、并真打一次 /api/me。
      configServer: () => "https://agentparty.example.com",
      verifyToken: async () => ({ kind: "agent" }),
    } as unknown as ClaudeLaunchDependencies;
  }

  function harness(env: Record<string, string | undefined>) {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const rebinds: (string | undefined)[] = [];
    return {
      calls,
      rebinds,
      deps: {
        ...base(calls, env),
        rebindToken: async (channel: string | undefined) => {
          rebinds.push(channel);
          return 0;
        },
      } as ClaudeLaunchDependencies,
    };
  }

  test("有 AGENTPARTY_TOKEN ⇒ 先重绑该频道，再照常启动", async () => {
    const h = harness({ AGENTPARTY_TOKEN: "ap_secret" });
    expect(await run(["dev"], h.deps)).toBe(0);
    expect(h.rebinds).toEqual(["dev"]);
    expect(h.calls).toHaveLength(1);
  });

  test("没有 AGENTPARTY_TOKEN ⇒ 一次重绑都不做（行为与今天一字不差）", async () => {
    const h = harness({});
    expect(await run(["dev"], h.deps)).toBe(0);
    expect(h.rebinds).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  test("空字符串不算「给了 token」", async () => {
    const h = harness({ AGENTPARTY_TOKEN: "" });
    expect(await run(["dev"], h.deps)).toBe(0);
    expect(h.rebinds).toEqual([]);
  });

  test("重绑失败 ⇒ 不启动会话，把退出码原样带出", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const deps = {
      ...base(calls, { AGENTPARTY_TOKEN: "ap_secret" }),
      rebindToken: async () => 7,
    } as ClaudeLaunchDependencies;
    expect(await run(["dev"], deps)).toBe(7);
    expect(calls).toHaveLength(0);
  });

  test("token 绝不进 argv，也绝不传给子进程 Claude", async () => {
    const h = harness({ AGENTPARTY_TOKEN: "ap_secret" });
    await run(["dev"], h.deps);
    const launch = h.calls[0]!;
    // argv：ps -axww 同机任何用户都看得见
    expect(launch.args.join(" ")).not.toContain("ap_secret");
    // 子进程环境：Claude 的每个 Bash 调用都继承它，模型一句 echo 就能读到
    expect(launch.env.AGENTPARTY_TOKEN).toBeUndefined();
    expect(JSON.stringify(launch.env)).not.toContain("ap_secret");
  });
});

// CodeRabbit on #1031：三条都成立——凭据可能被发往明文地址、可能顺着 env 流进 claude 子进程、
// 以及 harness 绑定会被探成 other。
describe("AGENTPARTY_TOKEN 重绑的安全边界（#1031 review）", () => {
  function deps(server: string | null, calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>, rebinds: string[]) {
    return {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch(args: string[], childEnv: NodeJS.ProcessEnv) {
        calls.push({ args, env: childEnv });
        return { status: 0 };
      },
      home: mkdtempSync(join(tmpdir(), "agentparty-claude-token-safety-")),
      env: { AGENTPARTY_TOKEN: "ap_secret" } as NodeJS.ProcessEnv,
      configServer: () => server,
      verifyToken: async () => ({ kind: "agent" }),
      rebindToken: async () => {
        rebinds.push("rebound");
        return 0;
      },
    } as unknown as ClaudeLaunchDependencies;
  }

  test("明文 http 远端 ⇒ 拒发凭据，不重绑也不启动", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const rebinds: string[] = [];
    expect(await run(["dev"], deps("http://agentparty.example.com", calls, rebinds))).toBe(1);
    expect(rebinds).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("https 与 loopback http ⇒ 放行", async () => {
    for (const server of ["https://agentparty.example.com", "http://localhost:8787", "http://127.0.0.1:8787"]) {
      const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      const rebinds: string[] = [];
      expect(await run(["dev"], deps(server, calls, rebinds))).toBe(0);
      expect(rebinds).toEqual(["rebound"]);
    }
  });

  test("safeTokenTarget 的判据本身", () => {
    expect(safeTokenTarget("https://x.example.com")).toBe(true);
    expect(safeTokenTarget("http://localhost:1")).toBe(true);
    expect(safeTokenTarget("http://x.example.com")).toBe(false);
    expect(safeTokenTarget("not a url")).toBe(false);
  });

  test("重绑成功后 token 从进程环境里消失（后续 spawn 的 claude / plugin 子进程都不该继承）", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const rebinds: string[] = [];
    const d = deps("https://agentparty.example.com", calls, rebinds);
    process.env.AGENTPARTY_TOKEN = "ap_secret";
    try {
      await run(["dev"], d);
      expect(process.env.AGENTPARTY_TOKEN).toBeUndefined();
      expect((d as { env?: NodeJS.ProcessEnv }).env?.AGENTPARTY_TOKEN).toBeUndefined();
    } finally {
      delete process.env.AGENTPARTY_TOKEN;
    }
  });
});

test("重绑交给 init 的参数必须显式带 --harness claude（#1031 review）", () => {
  // init 缺省从进程祖先链探 harness，而 `party claude` 是人在终端敲的、祖先里没有 claude，
  // 探出来会是 other —— @mention 唤醒就会绑错 harness。这里我们明确知道下一步起的是 claude。
  expect(rebindInitArgs("ludo")).toEqual(["--harness", "claude", "--channel", "ludo"]);
  expect(rebindInitArgs(undefined)).toEqual(["--harness", "claude"]);
});

// CodeRabbit on #1031（第二轮）：`party init` 会覆盖已有 config，而这条命令是启动器——
// 一个手滑设错的 AGENTPARTY_TOKEN 不该把原本还能用的身份毁掉。
describe("先验后写：坏 token 不许覆盖能用的身份（#1031 review 2）", () => {
  function deps(verify: () => Promise<{ kind: string } | null>, rebinds: string[]) {
    return {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch: () => ({ status: 0 }),
      home: mkdtempSync(join(tmpdir(), "agentparty-verify-first-")),
      env: { AGENTPARTY_TOKEN: "ap_bad" } as NodeJS.ProcessEnv,
      configServer: () => "https://agentparty.example.com",
      verifyToken: verify,
      rebindToken: async () => {
        rebinds.push("rebound");
        return 0;
      },
    } as unknown as ClaudeLaunchDependencies;
  }

  test("token 校验不通过 ⇒ 一次都不重绑（原有 config 原样保留）", async () => {
    const rebinds: string[] = [];
    expect(await run(["dev"], deps(async () => null, rebinds))).toBe(1);
    expect(rebinds).toEqual([]);
  });

  test("token 有效但不是 agent ⇒ 同样不重绑", async () => {
    const rebinds: string[] = [];
    expect(await run(["dev"], deps(async () => ({ kind: "human" }), rebinds))).toBe(1);
    expect(rebinds).toEqual([]);
  });

  test("校验通过 ⇒ 才重绑", async () => {
    const rebinds: string[] = [];
    expect(await run(["dev"], deps(async () => ({ kind: "agent" }), rebinds))).toBe(0);
    expect(rebinds).toEqual(["rebound"]);
  });
});

test("明文地址报错时清洗 server 字符串（它来自 config 文件，不是我们写的常量）", async () => {
  const errs: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
  try {
    await run(["dev"], {
      preflight: async () => ({ blockers: ["listener_not_observed"], listener: "not_observed" }),
      launch: () => ({ status: 0 }),
      home: mkdtempSync(join(tmpdir(), "agentparty-sanitize-")),
      env: { AGENTPARTY_TOKEN: "ap_x" } as NodeJS.ProcessEnv,
      // server 来自 config 文件：里面可以有 ANSI，能伪造终端输出
      configServer: () => `http://evil.example.com/${String.fromCharCode(27)}[31mFAKE`,
      verifyToken: async () => ({ kind: "agent" }),
    } as unknown as ClaudeLaunchDependencies);
  } finally {
    console.error = original;
  }
  const joined = errs.join("\n");
  expect(joined).toContain("拒绝把 AGENTPARTY_TOKEN 发往明文地址");
  expect(joined).not.toContain(String.fromCharCode(27));
});
