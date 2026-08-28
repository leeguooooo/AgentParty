import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import {
  activityNote,
  busyNote,
  classify,
  HELP_TEXT,
  identityNote,
  livenessNote,
  sessionNote,
  taskNote,
  terminalIdentityText,
  unhandledMentionNote,
  buildRows,
  renderRow,
  waitingOwnerNote,
  wakeGuidanceNote,
  wakeGuidanceOf,
  wakeHarnessOf,
  deferredQueueNote,
} from "../src/commands/who";
import { buildPullWakeLookup, hasCodexStopHook, locallyConfiguredNames, type PullWakeLookup } from "../src/pull-wake";
import type { CodexStopHookStatus } from "../src/wake-diagnosis";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = 1_000_000_000;

function p(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, kind: "agent", ...over };
}

describe("who classify（#47：可唤醒判定按 wake.kind 分口径）", () => {
  test("连接中且新鲜 → online", () => {
    expect(classify(p({ name: "bob" }), NOW)?.tier).toBe("online");
  });

  test("fresh 的 serve/watch → wakeable（supervisor 还活着）", () => {
    const serve = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" } }), NOW);
    expect(serve?.tier).toBe("wakeable");
    const watch = classify(p({ name: "bot", state: "offline", wake: { kind: "watch" } }), NOW);
    expect(watch?.tier).toBe("wakeable");
  });

  test("offline 13 分钟的 serve → recent（listener 租约已过期，#454）", () => {
    const r = classify(p({ name: "computer-use-mini", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
    expect(r?.wake_unverified).toBeUndefined();
  });

  test("offline 13 分钟的 watch → recent，不能把已死 listener 报成 wakeable（#454）", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "watch" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
    expect(r?.wake_unverified).toBeUndefined();
  });

  test("陈旧的 serve 即使曾验证过也 → recent；历史成功不能替代当前 listener 租约（#454）", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "serve", verified_at: NOW - 60_000 }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
    expect(r?.wake_unverified).toBeUndefined();
  });

  test("human_driven 的 watch 不算 wakeable（需要人工/外层 harness 接续）→ recent", () => {
    const r = classify(p({ name: "bot", state: "offline", residency: "human_driven", wake: { kind: "watch" } }), NOW);
    expect(r?.tier).toBe("recent");
  });

  test("offline 的 webhook 仍是 wakeable：服务端投递，不靠本地 supervisor", () => {
    const r = classify(p({ name: "hook-bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("wakeable");
    expect(r?.wake).toBe("webhook");
  });

  test("超过 14 天的幽灵一律不列（webhook 也不豁免）", () => {
    const age = 15 * 24 * 60 * 60 * 1000;
    expect(classify(p({ name: "ghost", state: "offline", wake: { kind: "serve" }, last_seen: NOW - age }), NOW)).toBeNull();
    expect(classify(p({ name: "ghost", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - age }), NOW)).toBeNull();
  });

  test("不在线的人类不列", () => {
    expect(classify(p({ name: "leo", kind: "human", state: "offline", last_seen: NOW - 120_000 }), NOW)).toBeNull();
  });
});

// #664：recent 档把「最近露面、或许在轮询」和「真·死了、@ 落历史无人应」混在一起，误导人以为 recent = 还能叫醒。
// 对后者（无活 wake 通道 + 陈旧）单独标 unreachable，让人一眼看清「@ 它白发」。
describe("who classify recent unreachable 标注（#664）", () => {
  test("offline + 无 wake layer + 陈旧(88h) → recent 且 unreachable", () => {
    const r = classify(p({ name: "kyc-claude", state: "offline", wake: { kind: "none" }, last_seen: NOW - 88 * 60 * 60 * 1000 }), NOW);
    expect(r?.tier).toBe("recent");
    expect(r?.unreachable).toBe(true);
  });

  test("陈旧的 serve（supervisor 已死）→ recent 且 unreachable（无活 wake 通道）", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
    expect(r?.unreachable).toBe(true);
  });

  test("fresh 的 serve → wakeable，不标 unreachable", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" } }), NOW);
    expect(r?.tier).toBe("wakeable");
    expect(r?.unreachable).toBeUndefined();
  });

  test("offline webhook → wakeable，不标 unreachable（服务端投递真能唤醒）", () => {
    const r = classify(p({ name: "hook", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 2 * 60 * 60 * 1000 }), NOW);
    expect(r?.tier).toBe("wakeable");
    expect(r?.unreachable).toBeUndefined();
  });

  test("online → 不标 unreachable", () => {
    expect(classify(p({ name: "bob" }), NOW)?.unreachable).toBeUndefined();
  });

  test("刚断线(<STALE_MS)且无 wake → recent 但不急着判死，不标 unreachable", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "none" }, last_seen: NOW - 30_000 }), NOW);
    expect(r?.tier).toBe("recent");
    expect(r?.unreachable).toBeUndefined();
  });
});

