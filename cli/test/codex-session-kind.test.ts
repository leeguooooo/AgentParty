// #959：一次性 / 嵌入式 codex 会话不该拉唤醒层——判定必须在 SessionStart 那一刻、按进程形态做出。
//
// 进程表全部照抄真机 `ps -axo pid=,ppid=,args=` 的形态：
//   - Claude 插件的 codex-rescue：`spawn("codex", ["app-server"])`，父进程是 node 脚本，再上面是 claude；
//   - 桌面 codex：/Applications/ChatGPT.app/Contents/Resources/codex … app-server；
//   - 终端 TUI：codex ← zsh ← iTerm。
import { describe, expect, test } from "bun:test";
import { classifyCodexSession, codexSubcommand, probeCodexSessionKind } from "../src/codex-session-kind";
import type { ProcessRow } from "../src/join-binding";

function table(rows: Array<[pid: number, ppid: number, args: string]>): Map<number, ProcessRow> {
  return new Map(rows.map(([pid, ppid, args]) => [pid, { ppid, args }]));
}

describe("子命令解析", () => {
  test("跳过全局选项及其取值，拿到真正的子命令", () => {
    expect(codexSubcommand("codex -c features.x=true -m gpt-5 exec --json 'do it'")).toBe("exec");
    expect(codexSubcommand("/Applications/ChatGPT.app/Contents/Resources/codex -c a=b app-server --flag")).toBe("app-server");
    expect(codexSubcommand("codex --full-auto")).toBeNull();
    expect(codexSubcommand("codex")).toBeNull();
    expect(codexSubcommand("codex e")).toBe("e");
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
    expect(probe.detail).toContain("claude");
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
