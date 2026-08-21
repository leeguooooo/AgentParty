// #908 孤儿进程判据的单测。重点在两条硬约束：
//  (a) 「绝不碰非 party 进程」——有专门的变异用例（#884 教训：守卫自己会假阴性）；
//  (b) 「人有意 daemonize 的 lane 永远不判 stale」。
import { describe, expect, test } from "bun:test";
import {
  classifyOrphanProcess,
  commandArgv,
  isPartyProcess,
  parsePsOutput,
  partyLane,
  partySubcommand,
  type ScannedProcess,
} from "../src/orphan-scan";
import { ancestorPids, planOrphans, runOrphans } from "../src/commands/orphans";

function proc(pid: number, ppid: number, command: string): ScannedProcess {
  return { pid, ppid, command };
}

describe("parsePsOutput", () => {
  test("解析 pid/ppid/command 三列，跳过形状不对的行", () => {
    const out = parsePsOutput(
      [
        "  41114     1 /Users/leo/.local/bin/party claude-channel --require-launch-opt-in",
        "  10672 10600 /usr/local/bin/claude",
        "garbage line",
        "",
        "   77            ", // 没有 command
      ].join("\n"),
    );
    expect(out).toEqual([
      proc(41114, 1, "/Users/leo/.local/bin/party claude-channel --require-launch-opt-in"),
      proc(10672, 10600, "/usr/local/bin/claude"),
    ]);
  });

  test("命令里的空格与参数原样保留", () => {
    const out = parsePsOutput("  5 1 /bin/party mcp --channel dev --identity bot\n");
    expect(out[0]!.command).toBe("/bin/party mcp --channel dev --identity bot");
    expect(commandArgv(out[0]!.command)).toEqual(["/bin/party", "mcp", "--channel", "dev", "--identity", "bot"]);
  });
});

describe("isPartyProcess —— 只按命令本体判定", () => {
  test("认得两个官方 basename（含 Windows 后缀）", () => {
    expect(isPartyProcess("/Users/leo/.local/bin/party claude-channel")).toBe(true);
    expect(isPartyProcess("/x/plugins/agentparty/bin/agentparty-runtime mcp")).toBe(true);
    // 后缀剥离与 isPartyMcpRegistration 保持同款；路径分隔符只按 POSIX 处理——
    // 这条链的输入是 `ps`，Windows 上根本没有它。
    expect(isPartyProcess("party.exe mcp")).toBe(true);
  });

  test("不认间接形态与任何冒名者", () => {
    for (const command of [
      "npx party claude-channel",
      "sh -c 'party claude-channel'",
      "bun run cli/src/index.ts claude-channel",
      "/opt/other/partyd claude-channel",
      "/opt/other/my-party mcp",
      "/usr/bin/node /x/party.js mcp",
      "",
      "   ",
    ]) {
      expect(isPartyProcess(command)).toBe(false);
    }
  });

  test("变异守卫：进程名/参数里出现 party 字样绝不足以让它被认成我们的进程", () => {
    // 这些是别人的进程，只是命令行里恰好带着 party / claude-channel 字样。
    // 若把判定从「argv[0] 的 basename」放宽成任何形式的子串/包含匹配，这里必挂。
    const impostors = [
      proc(900, 1, "/Applications/Discord.app/Contents/MacOS/Discord --party-mode"),
      proc(901, 1, "/usr/local/bin/iphone-use-mcp --server party claude-channel"),
      proc(902, 1, "/usr/bin/python3 party_worker.py claude-channel"),
      proc(903, 1, "/usr/bin/tail -f /var/log/party-claude-channel.log"),
    ];
    for (const p of impostors) {
      expect(isPartyProcess(p.command)).toBe(false);
      const verdict = classifyOrphanProcess({ proc: p });
      expect(verdict.action).toBe("keep");
      expect(verdict.reason).toBe("not an AgentParty process — never touched");
    }
  });
});

describe("partySubcommand / partyLane", () => {
  test("子命令＝第一个非 flag 参数", () => {
    expect(partySubcommand("/bin/party --channel dev claude-channel")).toBe("claude-channel");
    expect(partySubcommand("/bin/party claude-channel --require-launch-opt-in")).toBe("claude-channel");
    expect(partySubcommand("/bin/party")).toBeNull();
    expect(partySubcommand("/bin/node index.js serve")).toBeNull();
  });

  test("lane 分档", () => {
    expect(partyLane("/bin/party claude-channel --require-launch-opt-in")).toBe("session-child");
    expect(partyLane("/bin/party mcp --channel dev")).toBe("session-child");
    // `party mcp prune` 是短命 CLI，不是常驻 server——正在跑的清理不该被当成孤儿。
    expect(partyLane("/bin/party mcp prune --yes")).toBe("oneshot");
    expect(partyLane("/bin/party serve dev --runner claude")).toBe("daemon");
    expect(partyLane("/bin/party watch dev --once")).toBe("daemon");
    expect(partyLane("/bin/party hook codex-autowake --supervise --channel dev")).toBe("daemon");
    expect(partyLane("/bin/party send hi")).toBe("oneshot");
  });
});