describe("who classify 暂停接待（#180：paused 与 offline 视觉/语义区分）", () => {
  test("被暂停的 agent 带出 paused + resume_at，供 who 独立渲染", () => {
    const r = classify(p({ name: "bot", state: "waiting", paused: true, resume_at: NOW + 3_600_000 }), NOW);
    expect(r).not.toBeNull();
    expect(r?.paused).toBe(true);
    expect(r?.resume_at).toBe(NOW + 3_600_000);
  });

  test("无 resume_at 的暂停（开放式）：paused 为 true，不带 resume_at", () => {
    const r = classify(p({ name: "bot", state: "waiting", paused: true }), NOW);
    expect(r?.paused).toBe(true);
    expect(r?.resume_at).toBeUndefined();
  });

  test("暂停即使离线很久也照列（人主动保留的状态，不当幽灵清掉）", () => {
    const stale = 20 * 24 * 60 * 60 * 1000; // 超过 14 天幽灵阈值
    const r = classify(p({ name: "bot", state: "offline", paused: true, last_seen: NOW - stale }), NOW);
    expect(r).not.toBeNull();
    expect(r?.paused).toBe(true);
  });

  test("未暂停的 agent 不带 paused 字段（诚实留白）", () => {
    const r = classify(p({ name: "bot", state: "working" }), NOW);
    expect(r?.paused).toBeUndefined();
  });
});

describe("who 身份分层（#110：who --json 不再对 presence 已有的身份信息保持沉默）", () => {
  // presence 里 name / kind / account / handle / display_name 是五层身份；who 只吐 name 时，
  // 想 @ 一个人类的 agent 从 who 里看不到 handle，@ 名字送不到（web 通知按 handle 命中）。
  test("在线人类：handle / account / display_name 原样带出，与 presence 一致", () => {
    const e = p({
      name: "web-login-uuid",
      kind: "human",
      state: "working",
      account: "davianpearson1@gmail.com",
      handle: "leo",
      display_name: "Davian Pearson",
    });
    const r = classify(e, NOW);
    expect(r).not.toBeNull();
    expect(r?.handle).toBe("leo");
    expect(r?.account).toBe("davianpearson1@gmail.com");
    expect(r?.display_name).toBe("Davian Pearson");
  });

  test("agent 也带出 account（owner/账号），供归属展示", () => {
    const r = classify(p({ name: "leeguooooo-agentparty-mini2", account: "leeguooooo@gmail.com" }), NOW);
    expect(r?.account).toBe("leeguooooo@gmail.com");
  });

  test("缺字段就省略（不无中生有 null/空串），诚实留白", () => {
    const r = classify(p({ name: "bob" }), NOW);
    expect(r).not.toBeNull();
    expect("handle" in (r as object)).toBe(false);
    expect("account" in (r as object)).toBe(false);
    expect("display_name" in (r as object)).toBe(false);
  });

  test("空串等同缺失：不下发（presence 层不会给空串，但防御性对齐）", () => {
    const r = classify(p({ name: "bob", handle: "", account: "", display_name: "" }), NOW);
    expect("handle" in (r as object)).toBe(false);
    expect("account" in (r as object)).toBe(false);
    expect("display_name" in (r as object)).toBe(false);
  });

  // 绑定真实观测路径：who --json 打印的是 JSON.stringify(classify(...))，断言序列化后 key 真的在。
  test("JSON.stringify（who --json 的真实输出）含 handle/account/display_name 且值一致", () => {
    const e = p({
      name: "web-login-uuid",
      kind: "human",
      state: "working",
      account: "davianpearson1@gmail.com",
      handle: "leo",
      display_name: "Davian Pearson",
    });
    const line = JSON.stringify(classify(e, NOW));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.handle).toBe("leo");
    expect(parsed.account).toBe("davianpearson1@gmail.com");
    expect(parsed.display_name).toBe("Davian Pearson");
    // 与 presence 输入的值逐字一致（不是只断言 key 存在）
    expect(parsed.handle).toBe(e.handle);
    expect(parsed.account).toBe(e.account);
    expect(parsed.display_name).toBe(e.display_name);
  });

  // 终端行（非 --json）也要能看见 @handle，否则人类读 who 仍不知道该 @ 谁。
  test("identityNote：@handle 出现在人类可读行里；handle==name 时不重复", () => {
    const withHandle = classify(
      p({ name: "web-login-uuid", kind: "human", state: "working", handle: "leo", account: "a@b.com" }),
      NOW,
    );
    const note = identityNote(withHandle!);
    expect(note).toContain("@leo");
    expect(note).toContain("a@b.com");
    // handle 与 name 相同 → 不重复贴 @name
    const same = classify(p({ name: "leo", kind: "human", state: "working", handle: "leo" }), NOW);
    expect(identityNote(same!)).not.toContain("@leo");
    // 什么身份信息都没有 → 空串，不污染输出
    expect(identityNote(classify(p({ name: "bob" }), NOW)!)).toBe("");
  });

  test("who --json 保留 raw 身份字段；终端 identityNote 归一化控制字符", () => {
    const e = p({
      name: "web-login-uuid",
      kind: "human",
      state: "working",
      handle: "leo\n\u001b[31m\u009badmin",
      account: "team\r\nroot@example.com",
      display_name: "Davian\tPearson\u007f\u0085Ops",
    });
    const r = classify(e, NOW)!;

    // JSON 路径必须保持 presence 的真实 raw 值，不能为了终端展示污染机器可读输出。
    const parsed = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    expect(parsed.handle).toBe(e.handle);
    expect(parsed.account).toBe(e.account);
    expect(parsed.display_name).toBe(e.display_name);

    const note = identityNote(r);
    expect(note).toContain("@leo [31m admin");
    expect(note).toContain("team root@example.com");
    expect(note).toContain("Davian Pearson Ops");
    expect(note).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
  });

  test("terminalIdentityText：控制字符变空格，并折叠多余空白", () => {
    expect(terminalIdentityText(" a\n\tb\u001b[31m\u009bc\u007f\u0085 ")).toBe("a b [31m c");
  });
});

