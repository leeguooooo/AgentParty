// 唤醒注入文案的内容与语言（issue #1003；#1052 起为 wake protocol v2）。
//
// 两件事集中在这一个文件里，别再散落字符串：
//   1. **说什么**：被 @ 唤醒时注入会话的那段话。v2（#1052 #4，与 open-cross-session 共用的
//      docs/wake-protocol.md §1）的骨架行序固定：
//        [AgentParty wake] <sender> mentioned you in #<channel> (seq <N>[, reply to seq <M>][, <ago>])
//        [siblings=N 行]
//        <空行>
//        <正文：≤4096B 逐字内联；否则前 512B（字符边界）+ `… (<total> bytes total; full text: …)` 行>
//        <空行>
//        Reply: <可直接复制执行的 party reply N …>
//        Thread: party history <channel> --seq N
//        from-id: <技术 identity>（#1002 防冒充行）
//      正文直接进上下文、回复命令填好——对齐 Claude Code 内置 SendMessage（正文直达、from 抄成 to）。
//      整条 ≤5120B（4096 正文 + 骨架 ≤1024）。
//   2. **用哪种语言**：按接收 agent 自己使用的语言来（owner：「语言应该根据 ai 使用的语言……自动改成
//      对应的语言」）。优先级见 detectWakeLang。先做 zh/en 两种。
//
// 同一套规则也覆盖：`party wake verify` 的验证帧正文（#996）、codex Stop hook 的 codexStopWakeReason
// （#965）、Claude Cross-session wake hint（#836）、空闲通知 idle notice（#1052 #5）。文案都从这里的 t() 取。
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { configPath as ambientAgentpartyConfigPath } from "./config";

export type WakeLang = "zh" | "en";

/** 唤醒通知总长上限（wake protocol v2）：4096 正文 + 骨架 ≤1024。 */
export const WAKE_NOTE_MAX_BYTES = 5120;
/** 正文逐字内联的上限（UTF-8 字节）；超过则只内联前 WAKE_NOTE_BODY_PREFIX_BYTES。 */
export const WAKE_NOTE_BODY_INLINE_MAX_BYTES = 4096;
/** 超长正文内联的前缀字节数（字符边界截断，不切多字节字符 / 代理对）。 */
export const WAKE_NOTE_BODY_PREFIX_BYTES = 512;
/** 骨架（头行 / siblings / Reply / Thread / from-id 与空行）的预算；超预算走降级阶梯。 */
export const WAKE_NOTE_SKELETON_MAX_BYTES = 1024;
/** 接收者最近消息里 CJK 字符占比超过这个值 ⇒ zh。 */
export const WAKE_LANG_CJK_RATIO = 0.3;
/** 判语言时看接收者在本频道最近多少条自己的消息。 */
export const WAKE_LANG_RECEIVER_SAMPLE = 20;
/** 接收者历史的进程内缓存时效：语言习惯不会分钟级变化，别每次注入都拉历史。 */
export const WAKE_LANG_CACHE_TTL_MS = 30 * 60 * 1000;
/** 发信人友好名进正文前的上限（字节），防长昵称把预算吃光：16 个汉字 / 48 个拉丁字母。 */
const WAKE_NOTE_SENDER_MAX_BYTES = 48;

export function isWakeLang(value: unknown): value is WakeLang {
  return value === "zh" || value === "en";
}

/** 显式覆盖值的归一化：`zh` / `zh-CN` / `en_US` 这类都认；认不出来 ⇒ null（不覆盖）。 */
export function normalizeWakeLang(value: unknown): WakeLang | null {
  if (typeof value !== "string") return null;
  const head = value.trim().toLowerCase();
  if (head === "") return null;
  if (/^zh/.test(head)) return "zh";
  if (/^en/.test(head)) return "en";
  return null;
}

// ---- 语言判定 ----

