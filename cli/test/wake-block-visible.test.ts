// #926：「装了、看起来正常、其实叫不醒、而且没人被告知」这个状态必须不复存在。
//
// 本文件钉死本次故障形态的**唯一验收条件**：
//   hook 处于 disabled / needs-review 时，@ 该身份的**发送方**能看到明确提示。
// 这条不存在等于没修——所以它单独成文件，不混进别的 describe 里被顺手删掉。
//
// ── fixture 的设计要点（别改坏）──────────────────────────────────────────────
// 每个 fixture 都刻意让**除 wake_block 以外的每一道闸都判「一切正常」**：
//   live=true、state=working、last_seen=now、wake=serve、kind=agent、未 paused。
// 于是断言只可能被 wake_block 那一道闸决定。这是针对我在 #925 踩过的假绿形态的直接防御：
// 那次断言写对了，但 fixture 让另一个分支（identity === null）单独满足了条件，
// 把被测的闸整个遮住，退回旧实现照样全绿。
import { describe, expect, test } from "bun:test";
import type { PresenceEntry, WakeBlock } from "@agentparty/shared";
import { activeWakeBlock, formatReach, formatUnreachable, reachOf, unreachableOf } from "../src/reach";
import { wakeBlockForCodexHook } from "../src/wake-reachability";

const NOW = 1_000_000_000;

const BLOCK: Record<"disabled" | "needs-review", WakeBlock> = {
  disabled: wakeBlockForCodexHook("disabled", NOW)!,
  "needs-review": wakeBlockForCodexHook("needs-review", NOW)!,
};

/**
 * 一个**每一道闸都判「一切正常」**的目标：在线、live、心跳新鲜、有 serve 唤醒层、是 agent、没暂停。
 * 唯一的变量是 wake_block。
 */
function healthyLooking(over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    name: "lark-codex1",
    kind: "agent",
    state: "working",
    note: null,
    ts: NOW,
    last_seen: NOW,
    live: true,
    wake: { kind: "serve", verified_at: NOW },
    ...over,
  };
}

describe("#926 发送方当场看得见「叫不醒」", () => {
  for (const status of ["disabled", "needs-review"] as const) {
    test(`hook=${status} 时，@ 这个身份的发送方拿到明确的 unreachable 提示`, () => {
      const entry = healthyLooking({ wake_block: BLOCK[status] });
      // 先自证 fixture：把 wake_block 摘掉，这一行就是「完全健康」——
      // 也就是说下面的断言不可能是别的闸凑出来的。
      expect(unreachableOf("lark-codex1", [healthyLooking()], NOW)).toBeNull();

      const u = unreachableOf("lark-codex1", [entry], NOW);
      expect(u).not.toBeNull();
      expect(u!.reason).toBe("wake_blocked");

      const line = formatUnreachable(u!);
      // ① 明说叫不醒，不含糊成 offline / 「重连就好」。
      expect(line).toContain("叫不醒");
      // ② 说清为什么（对方那台机器的 hook 信任闸）。
      expect(line).toContain("hook");
      // ③ 带一条能原样转给对方执行的命令。
      expect(line).toContain("party wake check");
      // ④ 绝不建议绕过 codex 的安全控制。
      expect(line).not.toContain("dangerously-bypass-hook-trust");
    });

    test(`hook=${status} 时 reach 行不谎报 online（#926 核心：它看起来最正常）`, () => {
      const r = reachOf("lark-codex1", [healthyLooking({ wake_block: BLOCK[status] })], NOW);
      // 同一份 fixture 去掉 wake_block 就是 online——只有被测的这道闸能改变结论。
      expect(reachOf("lark-codex1", [healthyLooking()], NOW).reach).toBe("online");
      expect(r.reach).not.toBe("online");
      expect(r.block?.reason).toBe(status === "disabled" ? "codex_hook_disabled" : "codex_hook_needs_review");
      const text = formatReach(r);
      expect(text).toContain("wake blocked");
      expect(text).not.toContain("online");
    });
  }

  // #925 已确立的语义，别改坏：老版本 codex 没有信任闸 ⇒ ok ⇒ 不产生任何 block，不喊狼来了。
  test("hook=ok 不产生 wake_block，发送方一个字也不该多看到", () => {
    expect(wakeBlockForCodexHook("ok", NOW)).toBeNull();
    const r = reachOf("lark-codex1", [healthyLooking()], NOW);
    expect(r.block).toBeUndefined();
    expect(r.reach).toBe("online");
    expect(unreachableOf("lark-codex1", [healthyLooking()], NOW)).toBeNull();
  });

  // 陈旧兜底：目标那台机器再也不启动了，别让一条永不更新的判定挂到天荒地老。
  test("超过 TTL 的自报不再算数（只兜底，判定权仍在目标那台机器上）", () => {
    const stale: WakeBlock = { ...BLOCK.disabled, ts: NOW - 8 * 24 * 60 * 60 * 1000 };
    expect(activeWakeBlock(healthyLooking({ wake_block: stale }), NOW)).toBeUndefined();
    expect(reachOf("lark-codex1", [healthyLooking({ wake_block: stale })], NOW).reach).toBe("online");
  });

  // 顺序即语义：wake_block 必须在 online 判定**之前**。这条测的是「先后」，不是「有无」——
  // 把 unreachableOf 里那一段挪到 online 判定之后，上面的主断言会红，这条也会红。
  test("离线 + 无唤醒层的目标也照样给出 wake_blocked（而不是退回 no_wake）", () => {
    const entry = healthyLooking({
      state: "offline",
      live: false,
      last_seen: NOW - 88 * 60 * 60 * 1000,
      wake: { kind: "none" },
      wake_block: BLOCK.disabled,
    });
    const u = unreachableOf("lark-codex1", [entry], NOW);
    // 两条路都会判「不可达」，但结论完全不同：no_wake 会让人去装 hook（已经装了），
    // wake_blocked 才指向真正的那一步。报错的方向错了，用户就会在错的地方绕圈。
    expect(u!.reason).toBe("wake_blocked");
  });

  // 人类会话没有本机唤醒层可言，服务端也只接受 agent 自报——这里守住消费侧不越界。
  test("人类身份不进这一档", () => {
    const entry = healthyLooking({ kind: "human", state: "offline", live: false, wake_block: BLOCK.disabled });
    expect(unreachableOf("lark-codex1", [entry], NOW)).toBeNull();
  });
});
