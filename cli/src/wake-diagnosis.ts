// 「这台机器上这个身份叫不醒，因为 X」——终结静默失败（issue #924 第 4 条）。
//
// 之前解析不出唯一身份时，我们只往 `~/.agentparty/logs/codex-auto-wake.log` 里写一行。
// 那行没人看：用户看到的是「被 @ 了但什么都没弹」，然后开始怀疑网络、怀疑 token、怀疑服务端。
// owner 那台机器的排查花了一整轮才剥到第四层。
//
// 所以判定结果必须能被**主动查询**：`party doctor` 与 `party who` 都会显示这段，
// 而且每一种失败都配**一条可执行的命令**（`codexHookIdentityFix`），不留「无可奉告」的出口。
//
// 本模块纯读本地盘 + 至多一次 `ps`，不发网络、不写任何东西——诊断绝不能有副作用。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentpartyHome, readState } from "./config";
import {
  codexHookIdentityFix,
  defaultCodexHookIdentityDeps,
  resolveCodexHookIdentity,
  type CodexHookIdentityRefusal,
  type CodexHookIdentitySource,
} from "./codex-session-identity";
import { findJoinBindings, joinBindingsPath, readJoinBindings, type JoinBinding } from "./join-binding";

export interface CodexWakeDiagnosis {
  channel: string | null;
  /** 解析成功时的身份与来源。 */
  identity: string | null;
  server: string | null;
  source: CodexHookIdentitySource | null;
  /** 解析失败时的原因码与人话说明。 */
  reason: CodexHookIdentityRefusal | null;
  detail: string;
  /** 一条能直接粘贴执行的命令。成功时为 null。 */
  fix: string | null;
  /** 本机为 codex 记下的加入绑定（#924）。空＝这台机器还没加入即绑定过。 */
  bindings: JoinBinding[];
  /** Stop hook 在 codex 那边能不能跑（装了 ≠ 会跑，见 codexStopHookStatus）。 */
  hook: CodexStopHookStatus;
  /** 兼容字段：`hook !== "missing"`。 */
  hookInstalled: boolean;
}

/**
 * Stop hook 在 codex 那边到底能不能跑。
 *
 * 「装了」和「会跑」是两件事——真机上（#924 验收，codex 0.149）撞到的第二个静默断点：
 * codex 新增了 **hook 信任闸**，每条 hook 要在 `config.toml` 的
 * `[hooks.state."<hooks.json 路径>:<事件>:<组下标>:<条下标>"]` 里被显式信任（`enabled = true`）
 * 才会被执行；没批准的一律**静默跳过**。owner 那台机器上我们的 stop hook 恰恰是
 * `enabled = false`——也就是说身份解析得再对，hook 也根本不会被调用。
 * 这正是本 issue 要根除的那类「我们知道、用户不知道」的失败，必须报出来。
 */
export type CodexStopHookStatus = "ok" | "missing" | "needs-review" | "disabled";

function codexHomeDir(env: NodeJS.ProcessEnv, userHome: string): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome !== undefined && codexHome !== "" ? codexHome : join(userHome, ".codex");
}

/**
 * 我们那条 Stop hook 所在的 hooks.json 路径（跟着 CODEX_HOME 走，与 `party hook install --codex`
 * 的 settingsPath 同一口径）。给自检清单显示「在哪」用——说了「装了」就得说得出装在哪。
 */
export function codexHooksJsonPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): string {
  return join(codexHomeDir(env, userHome), "hooks.json");
}

/** 我们那条 stop hook 在 hooks.json 里的位置，转成信任表的键。找不到返回 null。 */
export function codexStopHookTrustKey(hooksPath: string, hooksJson: unknown): string | null {
  if (hooksJson === null || typeof hooksJson !== "object" || Array.isArray(hooksJson)) return null;
  const hooks = (hooksJson as Record<string, unknown>).hooks;
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const groups = (hooks as Record<string, unknown>).Stop;
  if (!Array.isArray(groups)) return null;
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    if (group === null || typeof group !== "object" || Array.isArray(group)) continue;
    const entries = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(entries)) continue;
    for (let h = 0; h < entries.length; h += 1) {
      const entry = entries[h];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const command = (entry as Record<string, unknown>).command;
      if (typeof command === "string" && command.includes("hook codex-stop")) {
        return `${hooksPath}:stop:${String(g)}:${String(h)}`;
      }
    }
  }
  return null;
}

export function codexStopHookStatus(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): CodexStopHookStatus {
  const dir = codexHomeDir(env, userHome);
  const hooksPath = join(dir, "hooks.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(hooksPath, "utf8")) as unknown;
  } catch {
    return "missing";
  }
  const key = codexStopHookTrustKey(hooksPath, parsed);
  if (key === null) return "missing";
  let config: unknown;
  try {
    config = Bun.TOML.parse(readFileSync(join(dir, "config.toml"), "utf8"));
  } catch {
    // 读不出 config.toml：老版本 codex 根本没有信任闸，别无中生有地报警。
    return "ok";
  }
  const hooks = config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).hooks
    : null;
  const state = hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>).state
    : null;
  // 整张信任表都不存在 ⇒ 这个 codex 版本没有信任闸（0.145 及更早）。不喊狼来了。
  if (state === null || typeof state !== "object" || Array.isArray(state)) return "ok";
  const row = (state as Record<string, unknown>)[key];
  if (row === undefined) return "needs-review";
  if (row !== null && typeof row === "object" && !Array.isArray(row)
    && (row as Record<string, unknown>).enabled === false) {
    return "disabled";
  }
  return "ok";
}

