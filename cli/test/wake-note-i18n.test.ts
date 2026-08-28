// #1003：唤醒注入文案的内容与语言。
//
// 钉四件事：① 语言判定的优先级（config 覆盖 > 接收者历史 > 触发消息 > LANG > en）——把 detectWakeLang 短路成恒 en，
// 「接收者中文 ⇒ zh」那条必须红；② 512B 预算——预览按剩余字节动态截、末尾 …、from-id 行永不被挤掉，把截断去掉，
// 长正文用例必须红；③ 接收者历史按 (server, channel, identity) 进程内缓存、拉取失败不缓存；④ 文案集中在 t()。
import { beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  WAKE_LANG_CACHE_TTL_MS,
  WAKE_NOTE_MAX_BYTES,
  buildWakeNote,
  cjkRatio,
  clampPreview,
  detectWakeLang,
  langFromEnv,
  normalizeWakeLang,
  receiverRecentBodies,
  relativeTime,
  resetWakeLangCache,
  resolveWakeLang,
  t,
  textsLang,
  wakeNoteFromId,
} from "../src/wake-note-i18n";

const NOW = Date.parse("2026-08-28T10:02:00Z");
const ZH_BODY = "我们的展示信息是不是有点太少了，语言应该根据 ai 使用的语言或者其他的方式，自动改成对应的语言";
const SOURCE = { server: "https://party.example", token: "tok", channel: "pwtk", identity: "lark-ad72b3f97491-agentparty" };

beforeEach(() => resetWakeLangCache());

