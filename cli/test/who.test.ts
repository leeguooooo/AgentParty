import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { classify, identityNote, terminalIdentityText } from "../src/commands/who";

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

  test("offline 13 分钟的 serve → recent，不再谎报 ◐ 可唤醒（issue #47 实测场景）", () => {
    const r = classify(p({ name: "computer-use-mini", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
  });

  test("offline 13 分钟的 watch 同样降级为 recent", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "watch" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
  });

  test("human_driven 的 watch 不算 wakeable（需要人工/外层 harness 接续）", () => {
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

describe("who wake_unverified（#55/#60：自报 watch wake 如实标注未验证）", () => {
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

  test("serve/webhook 不带标记（有活 supervisor / 服务端投递）", () => {
    const serve = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" } }), NOW);
    expect(serve?.wake_unverified).toBeUndefined();
    const hook = classify(p({ name: "bot", state: "offline", wake: { kind: "webhook" } }), NOW);
    expect(hook?.wake_unverified).toBeUndefined();
  });
});