// CJK：汉字（含扩展 A、兼容区）+ 假名 + 谚文。日/韩用户今天也落到 zh 文案——比英文近。
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/gu;
const LETTER_RE = /\p{L}/gu;
// 去掉代码块、URL、@handle 再数：agent 的中文消息里常夹着一整段命令/日志，@ 的是技术 handle
// （`@lark-ad72b3f97491-agentparty`）——都不是它「说话」的语言。
const NOISE_RE = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|@[A-Za-z0-9][A-Za-z0-9._-]*/g;

/** 文本里 CJK 字符占全部字母类字符的比例；没有字母类字符 ⇒ null（无信号）。 */
export function cjkRatio(text: string): number | null {
  const cleaned = text.replace(NOISE_RE, " ");
  const letters = cleaned.match(LETTER_RE)?.length ?? 0;
  if (letters === 0) return null;
  const cjk = cleaned.match(CJK_RE)?.length ?? 0;
  return cjk / letters;
}

/** 一批文本的语言：CJK 占比 > WAKE_LANG_CJK_RATIO ⇒ zh，否则 en；完全没有字母类字符 ⇒ null。 */
export function textsLang(texts: readonly (string | null | undefined)[]): WakeLang | null {
  const joined = texts.filter((t): t is string => typeof t === "string" && t.trim() !== "").join("\n");
  if (joined === "") return null;
  const ratio = cjkRatio(joined);
  if (ratio === null) return null;
  return ratio > WAKE_LANG_CJK_RATIO ? "zh" : "en";
}

/** 接收会话的 locale：LC_ALL > LC_MESSAGES > LANG，zh* ⇒ zh；其余 ⇒ null（交给兜底）。 */
export function langFromEnv(env: NodeJS.ProcessEnv | undefined): WakeLang | null {
  if (env === undefined) return null;
  for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    return /^zh/i.test(value.trim()) ? "zh" : null;
  }
  return null;
}

export interface DetectWakeLangInput {
  /** config `lang` / `--lang`：显式覆盖，优先级最高。非法值当没有。 */
  override?: unknown;
  /** 接收 agent 自己在本频道最近 N 条消息的正文（「根据 ai 使用的语言」）。 */
  receiverRecentBodies?: readonly string[] | null;
  /** 触发这次唤醒的那条消息正文。 */
  triggerBody?: string | null;
  /** 接收会话的环境（LANG / LC_ALL）。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 语言判定，按优先级取第一个有信号的：
 *   1. 显式覆盖（config `lang`）；
 *   2. 接收者最近消息：CJK 占比 > 30% ⇒ zh，否则 en（有历史就以它为准，不再往下看）；
 *   3. 没有历史 ⇒ 触发消息正文，同一启发式；
 *   4. 都没有 ⇒ LANG/LC_ALL（zh* ⇒ zh）；
 *   5. 兜底 en。
 */
export function detectWakeLang(input: DetectWakeLangInput): WakeLang {
  const override = normalizeWakeLang(input.override);
  if (override !== null) return override;
  const fromReceiver = textsLang(input.receiverRecentBodies ?? []);
  if (fromReceiver !== null) return fromReceiver;
  const fromTrigger = textsLang([input.triggerBody]);
  if (fromTrigger !== null) return fromTrigger;
  return langFromEnv(input.env) ?? "en";
}

// ---- 接收者历史（进程内缓存） ----

export interface ReceiverBodiesSource {
  server: string;
  token: string;
  channel: string;
  /** 接收者的频道身份（msg 帧 sender.name）。 */
  identity: string;
}

export type FetchReceiverBodies = (source: ReceiverBodiesSource, signal?: AbortSignal) => Promise<string[]>;

const receiverBodiesCache = new Map<string, { bodies: string[]; at: number }>();

function receiverCacheKey(source: ReceiverBodiesSource): string {
  return `${source.server}\x00${source.channel}\x00${source.identity}`;
}

/** 测试用：清空 (server, channel, identity) 的历史缓存。 */
export function resetWakeLangCache(): void {
  receiverBodiesCache.clear();
}

/** 真实读法：REST 拉本频道最近 100 条，只留接收者自己发的、取最近 N 条正文。走 rest 的 fetchRecentMessages，不另开一套。 */
export const fetchReceiverBodiesViaRest: FetchReceiverBodies = async (source, signal) => {
  const { fetchRecentMessages } = await import("./rest");
  const wanted = source.identity.trim().toLowerCase();
  const frames = await fetchRecentMessages(source.server, source.token, source.channel, 100, {}, signal);
  return frames
    .filter(
      (frame) =>
        frame.type === "msg" &&
        typeof frame.body === "string" &&
        typeof frame.sender?.name === "string" &&
        frame.sender.name.trim().toLowerCase() === wanted,
    )
    .slice(-WAKE_LANG_RECEIVER_SAMPLE)
    .map((frame) => frame.body);
};

/**
 * 接收者最近消息正文，按 (server, channel, identity) 在进程内缓存 WAKE_LANG_CACHE_TTL_MS。
 * 拉取失败 ⇒ 返回 []（当「没有历史」，判定自然落到触发消息/环境），**不缓存**失败——下次再试。
 */
export async function receiverRecentBodies(
  source: ReceiverBodiesSource,
  opts: { fetch?: FetchReceiverBodies; now?: number; signal?: AbortSignal; ttlMs?: number } = {},
): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? WAKE_LANG_CACHE_TTL_MS;
  const key = receiverCacheKey(source);
  const hit = receiverBodiesCache.get(key);
  if (hit !== undefined && now - hit.at < ttl) return hit.bodies;
  let bodies: string[];
  try {
    bodies = await (opts.fetch ?? fetchReceiverBodiesViaRest)(source, opts.signal);
  } catch {
    return [];
  }
  receiverBodiesCache.set(key, { bodies, at: now });
  return bodies;
}

