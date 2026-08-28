// #959：一次性 / 嵌入式 codex 会话不该拉唤醒层——判定必须在 SessionStart 那一刻、按进程形态做出。
//
// 进程表全部照抄真机 `ps -axo pid=,ppid=,args=` 的形态：
//   - Claude 插件的 codex-rescue：`spawn("codex", ["app-server"])`，父进程是 node 脚本，再上面是 claude；
//   - 桌面 codex：/Applications/ChatGPT.app/Contents/Resources/codex … app-server；
//   - 终端 TUI：codex ← zsh ← iTerm。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCodexRolloutMeta, classifyCodexSession, codexSubcommand, harnessAncestor, parseCodexRolloutMeta, probeCodexSessionKind, readCodexRolloutMeta, resetCodexRolloutMetaCache } from "../src/codex-session-kind";
import type { ProcessRow } from "../src/join-binding";

function table(rows: Array<[pid: number, ppid: number, args: string]>): Map<number, ProcessRow> {
  return new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, args }]));
}

/** 把进程表伪装成 `ps -axo pid=,ppid=,args=` 的输出，给 probeCodexSessionKind 的 spawn 桩用。 */
function psStub(rows: Array<[pid: number, ppid: number, args: string]>): never {
  const stdout = rows.map(([pid, ppid, args]) => `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${args}`).join("\n");
  return ((cmd: string) => {
    if (cmd !== "ps") throw new Error(`unexpected spawn ${cmd}`);
    return { status: 0, stdout, stderr: "" };
  }) as never;
}

describe("子命令解析", () => {
  test("跳过全局选项及其取值，拿到真正的子命令", () => {
    expect(codexSubcommand("codex -c features.x=true -m gpt-5 exec --json 'do it'")).toBe("exec");
    expect(codexSubcommand("/Applications/ChatGPT.app/Contents/Resources/codex -c a=b app-server --flag")).toBe("app-server");
    expect(codexSubcommand("codex --full-auto")).toBeNull();
    expect(codexSubcommand("codex")).toBeNull();
    expect(codexSubcommand("codex e")).toBe("e");
  });

  test("#976：npm 版 codex 的 node 启动层不是子命令——跳过解释器 / 包裹层再取", () => {
    expect(codexSubcommand("node /opt/homebrew/bin/codex app-server")).toBe("app-server");
    expect(codexSubcommand("node /x/codex exec")).toBe("exec");
    expect(codexSubcommand("node --no-warnings /opt/homebrew/bin/codex -c a=b exec")).toBe("exec");
    expect(codexSubcommand("/usr/bin/env node /opt/homebrew/bin/codex mcp-server")).toBe("mcp-server");
    expect(codexSubcommand("/bin/sh -c codex exec 'x'")).toBe("exec");
    expect(codexSubcommand("/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex app-server")).toBe("app-server");
    expect(codexSubcommand("node /opt/homebrew/bin/codex")).toBeNull();
  });
});

describe("#976：祖先链上的 harness——看跳过包裹层后的可执行文件本体", () => {
  test("node 包裹的 codex / claude 入口都算 harness", () => {
    expect(harnessAncestor("node /opt/homebrew/bin/codex app-server")).toBe("codex");
    expect(harnessAncestor("node /Users/leo/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js --settings x")).toBe("claude");
    expect(harnessAncestor("node /usr/local/lib/node_modules/claude/cli.js")).toBe("claude");
    expect(harnessAncestor("node /Users/leo/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs task --x")).toBe("codex");
    expect(harnessAncestor("/Users/leo/.local/bin/claude --settings /tmp/s.json")).toBe("claude");
    expect(harnessAncestor("/Applications/ChatGPT.app/Contents/Resources/codex -c a=b app-server")).toBe("codex");
  });

  test("命令行里任意位置出现 codex / claude 字样不算（#918 的判据不能松）", () => {
    expect(harnessAncestor("vim codex-notes.md")).toBeNull();
    expect(harnessAncestor("git commit -m claude")).toBeNull();
    expect(harnessAncestor("/Users/leo/.local/bin/cxs _launch-codex app-server")).toBeNull();
    expect(harnessAncestor("-zsh")).toBeNull();
    expect(harnessAncestor("/Applications/iTerm.app/Contents/MacOS/iTerm2")).toBeNull();
  });
});

