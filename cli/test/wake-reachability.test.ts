// #926：MCP 启动时的唤醒自检——判定谁该被上报、上报什么，以及接入包最后那张「还差几步」的清单。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWakeSelfCheck, isLocalCodexIdentity, wakeBlockForCodexHook } from "../src/wake-reachability";
import { buildWakeChecklist, formatWakeChecklist, CODEX_EXEC_NO_HOOKS_NOTE } from "../src/wake-checklist";
import type { JoinBinding } from "../src/join-binding";
import type { CodexWakeDiagnosis } from "../src/wake-diagnosis";

const NOW = 1_700_000_000_000;
const SERVER = "https://agentparty.leeguoo.com";

function binding(over: Partial<JoinBinding> = {}): JoinBinding {
  return {
    harness: "codex",
    server: SERVER,
    channel: "agentparty",
    owner: "leo",
    identity: "lark-codex1",
    config_path: "/x/config.json",
    cwd: "/x",
    created_at: NOW,
    ...over,
  };
}

const base = {
  bindings: [] as JoinBinding[],
  server: SERVER,
  channel: "agentparty",
  identity: "lark-codex1",
  now: NOW,
};

describe("#926 自检判定：谁该被上报", () => {
  test("祖先链上跑着 codex → 就是 codex 身份（最直接的事实）", () => {
    expect(isLocalCodexIdentity({ ...base, harness: () => "codex" })).toBe(true);
  });

  test("探测不出 harness 时，加入绑定（#924）是唯一还站得住的判据", () => {
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [binding()] })).toBe(true);
  });

  // #865：本机两台生产实例都有 #agentparty。只按频道名匹配会把隔壁实例的同名身份认成本机的。
  // fixture 只差 server 一个字段，别的全同——所以只有 server 那道比对能决定结果。
  test("server 维度：隔壁实例的同名身份不算数（#865）", () => {
    const elsewhere = binding({ server: "https://agentparty.pwtk-dev.work" });
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [elsewhere] })).toBe(false);
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [binding()] })).toBe(true);
  });

  test("末尾斜杠不影响 server 比对", () => {
    const trailing = binding({ server: `${SERVER}/` });
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [trailing] })).toBe(true);
  });

  test("同频道同 server 但别的身份 / 别的 harness 都不算数", () => {
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [binding({ identity: "someone-else" })] })).toBe(false);
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [binding({ harness: "claude" })] })).toBe(false);
    expect(isLocalCodexIdentity({ ...base, harness: () => null, bindings: [binding({ channel: "other" })] })).toBe(false);
  });

  test("非 codex 身份一律 skip —— 我们对它的唤醒层一无所知，绝不报「一切正常」", () => {
    const d = decideWakeSelfCheck({ ...base, harness: () => "claude", hookStatus: () => "disabled" });
    expect(d.report).toBe("skip");
  });

  // 这条钉死「装了 ≠ 会跑」：hookStatus 是唯一变量，其余每一道闸都放行。
  for (const status of ["disabled", "needs-review", "missing"] as const) {
    test(`codex 身份 + hook=${status} → 上报 block`, () => {
      const d = decideWakeSelfCheck({ ...base, harness: () => "codex", hookStatus: () => status });
      expect(d.report).toBe("block");
      if (d.report !== "block") throw new Error("unreachable");
      expect(d.block.fix).toBe("party wake check");
      expect(d.block.detail).not.toContain("dangerously-bypass-hook-trust");
      expect(d.block.ts).toBe(NOW);
    });
  }

  // #925 语义：老版本 codex 没有信任闸时判 ok，不喊狼来了。clear 是自愈的正路。
  test("codex 身份 + hook=ok → clear（修好后新开会话就会走到这里）", () => {
    const d = decideWakeSelfCheck({ ...base, harness: () => "codex", hookStatus: () => "ok" });
    expect(d.report).toBe("clear");
    expect(wakeBlockForCodexHook("ok", NOW)).toBeNull();
  });
});

function diagnosis(over: Partial<CodexWakeDiagnosis> = {}): CodexWakeDiagnosis {
  return {
    channel: "agentparty",
    identity: "lark-codex1",
    server: SERVER,
    source: "join-binding",
    reason: null,
    detail: "",
    fix: null,
    bindings: [],
    hook: "ok",
    hookInstalled: true,
    ...over,
  };
}

describe("#910 接入包最后一步：验证，不是指令", () => {
  const home = (() => {
    const dir = mkdtempSync(join(tmpdir(), "wake-check-codex-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hooks.json"), "{}");
    return dir;
  })();
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv;

  test("四步全通 → remaining=0、没有 next，退出口径是「通了」", () => {
    const c = buildWakeChecklist(diagnosis(), env);
    expect(c.remaining).toBe(0);
    expect(c.next).toBeNull();
    expect(formatWakeChecklist(c).join("\n")).toContain("全部通过");
  });

  // 本 issue 的目标形态：装了、身份也解析得出、就差信任闸。
  // fixture 让前三步**全部通过**，于是 remaining/next 只可能由信任闸那一步决定。
  for (const hook of ["disabled", "needs-review"] as const) {
    test(`只差信任闸（hook=${hook}）→ 明确说还差 1 步，并只给这一件事`, () => {
      const c = buildWakeChecklist(diagnosis({ hook }), env);
      expect(c.remaining).toBe(1);
      expect(c.steps.filter((s) => !s.ok).map((s) => s.id)).toEqual(["hook_trusted"]);
      const text = formatWakeChecklist(c).join("\n");
      expect(text).toContain("还差 1 步");
      expect(text).toContain("Hooks need review");
      // #910 附带发现：codex exec 不触发任何 hook。不写这句，人会在 exec 里验一遍得出错误结论。
      expect(text).toContain("codex exec");
      expect(c.next!.note).toBe(CODEX_EXEC_NO_HOOKS_NOTE);
      // 绝不建议绕过安全闸。
      expect(text).not.toContain("dangerously-bypass-hook-trust");
      // 这类失败没有任何报错——不明说就没人知道自己坏了。
      expect(text).toContain("不会有任何报错");
    });
  }

  test("没装 hook → next 是安装那一步，而不是「去批准」（顺序不能乱）", () => {
    const c = buildWakeChecklist(diagnosis({ hook: "missing", hookInstalled: false }), env);
    expect(c.steps.filter((s) => !s.ok).map((s) => s.id)).toEqual(["hook_installed", "hook_trusted"]);
    expect(c.next!.do).toContain("party hook install --codex");
  });

  test("身份解析不出来时，next 复用 #925 已经算好的那条命令，不另写一套", () => {
    const c = buildWakeChecklist(
      diagnosis({ identity: null, server: null, source: null, reason: "ambiguous", detail: "两个身份", fix: "party mcp identities" }),
      env,
    );
    expect(c.next!.do).toBe("party mcp identities");
    expect(c.next!.note).toBe("两个身份");
  });

  test("没绑频道时先解决频道——后面每一步都建立在它之上", () => {
    const c = buildWakeChecklist(diagnosis({ channel: null, identity: null, source: null, server: null }), env);
    expect(c.next!.do).toContain("party init --channel");
  });
});