/** 一步到位：拉（缓存的）接收者历史 + detectWakeLang。任何失败都不抛，最差退到 en。 */
export async function resolveWakeLang(
  input: Omit<DetectWakeLangInput, "receiverRecentBodies"> & {
    source?: ReceiverBodiesSource | null;
    fetch?: FetchReceiverBodies;
    now?: number;
    signal?: AbortSignal;
  },
): Promise<WakeLang> {
  const override = normalizeWakeLang(input.override);
  if (override !== null) return override;
  let bodies: string[] = [];
  if (input.source !== undefined && input.source !== null) {
    bodies = await receiverRecentBodies(input.source, {
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
  return detectWakeLang({ receiverRecentBodies: bodies, triggerBody: input.triggerBody, env: input.env });
}

// ---- 文案 ----

type Params = Record<string, string | number>;

const MESSAGES: Record<WakeLang, Record<string, string>> = {
  zh: {
    "wake.header.named": "[AgentParty 唤醒] {sender} 在 #{channel} 提到了你（seq {seq}{replyTo}{when}）",
    "wake.header.anon": "[AgentParty 唤醒] 有人在 #{channel} 提到了你（seq {seq}{replyTo}{when}）",
    "wake.reply_to": "，回复 seq {seq}",
    "wake.when": "，{ago}",
    "wake.ago.now": "刚刚",
    "wake.ago.min": "{n} 分钟前",
    "wake.ago.hour": "{n} 小时前",
    "wake.ago.day": "{n} 天前",
    "wake.siblings": "siblings={n}：同身份有 {n} 个 runtime 在线，先看频道里有没有兄弟已回再开口",
    // 超长正文的截断行：与 open-cross-session 逐字一致（协议层文案，两种语言同一句）。
    "wake.body.truncated": "… ({total} bytes total; full text: {read})",
    "wake.reply": "回复：{cmd}",
    "wake.thread": "线程：{cmd}",
    "wake.reply.placeholder": "<你的回复>",
    "idle.notice.idle": "[跨会话空闲通知] {target} 现在空闲了（忙了 {duration}）。",
    "idle.notice.exited": "[跨会话空闲通知] {target} 在空闲前已退出。",
    "idle.notice.expired": "[跨会话空闲通知] {target} 6 小时内没有空闲，订阅已过期。",
    "duration.sec": "{s} 秒",
    "duration.min": "{m} 分 {s} 秒",
    "duration.hour": "{h} 小时 {m} 分",
    "verify.body": "@{identity} ping · 接入引导第 4 步的唤醒验证——收到请用 party send \"pong\" --reply-to <这条的 seq> 回一句",
    "codex.stop.single":
      "[AgentParty] 频道 #{channel} 有一条 @ 你的消息还没处理（seq {seq}）。" +
      "请先执行 `party history {channel} --since {since}` 读到正文，" +
      "再按正文内容处理并用 `party send` 回到该频道。" +
      "频道是唯一数据源：这条提示只给了指针，不要凭它猜测消息内容。处理完正常结束本轮即可。",
    "codex.stop.reply": "回复：`{cmd}`。",
    "codex.stop.single.scoped":
      "[AgentParty] #{channel} 有未处理 @（seq {seq}）。为防同名频道误投，执行 `{history}` 读正文。" +
      "处理后复用该命令里的 --config-b64 身份选择，再执行 send 子命令回频道；本提示不含正文。",
    "codex.stop.backlog":
      "[AgentParty] 频道 #{channel} 有 {total} 条 @ 你的消息还没处理，这是第 1/{total} 条（seq {seq}），" +
      "还有 {remaining} 条排在后面，每轮只会送一条。" +
      "一次读完全部并推进游标：`{drain}`。" +
      "读到正文后按内容处理，用 `party send` 回到该频道。频道是唯一数据源，不要凭本提示猜测内容。",
    "codex.stop.backlog.scoped":
      "[AgentParty] #{channel} 有 {total} 条未处理 @；当前 1/{total}（seq {seq}），后有 {remaining} 条。" +
      "为防同名频道误投，用固定身份一次读完并推进游标：`{drain}`。" +
      "按频道正文处理；回复时复用该命令里的 --config-b64 身份选择，再执行 send 子命令。",
    "hint.cross_session":
      "Cross-session 唤醒提示：{targets} 可能就在本机——Claude Cross-session 列表里仍有与这次 @ 匹配的会话。" +
      "列表有时效、可能已过期，这不是会话在线的证明。若提前在本机唤醒有帮助，先走完整授权链：" +
      "{peersTool} → Claude 内置 ListAgents → {peerCheckTool}，确认通过后才发一条 ≤512 UTF-8 字节、" +
      "只含 channel+seq 引用（本频道，seq={seq}）、不带正文的 SendMessage。" +
      "AgentParty 频道仍是唯一事实源，对方去频道读正文。",
  },
  en: {
    "wake.header.named": "[AgentParty wake] {sender} mentioned you in #{channel} (seq {seq}{replyTo}{when})",
    "wake.header.anon": "[AgentParty wake] you were mentioned in #{channel} (seq {seq}{replyTo}{when})",
    "wake.reply_to": ", reply to seq {seq}",
    "wake.when": ", {ago}",
    "wake.ago.now": "just now",
    "wake.ago.min": "{n} min ago",
    "wake.ago.hour": "{n} h ago",
    "wake.ago.day": "{n} d ago",
    "wake.siblings": "siblings={n}: {n} live runtimes share your identity; check whether a sibling already replied before you speak.",
    "wake.body.truncated": "… ({total} bytes total; full text: {read})",
    "wake.reply": "Reply: {cmd}",
    "wake.thread": "Thread: {cmd}",
    "wake.reply.placeholder": "<your reply>",
    "idle.notice.idle": "[Cross-session idle notice] {target} is now idle. (busy for {duration})",
    "idle.notice.exited": "[Cross-session idle notice] {target} exited before going idle.",
    "idle.notice.expired": "[Cross-session idle notice] {target} did not go idle within 6h; subscription expired.",
    "duration.sec": "{s}s",
    "duration.min": "{m}m {s}s",
    "duration.hour": "{h}h {m}m",
    "verify.body": "@{identity} ping · onboarding step 4 wake verification — when you get this, reply with party send \"pong\" --reply-to <this seq>",
    "codex.stop.single":
      "[AgentParty] #{channel} has one unhandled @-mention for you (seq {seq}). " +
      "First run `party history {channel} --since {since}` to read the body, " +
      "then act on it and reply with `party send` in that channel. " +
      "The channel is the single source of truth: this hint is only a pointer, do not guess the content. Finish the turn normally when done.",
    "codex.stop.reply": " Reply: `{cmd}`.",
    "codex.stop.single.scoped":
      "[AgentParty] #{channel} has an unhandled @ (seq {seq}). To avoid a same-name channel misroute, read it with `{history}`. " +
      "Act on the channel body, then reuse that --config-b64 identity selector with the send subcommand. This hint has no body.",
    "codex.stop.backlog":
      "[AgentParty] #{channel} has {total} unhandled @-mentions for you; this is 1/{total} (seq {seq}), " +
      "{remaining} more are queued and each turn delivers one. " +
      "Read them all and advance the cursor at once: `{drain}`. " +
      "Act on the bodies and reply with `party send` in that channel. The channel is the single source of truth; do not guess from this hint.",
    "codex.stop.backlog.scoped":
      "[AgentParty] #{channel} has {total} unhandled @s; this is 1/{total} (seq {seq}), with {remaining} queued. " +
      "To avoid a same-name channel misroute, read all and advance the cursor with the exact identity: `{drain}`. " +
      "Act on the channel bodies, then reuse that --config-b64 identity selector with the send subcommand.",
    "hint.cross_session":
      "Cross-session wake hint: {targets} may be reachable locally — a Claude Cross-session listing still matches this mention. " +
      "Listings expire and can be stale, so this is not proof of a live session. If an earlier local wake would help, follow the " +
      "full authorization chain first: {peersTool}, then Claude's built-in ListAgents, then {peerCheckTool}, and only after a " +
      "confirmed check send one SendMessage of at most 512 UTF-8 bytes that carries only a channel+seq reference (this channel, " +
      "seq={seq}) and no message body. The AgentParty channel remains the single source of truth; the peer reads the message there.",
  },
};

/** 取文案。key 不存在属程序错误（直接抛，别静默吐出 key 本身给模型看）。`{name}` 占位符按 params 替换。 */
export function t(lang: WakeLang, key: string, params: Params = {}): string {
  const template = MESSAGES[lang][key];
  if (template === undefined) throw new Error(`wake-note-i18n: unknown key ${key}`);
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。ts 缺失、非法或在未来 ⇒ null（不写时间）。 */
export function relativeTime(lang: WakeLang, ts: number | null | undefined, now: number): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0 || !Number.isFinite(now)) return null;
  const delta = now - ts;
  if (delta < 0) return null;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return t(lang, "wake.ago.now");
  if (minutes < 60) return t(lang, "wake.ago.min", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(lang, "wake.ago.hour", { n: hours });
  return t(lang, "wake.ago.day", { n: Math.floor(hours / 24) });
}

// ---- 唤醒通知本体 ----

/** 正文末行元信息键（#986）：`from-id: <技术 identity>`。 */
export const WAKE_NOTE_FROM_ID_KEY = "from-id:";
const WAKE_NOTE_FROM_ID_RE = /^from-id: (\S+)/gm;

/**
 * 从通知正文读回 from-id（#986 防冒充字段的读回路径）；没有则 null。
 * v2 起正文逐字内联，对方正文里也可能出现 `from-id:` 形状的行——真正的 from-id 恒是最后一行，取最后一个匹配。
 */
export function wakeNoteFromId(note: string): string | null {
  let last: string | null = null;
  for (const match of note.matchAll(WAKE_NOTE_FROM_ID_RE)) last = match[1] ?? last;
  return last;
}

/** 技术 identity 进正文前的净化：只认无空白的单个 token，空/非串一律当没有。 */
export function normalizeWakeFromId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, "").trim();
  return cleaned === "" ? null : cleaned;
}

export interface BuildWakeNoteInput {
  lang: WakeLang;
  channel: string;
  seq: number;
  /** 发信人友好名（senderFriendlyName）；缺 ⇒ 「有人 / you were mentioned」。 */
  sender?: string | null;
  /** 触发消息的时间戳（epoch ms）；缺 ⇒ 不写相对时间。 */
  ts?: number | null;
  /** 当前时刻（epoch ms）；缺省 Date.now()。 */
  now?: number;
  /** 触发消息正文；缺/空 ⇒ 不给正文块（老调用方 / 只带指针的短版）。 */
  body?: string | null;
  /** 触发消息回复的那条 seq（帧 reply_to）；有 ⇒ 头行写「reply to seq M」。 */
  replyTo?: number | null;
  /**
   * 接收方身份来自显式 `AGENTPARTY_CONFIG` 路径时传入：Reply 行前缀 `AGENTPARTY_CONFIG=<path> `，
   * 复制即用、不依赖 cwd 解析到同一身份（同目录并发会话会撞 workspaceId，见 config.ts）。
   */
  configPath?: string | null;
  /** from-name 背后的技术 identity（#986）；缺/空 ⇒ 不写 from-id 行。 */
  fromId?: string | null;
  /** 同身份存活 runtime 数（#963）；≤1/缺省 ⇒ 不写。 */
  siblings?: number;
  /** 总预算，缺省 WAKE_NOTE_MAX_BYTES。 */
  maxBytes?: number;
  /** 骨架预算，缺省 WAKE_NOTE_SKELETON_MAX_BYTES（且不超过 maxBytes）。 */
  skeletonMaxBytes?: number;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** 按字节预算截到码点边界；超出时末尾加 …。 */
export function clampPreview(text: string, budget: number): string {
  if (bytes(text) <= budget) return text;
  const ellipsis = "…";
  const limit = budget - bytes(ellipsis);
  if (limit <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = bytes(ch);
    if (used + size > limit) break;
    out += ch;
    used += size;
  }
  return `${out.trimEnd()}${ellipsis}`;
}


/** 按字节数在字符边界截断（不切开多字节字符 / 代理对），不加省略号；≤budget 时原样返回。 */
export function cutOnCharBoundary(text: string, budget: number): string {
  if (bytes(text) <= budget) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = bytes(ch);
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out;
}

function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 可直接复制执行的回复命令（Reply 行）。当前会话已经会解析到同一 config 时，不重复显示
 * `AGENTPARTY_CONFIG=`；只有跨身份注入才保留这个必要的作用域前缀（#1076）。
 */
export function wakeReplyCommand(
  lang: WakeLang,
  channel: string,
  seq: number,
  configPath?: string | null,
  ambientConfigPath: string | null = ambientAgentpartyConfigPath(),
): string {
  const scoped = typeof configPath === "string" && configPath.trim() !== "" ? configPath.trim() : null;
  const needsPrefix = scoped !== null
    && (ambientConfigPath === null || comparablePath(scoped) !== comparablePath(ambientConfigPath));
  const prefix = needsPrefix ? `AGENTPARTY_CONFIG=${shellQuote(scoped)} ` : "";
  return `${prefix}party reply ${seq} "${t(lang, "wake.reply.placeholder")}" --channel ${channel}`;
}

/** 读线程的命令（Thread 行）。 */
export function wakeThreadCommand(channel: string, seq: number): string {
  return `party history ${channel} --seq ${seq}`;
}

/** 路径进 shell 命令前的最小引用：只含安全字符时原样，否则单引号包裹。 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./~-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 唤醒通知正文（wake protocol v2 §1，≤ maxBytes）：
 *   [AgentParty wake] <sender> mentioned you in #<channel> (seq <N>[, reply to seq <M>][, <ago>])
 *   [siblings=N 行]
 *
 *   <body>                       ← ≤4096B 逐字内联；否则前 512B（字符边界）+ `… (<total> bytes total; full text: <read>)`
 *
 *   Reply: <可复制执行的回复命令>
 *   Thread: party history <channel> --seq N
 *   [from-id: <技术 identity>]   ← 永不因预算被挤掉
 *
 * 骨架（除正文外的一切）预算 skeletonMaxBytes（缺省 1024）：超预算按阶梯让步——siblings 行只留裸 `siblings=N`
 * → 去掉 <ago> → 去掉发信人（头行退回「有人提到了你」）→ 去掉 Reply 行里的 AGENTPARTY_CONFIG 前缀。
 * Reply / Thread / from-id 永不让步；让完仍超预算属于程序错误（channel ≤64 + identity ≤64，正常不会），直接抛。
 * 正文块按「骨架 + 正文 ≤ maxBytes」判定内联还是截前缀，因此整条恒 ≤ maxBytes。
 */
export function buildWakeNote(input: BuildWakeNoteInput): string {
  const { lang, channel, seq } = input;
  const maxBytes = input.maxBytes ?? WAKE_NOTE_MAX_BYTES;
  const skeletonMax = Math.min(maxBytes, input.skeletonMaxBytes ?? WAKE_NOTE_SKELETON_MAX_BYTES);
  const now = input.now ?? Date.now();
  const fullSender = typeof input.sender === "string" && input.sender.trim() !== ""
    ? clampPreview(input.sender.trim(), WAKE_NOTE_SENDER_MAX_BYTES)
    : null;
  const fullAgo = relativeTime(lang, input.ts, now);
  const replyTo = typeof input.replyTo === "number" && Number.isInteger(input.replyTo) && input.replyTo > 0
    ? t(lang, "wake.reply_to", { seq: input.replyTo })
    : "";
  const siblingsCount = typeof input.siblings === "number" && Number.isInteger(input.siblings) && input.siblings > 1
    ? input.siblings
    : null;
  const fromId = normalizeWakeFromId(input.fromId);
  const fromIdLine = fromId === null ? null : `${WAKE_NOTE_FROM_ID_KEY} ${fromId}`;
  const body = typeof input.body === "string" ? input.body : "";
  const hasBody = body.trim() !== "";
  const threadLine = t(lang, "wake.thread", { cmd: wakeThreadCommand(channel, seq) });

  interface Tier {
    sender: string | null;
    ago: string | null;
    siblingsBare: boolean;
    configPath: string | null;
  }
  const assemble = (tier: Tier, bodyBlock: string | null): string => {
    const when = tier.ago === null ? "" : t(lang, "wake.when", { ago: tier.ago });
    const header = tier.sender === null
      ? t(lang, "wake.header.anon", { channel, seq, replyTo, when })
      : t(lang, "wake.header.named", { sender: tier.sender, channel, seq, replyTo, when });
    const siblings = siblingsCount === null
      ? null
      : tier.siblingsBare ? `siblings=${siblingsCount}` : t(lang, "wake.siblings", { n: siblingsCount });
    const replyLine = t(lang, "wake.reply", { cmd: wakeReplyCommand(lang, channel, seq, tier.configPath) });
    const lines: (string | null)[] = [header, siblings];
    // 正文块前后各一空行；没有正文（老调用方）时骨架与命令行之间仍留一空行。
    if (bodyBlock !== null) lines.push("", bodyBlock);
    lines.push("", replyLine, threadLine, fromIdLine);
    return lines.filter((line): line is string => line !== null).join("\n");
  };

  const cfg = typeof input.configPath === "string" && input.configPath.trim() !== "" ? input.configPath : null;
  // 让步阶梯：完整 → siblings 裸 → 无 ago → 无发信人 → 无发信人且无 ago → 再去 AGENTPARTY_CONFIG 前缀。
  const tiers: Tier[] = [
    { sender: fullSender, ago: fullAgo, siblingsBare: false, configPath: cfg },
    { sender: fullSender, ago: fullAgo, siblingsBare: true, configPath: cfg },
    { sender: fullSender, ago: null, siblingsBare: true, configPath: cfg },
    { sender: null, ago: fullAgo, siblingsBare: true, configPath: cfg },
    { sender: null, ago: null, siblingsBare: true, configPath: cfg },
    { sender: null, ago: null, siblingsBare: true, configPath: null },
  ];
  for (const tier of tiers) {
    // 骨架字节数按「带空正文块」算：正文块前后的空行也是骨架的一部分，这样 总长 = 骨架 + 正文 恒成立。
    const skeleton = assemble(tier, hasBody ? "" : null);
    const skeletonBytes = bytes(skeleton);
    if (skeletonBytes > skeletonMax) continue;
    if (!hasBody) return skeleton;
    const total = bytes(body);
    let bodyBlock: string;
    if (total <= WAKE_NOTE_BODY_INLINE_MAX_BYTES && skeletonBytes + total <= maxBytes) {
      bodyBlock = body;
    } else {
      const prefix = cutOnCharBoundary(body, WAKE_NOTE_BODY_PREFIX_BYTES);
      bodyBlock = `${prefix}\n${t(lang, "wake.body.truncated", { total, read: wakeThreadCommand(channel, seq) })}`;
    }
    const note = assemble(tier, bodyBlock);
    if (bytes(note) > maxBytes) continue;
    return note;
  }
  throw new Error(`wake note exceeds ${maxBytes} bytes`);
}

// ---- 空闲通知（#1052 #5，wake protocol v2 §2） ----

export type IdleNoticeReason = "idle" | "exited" | "expired";

/** 时长文案：<60s ⇒ Ns；<1h ⇒ Mm Ss；否则 Hh Mm（中文：N 秒 / M 分 S 秒 / H 小时 M 分）。 */
export function formatDuration(lang: WakeLang, ms: number): string {
  const totalSec = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSec < 60) return t(lang, "duration.sec", { s: totalSec });
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return t(lang, "duration.min", { m: totalMin, s: totalSec % 60 });
  return t(lang, "duration.hour", { h: Math.floor(totalMin / 60), m: totalMin % 60 });
}

export interface BuildIdleNoticeInput {
  lang: WakeLang;
  target: string;
  reason: IdleNoticeReason;
  /** reason=idle 时目标忙了多久（ms）；缺省 0。 */
  busyMs?: number | null;
}

/**
 * 空闲通知正文（逐字对齐规范 §2）：
 *   [Cross-session idle notice] <target> is now idle. (busy for <duration>)
 *   [Cross-session idle notice] <target> exited before going idle.
 *   [Cross-session idle notice] <target> did not go idle within 6h; subscription expired.
 * 注入时 from-name 为 `AgentParty`，不带 from-id 行（发信人是系统，不是频道成员）。
 */
export function buildIdleNotice(input: BuildIdleNoticeInput): string {
  const target = input.target.replace(/\s+/g, "").trim();
  switch (input.reason) {
    case "idle":
      return t(input.lang, "idle.notice.idle", { target, duration: formatDuration(input.lang, input.busyMs ?? 0) });
    case "exited":
      return t(input.lang, "idle.notice.exited", { target });
    case "expired":
      return t(input.lang, "idle.notice.expired", { target });
  }
}