describe("who agent session（#522）", () => {
  test("JSON 保留完整 resume 信息，终端行显示可直接复用的 harness + session id", () => {
    const r = classify(p({
      name: "resume-agent",
      agent_session: {
        harness: "codex",
        session_id: "019f35d9-0000-7000-8000-000000000522",
        updated_at: NOW,
        cwd: "/workspace/agentparty",
      },
    }), NOW)!;
    expect(JSON.parse(JSON.stringify(r)).agent_session).toEqual({
      harness: "codex",
      session_id: "019f35d9-0000-7000-8000-000000000522",
      updated_at: NOW,
      cwd: "/workspace/agentparty",
    });
    expect(sessionNote(r)).toBe(" · session codex:019f35d9-0000-7000-8000-000000000522");
  });
});

describe("who wake_unverified（#55/#60/#191：自报 wake 未经服务端验证一律如实标注）", () => {
  test("watch 无 verified_at → wakeable 但带 wake_unverified", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "watch" } }), NOW);
    expect(r?.tier).toBe("wakeable");
    expect(r?.wake_unverified).toBe(true);
  });

  test("watch 有 verified_at → 不带标记", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "watch", verified_at: NOW - 1000 } }), NOW);
    expect(r?.tier).toBe("wakeable");
    expect(r?.wake_unverified).toBeUndefined();
  });

  // #191：serve 同样是自报——未经服务端验证就不该被默认信任（旧口径默认信 serve，是 false-online 的口子）。
  test("serve 无 verified_at → wakeable 但带 wake_unverified（自报未验证）", () => {
    const serve = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" } }), NOW);
    expect(serve?.tier).toBe("wakeable");
    expect(serve?.wake_unverified).toBe(true);
  });

  test("serve 有服务端 verified_at → 不带标记（已验证）", () => {
    const serve = classify(p({ name: "bot", state: "offline", wake: { kind: "serve", verified_at: NOW - 1000 } }), NOW);
    expect(serve?.wake_unverified).toBeUndefined();
  });

  test("webhook 不带标记：服务端控制投递，天然已验证", () => {
    const hook = classify(p({ name: "bot", state: "offline", wake: { kind: "webhook" } }), NOW);
    expect(hook?.tier).toBe("wakeable");
    expect(hook?.wake_unverified).toBeUndefined();
  });
});