describe("#976 真机进程链（本机 ps 实抓）", () => {
  test("被 Claude 委托的 npm 版 codex：vendor 二进制 ← node 启动层 ← cxs 包装 ← codex-companion ← claude ← cmux ⇒ 非交互式", () => {
    const rows = table([
      [10, 1, "/Applications/cmux.app/Contents/MacOS/cmux"],
      [20, 10, "login -fp leo"],
      [30, 20, "-zsh"],
      [40, 30, "/Users/leo/.local/bin/claude --settings /tmp/settings.json"],
      [50, 40, "node /Users/leo/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/stop-review-gate-hook.mjs"],
      [60, 50, "node /Users/leo/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs task --json"],
      [70, 60, "/Users/leo/.local/bin/cxs _launch-codex app-server"],
      [80, 70, "node /opt/homebrew/bin/codex app-server"],
      [90, 80, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex app-server"],
      [95, 90, "party hook codex-report"],
    ]);
    const probe = classifyCodexSession(rows, 90);
    expect(probe.kind).toBe("non-interactive");
    // 委托者是 codex-companion（codex harness），不是把同一会话的 node 启动层误认成「另一个 codex」。
    expect(probe.detail).toContain("pid 60");
  });

  test("同一条链、祖先已在 ps 快照里消失（只剩最下面三层）：app-server 无 GUI 祖先 ⇒ 仍非交互式", () => {
    const rows = table([
      [70, 1, "/Users/leo/.local/bin/cxs _launch-codex app-server"],
      [80, 70, "node /opt/homebrew/bin/codex app-server"],
      [90, 80, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex app-server"],
    ]);
    expect(classifyCodexSession(rows, 90).kind).toBe("non-interactive");
  });

  test("ChatGPT.app 桌面 codex：Resources/codex app-server ← ChatGPT ← launchd ⇒ 交互式（#966 有意设计）", () => {
    const rows = table([
      [684, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      [1230, 684, "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled"],
      [1300, 1230, "party hook codex-report"],
    ]);
    expect(classifyCodexSession(rows, 1230).kind).toBe("interactive");
  });

  test("npm 版交互式 TUI：vendor 二进制 ← node /opt/homebrew/bin/codex ← zsh ← iTerm ⇒ 交互式（启动层折进宿主，不算「另一个 codex」）", () => {
    const rows = table([
      [100, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"],
      [200, 100, "-zsh"],
      [300, 200, "node /opt/homebrew/bin/codex"],
      [400, 300, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex"],
    ]);
    const probe = classifyCodexSession(rows, 400);
    expect(probe.kind).toBe("interactive");
    expect(probe.detail).toContain("TUI");
  });

  test("npm 版交互式 TUI 里嵌 `codex app-server`（子命令不同）⇒ 仍是委托，非交互式", () => {
    const rows = table([
      [300, 1, "node /opt/homebrew/bin/codex"],
      [400, 300, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex"],
      [500, 400, "node /opt/homebrew/bin/codex app-server"],
      [600, 500, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex app-server"],
    ]);
    expect(classifyCodexSession(rows, 600).kind).toBe("non-interactive");
  });
});

describe("事故形态：别的 Claude 会话委托的一次性 codex（#959）", () => {
  test("codex app-server ← node 插件脚本 ← claude ⇒ 非交互式（委托拉起，跑完即走）", () => {
    const rows = table([
      [100, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"],
      [200, 100, "-zsh"],
      [300, 200, "claude"],
      [400, 300, "node /Users/leo/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex.mjs rescue"],
      [500, 400, "codex app-server"],
      [600, 500, "party hook codex-report"],
    ]);
    const probe = classifyCodexSession(rows, 500);
    expect(probe.kind).toBe("non-interactive");
    // #976 起最近的委托者就是插件的 codex 脚本（pid 400，node 包裹也认得出来），不必再爬到 claude。
    expect(probe.detail).toContain("委托拉起");
    expect(probe.detail).toContain("pid 400");
  });

  test("codex exec（哪怕是人在终端里敲的）⇒ 非交互式：一次性任务，没有人在它前面等着被 @", () => {
    const rows = table([
      [200, 1, "-zsh"],
      [500, 200, "codex exec --skip-git-repo-check -o out.md 'review this'"],
    ]);
    expect(classifyCodexSession(rows, 500).kind).toBe("non-interactive");
  });

  test("codex 通过 sh -c 跑 hook：起点是 shell 也要能穿透到 codex 本体", () => {
    const rows = table([
      [200, 1, "-zsh"],
      [500, 200, "codex e 'fix it'"],
      [550, 500, "/bin/sh -c party hook codex-report"],
    ]);
    expect(classifyCodexSession(rows, 550).kind).toBe("non-interactive");
  });

  test("codex mcp-server（作为别人的 MCP 子进程）⇒ 非交互式", () => {
    const rows = table([[500, 1, "codex mcp-server"]]);
    expect(classifyCodexSession(rows, 500).kind).toBe("non-interactive");
  });

  test("被 detach 的 app-server（父进程是 launchd、祖先链上没有 GUI）⇒ 非交互式", () => {
    const rows = table([
      [400, 1, "node app-server-broker.mjs serve --endpoint unix:///tmp/x.sock"],
      [500, 400, "codex app-server"],
    ]);
    expect(classifyCodexSession(rows, 500).kind).toBe("non-interactive");
  });

  test("codex 嵌在另一个 codex 里（codex 委托 codex）⇒ 非交互式", () => {
    const rows = table([
      [300, 1, "codex"],
      [500, 300, "codex app-server"],
    ]);
    expect(classifyCodexSession(rows, 500).kind).toBe("non-interactive");
  });
});

describe("人在用的 codex 一律照旧（行为与修复前逐字相同）", () => {
  test("终端 TUI：codex ← zsh ← iTerm ⇒ 交互式", () => {
    const rows = table([
      [100, 1, "/Applications/iTerm.app/Contents/MacOS/iTerm2"],
      [200, 100, "-zsh"],
      [500, 200, "codex"],
    ]);
    expect(classifyCodexSession(rows, 500).kind).toBe("interactive");
  });

  test("codex resume / 带全局选项的 TUI ⇒ 交互式", () => {
    const rows = table([[500, 1, "codex -m gpt-5 resume --last"]]);
    expect(classifyCodexSession(rows, 500).kind).toBe("interactive");
  });

  test("桌面 codex（ChatGPT.app 里的 codex app-server）⇒ 交互式", () => {
    const rows = table([
      [684, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
      [1230, 684, "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled"],
    ]);
    expect(classifyCodexSession(rows, 1230).kind).toBe("interactive");
  });

  test("IDE 扩展里的 codex app-server（祖先链上有 .app）⇒ 交互式", () => {
    const rows = table([
      [700, 1, "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"],
      [710, 700, "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility"],
      [720, 710, "/Users/leo/.vscode/extensions/openai.chatgpt-1.0.0/bin/codex app-server"],
    ]);
    expect(classifyCodexSession(rows, 720).kind).toBe("interactive");
  });
});

describe("探测失败＝不知道，绝不误判成一次性", () => {
  test("进程表为空 ⇒ unknown", () => {
    expect(classifyCodexSession(new Map(), 500).kind).toBe("unknown");
  });

  test("进程表里找不到父进程 ⇒ unknown", () => {
    expect(classifyCodexSession(table([[1, 0, "launchd"]]), 500).kind).toBe("unknown");
  });

  test("ps 挂了 / pid 不合法 ⇒ unknown，不抛", () => {
    expect(probeCodexSessionKind(0).kind).toBe("unknown");
    expect(probeCodexSessionKind(4242, (() => { throw new Error("ps down"); }) as never).kind).toBe("unknown");
  });
});

// ---- #976：rollout 头是首要信号 ----

/** piggo 机 codex 0.149.1 实抓的两种 session_meta 头（base_instructions 换成占位）。 */
const DIRECT_ID = "01a046e8-89f6-7ba2-a792-4d0342522e7f";
const SUBAGENT_ID = "01a046e9-1111-7ba2-a792-4d0342522e7f";
const PARENT_ID = "01a04644-ff88-7442-92c0-c828091ba7f0";
const DESKTOP_ID = "01a046ea-2222-7ba2-a792-4d0342522e7f";

function headA(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    timestamp: "2026-08-28T05:47:19.944Z",
    type: "session_meta",
    payload: {
      session_id: DIRECT_ID, id: DIRECT_ID, timestamp: "2026-08-28T05:47:19.944Z", cwd: "/Users/leo/tk.com/piggo",
      originator: "Claude Code", cli_version: "0.149.1", source: "vscode", model_provider: "openai",
      base_instructions: "<long text that must never reach the log>", history_mode: "legacy",
      context_window: { window_id: "01a046e8-89f6-7ba2-a792-4d1a4ba508f9" },
      git: { commit_hash: "6b17c9e", branch: "leo-dev", repository_url: "https://example.invalid/x.git" },
      ...overrides,
    },
  })}\n`;
}

function headB(): string {
  return `${JSON.stringify({
    timestamp: "2026-08-28T05:50:00.000Z",
    type: "session_meta",
    payload: {
      session_id: PARENT_ID, id: SUBAGENT_ID, forked_from_id: PARENT_ID, parent_thread_id: PARENT_ID,
      timestamp: "2026-08-28T05:50:00.000Z", cwd: "/Users/leo/tk.com/piggo", originator: "Claude Code", cli_version: "0.149.1",
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID, depth: 1, agent_path: "/root/review_api_contract", agent_nickname: "Maxwell", agent_role: null } } },
      thread_source: "subagent", agent_nickname: "Maxwell", agent_path: "/root/review_api_contract", multi_agent_version: "v2",
      base_instructions: "<long text>",
    },
  })}\n`;
}

describe("#976：rollout 头解析", () => {
  test("头 A（直接会话，source 是字符串）：originator=Claude Code ⇒ 非交互式，detail 说明来源是 rollout", () => {
    const meta = parseCodexRolloutMeta(headA())!;
    expect(meta).toMatchObject({ id: DIRECT_ID, sessionId: DIRECT_ID, originator: "Claude Code", source: "vscode", subagent: false });
    const verdict = classifyCodexRolloutMeta(meta)!;
    expect(verdict.kind).toBe("non-interactive");
    expect(verdict.detail).toContain("rollout");
    expect(verdict.detail).toContain("originator=Claude Code");
    expect(verdict.detail).not.toContain("long text");
  });

  test("头 B（subagent 派生，source 是对象、session_id ≠ id）：一票定非交互式", () => {
    const meta = parseCodexRolloutMeta(headB())!;
    expect(meta).toMatchObject({ id: SUBAGENT_ID, sessionId: PARENT_ID, parentThreadId: PARENT_ID, threadSource: "subagent", subagent: true, source: "subagent" });
    const verdict = classifyCodexRolloutMeta(meta)!;
    expect(verdict.kind).toBe("non-interactive");
    expect(verdict.detail).toContain("subagent");
    expect(verdict.detail).toContain(PARENT_ID);
  });

  test("subagent 的三个特征各自单独成立也够（source 对象 / thread_source / parent_thread_id）", () => {
    expect(parseCodexRolloutMeta(headA({ source: { subagent: {} } }))!.subagent).toBe(true);
    expect(parseCodexRolloutMeta(headA({ thread_source: "subagent" }))!.subagent).toBe(true);
    expect(parseCodexRolloutMeta(headA({ parent_thread_id: PARENT_ID }))!.subagent).toBe(true);
  });

  test("originator 不是 Claude Code、也不是 subagent ⇒ 无结论（null），交给进程形态", () => {
    const meta = parseCodexRolloutMeta(headA({ originator: "Codex Desktop", source: "desktop" }))!;
    expect(classifyCodexRolloutMeta(meta)).toBeNull();
  });

  test("首行未就绪（没有换行 / 不是 JSON / 不是 session_meta）⇒ null＝读不到，不判死", () => {
    expect(parseCodexRolloutMeta("")).toBeNull();
    expect(parseCodexRolloutMeta(headA().trimEnd())).toBeNull();
    expect(parseCodexRolloutMeta('{"timestamp":"x","type":"sess')).toBeNull();
    expect(parseCodexRolloutMeta('{"type":"event_msg","payload":{"originator":"Claude Code"}}\n')).toBeNull();
  });
});

describe("#976：按 session_id 定位 rollout 并作为首要信号", () => {
  let root: string;
  const day = join("2026", "08", "28");
  function writeRollout(uuid: string, body: string, stamp = "2026-08-28T14-47-19"): string {
    mkdirSync(join(root, day), { recursive: true });
    const path = join(root, day, `rollout-${stamp}-${uuid}.jsonl`);
    writeFileSync(path, body);
    return path;
  }
  const desktopChain: Array<[number, number, string]> = [
    [684, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"],
    [1230, 684, "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server"],
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
    resetCodexRolloutMetaCache();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    resetCodexRolloutMetaCache();
  });

  test("头 A：文件名 uuid 命中 ⇒ 非交互式，不需要进程表（ps 桩若被调用直接抛）", () => {
    writeRollout(DIRECT_ID, headA());
    const probe = probeCodexSessionKind({
      hookParentPid: 4242,
      sessionId: DIRECT_ID,
      rolloutRoot: root,
      spawn: (() => { throw new Error("ps must not run"); }) as never,
    });
    expect(probe.kind).toBe("non-interactive");
    expect(probe.detail).toContain("rollout");
  });

  test("头 B：文件名 uuid 是本线程 id、payload.session_id 是父线程——两种 id 都定位得到，都判非交互式", () => {
    writeRollout(SUBAGENT_ID, headB(), "2026-08-28T14-50-00");
    const spawn = (() => { throw new Error("ps must not run"); }) as never;
    expect(probeCodexSessionKind({ hookParentPid: 4242, sessionId: SUBAGENT_ID, rolloutRoot: root, spawn }).kind).toBe("non-interactive");
    resetCodexRolloutMetaCache();
    const byParent = probeCodexSessionKind({ hookParentPid: 4242, sessionId: PARENT_ID, rolloutRoot: root, spawn });
    expect(byParent.kind).toBe("non-interactive");
    expect(byParent.detail).toContain("subagent");
  });

  test("文件存在但首行还没落盘 ⇒ 退回 ps 探测（这里 ps 说是 ChatGPT.app ⇒ 交互式）", () => {
    writeRollout(DESKTOP_ID, "");
    const probe = probeCodexSessionKind({ hookParentPid: 1230, sessionId: DESKTOP_ID, rolloutRoot: root, spawn: psStub(desktopChain) });
    expect(probe.kind).toBe("interactive");
    expect(probe.detail).toContain("rollout 头读不到");
  });

  test("找不到 rollout（session_id 对不上任何文件）⇒ 退回 ps 探测", () => {
    writeRollout(DIRECT_ID, headA());
    const probe = probeCodexSessionKind({ hookParentPid: 1230, sessionId: DESKTOP_ID, rolloutRoot: root, spawn: psStub(desktopChain) });
    expect(probe.kind).toBe("interactive");
  });

  test("ChatGPT.app 桌面 codex：rollout 头读得到但 originator 不是 Claude Code ⇒ 无结论，进程形态判交互式（#966 保住）", () => {
    writeRollout(DESKTOP_ID, headA({ session_id: DESKTOP_ID, id: DESKTOP_ID, originator: "Codex Desktop", source: "desktop" }));
    const probe = probeCodexSessionKind({ hookParentPid: 1230, sessionId: DESKTOP_ID, rolloutRoot: root, spawn: psStub(desktopChain) });
    expect(probe.kind).toBe("interactive");
    expect(probe.detail).toContain("originator=Codex Desktop");
    expect(probe.detail).toContain("无结论");
  });

  test("rollout 无结论 + ps 也没结论 ⇒ unknown（决策层据此不拉）", () => {
    writeRollout(DESKTOP_ID, headA({ session_id: DESKTOP_ID, id: DESKTOP_ID, originator: "codex_cli_rs", source: "cli" }));
    const probe = probeCodexSessionKind({ hookParentPid: 4242, sessionId: DESKTOP_ID, rolloutRoot: root, spawn: psStub([[1, 0, "launchd"]]) });
    expect(probe.kind).toBe("unknown");
  });

  test("没给 session_id ⇒ 不碰 rollout 目录，直接进程探测", () => {
    const probe = probeCodexSessionKind({ hookParentPid: 1230, sessionId: null, rolloutRoot: join(root, "does-not-exist"), spawn: psStub(desktopChain) });
    expect(probe.kind).toBe("interactive");
    expect(probe.detail).not.toContain("rollout");
  });

  test("session_id 不是 uuid 形态 ⇒ 不扫目录", () => {
    expect(readCodexRolloutMeta("../../etc/passwd", root)).toBeNull();
    expect(readCodexRolloutMeta("not-a-uuid", root)).toBeNull();
  });

  test("旧签名 probeCodexSessionKind(pid, spawn) 仍可用", () => {
    expect(probeCodexSessionKind(1230, psStub(desktopChain)).kind).toBe("interactive");
  });
});

// coderabbit on #977：`env` 后面的 `KEY=VALUE` 赋值不是程序名，跳过它们再找真正在跑的可执行文件；
// 否则 `env RUST_LOG=info codex exec x` 会把 `RUST_LOG=info` 当程序、把 `codex` 当子命令，
// 一次性 codex 落回 interactive，#959 的拉起→发帧→回收又回来。
describe("包裹层解析：env 的 KEY=VALUE 赋值（#976）", () => {
  test("env 赋值之后的 codex 仍被识别，子命令取到 exec", () => {
    const line = "env RUST_LOG=info CODEX_HOME=/tmp/x codex exec --json do-it";
    expect({ harness: harnessAncestor(line), sub: codexSubcommand(line) }).toEqual({ harness: "codex", sub: "exec" });
  });
  test("env -S 与赋值混用同样跳过", () => {
    const line = "/usr/bin/env -S FOO=1 node /opt/homebrew/bin/codex app-server";
    expect({ harness: harnessAncestor(line), sub: codexSubcommand(line) }).toEqual({ harness: "codex", sub: "app-server" });
  });
  test("非 env 解释器后的 KEY=VALUE 不被当作赋值吞掉", () => {
    // node 没有 env 的赋值语义：`node A=B` 的 A=B 就是脚本参数位，不能跳过。
    expect(harnessAncestor("node A=B codex exec")).toBe(null);
  });
});
