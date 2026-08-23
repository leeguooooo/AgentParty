// `party wake check` —— 接入包的最后一步，从「指令」改成「验证」（issue #910 / #926）。
//
// 之前接入包末尾是一句「接下来请在 codex TUI 里 Trust 一次」。没人读。owner 的原话：
// 「如果是用户怎么办，用户很少会有耐心一步步来」——把待办清单塞给用户，等于把我们的问题
// 推给他，而且他连自己失败了都不知道（hook 未获批准时 codex **静默跳过**，零报错）。
//
// 所以这里不再告诉用户「接下来该干什么」，而是**跑完直接告诉他还差几步、差哪一步**，
// 并且只给一条现在就能做的事。全程零网络、只读本地盘——接入的最后一步不该再多一个失败源。
//
// 边界（issue #926 明确划的，别越）：
//   - 绝不提、绝不写 `--dangerously-bypass-hook-trust`。那是让用户关掉一个安全控制来换我们的
//     功能。批准 hook 这一步只能让它**显眼**，不能让它消失。
//   - 绝不自动改用户的 `~/.codex/config.toml` 把 hook 置为 enabled——等于替用户点信任确认。
import { codexHooksJsonPath, type CodexWakeDiagnosis } from "./wake-diagnosis";

export interface WakeCheckStep {
  /** 稳定的机读 id（--json 消费方按它判，不按文案）。 */
  id: "channel_bound" | "identity_resolved" | "hook_installed" | "hook_trusted";
  ok: boolean;
  label: string;
  /** 通过时的证据（装在哪、解析成谁）；没有就空。 */
  evidence: string;
}

export interface WakeChecklist {
  channel: string | null;
  steps: WakeCheckStep[];
  /** 还差几步。0 = 通了。 */
  remaining: number;
  /**
   * 现在就该做的那一件事。**只给一件**——列三件等于没给，用户会挑最容易的那件做完就停。
   * 通了则为 null。
   */
  next: { do: string; note: string | null; verify: string } | null;
}

/** codex `exec` 不触发任何 hook（#910 附带发现）。凡是让人「去验证一下」的地方都必须带上这句。 */
export const CODEX_EXEC_NO_HOOKS_NOTE =
  "注意：`codex exec` 不触发任何 hook，只有交互式 TUI 会——别在 `codex exec` 里验证这一步，会得出「装了也没用」的错误结论。";

const VERIFY = "party wake check";

/**
 * 纯函数：一份诊断 → 一张「还差几步」的清单。
 *
 * 四步是**依次成立**的：没绑频道就谈不上身份，没装 hook 就谈不上批准。所以 next 永远取
 * 第一条未通过的——修后面那条对用户毫无意义。
 */
export function buildWakeChecklist(
  d: CodexWakeDiagnosis,
  env: NodeJS.ProcessEnv = process.env,
): WakeChecklist {
  const hooksPath = codexHooksJsonPath(env);
  const steps: WakeCheckStep[] = [
    {
      id: "channel_bound",
      ok: d.channel !== null,
      label: "这个目录绑了频道",
      evidence: d.channel === null ? "" : `#${d.channel}`,
    },
    {
      id: "identity_resolved",
      ok: d.identity !== null,
      label: "被 @ 时解析得出唯一身份",
      evidence: d.identity === null ? "" : `${d.identity}@${d.server ?? "?"}（依据：${d.source ?? "?"}）`,
    },
    {
      id: "hook_installed",
      ok: d.hook !== "missing",
      label: "codex 装了 AgentParty 的 Stop hook",
      evidence: d.hook === "missing" ? "" : hooksPath,
    },
    {
      // #925 的语义：老版本 codex 没有信任闸时 codexStopHookStatus 判 ok，这一步照样算通过，
      // 绝不对着一个根本没有这道闸的 codex 喊狼来了。
      id: "hook_trusted",
      ok: d.hook === "ok",
      label: "codex 批准了这条 hook（未获批准的 hook 会被静默跳过）",
      evidence: d.hook === "ok" ? "已生效" : "",
    },
  ];
  const failed = steps.find((s) => !s.ok);
  return {
    channel: d.channel,
    steps,
    remaining: steps.filter((s) => !s.ok).length,
    next: failed === undefined ? null : nextActionFor(failed.id, d),
  };
}

function nextActionFor(id: WakeCheckStep["id"], d: CodexWakeDiagnosis): WakeChecklist["next"] {
  switch (id) {
    case "channel_bound":
      return { do: "party init --channel <频道>", note: null, verify: VERIFY };
    case "identity_resolved":
      // 身份解析失败的每一种原因，#925 都已经算好了对应的那条命令；这里不另写一套判定。
      return { do: d.fix ?? "重跑一遍这个身份的接入包（加入即绑定，#924）", note: d.detail || null, verify: VERIFY };
    case "hook_installed":
      return {
        do: "party hook install --codex   然后【新开一个 codex 会话】才生效",
        note: CODEX_EXEC_NO_HOOKS_NOTE,
        verify: VERIFY,
      };
    case "hook_trusted":
      return {
        do:
          "新开一个 codex 交互式会话（直接跑 `codex`）；启动时它会提示 \"Hooks need review\"，" +
          "在那里把 AgentParty 的 stop hook 选为启用。",
        note: CODEX_EXEC_NO_HOOKS_NOTE,
        verify: VERIFY,
      };
  }
}

/** 渲染成给人看的几行。通过与否都必须**一眼**看出，不要求人去数勾。 */
export function formatWakeChecklist(c: WakeChecklist): string[] {
  const out: string[] = [`接入自检${c.channel === null ? "" : ` · #${c.channel}`}`];
  for (const step of c.steps) {
    const mark = step.ok ? "✓" : "✗";
    out.push(`  ${mark} ${step.label}${step.evidence === "" ? "" : `    ${step.evidence}`}`);
  }
  out.push("");
  if (c.next === null) {
    out.push("全部通过：现在 @ 这个身份，这台机器上的 codex 会话会在一轮结束时把它取走。");
    return out;
  }
  out.push(`还差 ${c.remaining} 步。现在只做这一件事：`);
  out.push(`  ${c.next.do}`);
  if (c.next.note !== null) out.push(`  ${c.next.note}`);
  out.push(`  做完回来再跑一次：${c.next.verify}`);
  out.push("");
  // 这句是整张清单存在的理由：这类失败**没有任何报错**，不明说就没人知道自己坏了。
  out.push("在这一步完成之前：@ 你不会有任何反应，而且不会有任何报错——别人只会以为你在忙。");
  return out;
}