// busy + 队列深度（#103）：serve 串行处理长任务时，who 要能看出「忙、N 待处理」，
// 而不是显示 working/可达、让人以为 @ 了会立刻回。
describe("who busy + queue depth (#103)", () => {
  test("busy 在线 agent：classify 带出 busy，无队列时不带 queue_depth", () => {
    const r = classify(p({ name: "bot", state: "working", busy: true }), NOW);
    expect(r?.tier).toBe("online");
    expect(r?.busy).toBe(true);
    expect(r).not.toHaveProperty("queue_depth");
  });

  test("busy 且有积压：带出 queue_depth", () => {
    const r = classify(p({ name: "bot", state: "working", busy: true, queue_depth: 3 }), NOW);
    expect(r?.busy).toBe(true);
    expect(r?.queue_depth).toBe(3);
  });

  test("不 busy：不带 busy/queue_depth（诚实留白）", () => {
    const r = classify(p({ name: "bot", state: "working", queue_depth: 5 }), NOW);
    expect(r).not.toHaveProperty("busy");
    expect(r).not.toHaveProperty("queue_depth");
  });

  test("busy 但 queue_depth=0：只带 busy，不显示 0 queued", () => {
    const r = classify(p({ name: "bot", state: "working", busy: true, queue_depth: 0 }), NOW);
    expect(r?.busy).toBe(true);
    expect(r).not.toHaveProperty("queue_depth");
  });

  test("waiting_owner 与 busy/current_task 分开展示", () => {
    const row = classify(p({ name: "bot", state: "waiting", waiting_owner_count: 2 }), NOW);
    expect(row?.waiting_owner_count).toBe(2);
    expect(row?.busy).toBeUndefined();
    expect(row?.current_task).toBeUndefined();
    expect(waitingOwnerNote(row!)).toBe(" · 💬 2 waiting owner");
    expect(waitingOwnerNote({ name: "bot", kind: "agent", tier: "online", age_ms: 0 })).toBe("");
  });

  test("未处理 @ 债务带出计数和最早消息，终端提示对离线 agent 也有效", () => {
    const row = classify(
      p({
        name: "bot",
        state: "offline",
        wake: { kind: "serve" },
        unhandled_mention_count: 2,
        oldest_unhandled_mention_seq: 518,
      }),
      NOW,
    );
    expect(row).toMatchObject({
      unhandled_mention_count: 2,
      oldest_unhandled_mention_seq: 518,
    });
    expect(unhandledMentionNote(row!)).toBe(" · ⚠ 2 unhandled @ · oldest #518");
    expect(
      unhandledMentionNote({
        name: "bot",
        kind: "agent",
        tier: "online",
        age_ms: 0,
        unhandled_mention_count: 1,
      }),
    ).toBe(" · ⚠ 1 unhandled @");
    expect(unhandledMentionNote({ name: "bot", kind: "agent", tier: "online", age_ms: 0 })).toBe("");
  });

  // #818：debt 逐条清，所以要看见的是「欠哪几条」而不是「欠几条」。只有 count + oldest 时中间那些
  // 查不到，已处理过的 @ 于是反复重放。
  test("pending_mention_seqs 列全时直接报 seq 列表，替掉 oldest 那个替代品", () => {
    const row = classify(
      p({
        name: "bot",
        state: "offline",
        wake: { kind: "serve" },
        unhandled_mention_count: 3,
        oldest_unhandled_mention_seq: 416,
        pending_mention_seqs: [416, 417, 421],
      }),
      NOW,
    );
    expect(row).toMatchObject({ pending_mention_seqs: [416, 417, 421] });
    expect(unhandledMentionNote(row!)).toBe(" · ⚠ 3 unhandled @ #416 #417 #421");
  });

  test("列表被服务端上限截断时如实说还有多少条没列出来", () => {
    expect(
      unhandledMentionNote({
        name: "bot",
        kind: "agent",
        tier: "online",
        age_ms: 0,
        unhandled_mention_count: 53,
        pending_mention_seqs: [1, 2, 3],
      }),
    ).toBe(" · ⚠ 53 unhandled @ #1 #2 #3 (+50 more)");
  });

  test("busyNote 渲染：忙、忙+队列、空闲三态", () => {
    expect(busyNote({ name: "a", kind: "agent", tier: "online", age_ms: 0, busy: true })).toBe(" · ⏳ busy");
    expect(busyNote({ name: "a", kind: "agent", tier: "online", age_ms: 0, busy: true, queue_depth: 4 })).toBe(
      " · ⏳ busy · 4 queued",
    );
    expect(busyNote({ name: "a", kind: "agent", tier: "online", age_ms: 0 })).toBe("");
  });

  test("taskNote 渲染：正在处理的 seq + 心跳新鲜度（#228）", () => {
    const now = 100_000;
    // 有 current_task + 心跳：显示 ▶ seq 与心跳年龄
    expect(taskNote({ name: "a", kind: "agent", tier: "online", age_ms: 0, current_task: 510, heartbeat_at: now - 8_000 }, now)).toBe(
      " · ▶ seq 510 · ♥ 8s",
    );
    // 无心跳时间戳：如实标 (none)，不伪造新鲜
    expect(taskNote({ name: "a", kind: "agent", tier: "online", age_ms: 0, current_task: 7 }, now)).toBe(" · ▶ seq 7 · ♥ (none)");
    // 无活跃任务：空
    expect(taskNote({ name: "a", kind: "agent", tier: "online", age_ms: 0 }, now)).toBe("");
  });

  test("classify 带出 current_task/task_started_at/heartbeat_at；离线不带（#228）", () => {
    const online = classify(p({ name: "bot", current_task: 42, task_started_at: 1000, heartbeat_at: 2000 }), NOW);
    expect(online).toMatchObject({ current_task: 42, task_started_at: 1000, heartbeat_at: 2000 });
    // 离线 presence 服务端本就不下发这些字段；即便脏数据混进来，classify 也不该把它当成「正在处理」。
    const offline = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" } }), NOW);
    expect(offline?.current_task).toBeUndefined();
  });

  test("party claude 的交互 activity 不依赖 current_task，离线残值不展示（#615）", () => {
    const interactive = classify(
      p({ name: "claude", live: true, activity: { phase: "tool", tool: "Bash", ts: NOW - 2_000 } }),
      NOW,
    );
    expect(interactive?.current_task).toBeUndefined();
    expect(interactive?.activity).toEqual({ phase: "tool", tool: "Bash", ts: NOW - 2_000 });
    expect(activityNote(interactive!, NOW)).toBe(" · ⚙ Bash (2s)");

    const offline = classify(
      p({
        name: "claude-offline",
        state: "offline",
        wake: { kind: "serve" },
        activity: { phase: "working", ts: NOW - 2_000 },
      }),
      NOW,
    );
    expect(offline?.activity).toBeUndefined();
  });
});

// 探活分级（#603）：listening（服务端派生「没在听」）与 runner_health（自报「干不动」）的展示与透传。
describe("who liveness tiers (#603)", () => {
  test("classify 透传 listening 与 runner_health（缺省即无恙、不无中生有）", () => {
    const row = classify(p({ name: "bot", live: true, listening: "deaf", runner_health: { ok: false, consecutive_failures: 3, last_error: "boom" } }), NOW);
    expect(row?.listening).toBe("deaf");
    expect(row?.runner_health).toMatchObject({ ok: false, consecutive_failures: 3 });
    const clean = classify(p({ name: "ok-bot", live: true }), NOW);
    expect(clean?.listening).toBeUndefined();
    expect(clean?.runner_health).toBeUndefined();
  });

  test("livenessNote：deaf/suspect 与 runner 连败分别标注，健康时为空", () => {
    const deaf = classify(p({ name: "bot", live: true, listening: "deaf" }), NOW)!;
    expect(livenessNote(deaf)).toContain("not listening");
    const suspect = classify(p({ name: "bot", live: true, listening: "suspect" }), NOW)!;
    expect(livenessNote(suspect)).toContain("slow to consume");
    const failing = classify(p({ name: "bot", live: true, runner_health: { ok: false, consecutive_failures: 2, last_error: "spawn ENOENT" } }), NOW)!;
    expect(livenessNote(failing)).toContain("runner failing x2");
    expect(livenessNote(failing)).toContain("spawn ENOENT");
    // 单次失败（ok=true）不告警：有重试兜底，别制造噪音
    const single = classify(p({ name: "bot", live: true, runner_health: { ok: true, consecutive_failures: 1 } }), NOW)!;
    expect(livenessNote(single)).toBe("");
    const healthy = classify(p({ name: "bot", live: true }), NOW)!;
    expect(livenessNote(healthy)).toBe("");
  });
});


