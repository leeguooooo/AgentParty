// #926：MCP 启动时的唤醒自检——判定谁该被上报、上报什么，以及接入包最后那张「还差几步」的清单。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWakeSelfCheck, isLocalCodexIdentity, wakeBlockForCodexHook } from "../src/wake-reachability";
import { buildWakeChecklist, formatWakeChecklist, CODEX_EXEC_NO_HOOKS_NOTE } from "../src/wake-checklist";
import type { CodexBinary, CodexTrustGateProbe } from "../src/codex-trust-gate";
import type { CodexHookTarget, CodexTrustRemedy } from "../src/codex-hook-trust";
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

const DESKTOP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const SHIM_BIN = "/var/folders/f1/xx/T/cmux-cli-shims/84883385/codex";

function bin(over: Partial<CodexBinary> & { path: string }): CodexBinary {
  return { origin: "path", app: null, version: null, gate: null, probed: true, ...over };
}

/** 终端形态：PATH 上那个自己就带闸——文案维持 #910 的老样子。 */
const TERMINAL_PROBE: CodexTrustGateProbe = (() => {
  const onPath = bin({ path: "/opt/homebrew/bin/codex", version: "codex-cli 0.149.0", gate: true });
  return { onPath, candidates: [onPath], gated: [onPath], desktop: null };
})();

const FAKE_HOOKS = "/tmp/codexhome/hooks.json";
const OURS_STOP_KEY = `${FAKE_HOOKS}:stop:2:0`;

function trustTarget(state: "disabled" | "absent"): CodexHookTarget {
  return {
    kind: "codex-stop",
    label: "前台唤醒",
    event: "Stop",
    group: 2,
    index: 0,
    key: OURS_STOP_KEY,
    command: "party hook codex-stop",
    state,
    trustedHash: state === "disabled" ? "sha256:ours" : null,
  };
}

/** 我们那条带着 hash 且 enabled=false —— codex 再也不会问，只能由我们写（#942 第二轮）。 */
function remedy(state: "disabled" | "absent"): CodexTrustRemedy {
  const targets = [trustTarget(state)];
  return {
    hooksPath: FAKE_HOOKS,
    configPath: "/tmp/codexhome/config.toml",
    targets,
    enableable: targets.filter((t) => t.state === "disabled"),
    absent: targets.filter((t) => t.state === "absent"),
    snippet: ["PASTE-THIS"],
    detail: "",
  };
}