describe("classifyOrphanProcess", () => {
  test("本次故障形态：宿主已死的 announce 被 init 收养 ⇒ stale", () => {
    const v = classifyOrphanProcess({
      proc: proc(41114, 1, "/Users/leo/.local/bin/party claude-channel --require-launch-opt-in"),
    });
    expect(v.action).toBe("stale");
    expect(v.reason).toContain("orphaned");
  });

  test("父进程还在 ⇒ 一律 keep（宿主活着的 announce 绝不能被碰）", () => {
    const v = classifyOrphanProcess({
      proc: proc(41114, 10672, "/bin/party claude-channel --require-launch-opt-in"),
    });
    expect(v.action).toBe("keep");
  });

  test("人有意 daemonize 的 lane 即使 ppid=1 也只 review，绝不 stale", () => {
    for (const command of [
      "/bin/party serve dev --runner claude",
      "/bin/party watch dev --once",
      "/bin/party hook codex-autowake --supervise --channel dev",
    ]) {
      const v = classifyOrphanProcess({ proc: proc(500, 1, command) });
      expect(v.action).toBe("review");
    }
  });

  test("受保护的 pid（自己/祖先）永不进入清理列表", () => {
    const v = classifyOrphanProcess({
      proc: proc(10672, 1, "/bin/party claude-channel"),
      protectedPids: new Set([10672]),
    });
    expect(v.action).toBe("keep");
  });

  test("短命 party 命令即便 ppid=1 也不动", () => {
    expect(classifyOrphanProcess({ proc: proc(7, 1, "/bin/party send hi") }).action).toBe("keep");
    expect(classifyOrphanProcess({ proc: proc(8, 1, "/bin/party mcp prune") }).action).toBe("keep");
  });
});

describe("ancestorPids", () => {
  test("自己 + 整条祖先链", () => {
    const procs = [proc(10, 20, "a"), proc(20, 30, "b"), proc(30, 1, "c"), proc(99, 1, "d")];
    expect([...ancestorPids(10, procs)].sort((x, y) => x - y)).toEqual([10, 20, 30]);
  });

  test("环形 ppid 不死循环", () => {
    const procs = [proc(10, 20, "a"), proc(20, 10, "b")];
    expect([...ancestorPids(10, procs)].sort((x, y) => x - y)).toEqual([10, 20]);
  });
});

const PS_FIXTURE = [
  "  10672 10600 /usr/local/bin/claude",
  "  41114     1 /Users/leo/.local/bin/party claude-channel --require-launch-opt-in",
  "  41115 10672 /Users/leo/.local/bin/party claude-channel --require-launch-opt-in",
  "  52207     1 /usr/local/bin/party serve dev --runner claude",
  "  60000     1 /usr/local/bin/iphone-use-mcp --party",
  "  60001     1 /Applications/Slack.app/Contents/MacOS/Slack",
].join("\n");

describe("party orphans 命令", () => {
  test("dry-run 是默认值：列出孤儿但一个信号都不发", async () => {
    const lines: string[] = [];
    const signalled: number[] = [];
    const code = await runOrphans({
      ps: () => PS_FIXTURE,
      selfPid: 10672,
      json: true,
      signal: (pid) => { signalled.push(pid); return { ok: true, detail: "" }; },
      sweepRegistry: () => 3,
      log: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(signalled).toEqual([]);
    const report = JSON.parse(lines.join("\n")) as {
      dry_run: boolean;
      orphans: { pid: number }[];
      review: { pid: number }[];
      untouched_non_party: number;
      live_session_registrations: number;
    };
    expect(report.dry_run).toBe(true);
    expect(report.orphans.map((o) => o.pid)).toEqual([41114]);
    expect(report.review.map((o) => o.pid)).toEqual([52207]);
    // claude 本体 + iphone-use-mcp + Slack：三个非 party 进程，看见了、没碰。
    expect(report.untouched_non_party).toBe(3);
    expect(report.live_session_registrations).toBe(3);
  });

  test("--yes 只对确证的孤儿发 SIGTERM，别的进程一个都不碰", async () => {
    const signalled: number[] = [];
    await runOrphans({
      ps: () => PS_FIXTURE,
      selfPid: 10672,
      yes: true,
      json: true,
      signal: (pid) => { signalled.push(pid); return { ok: true, detail: "" }; },
      sweepRegistry: () => 0,
      log: () => undefined,
    });
    expect(signalled).toEqual([41114]);
    // 宿主还活着的那个 announce（41115）、人手工起的 serve（52207）、别人的 mcp（60000）都没被动。
    expect(signalled).not.toContain(41115);
    expect(signalled).not.toContain(52207);
    expect(signalled).not.toContain(60000);
  });

  test("命令层扫描不会把自己列进去", () => {
    const plan = planOrphans({ ps: () => "  4242     1 /bin/party claude-channel\n", selfPid: 4242 });
    expect(plan.entries[0]!.verdict.action).toBe("keep");
  });

  test("发信号失败会被报告且退出码非 0", async () => {
    const code = await runOrphans({
      ps: () => PS_FIXTURE,
      selfPid: 10672,
      yes: true,
      json: true,
      signal: () => ({ ok: false, detail: "ESRCH" }),
      sweepRegistry: () => 0,
      log: () => undefined,
    });
    expect(code).toBe(1);
  });
});