// #879/#891：unreachable 只说了「叫不醒」，没说「怎么修」；#879 按 harness 分叉给建议，但它选的
// 两个判据字段（agent_session / reception_runner）**只有活跃身份的 presence 才有**，而提示只对
// **离线**身份显示——判据与展示场景在时间上互斥，于是真机上 10 个身份里 7 个全落 unknown 兜底。
//
// 本 describe 的核心不是「字段在场时分叉正确」（#879 已测过，也确实全绿），而是把 #891 的真机形态
// **变成第一等测试样本**：离线身份**没有**这些字段。那种形态下正确行为是闭嘴，不是兜底。
describe("who wake guidance（#879/#891：判据在场才给建议，判不出就闭嘴）", () => {
  const STALE = { state: "offline" as const, wake: { kind: "none" as const }, last_seen: NOW - 88 * 60 * 60 * 1000 };
  function row(over: Partial<PresenceEntry> & { name: string }) {
    const r = classify(p({ ...STALE, ...over }), NOW);
    expect(r).not.toBeNull();
    return r as NonNullable<ReturnType<typeof classify>>;
  }

  test("codex 身份（agent_session.harness）→ 建议装 Stop hook / bridge，不含 serve", () => {
    const g = wakeGuidanceOf(
      row({ name: "lark-agentparty-codex", agent_session: { harness: "codex", session_id: "s1", updated_at: NOW } }),
      "pwtk",
    );
    expect(g).toEqual({
      reason: "no_wake_layer",
      harness: "codex",
      harness_source: "agent_session",
      remedy: ["party hook install --codex", "party bridge codex pwtk"],
    });
  });

  test("codex-sdk 与 reception_runner 同样判为 codex 族", () => {
    expect(
      wakeGuidanceOf(row({ name: "a", agent_session: { harness: "codex-sdk", session_id: "s", updated_at: NOW } }), "c")
        ?.harness,
    ).toBe("codex");
    const viaReception = wakeGuidanceOf(
      row({ name: "b", status: { context: { reception_runner: "codex" } } as PresenceEntry["status"] }),
      "c",
    );
    expect(viaReception?.harness).toBe("codex");
    expect(viaReception?.harness_source).toBe("reception_runner");
  });

  test("claude 身份 → 建议装插件，绝不出现 codex 专属命令", () => {
    const g = wakeGuidanceOf(
      row({ name: "kyc-claude", agent_session: { harness: "claude", session_id: "s1", updated_at: NOW } }),
      "pwtk",
    );
    expect(g).toEqual({
      reason: "no_wake_layer",
      harness: "claude",
      harness_source: "agent_session",
      remedy: ["claude plugin install agentparty@agentparty", "claude plugin update agentparty@agentparty"],
    });
  });

  // ★ #891 的真机形态：这正是 `party who agentparty` 上 7/10 行的样子——离线、陈旧、
  //   agent_session 和 reception_runner 双双缺席。#879 的单测样本从没覆盖过它。
  test("#891 真机形态（离线身份缺判据字段）→ 完全不给建议，而不是兜底并列两条命令", () => {
    for (const name of ["claude-statebar-codex", "lark-ad72b3f9749e-agentparty-codex1", "leo-claude"]) {
      const r = row({ name });
      expect(r.unreachable).toBe(true);
      expect(r.agent_session).toBeUndefined();
      expect(r.reception_runner).toBeUndefined();
      expect(wakeGuidanceOf(r, "agentparty")).toBeUndefined();
    }
  });

  test("#891：名字带 -codex/-claude 后缀不构成 harness 证据，绝不据此断言", () => {
    expect(wakeHarnessOf(row({ name: "lark-ad72b3f9749e-agentparty-codex" }))).toBeUndefined();
    expect(wakeHarnessOf(row({ name: "leo-claude" }))).toBeUndefined();
  });

  test("有唤醒层的身份不给建议（online / wakeable / 刚断线都不加噪音）", () => {
    const session = { harness: "codex" as const, session_id: "s1", updated_at: NOW };
    expect(
      wakeGuidanceOf(row({ name: "on", state: "waiting", last_seen: NOW, agent_session: session }), "c"),
    ).toBeUndefined();
    expect(
      wakeGuidanceOf(row({ name: "srv", wake: { kind: "serve" }, last_seen: NOW, agent_session: session }), "c"),
    ).toBeUndefined();
  });

  test("人类不靠 bridge/hook 唤醒，不给建议", () => {
    const human = classify(p({ ...STALE, name: "leo", kind: "human", paused: true }), NOW);
    expect(human?.kind).toBe("human");
    expect(wakeGuidanceOf(human as NonNullable<typeof human>, "c")).toBeUndefined();
  });

  test("codex 提示整段文案：指向 Stop hook / bridge，且既不含「装插件」也不含 serve", () => {
    const note = wakeGuidanceNote({
      reason: "no_wake_layer",
      harness: "codex",
      harness_source: "agent_session",
      remedy: ["party hook install --codex", "party bridge codex pwtk"],
    });
    expect(note).toBe(
      " · ↳ fix: a codex session has no per-session inbox — give it the Stop hook so the @ surfaces in the session you are looking at: run party hook install --codex (then it picks pending @s up at the end of a turn), or party bridge codex pwtk to hold its app-server connection right now",
    );
    expect(note).not.toContain("plugin");
    expect(note).not.toContain("party serve");
  });

  test("claude 提示整段文案：不含任何 codex 专属命令，也不含 serve", () => {
    const note = wakeGuidanceNote({
      reason: "no_wake_layer",
      harness: "claude",
      harness_source: "agent_session",
      remedy: ["claude plugin install agentparty@agentparty", "claude plugin update agentparty@agentparty"],
    });
    // #961：install 对已装的只回 already installed、不升级——修法必须带上 update，且说明要重开。
    expect(note).toBe(
      " · ↳ fix: an interactive Claude Code session is wakeable once the agentparty plugin is installed and matches the party CLI version — run claude plugin install agentparty@agentparty, then claude plugin update agentparty@agentparty (install never upgrades an already-installed plugin), restart Claude Code and rejoin the channel",
    );
    expect(note).not.toContain("codex");
    expect(note).not.toContain("party serve");
  });

  test("没有建议时不输出任何提示（不给全员加噪音）", () => {
    expect(wakeGuidanceNote(undefined)).toBe("");
  });

  test("help 文案钉住 codex 无 per-session 收件箱这条硬事实与 JSON 字段名", () => {
    expect(HELP_TEXT).toContain("wake_guidance");
    expect(HELP_TEXT).toContain("pull_wake");
    expect(HELP_TEXT).toContain("A codex session has NO per-session");
    expect(HELP_TEXT).toContain("party bridge codex");
    expect(HELP_TEXT).toContain("party hook install --codex");
  });
});

