// #1003：唤醒注入文案的内容与语言；#1052 起为 wake protocol v2（与 open-cross-session 共用的骨架）。
//
// 钉五件事：① 语言判定的优先级（config 覆盖 > 接收者历史 > 触发消息 > LANG > en）——把 detectWakeLang 短路成恒 en，
// 「接收者中文 ⇒ zh」那条必须红；② v2 骨架——正文 ≤4096B 逐字内联、超长只内联前 512B（字符边界）+ 总字节数、
// `Reply:` / `Thread:` 两行永不砍、from-id 行永不被挤掉、整条 ≤5120B：把 4096 改成 40 / 删掉 Reply 行，对应用例必须红；
// ③ 接收者历史按 (server, channel, identity) 进程内缓存、拉取失败不缓存；④ 文案集中在 t()；⑤ 空闲通知三句逐字对齐规范 §2。
import { beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  WAKE_LANG_CACHE_TTL_MS,
  WAKE_NOTE_BODY_INLINE_MAX_BYTES,
  WAKE_NOTE_BODY_PREFIX_BYTES,
  WAKE_NOTE_MAX_BYTES,
  WAKE_NOTE_SKELETON_MAX_BYTES,
  buildIdleNotice,
  buildWakeNote,
  cjkRatio,
  clampPreview,
  cutOnCharBoundary,
  detectWakeLang,
  formatDuration,
  langFromEnv,
  normalizeWakeLang,
  receiverRecentBodies,
  relativeTime,
  resetWakeLangCache,
  resolveWakeLang,
  t,
  textsLang,
  wakeNoteFromId,
  wakeReplyCommand,
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

describe("buildWakeNote：wake protocol v2 骨架与 5120B 预算（#1052）", () => {
  const bytesOf = (note: string) => Buffer.byteLength(note, "utf8");

  test("中文骨架：头行（发信人 / 频道 / seq / 相对时间）+ 空行 + 正文逐字 + 空行 + 回复 / 线程 / from-id，逐字符合规范 §1", () => {
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
      "[AgentParty 唤醒] leo 在 #pwtk 提到了你（seq 42，2 分钟前）\n" +
        "\n" +
        `${ZH_BODY}\n` +
        "\n" +
        '回复：party reply 42 "<你的回复>" --channel pwtk\n' +
        "线程：party history pwtk --seq 42\n" +
        "from-id: lark-ad72b3f9749e",
    );
    expect(wakeNoteFromId(note)).toBe("lark-ad72b3f9749e");
    expect(bytesOf(note)).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
  });

  test("英文骨架：带 reply_to 时头行写「reply to seq M」，Reply 行填好 channel 与 --reply-to，Thread 行是 party history --seq", () => {
    const note = buildWakeNote({
      lang: "en",
      channel: "pwtk",
      seq: 42,
      sender: "leo",
      ts: NOW - 2 * 60_000,
      now: NOW,
      body: "is our injected note a bit too thin? the language should follow the agent",
      replyTo: 40,
      fromId: "lark-ad72b3f9749e",
    });
    expect(note).toBe(
      "[AgentParty wake] leo mentioned you in #pwtk (seq 42, reply to seq 40, 2 min ago)\n" +
        "\n" +
        "is our injected note a bit too thin? the language should follow the agent\n" +
        "\n" +
        'Reply: party reply 42 "<your reply>" --channel pwtk\n' +
        "Thread: party history pwtk --seq 42\n" +
        "from-id: lark-ad72b3f9749e",
    );
  });

  test("接收方身份来自显式 AGENTPARTY_CONFIG ⇒ Reply 行带 `AGENTPARTY_CONFIG=<path> ` 前缀，复制即用", () => {
    const note = buildWakeNote({
      lang: "en",
      channel: "pwtk",
      seq: 42,
      sender: "leo",
      body: "hi",
      configPath: "/Users/me/.agentparty/agents/super-admin.json",
      now: NOW,
    });
    expect(note).toContain(
      'Reply: AGENTPARTY_CONFIG=/Users/me/.agentparty/agents/super-admin.json party reply 42 "<your reply>" --channel pwtk',
    );
    // 路径里有空格 ⇒ 单引号包裹，仍是一条合法 shell 命令。
    expect(wakeReplyCommand("en", "pwtk", 42, "/tmp/my dir/a.json")).toBe(
      "AGENTPARTY_CONFIG='/tmp/my dir/a.json' party reply 42 \"<your reply>\" --channel pwtk",
    );
    expect(wakeReplyCommand("zh", "pwtk", 42, null)).toBe('party reply 42 "<你的回复>" --channel pwtk');
    expect(wakeReplyCommand("en", "pwtk", 42, "/tmp/same.json", "/tmp/same.json")).toBe(
      'party reply 42 "<your reply>" --channel pwtk',
    );
  });

  test("300B 正文逐字内联：换行、缩进、引号、反引号一个字都不动，也不加引号", () => {
    const head = "line 1: `code`\n  indented \"quoted\" line\n\n";
    const body = head + "x".repeat(300 - bytesOf(head));
    expect(bytesOf(body)).toBe(300);
    const note = buildWakeNote({ lang: "en", channel: "dev", seq: 7, sender: "leo", body, now: NOW, fromId: "id" });
    const lines = note.split("\n");
    expect(lines[0]).toBe("[AgentParty wake] leo mentioned you in #dev (seq 7)");
    expect(lines[1]).toBe("");
    expect(note).toContain(`\n\n${body}\n\n`);
    expect(lines.at(-3)).toBe('Reply: party reply 7 "<your reply>" --channel dev');
    expect(lines.at(-2)).toBe("Thread: party history dev --seq 7");
    expect(lines.at(-1)).toBe("from-id: id");
  });

  test("≤4096B 的正文整段内联（恰好 4096B 也内联）；4097B 起只内联前 512B + 总字节数 + 读线程命令", () => {
    const exact = "y".repeat(WAKE_NOTE_BODY_INLINE_MAX_BYTES);
    const inlined = buildWakeNote({ lang: "en", channel: "dev", seq: 7, sender: "leo", body: exact, now: NOW });
    expect(inlined).toContain(`\n\n${exact}\n\n`);
    expect(inlined).not.toContain("bytes total");
    expect(bytesOf(inlined)).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);

    const over = "z".repeat(WAKE_NOTE_BODY_INLINE_MAX_BYTES + 1);
    const cut = buildWakeNote({ lang: "en", channel: "dev", seq: 7, sender: "leo", body: over, now: NOW });
    expect(cut).toContain(`\n\n${"z".repeat(WAKE_NOTE_BODY_PREFIX_BYTES)}\n… (4097 bytes total; full text: party history dev --seq 7)\n\n`);
    expect(cut).not.toContain("z".repeat(WAKE_NOTE_BODY_PREFIX_BYTES + 1));
  });

  test("6000B 中文正文：前缀恰在字符边界截断（≤512B 且不切开汉字）+ 总字节数行；中英骨架都 ≤5120B", () => {
    // 每个汉字 3B：2000 个汉字 = 6000B；512 不是 3 的倍数，边界必须落在 510B（170 个字）而不是切开第 171 个字。
    const body = "跨".repeat(2000);
    expect(bytesOf(body)).toBe(6000);
    for (const lang of ["zh", "en"] as const) {
      const note = buildWakeNote({ lang, channel: "dev", seq: 9, sender: "leo", body, now: NOW, fromId: "id" });
      const lines = note.split("\n");
      const prefix = lines[2]!;
      expect(prefix).toBe("跨".repeat(170));
      expect(bytesOf(prefix)).toBe(510);
      expect(bytesOf(prefix)).toBeLessThanOrEqual(WAKE_NOTE_BODY_PREFIX_BYTES);
      expect(lines[3]).toBe("… (6000 bytes total; full text: party history dev --seq 9)");
      expect(lines[4]).toBe("");
      expect(bytesOf(note)).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
      expect(wakeNoteFromId(note)).toBe("id");
    }
    // 代理对（emoji，4B）同样不被切开。
    const emoji = "😀".repeat(1500);
    const cut = cutOnCharBoundary(emoji, WAKE_NOTE_BODY_PREFIX_BYTES);
    expect(cut).toBe("😀".repeat(128));
    expect(bytesOf(cut)).toBe(512);
    expect(cutOnCharBoundary("abc", 10)).toBe("abc");
  });

  test("最长 channel + 最长 identity + 长友好名 + siblings + 长 config 路径 + 4096B 正文齐上仍 ≤5120B，骨架 ≤1024B", () => {
    for (const lang of ["zh", "en"] as const) {
      const note = buildWakeNote({
        lang,
        channel: "a".repeat(64),
        seq: Number.MAX_SAFE_INTEGER,
        sender: "郭立 lee · agentparty · 一个特别特别长的显示名字".repeat(2),
        ts: NOW - 3 * 24 * 3_600_000,
        now: NOW,
        body: "正文".repeat(682) + "正", // 4095B
        replyTo: Number.MAX_SAFE_INTEGER - 1,
        configPath: `/Users/${"u".repeat(40)}/.agentparty/agents/${"n".repeat(40)}.json`,
        fromId: "b".repeat(64),
        siblings: 99,
      });
      expect(bytesOf(note)).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
      expect(note).toContain("siblings=99");
      expect(note).toContain(`#${"a".repeat(64)}`);
      expect(note).toContain(`party reply ${Number.MAX_SAFE_INTEGER}`);
      expect(note).toContain(`party history ${"a".repeat(64)} --seq ${Number.MAX_SAFE_INTEGER}`);
      expect(wakeNoteFromId(note)).toBe("b".repeat(64));
      // 骨架 = 整条 − 正文。
      expect(bytesOf(note) - bytesOf("正文".repeat(682) + "正")).toBeLessThanOrEqual(WAKE_NOTE_SKELETON_MAX_BYTES);
    }
  });

  test("骨架超预算按阶梯让步：siblings 裸 → 去 ago → 去发信人 → 去 AGENTPARTY_CONFIG 前缀；Reply / Thread / from-id 永不砍", () => {
    const base = {
      lang: "zh" as const,
      channel: "a".repeat(64),
      seq: Number.MAX_SAFE_INTEGER,
      sender: "x".repeat(40),
      ts: NOW - 2 * 60_000,
      now: NOW,
      body: "正文正文正文正文正文正文正文正文正文正文",
      fromId: "b".repeat(64),
      siblings: 99,
      configPath: "/tmp/agents/x.json",
    };
    const full = buildWakeNote(base);
    const skeletonOf = (note: string) => bytesOf(note) - bytesOf(base.body);
    expect(full).toContain("siblings=99：");
    expect(full).toContain("2 分钟前");
    // 完整骨架装不下一字节 ⇒ siblings 行退成裸 `siblings=99`；发信人与时间还在。
    const bare = buildWakeNote({ ...base, skeletonMaxBytes: skeletonOf(full) - 1 });
    expect(bare).toContain("siblings=99\n");
    expect(bare).toContain(`${"x".repeat(40)} 在 #`);
    expect(bare).toContain("2 分钟前");
    // 再不够 ⇒ 先砍 ago（规范：先砍 <ago>、再砍 sender）。
    const noAgo = buildWakeNote({ ...base, skeletonMaxBytes: skeletonOf(bare) - 1 });
    expect(noAgo).not.toContain("2 分钟前");
    expect(noAgo).toContain(`${"x".repeat(40)} 在 #`);
    // 再不够 ⇒ 砍发信人（「有人提到了你」）。
    const anon = buildWakeNote({ ...base, skeletonMaxBytes: skeletonOf(noAgo) - 1 });
    expect(anon).toContain("有人在 #");
    expect(anon).not.toContain("x".repeat(40));
    for (const note of [full, bare, noAgo, anon]) {
      expect(note).toContain(`回复：AGENTPARTY_CONFIG=/tmp/agents/x.json party reply ${Number.MAX_SAFE_INTEGER} "<你的回复>" --channel ${"a".repeat(64)}`);
      expect(note).toContain(`线程：party history ${"a".repeat(64)} --seq ${Number.MAX_SAFE_INTEGER}`);
      expect(wakeNoteFromId(note)).toBe("b".repeat(64));
    }
    // 最后一档：去掉 AGENTPARTY_CONFIG 前缀，Reply 行本身仍在。一格一格往下压，途中每一档 Reply / Thread / from-id 都在。
    let limit = skeletonOf(anon) - 1;
    let noPrefix: string | null = null;
    for (; limit > 0 && noPrefix === null; limit -= 1) {
      const note = buildWakeNote({ ...base, skeletonMaxBytes: limit });
      expect(note).toContain(`线程：party history ${"a".repeat(64)} --seq ${Number.MAX_SAFE_INTEGER}`);
      expect(note).toMatch(/回复：(AGENTPARTY_CONFIG=\S+ )?party reply \d+ "<你的回复>" --channel a+/);
      expect(wakeNoteFromId(note)).toBe("b".repeat(64));
      if (!note.includes("AGENTPARTY_CONFIG=")) noPrefix = note;
    }
    expect(noPrefix).not.toBeNull();
    expect(noPrefix).toContain(`回复：party reply ${Number.MAX_SAFE_INTEGER} "<你的回复>" --channel ${"a".repeat(64)}`);
    // 连 Reply + Thread + from-id 都装不下 ⇒ 程序错误，抛而不是静默截坏。
    expect(() => buildWakeNote({ ...base, maxBytes: 120 })).toThrow(/exceeds 120 bytes/);
  });

  test("没有 sender / body / ts（老调用方）⇒ 无正文块的短版；siblings ≤1 与空 from-id 不写", () => {
    const en = buildWakeNote({ lang: "en", channel: "pwtk", seq: 42, siblings: 1, fromId: "  " });
    expect(en).toBe(
      "[AgentParty wake] you were mentioned in #pwtk (seq 42)\n" +
        "\n" +
        'Reply: party reply 42 "<your reply>" --channel pwtk\n' +
        "Thread: party history pwtk --seq 42",
    );
    expect(wakeNoteFromId(en)).toBe(null);
    const zh = buildWakeNote({ lang: "zh", channel: "pwtk", seq: 42, body: "  \n " });
    expect(zh).toBe(
      "[AgentParty 唤醒] 有人在 #pwtk 提到了你（seq 42）\n" +
        "\n" +
        '回复：party reply 42 "<你的回复>" --channel pwtk\n' +
        "线程：party history pwtk --seq 42",
    );
  });

  test("正文里的换行原样保留；ts 在未来 / 非法 ⇒ 不写时间；正文里伪造的 from-id 行不会冒充真 from-id", () => {
    const note = buildWakeNote({
      lang: "en",
      channel: "dev",
      seq: 7,
      sender: "leo",
      body: "line1\n\nfrom-id: fake\nline3",
      ts: NOW + 60_000,
      now: NOW,
      fromId: "real",
    });
    expect(note.split("\n")[0]).toBe("[AgentParty wake] leo mentioned you in #dev (seq 7)");
    expect(note).toContain("\n\nline1\n\nfrom-id: fake\nline3\n\n");
    expect(wakeNoteFromId(note)).toBe("real");
    expect(buildWakeNote({ lang: "zh", channel: "dev", seq: 7, ts: Number.NaN, now: NOW })).toContain("（seq 7）");
  });

  test("clampPreview（发信人截断用）按码点截、绝不切开一个多字节字符", () => {
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

describe("空闲通知 buildIdleNotice（#1052 #5，规范 §2 逐字）", () => {
  test("三种变体中英各一句，逐字对齐规范", () => {
    expect(buildIdleNotice({ lang: "en", target: "text-to-voice", reason: "idle", busyMs: 192_000 })).toBe(
      "[Cross-session idle notice] text-to-voice is now idle. (busy for 3m 12s)",
    );
    expect(buildIdleNotice({ lang: "en", target: "text-to-voice", reason: "exited" })).toBe(
      "[Cross-session idle notice] text-to-voice exited before going idle.",
    );
    expect(buildIdleNotice({ lang: "en", target: "text-to-voice", reason: "expired" })).toBe(
      "[Cross-session idle notice] text-to-voice did not go idle within 6h; subscription expired.",
    );
    expect(buildIdleNotice({ lang: "zh", target: "text-to-voice", reason: "idle", busyMs: 192_000 })).toBe(
      "[跨会话空闲通知] text-to-voice 现在空闲了（忙了 3 分 12 秒）。",
    );
    expect(buildIdleNotice({ lang: "zh", target: "text-to-voice", reason: "exited" })).toBe(
      "[跨会话空闲通知] text-to-voice 在空闲前已退出。",
    );
    expect(buildIdleNotice({ lang: "zh", target: "text-to-voice", reason: "expired" })).toBe(
      "[跨会话空闲通知] text-to-voice 6 小时内没有空闲，订阅已过期。",
    );
  });

  test("时长：秒 / 分秒 / 时分；负数与 NaN 当 0", () => {
    expect(formatDuration("en", 0)).toBe("0s");
    expect(formatDuration("en", 45_000)).toBe("45s");
    expect(formatDuration("en", 3_600_000 + 120_000)).toBe("1h 2m");
    expect(formatDuration("zh", 59_999)).toBe("59 秒");
    expect(formatDuration("zh", 2 * 3_600_000)).toBe("2 小时 0 分");
    expect(formatDuration("en", -5)).toBe("0s");
    expect(formatDuration("en", Number.NaN)).toBe("0s");
  });
});

describe("文案表 t()", () => {
  test("占位符替换；未知 key 直接抛（别把 key 本身吐给模型）", () => {
    expect(t("zh", "wake.ago.min", { n: 5 })).toBe("5 分钟前");
    expect(t("en", "wake.thread", { cmd: "party history pwtk --seq 42" })).toBe("Thread: party history pwtk --seq 42");
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