/** 兼容旧判定：只回答「装没装」。 */
export function codexStopHookInstalled(
  env: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): boolean {
  return codexStopHookStatus(env, userHome) !== "missing";
}

/**
 * 「如果现在有人 @ 这个 cwd 上的 codex 会话，我们叫得醒吗？」
 *
 * 判定跑的是**和 Stop hook 完全同一条**解析链（`resolveCodexHookIdentity`）——诊断与真实
 * 行为共用一份实现，绝不写第二套「诊断专用」的逻辑，否则诊断说好、真跑起来坏（本仓这条链上
 * 已经连续多次「测试全绿真机是坏的」）。
 */
export function diagnoseCodexWake(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): CodexWakeDiagnosis {
  const channel = env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel ?? null;
  const bindings = channel === null
    ? []
    : findJoinBindings(readJoinBindings(joinBindingsPath(agentpartyHome(env))), {
        harness: "codex",
        channel,
      });
  const hook = codexStopHookStatus(env);
  const hookInstalled = hook !== "missing";
  const resolved = resolveCodexHookIdentity({
    cwd,
    channel,
    sessionId: null,
    deps: defaultCodexHookIdentityDeps(env),
  });
  if (resolved.ok) {
    return {
      channel,
      identity: resolved.identity.name,
      server: resolved.identity.server,
      source: resolved.identity.source,
      reason: null,
      detail: "",
      fix: null,
      bindings,
      hook,
      hookInstalled,
    };
  }
  return {
    channel,
    identity: null,
    server: null,
    source: null,
    reason: resolved.reason,
    detail: resolved.detail,
    fix: codexHookIdentityFix(resolved.reason, { channel }),
    bindings,
    hook,
    hookInstalled,
  };
}

/**
 * 渲染成给人看的几行。**失败必须一眼看出**：一行结论、一行原因、一行可执行命令，不多不少。
 */
/**
 * 这份诊断该不该主动说出来（#924/#926）。
 *
 * 判据是「会不会跑」，**不是**「装没装」：`hookInstalled` 只排除了 `missing`，
 * 而真机上最常见的断点是信任闸没过（`disabled` / `needs-review`）——那时 hook 一次都不会
 * 被调用，却会被 `hookInstalled` 判成正常，于是 who 继续沉默。只有 `ok` 才算通。
 */
export function shouldSurfaceCodexWakeDiagnosis(d: CodexWakeDiagnosis): boolean {
  return d.identity === null || d.hook !== "ok";
}

export function formatCodexWakeDiagnosis(d: CodexWakeDiagnosis): string[] {
  const out: string[] = [];
  if (d.channel === null) {
    out.push("wake (codex): 这个目录没绑频道，@ 无从谈起 → party init --channel <频道>");
  } else if (d.identity !== null) {
    out.push(`wake (codex): #${d.channel} 被 @ 时会唤醒 ${d.identity}@${d.server} （依据：${d.source}）`);
  } else {
    out.push(`wake (codex): #${d.channel} 上这台机器的 codex 会话【叫不醒】`);
    out.push(`  为什么: ${d.detail}`);
    out.push(`  怎么修: ${d.fix ?? ""}`);
  }
  // 身份解析得再对，hook 跑不起来也不会有人来问——这是完全独立的另一个断点，必须单独说。
  if (d.hook === "missing") {
    out.push("  另外: codex 的 hooks.json 里没有我们的 Stop hook，前台唤醒根本不会被触发");
    out.push("  怎么修: party hook install --codex   然后【新开一个 codex 会话】才生效");
  } else if (d.hook === "disabled") {
    out.push("  另外: hook 装了，但 codex 的信任闸把它标成了 enabled=false —— codex 会【静默跳过】它");
    // #942：这里**不再**复述「新开一个 codex 会话就会弹 hooks review」。那句话对 ChatGPT.app
    // 桌面版是假的（它不走 TUI 启动路径），对 0.149 以前的 codex 也是假的（那时还没有这道闸）。
    // 要给绝对路径就得先探测本机，而探测要 spawn 进程——doctor/who 这类热路径不该背这个成本。
    // 所以统一指向 `party wake check`：那里探测过，说得出该跑哪个二进制。
    out.push("  怎么修: party wake check   （它会说出该在【哪个 codex 二进制】里批准——直接跑 `codex` 未必是对的）");
  } else if (d.hook === "needs-review") {
    out.push("  另外: hook 装了但还没被 codex 信任 —— 未获批准的 hook 会被【静默跳过】");
    out.push("  怎么修: party wake check   （它会说出该在【哪个 codex 二进制】里批准——直接跑 `codex` 未必是对的）");
  }
  if (d.bindings.length === 0 && d.identity === null) {
    out.push("  提示: 本机还没有为 codex 记下任何加入绑定——重跑一遍该身份的接入包即可（加入即绑定，#924）");
  }
  return out;
}