// #905：拉取式唤醒通道（codex Stop hook）的可达性表达。
describe("who pull-based reachability（#905：既不是在线，也不是不可达）", () => {
  const CH = "agentparty";
  const stale = (over: Partial<PresenceEntry> & { name: string }): PresenceEntry =>
    p({ state: "offline", wake: { kind: "none" }, last_seen: NOW - 88 * 60 * 60 * 1000, ...over });
  // #926：`hookStatus` 必须显式注入。默认实现会去读**这台机器真实的** ~/.codex/config.toml，
  // 于是单测结果会随跑测试那台机器的 hook 信任闸摇摆（owner 那台就是全 disabled）。
  const lookup = (names: string[], hook: CodexStopHookStatus = "ok"): PullWakeLookup =>
    buildPullWakeLookup(CH, "https://s", {
      hasHook: () => true,
      hookStatus: () => hook,
      names: () => new Set(names),
    });

  test("装了 Stop hook 的身份：不再断言 unreachable，改说「下次跑起来时会取到」", () => {
    const rows = buildRows([stale({ name: "lark-codex1" })], {
      now: NOW,
      channel: CH,
      pullWake: lookup(["lark-codex1"]),
    });
    const r = rows[0] as NonNullable<(typeof rows)[number]>;
    expect(r.pull_wake).toEqual({
      scope: "local",
      harness: "codex",
      hook: "ok",
      evidence: ["codex_stop_hook", "local_agent_config"],
    });
    const line = renderRow(r, NOW, 0);
    expect(line).toContain("⇢ deferred");
    expect(line).toContain("picks the @ up via the Stop hook");
    expect(line).not.toContain("⚠ no live wake layer");
    expect(line).not.toContain("unreachable");
    // 已经装过 hook 的身份不该再被劝装一遍。
    expect(line).not.toContain("↳ fix");
  });

  test("措辞保留「本机视角」限定——绝不把本机观察升格成服务端可达性", () => {
    const rows = buildRows([stale({ name: "x" })], { now: NOW, channel: CH, pullWake: lookup(["x"]) });
    expect(renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0)).toContain("local view:");
  });

  // ── #926：装了 ≠ 会跑 ──────────────────────────────────────────────────────
  // 这里的 fixture 有意让**除信任闸以外的每一道闸都通过**：身份在 names 里、hasHook 为真、
  // 是 agent、频道/server 都对得上。于是断言只可能被 hookStatus 那一道闸决定——
  // 退回「只看 hooks.json 里有没有」的旧实现，这三条会全红。
  for (const hook of ["disabled", "needs-review"] as const) {
    test(`hook 存在但信任闸未过（${hook}）→ 绝不标 deferred，如实说「收不到」`, () => {
      const rows = buildRows([stale({ name: "lark-codex1" })], {
        now: NOW,
        channel: CH,
        pullWake: lookup(["lark-codex1"], hook),
      });
      const r = rows[0] as NonNullable<(typeof rows)[number]>;
      // 线索仍然点亮（hook 确实装着），但它自带「会不会跑」的判定。
      expect(r.pull_wake?.hook).toBe(hook);
      const line = renderRow(r, NOW, 0);
      expect(line).not.toContain("⇢ deferred");
      expect(line).not.toContain("picks the @ up via the Stop hook");
      expect(line).toContain("⛔ wake blocked");
      // 必须给出一条能跑的命令，且绝不建议绕过信任闸（那是拿安全控制换功能）。
      expect(line).toContain("party wake check");
      expect(line).not.toContain("dangerously-bypass-hook-trust");
    });
  }

  // #925 已确立的语义，别改坏：老版本 codex 没有信任闸 ⇒ ok ⇒ 照常 deferred，不喊狼来了。
  test("信任闸判 ok（老版本 codex 无此闸）→ 仍走 deferred", () => {
    const rows = buildRows([stale({ name: "lark-codex1" })], {
      now: NOW,
      channel: CH,
      pullWake: lookup(["lark-codex1"], "ok"),
    });
    const line = renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0);
    expect(line).toContain("⇢ deferred");
    expect(line).not.toContain("⛔ wake blocked");
  });

  test("四态判定说 missing → 一个身份都不点亮（文件里有指纹也不算）", () => {
    const rows = buildRows([stale({ name: "lark-codex1" })], {
      now: NOW,
      channel: CH,
      pullWake: lookup(["lark-codex1"], "missing"),
    });
    expect(rows[0]?.pull_wake).toBeUndefined();
  });

  test("本机没这个身份的 config → 不点亮，行仍走无唤醒层措辞", () => {
    const rows = buildRows([stale({ name: "someone-else" })], {
      now: NOW,
      channel: CH,
      pullWake: lookup(["not-them"]),
    });
    expect(rows[0]?.pull_wake).toBeUndefined();
    expect(renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0)).toContain("⚠ no live wake layer");
  });

  test("本机没装 Stop hook → 一个身份都不点亮（连 agents 目录都不扫）", () => {
    let scanned = false;
    const l = buildPullWakeLookup(CH, "https://s", {
      hasHook: () => false,
      names: () => {
        scanned = true;
        return new Set(["a"]);
      },
    });
    expect(l.hintFor("a")).toBeUndefined();
    expect(scanned).toBe(false);
  });

  test("人类身份不走拉取式通道（Stop hook 是 agent 会话的东西）", () => {
    const rows = buildRows([p({ name: "leo", kind: "human", live: true })], {
      now: NOW,
      channel: CH,
      pullWake: lookup(["leo"]),
    });
    expect(rows[0]?.pull_wake).toBeUndefined();
  });

  // #865：本机两台生产实例都有同名频道 #agentparty。不比服务器就会把隔壁实例上的同名身份
  // 认成「本机可拉取」——那条 @ 根本不在同一台服务器上，永远等不到人取。
  test("locallyConfiguredNames：同频道但不同 server 的本机 config 不算数（#865）", () => {
    const home = mkdtempSync(join(tmpdir(), "who-agents-home-"));
    mkdirSync(join(home, "agents"), { recursive: true });
    const put = (file: string, name: string, server: string) =>
      writeFileSync(
        join(home, "agents", file),
        JSON.stringify({ server, token: "ap_x", identity: { name, kind: "agent", channel_scope: "agentparty" } }),
      );
    put("here.json", "codex-002", "https://agentparty.pwtk-dev.work");
    put("there.json", "codex-002-elsewhere", "https://agentparty.leeguoo.com");
    put("other-channel.json", "unrelated", "https://agentparty.pwtk-dev.work");
    writeFileSync(
      join(home, "agents", "other-channel.json"),
      JSON.stringify({
        server: "https://agentparty.pwtk-dev.work",
        token: "ap_x",
        identity: { name: "unrelated", kind: "agent", channel_scope: "pwtk" },
      }),
    );
    const prev = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    try {
      const names = locallyConfiguredNames("agentparty", "https://agentparty.pwtk-dev.work");
      expect(names.has("codex-002")).toBe(true);
      expect(names.has("codex-002-elsewhere")).toBe(false); // 隔壁实例
      expect(names.has("unrelated")).toBe(false); // 隔壁频道
    } finally {
      if (prev === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = prev;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("hasCodexStopHook：只认 Stop 事件里带我们指纹的 command，坏文件一律 false", () => {
    const dir = mkdtempSync(join(tmpdir(), "who-pullwake-"));
    const write = (body: string) => {
      const f = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(f, body);
      return f;
    };
    expect(hasCodexStopHook(write(JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: '"/x/party" hook codex-stop' }] }] },
    })))).toBe(true);
    // SessionStart 的 codex-report 不算——它不是唤醒通道。
    expect(hasCodexStopHook(write(JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "party hook codex-report" }] }] },
    })))).toBe(false);
    // 别人的 Stop hook 不算。
    expect(hasCodexStopHook(write(JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/other-tool" }] }] },
    })))).toBe(false);
    expect(hasCodexStopHook(write("not json"))).toBe(false);
    expect(hasCodexStopHook(write(JSON.stringify({ hooks: { Stop: "oops" } })))).toBe(false);
    expect(hasCodexStopHook(join(dir, "missing.json"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// #879/#891 装配层：note 函数单测全绿、真机什么都不显示（或反过来：真机全是兜底噪音），是本仓
// 反复出现的失败模式。这里断言的是 presence → 行 → 终端字符串这条链本身。
describe("who 唤醒建议的装配（presence → 行 → 终端一行）", () => {
  const CH = "pwtk";
  const stale = (over: Partial<PresenceEntry> & { name: string }): PresenceEntry =>
    p({ state: "offline", wake: { kind: "none" }, last_seen: NOW - 88 * 60 * 60 * 1000, ...over });

  test("codex 行既带结构化 wake_guidance，也把 fix 提示渲染进终端那一行", () => {
    const rows = buildRows(
      [stale({ name: "lark-codex", agent_session: { harness: "codex", session_id: "s", updated_at: NOW } })],
      { now: NOW, channel: CH },
    );
    expect(rows[0]?.wake_guidance).toEqual({
      reason: "no_wake_layer",
      harness: "codex",
      harness_source: "agent_session",
      remedy: ["party hook install --codex", "party bridge codex pwtk"],
    });
    const line = renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0);
    expect(line).toContain("⚠ no live wake layer");
    expect(line).toContain("party hook install --codex");
  });

  test("claude 行渲染 Claude 专属修法，且整行不含 codex 命令", () => {
    const rows = buildRows(
      [stale({ name: "kyc-claude", agent_session: { harness: "claude", session_id: "s", updated_at: NOW } })],
      { now: NOW, channel: CH },
    );
    const line = renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0);
    expect(line).toContain(
      "↳ fix: an interactive Claude Code session is wakeable once the agentparty plugin is installed and matches the party CLI version — run claude plugin install agentparty@agentparty, then claude plugin update agentparty@agentparty (install never upgrades an already-installed plugin), restart Claude Code and rejoin the channel",
    );
    expect(line).not.toContain("party bridge codex");
    expect(line).not.toContain("--runner codex");
  });

  // ★ #905 的验收线：整张表里不许再有一行叫人去挂 serve 来解决前台唤醒。
  test("#897/#905：真机形态的整张表里，没有任何一行建议 party serve", () => {
    const rows = buildRows(
      [
        stale({ name: "claude-statebar-codex", residency: "daemon" }),
        stale({ name: "lark-ad72b3f9749e-agentparty", residency: "supervised" }),
        stale({ name: "lark-ad72b3f9749e-agentparty-codex", residency: "episodic" }),
        stale({ name: "leo-claude" }),
        stale({ name: "super-admin-bug-7744", last_seen: NOW - 3 * 24 * 60 * 60 * 1000 }),
        stale({ name: "kyc-claude", agent_session: { harness: "claude", session_id: "s", updated_at: NOW } }),
      ],
      { now: NOW, channel: "agentparty" },
    );
    const lines = rows.map((r) => renderRow(r, NOW, 0));
    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(line).not.toContain("party serve");
      expect(line).not.toContain("harness unknown");
    }
    // 五个没有判据的身份一条 fix 都不给；唯一有判据的那个才给。
    expect(lines.filter((line) => line.includes("↳ fix")).length).toBe(1);
  });

  test("可唤醒的身份行里没有任何 fix 提示（不给全频道加噪音）", () => {
    const rows = buildRows(
      [p({ name: "srv", state: "offline", wake: { kind: "serve" }, agent_session: { harness: "codex", session_id: "s", updated_at: NOW } })],
      { now: NOW, channel: CH },
    );
    expect(rows[0]?.tier).toBe("wakeable");
    expect(rows[0]?.wake_guidance).toBeUndefined();
    expect(renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0)).not.toContain("↳ fix");
  });
});