/** owner 那台机器（#942）：桌面版带闸、PATH 上是 0.145 的 shim。 */
const DESKTOP_PROBE: CodexTrustGateProbe = (() => {
  const desktop = bin({ path: DESKTOP_BIN, origin: "running", app: "ChatGPT", version: "codex-cli 0.149.0-alpha.4.1", gate: true });
  const onPath = bin({ path: SHIM_BIN, version: "codex-cli 0.145.0", gate: false });
  return { onPath, candidates: [desktop, onPath], gated: [desktop], desktop };
})();

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
      // remedy 跟着 hook 状态走，别造出「诊断说 disabled、信任表说没这条」的矛盾组合。
      const c = buildWakeChecklist(
        diagnosis({ hook }),
        env,
        () => TERMINAL_PROBE,
        () => remedy(hook === "disabled" ? "disabled" : "absent"),
      );
      expect(c.remaining).toBe(1);
      expect(c.steps.filter((s) => !s.ok).map((s) => s.id)).toEqual(["hook_trusted"]);
      const text = formatWakeChecklist(c).join("\n");
      expect(text).toContain("还差 1 步");
      // 底线交付（#942 第二轮）：无论走到哪一档，用户都必须拿到「粘这个」。
      expect(text).toContain("PASTE-THIS");
      // #910 附带发现：codex exec 不触发任何 hook。不写这句，人会在 exec 里验一遍得出错误结论。
      expect(text).toContain("codex exec");
      expect(c.next!.notes).toContain(CODEX_EXEC_NO_HOOKS_NOTE);
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
    expect(c.next!.notes).toEqual(["两个身份"]);
  });

  test("没绑频道时先解决频道——后面每一步都建立在它之上", () => {
    const c = buildWakeChecklist(diagnosis({ channel: null, identity: null, source: null, server: null }), env);
    expect(c.next!.do).toContain("party init --channel");
  });

  // ── #942：修法本身错了 ────────────────────────────────────────────────────
  // 前三步在这里**全部通过**，hook 也固定为 needs-review，于是 next 只可能由信任闸那一步决定；
  // 两个 fixture 之间唯一的差别是「哪个二进制带闸」，所以只有那道判定能决定输出。

  // 两个 fixture 之间**只差 remedy 那一个变量**（探测结果都固定成 DESKTOP_PROBE），
  // 所以只有「条目在信任表里是什么状态」这道判定能决定输出。
  test("#942 带 hash 且 enabled=false ⇒ next 是 party hook install --codex（codex 那边已经没有入口了）", () => {
    const c = buildWakeChecklist(diagnosis({ hook: "disabled" }), env, () => DESKTOP_PROBE, () => remedy("disabled"));
    expect(c.next!.do).toContain("party hook install --codex");
    expect(c.next!.do).not.toContain("直接跑 `codex`");
    expect(c.next!.do).not.toContain(DESKTOP_BIN);
    const text = formatWakeChecklist(c).join("\n");
    expect(text).toContain("再也不会问");
    // 底线交付：兜底的「粘这个」在任何一档都要给得出。
    expect(text).toContain("PASTE-THIS");
  });

  test("#942 对照：条目还没进信任表 ⇒ 才轮到「去带闸的那个二进制里批准」", () => {
    const c = buildWakeChecklist(diagnosis({ hook: "needs-review" }), env, () => DESKTOP_PROBE, () => remedy("absent"));
    expect(c.next!.do).toContain(DESKTOP_BIN);
    expect(c.next!.do).not.toContain("party hook install --codex");
  });

  test("#942 PATH 上版本过低时必须明说（否则用户以为自己照做了）", () => {
    const c = buildWakeChecklist(diagnosis({ hook: "disabled" }), env, () => DESKTOP_PROBE, () => remedy("disabled"));
    const text = formatWakeChecklist(c).join("\n");
    expect(text).toContain("codex-cli 0.145.0");
    expect(text).toContain(SHIM_BIN);
    expect(text).toContain("没有 hook 信任闸");
  });

  test("#942 对照：PATH 上那个自己带闸 + 条目还没进表 ⇒ 直接跑 codex，也不拿版本吓唬人", () => {
    const c = buildWakeChecklist(diagnosis({ hook: "needs-review" }), env, () => TERMINAL_PROBE, () => remedy("absent"));
    const text = formatWakeChecklist(c).join("\n");
    expect(c.next!.do).toContain("直接跑 `codex`");
    expect(text).not.toContain("没有 hook 信任闸");
    expect(text).not.toContain(DESKTOP_BIN);
  });

  test("#942 探测抛异常也要给出建议，且绝不让自检本身挂掉（fail-open）", () => {
    const c = buildWakeChecklist(
      diagnosis({ hook: "needs-review" }),
      env,
      () => {
        throw new Error("probe exploded");
      },
      () => remedy("disabled"),
    );
    expect(c.remaining).toBe(1);
    const text = formatWakeChecklist(c).join("\n");
    expect(text).toContain("没探测到任何 codex 二进制");
    expect(text).toContain("codex exec");
    expect(text).not.toContain("dangerously-bypass-hook-trust");
  });

  test("#942 读 config.toml 抛异常同样不能炸", () => {
    const c = buildWakeChecklist(diagnosis({ hook: "disabled" }), env, () => TERMINAL_PROBE, () => {
      throw new Error("remedy exploded");
    });
    expect(c.remaining).toBe(1);
    expect(formatWakeChecklist(c).join("\n")).toContain("codex exec");
  });
});