describe("语言判定 detectWakeLang（#1003）", () => {
  test("接收者最近消息是中文 ⇒ zh（哪怕触发消息与 LANG 都是英文）", () => {
    expect(
      detectWakeLang({
        receiverRecentBodies: ["收到，跑一下 `bunx tsc --noEmit` 看看", "@leo 已合并"],
        triggerBody: "please take a look at the failing job",
        env: { LANG: "en_US.UTF-8" },
      }),
    ).toBe("zh");
  });

  test("接收者有历史且全英文 ⇒ en，不再看触发消息", () => {
    expect(detectWakeLang({ receiverRecentBodies: ["on it", "merged, thanks"], triggerBody: ZH_BODY, env: { LANG: "zh_CN.UTF-8" } }))
      .toBe("en");
  });

  test("没有历史 ⇒ 用触发消息的语言", () => {
    expect(detectWakeLang({ receiverRecentBodies: [], triggerBody: ZH_BODY, env: { LANG: "en_US.UTF-8" } })).toBe("zh");
    expect(detectWakeLang({ triggerBody: "@lark-ad72b3f97491-agentparty can you review #42?" })).toBe("en");
  });

  test("历史与触发消息都没有字母类信号 ⇒ LANG=zh_CN.UTF-8 兜底成 zh；LC_ALL 优先于 LANG", () => {
    expect(detectWakeLang({ receiverRecentBodies: [], triggerBody: "@lark-ad72b3f97491-agentparty 👀 42", env: { LANG: "zh_CN.UTF-8" } }))
      .toBe("zh");
    expect(langFromEnv({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" })).toBe(null);
    expect(langFromEnv({ LANG: "zh_TW.UTF-8" })).toBe("zh");
    expect(langFromEnv({ LANG: "C.UTF-8" })).toBe(null);
    expect(langFromEnv(undefined)).toBe(null);
  });

  test("什么都没有 ⇒ en", () => {
    expect(detectWakeLang({})).toBe("en");
    expect(detectWakeLang({ receiverRecentBodies: null, triggerBody: null, env: {} })).toBe("en");
  });

  test("config lang 显式覆盖优先级最高；非法值当没有", () => {
    expect(detectWakeLang({ override: "en", receiverRecentBodies: ["全是中文的历史"], triggerBody: ZH_BODY, env: { LANG: "zh_CN.UTF-8" } }))
      .toBe("en");
    expect(detectWakeLang({ override: "zh", receiverRecentBodies: ["all english"], triggerBody: "english" })).toBe("zh");
    expect(detectWakeLang({ override: "fr", receiverRecentBodies: ["中文历史"] })).toBe("zh");
    expect(normalizeWakeLang("zh-CN")).toBe("zh");
    expect(normalizeWakeLang("en_US")).toBe("en");
    expect(normalizeWakeLang("")).toBe(null);
    expect(normalizeWakeLang(42)).toBe(null);
  });

  test("CJK 占比按字母类字符算，代码块 / URL / @handle 不计入", () => {
    expect(cjkRatio("")).toBe(null);
    expect(cjkRatio("1234 !!")).toBe(null);
    expect(cjkRatio("中文")).toBe(1);
    // 三个汉字 + 一段命令：命令在反引号里不计，占比 100%。
    expect(cjkRatio("跑一下 `bunx tsc --noEmit && bun test test/serve.test.ts`")).toBe(1);
    expect(cjkRatio("看看 https://github.com/leeguooooo/AgentParty/issues/1003 @lark-ad72b3f97491-agentparty")).toBe(1);
    // 混合：4 汉字 / (4 + 12 拉丁) = 25% < 30% ⇒ en。
    expect(textsLang(["收到谢谢 nice work everyone"])).toBe("en");
    expect(textsLang(["收到谢谢，很好 nice"])).toBe("zh");
    expect(textsLang([null, undefined, "  "])).toBe(null);
  });
});

describe("buildWakeNote：内容与 512B 预算（#1003）", () => {
  test("中文样例：发信人 / 频道 / seq / 相对时间 / 预览 / 读全文命令 / from-id，逐字符合 issue 目标", () => {
    const note = buildWakeNote({
      lang: "zh",
      channel: "pwtk",
      seq: 42,
      sender: "leo",
      ts: NOW - 2 * 60_000,
      now: NOW,
      body: ZH_BODY,
      fromId: "lark-ad72b3f9749e",
    });
    expect(note).toBe(
      "AgentParty 唤醒：leo 在 #pwtk 提到了你（seq 42，2 分钟前）\n" +
        `「${ZH_BODY}」\n` +
        "以上是预览，正文以频道为准：party history pwtk --seq 42\n" +
        "from-id: lark-ad72b3f9749e",
    );
    expect(wakeNoteFromId(note)).toBe("lark-ad72b3f9749e");
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
  });

  test("英文样例：同样的字段，英文措辞，seq=N 形式保持可 grep", () => {
    const note = buildWakeNote({
      lang: "en",
      channel: "pwtk",
      seq: 42,
      sender: "leo",
      ts: NOW - 2 * 60_000,
      now: NOW,
      body: "is our injected note a bit too thin? the language should follow the agent",
      fromId: "lark-ad72b3f9749e",
    });
    expect(note).toBe(
      "AgentParty wake: leo mentioned you in #pwtk (seq=42, 2 min ago)\n" +
        "“is our injected note a bit too thin? the language should follow the agent”\n" +
        "Preview only; the channel is the single source of truth: party history pwtk --seq 42\n" +
        "from-id: lark-ad72b3f9749e",
    );
  });

  test("中文长正文：预览截到预算内、整条 ≤512B、末尾 …、from-id 行不丢", () => {
    const body = "这是一段很长的中文正文，用来把预算撑爆。".repeat(40);
    const note = buildWakeNote({
      lang: "zh",
      channel: "pwtk",
      seq: 42,
      sender: "leo",
      ts: NOW - 5_000,
      now: NOW,
      body,
      fromId: "lark-ad72b3f9749e",
    });
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
    // 预算要用足：截断后离上限不超过一个汉字（3B）——「取前 N 字符」的 N 是按字节动态算的，不是拍脑袋的常量。
    expect(Buffer.byteLength(note, "utf8")).toBeGreaterThan(WAKE_NOTE_MAX_BYTES - 4);
    const lines = note.split("\n");
    expect(lines[0]).toBe("AgentParty 唤醒：leo 在 #pwtk 提到了你（seq 42，刚刚）");
    expect(lines[1]!.startsWith("「这是一段很长的中文正文")).toBe(true);
    expect(lines[1]!.endsWith("…」")).toBe(true);
    expect(lines[2]).toBe("以上是预览，正文以频道为准：party history pwtk --seq 42");
    expect(lines[3]).toBe("from-id: lark-ad72b3f9749e");
    expect(wakeNoteFromId(note)).toBe("lark-ad72b3f9749e");
  });

  test("英文长正文同理：≤512B、末尾 …、from-id 可读回", () => {
    const note = buildWakeNote({
      lang: "en",
      channel: "pwtk",
      seq: 42,
      sender: "leo",
      body: "word ".repeat(300),
      fromId: "lark-ad72b3f9749e",
      now: NOW,
    });
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
    expect(Buffer.byteLength(note, "utf8")).toBeGreaterThan(WAKE_NOTE_MAX_BYTES - 4);
    const lines = note.split("\n");
    expect(lines[1]!.endsWith("…”")).toBe(true);
    expect(lines.at(-1)).toBe("from-id: lark-ad72b3f9749e");
    expect(wakeNoteFromId(note)).toBe("lark-ad72b3f9749e");
  });

  test("最长 channel + 最长 identity + 长友好名 + siblings + 长正文齐上仍 ≤512B，siblings=N 与 from-id 都在", () => {
    for (const lang of ["zh", "en"] as const) {
      const note = buildWakeNote({
        lang,
        channel: "a".repeat(64),
        seq: Number.MAX_SAFE_INTEGER,
        sender: "郭立 lee · agentparty · 一个特别特别长的显示名字".repeat(2),
        // 发信人按字节封顶（48B），长昵称截成「郭立 lee · agentparty · 一…」这类，不会把预算吃光。
        ts: NOW - 3 * 24 * 3_600_000,
        now: NOW,
        body: "正文".repeat(300),
        fromId: "b".repeat(64),
        siblings: 99,
      });
      expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
      expect(note).toContain("siblings=99");
      expect(note).toContain(`#${"a".repeat(64)}`);
      expect(wakeNoteFromId(note)).toBe("b".repeat(64));
    }
  });

  test("预算装不下预览时整行不给（不留半个引号）；再不够就 siblings 裸 → 去发信人；指针与 from-id 永不让步", () => {
    const base = {
      lang: "zh" as const,
      channel: "a".repeat(64),
      seq: Number.MAX_SAFE_INTEGER,
      sender: "x".repeat(40),
      body: "正文正文正文正文正文正文正文正文正文正文",
      fromId: "b".repeat(64),
      siblings: 99,
    };
    const bytesOf = (note: string) => Buffer.byteLength(note, "utf8");
    // 完整骨架（无预览）刚好装得下、预览装不下 ⇒ 只去预览，发信人与 siblings 说明都保留。
    const fullSkeleton = buildWakeNote({ ...base, body: "" });
    const noPreview = buildWakeNote({ ...base, maxBytes: bytesOf(fullSkeleton) + 5 });
    expect(noPreview).toBe(fullSkeleton);
    expect(noPreview).not.toContain("「");
    expect(noPreview).toContain(`${"x".repeat(40)} 在 #`);
    expect(noPreview).toContain("siblings=99：");
    // 完整骨架都装不下 ⇒ siblings 行退成裸 `siblings=99`，发信人还在。
    const bareSiblings = buildWakeNote({ ...base, maxBytes: bytesOf(fullSkeleton) - 1 });
    expect(bytesOf(bareSiblings)).toBeLessThanOrEqual(bytesOf(fullSkeleton) - 1);
    expect(bareSiblings).toContain("siblings=99\n");
    expect(bareSiblings).toContain(`${"x".repeat(40)} 在 #`);
    // 再不够 ⇒ 去发信人（「有人提到了你」）。
    const bareSkeleton = buildWakeNote({ ...base, body: "", maxBytes: bytesOf(fullSkeleton) - 1 });
    const anon = buildWakeNote({ ...base, maxBytes: bytesOf(bareSkeleton) - 1 });
    expect(bytesOf(anon)).toBeLessThanOrEqual(bytesOf(bareSkeleton) - 1);
    expect(anon).toContain("有人在 #");
    expect(anon).not.toContain("x".repeat(40));
    for (const note of [noPreview, bareSiblings, anon]) {
      expect(note).toContain(`party history ${"a".repeat(64)} --seq ${Number.MAX_SAFE_INTEGER}`);
      expect(wakeNoteFromId(note)).toBe("b".repeat(64));
    }
    // 连指针 + from-id 都装不下 ⇒ 程序错误，抛而不是静默截坏。
    expect(() => buildWakeNote({ ...base, maxBytes: 120 })).toThrow(/exceeds 120 bytes/);
  });

  test("没有 sender / body / ts（老调用方）⇒ 只带指针的短版；siblings ≤1 与空 from-id 不写", () => {
    const en = buildWakeNote({ lang: "en", channel: "pwtk", seq: 42, siblings: 1, fromId: "  " });
    expect(en).toBe(
      "AgentParty wake: you were mentioned in #pwtk (seq=42)\n" +
        "Read the channel for the message body (party history pwtk --seq 42); the channel is the single source of truth.",
    );
    expect(wakeNoteFromId(en)).toBe(null);
    const zh = buildWakeNote({ lang: "zh", channel: "pwtk", seq: 42, body: "  \n " });
    expect(zh).toBe("AgentParty 唤醒：有人在 #pwtk 提到了你（seq 42）\n正文去频道读：party history pwtk --seq 42（频道是唯一事实源）");
  });

  test("正文里的换行被压成空格；ts 在未来 / 非法 ⇒ 不写时间", () => {
    const note = buildWakeNote({ lang: "en", channel: "dev", seq: 7, sender: "leo", body: "line1\n\nline2\tline3", ts: NOW + 60_000, now: NOW });
    expect(note.split("\n")[0]).toBe("AgentParty wake: leo mentioned you in #dev (seq=7)");
    expect(note.split("\n")[1]).toBe("“line1 line2 line3”");
    expect(buildWakeNote({ lang: "zh", channel: "dev", seq: 7, ts: Number.NaN, now: NOW })).toContain("（seq 7）");
  });

  test("clampPreview 按码点截、绝不切开一个多字节字符", () => {
    expect(clampPreview("abc", 10)).toBe("abc");
    expect(clampPreview("中文预览", 9)).toBe("中文…");
    expect(clampPreview("中文预览", 3)).toBe("");
    expect(Buffer.byteLength(clampPreview("中文预览截断测试", 11), "utf8")).toBeLessThanOrEqual(11);
  });

  test("相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前，中英各一套", () => {
    expect(relativeTime("zh", NOW - 30_000, NOW)).toBe("刚刚");
    expect(relativeTime("zh", NOW - 2 * 60_000, NOW)).toBe("2 分钟前");
    expect(relativeTime("zh", NOW - 3 * 3_600_000, NOW)).toBe("3 小时前");
    expect(relativeTime("zh", NOW - 49 * 3_600_000, NOW)).toBe("2 天前");
    expect(relativeTime("en", NOW - 30_000, NOW)).toBe("just now");
    expect(relativeTime("en", NOW - 2 * 60_000, NOW)).toBe("2 min ago");
    expect(relativeTime("en", NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(relativeTime("en", NOW - 49 * 3_600_000, NOW)).toBe("2 d ago");
    expect(relativeTime("en", null, NOW)).toBe(null);
    expect(relativeTime("en", NOW + 1, NOW)).toBe(null);
  });
});

describe("文案表 t()", () => {
  test("占位符替换；未知 key 直接抛（别把 key 本身吐给模型）", () => {
    expect(t("zh", "wake.ago.min", { n: 5 })).toBe("5 分钟前");
    expect(t("en", "wake.footer.preview", { channel: "pwtk", seq: 42 })).toContain("party history pwtk --seq 42");
    expect(() => t("en", "nope.missing")).toThrow(/unknown key/);
  });

  test("四处文案 zh / en 各有一份，且都保住机器可读的锚点", () => {
    for (const lang of ["zh", "en"] as const) {
      expect(t(lang, "verify.body", { identity: "me" })).toContain("@me ping");
      expect(t(lang, "verify.body", { identity: "me" })).toContain("party send");
      expect(t(lang, "codex.stop.single", { channel: "pwtk", seq: 42, since: 41 })).toContain("party history pwtk --since 41");
      expect(t(lang, "codex.stop.backlog", { channel: "pwtk", seq: 42, total: 3, remaining: 2, drain: "party ack --drain --channel pwtk" }))
        .toContain("party ack --drain --channel pwtk");
      expect(t(lang, "hint.cross_session", { targets: "@peer", peersTool: "P", peerCheckTool: "C", seq: 42 })).toContain("seq=42");
      expect(t(lang, "wake.siblings", { n: 3 })).toContain("siblings=3");
    }
  });
});

describe("接收者历史缓存 receiverRecentBodies / resolveWakeLang", () => {
  test("同一 (server, channel, identity) 只拉一次；不同身份各拉各的；过了 TTL 再拉", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return ["中文历史"];
    };
    expect(await receiverRecentBodies(SOURCE, { fetch, now: NOW })).toEqual(["中文历史"]);
    expect(await receiverRecentBodies(SOURCE, { fetch, now: NOW + 1_000 })).toEqual(["中文历史"]);
    expect(calls).toBe(1);
    await receiverRecentBodies({ ...SOURCE, identity: "someone-else" }, { fetch, now: NOW });
    expect(calls).toBe(2);
    await receiverRecentBodies(SOURCE, { fetch, now: NOW + WAKE_LANG_CACHE_TTL_MS + 1 });
    expect(calls).toBe(3);
  });

  test("拉取失败 ⇒ 当没有历史（[]）且不缓存失败，下次还会再试", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      throw new Error("boom");
    };
    expect(await receiverRecentBodies(SOURCE, { fetch, now: NOW })).toEqual([]);
    expect(await receiverRecentBodies(SOURCE, { fetch, now: NOW })).toEqual([]);
    expect(calls).toBe(2);
  });

  test("resolveWakeLang：覆盖时一次都不拉；否则历史 > 触发消息 > env > en", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return ["merged, thanks"];
    };
    expect(await resolveWakeLang({ override: "zh", source: SOURCE, fetch, triggerBody: "english" })).toBe("zh");
    expect(calls).toBe(0);
    expect(await resolveWakeLang({ source: SOURCE, fetch, triggerBody: ZH_BODY })).toBe("en");
    expect(calls).toBe(1);
    expect(await resolveWakeLang({ source: null, triggerBody: ZH_BODY })).toBe("zh");
    expect(await resolveWakeLang({ source: null, env: { LANG: "zh_CN.UTF-8" } })).toBe("zh");
    expect(await resolveWakeLang({})).toBe("en");
  });
});