// #958：deferred 行必须带队列深度——Stop hook 每轮只送一条，积压 9 条时发送方那条要等 8 轮，
// 不说深度就和「坏了」无法区分。条数取服务端账本的 unhandled_mention_count（近似，见 deferredQueueNote）。
describe("who deferred 行的队列深度（#958）", () => {
  const CH = "agentparty";
  const stale = (over: Partial<PresenceEntry> & { name: string }): PresenceEntry =>
    p({ state: "offline", wake: { kind: "none" }, last_seen: NOW - 88 * 60 * 60 * 1000, ...over });
  const lookup = (names: string[]): PullWakeLookup =>
    buildPullWakeLookup(CH, "https://s", { hasHook: () => true, hookStatus: () => "ok", names: () => new Set(names) });
  const render = (entry: PresenceEntry): string => {
    const rows = buildRows([entry], { now: NOW, channel: CH, pullWake: lookup([entry.name]) });
    return renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0, CH);
  };

  test("积压 9 条：deferred 行说「9 unhandled @ queued ≈ 9 turns」并给出该频道的排空命令", () => {
    const line = render(stale({
      name: "lark-codex1",
      unhandled_mention_count: 9,
      pending_mention_seqs: [1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930, 1935],
    }));
    expect(line).toContain("⇢ deferred");
    expect(line).toContain("one per turn");
    expect(line).toContain("9 unhandled @ queued ≈ 9 turns");
    expect(line).toContain(`party ack --drain --channel ${CH}`);
  });

  test("只欠一条：单数措辞「1 turn」", () => {
    expect(deferredQueueNote({ unhandled_mention_count: 1 } as Parameters<typeof deferredQueueNote>[0], CH))
      .toContain("1 unhandled @ queued ≈ 1 turn —");
  });

  test("没有欠账：deferred 行不编造队列，也不给排空命令", () => {
    const line = render(stale({ name: "lark-codex1" }));
    expect(line).toContain("⇢ deferred");
    expect(line).not.toContain("queued");
    expect(line).not.toContain("ack --drain");
  });

  test("没传频道时排空命令退化成不带 --channel（仍可在绑定目录下直接跑）", () => {
    expect(deferredQueueNote({ unhandled_mention_count: 3 } as Parameters<typeof deferredQueueNote>[0]))
      .toContain("party ack --drain");
    expect(deferredQueueNote({ unhandled_mention_count: 3 } as Parameters<typeof deferredQueueNote>[0]))
      .not.toContain("--channel");
  });

  test("信任闸没过的身份走 wake blocked，不出现队列文案（先修 hook 再谈排队）", () => {
    const rows = buildRows([stale({ name: "lark-codex1", unhandled_mention_count: 9 })], {
      now: NOW,
      channel: CH,
      pullWake: buildPullWakeLookup(CH, "https://s", {
        hasHook: () => true,
        hookStatus: () => "disabled",
        names: () => new Set(["lark-codex1"]),
      }),
    });
    const line = renderRow(rows[0] as NonNullable<(typeof rows)[number]>, NOW, 0, CH);
    expect(line).toContain("⛔ wake blocked");
    expect(line).not.toContain("queued ≈");
  });
});
