// serve 本机唤醒代理（issue #841 P3）。
//
// 目标：频道消息 @ 到「本机已入册、当前 idle（无自己的 delivery 连接）」的交互式
// Claude 会话时，serve 不自己起新会话处理，而是给原会话转投一条 ≤512B 的唤醒
// 通知（只带 channel+seq 指针，被唤醒会话自己回频道读正文），随后照常继续自己
// 的职责。
//
// ⚠️ 载体现状（#856 起）：默认载体是**真载体** `socketWakeProxyForwarder`（serve.ts 的
// `?? socketWakeProxyForwarder()`），走本机 UDS 收件箱注入。下面那段「今天没有可用载体」
// 是 #841 时代的结论，保留作历史背景——但**不要**再据它写「无可用转投载体」这类日志：
// 今天 forwarded=false 的含义是「socket 注入以某个已知原因失败了」，原因必须打出来（#867 ①）。
//
// 载体调研结论（开放问题 B，2026-08 复核；已被 #844/#856 推翻，存档）：serve 进程当时
// **没有**可用的最小转投载体——
//   - Claude 的跨会话 SendMessage 是模型专属工具：claude-cross-session-gate 只放
//     行「armed Claude 会话内、走完 peers→ListAgents→peer_check 授权链的一次
//     模型调用」，serve 不是 Claude 会话，伪造这条链等于绕过 gate。
//   - Claude inbox socket 是三不变量之一，绝不直连（shell 直投已在 #836 前置
//     调研中证伪：无公开传输，且摘要面 ≤512B-only）。
//   - 起一次性 `claude -p` 转投会产生新会话 + 每条 @ 一次模型调用成本，且新会
//     话仍要走完整授权链，不满足「最小可行」。
//   - 真正对味的未来载体是蛰伏 announce MCP（#841 P2）自己：它已持有目标会话
//     的 stdio 通道并消费频道帧，补上 claude/channel 通知注入即可让「频道本身」
//     充当唯一传输——那是独立切片，不属于 serve 侧。
// 因此本模块落的是「转投判定 + 记录 + 降级为现行为」的骨架：判定与降级路径为
// 一等实现并被单测覆盖，转投函数可注入（未来载体接上即生效），默认载体恒返回
// false（未转投），serve 行为与现状一致——消息绝不因代理而丢失。
import { Buffer } from "node:buffer";
import {
  claudeSessionAnnounceName,
  listClaudeSessions,
  sessionEntryMatchesServer,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";
import { injectChannelMessage } from "./claude-inbox-inject";
import { friendlyAgentLabel } from "@agentparty/shared/identity";
import { readConfig, type CachedIdentity } from "./config";

/** 三不变量之一：唤醒通知只带 channel+seq 指针，且总长 ≤512 UTF-8 字节。 */
export const WAKE_PROXY_NOTE_MAX_BYTES = 512;

export interface WakeProxyRef {
  channel: string;
  /** serve 这条连接所连的实例 URL（#865）。频道 slug 跨实例不唯一，选目标必须同时比对它。 */
  server: string;
  seq: number;
  /**
   * 同身份存活 runtime 数（#963）。>1 时被唤醒的会话得知道自己是 N 个之一——先看频道里有没有
   * 兄弟已回，再决定要不要开口。省略/≤1 不写进通知。
   */
  siblings?: number;
}

/**
 * 未来载体要发的通知正文：只含 channel+seq 指针，不含消息正文。
 * 超出 512B 属于程序错误（channel ≤64 字符 + seq 数字，正常永远不会触发）。
 */
export function wakeProxyNote(ref: WakeProxyRef): string {
  const siblings = typeof ref.siblings === "number" && Number.isInteger(ref.siblings) && ref.siblings > 1
    ? ` siblings=${ref.siblings}: ${ref.siblings} live runtimes share your identity; ` +
      "check whether a sibling already replied before you speak."
    : "";
  const note =
    `AgentParty wake: you were mentioned in #${ref.channel} at seq=${ref.seq}.${siblings} ` +
    "Read the channel (party history) for the message body; the channel is the single source of truth.";
  if (Buffer.byteLength(note, "utf8") > WAKE_PROXY_NOTE_MAX_BYTES) {
    throw new Error("wake proxy note exceeds 512 bytes");
  }
  return note;
}

/**
 * 转投判定：在本频道的入册活会话里找被 @ 的目标。
 * - 宣告名（display_name 或回退 `claude-<12hex>`）必须出现在 mentions 里；
 * - 排除 serve 自己的身份（自己的 @ 走 runner，不转投）；
 * - 只认绑定同一 **server + channel** 的条目（#865：slug 跨实例不唯一，两台生产实例上
 *   都有 `agentparty`，只比 slug 会把 A 实例的 @ 注入到只属于 B 实例的会话——实机撞见）；
 *   旧条目（无 server 字段）恒不匹配，下次 SessionStart 自然升级；
 * - 多个候选取最新入册（与蛰伏 announce 的选择一致）。
 * 死会话由 listClaudeSessions 的 kill(pid,0) 探活现场剔除（开放问题 C）：
 * 进程已退出的条目根本不会出现在这里，消息自然回落到现行为。
 *
 * ⚠️ 已知局限（#857 实测记录，**本次刻意不改**）：mentions 里只会出现频道 handle，
 * 而这里比对的是宣告名（peers 命名空间），两者恒不相等 → 本函数今天实际上永远返回
 * null，serve 侧的唤醒代理是一条不触发的路径。改成按频道身份比对会翻转语义：本机
 * 交互式会话与 serve 共用同一个 agent config，「@ 我」的那个 handle 恰好就是被
 * `self` 排除掉的自己——放开它等于同一条 @ 既跑 serve runner 又注入交互式会话（双处理），
 * 会动到 serve 的 wake/欠账记账。#857 的 announce 腿已经在正确的命名空间上覆盖了这个
 * 场景（且不需要 serve 在跑），所以这里保持现状，是否合并两条腿留给单独切片决策。
 */
export function selectWakeProxyTarget(
  mentions: readonly string[],
  self: string,
  channel: string,
  sessions: readonly ClaudeSessionRegistryEntry[],
  server?: string | null,
): ClaudeSessionRegistryEntry | null {
  const wanted = new Set(mentions.filter((name) => name !== self));
  if (wanted.size === 0) return null;
  let best: ClaudeSessionRegistryEntry | null = null;
  for (const entry of sessions) {
    if (entry.channel !== channel) continue;
    if (!sessionEntryMatchesServer(entry, server)) continue;
    if (!wanted.has(claudeSessionAnnounceName(entry))) continue;
    if (best === null || entry.registered_at >= best.registered_at) best = entry;
  }
  return best;
}

/**
 * 注入面板上的「谁发来的」。接收端把它原样显示成
 * `from uds:<sock> (peer claims name: <fromName>)`（#844 实测面板文本），**面板不另外
 * 显示我们的技术 identity**——所以 fromName 必须自带技术 ID，否则两个仅哈希段不同的
 * 身份（`lark-ad72b3f97491-agentparty` / `lark-ad72b3f9749e-agentparty`）会显示成同一个
 * `leo · agentparty`，界面上无法分辨。
 *
 * 形态：`<所属人> · <角色> (<技术 identity>)`——友好前半对齐 web 的 identityDisplay
 * （规则同源于 shared/src/identity.ts），括号里给完整技术 ID 保证唯一可辨（选 A 不选
 * 尾 5 位短码：短码仍会碰撞，而 from-name 没有长度硬限，只禁 `"` 与 `\r\n<>`）。
 * 读不到本机 identity（未登录/旧配置）→ 回退 `agentparty#<channel>`。
 */
export function injectFromName(
  channel: string,
  identity: CachedIdentity | null | undefined = resolveLocalIdentity(),
): string {
  if (identity === null || identity === undefined || typeof identity.name !== "string" || identity.name === "") {
    return `agentparty#${channel}`;
  }
  return sanitizeFromName(withTechnicalId(friendlyAgentLabel(identity), identity.name), channel);
}

/**
 * announce 注入（#857）用的 from-name：那条路径知道**真实发信人**（频道 msg 帧的 sender），
 * 显示发信人比显示中转身份有用得多。规则同 injectFromName——友好名 + 括号里的技术 ID：
 * - 人类：`<display_name || handle || owner>`（本身就可读，技术 name 同值时不重复加括号）；
 * - agent：`<所属人> · <角色> (<技术 identity>)`。
 * sender 缺失/不可读时回退 `agentparty#<channel>`。
 */
export function senderInjectFromName(
  sender: { name?: string; kind?: string; owner?: string | null; handle?: string | null; display_name?: string | null } | null | undefined,
  channel: string,
): string {
  const name = typeof sender?.name === "string" ? sender.name.trim() : "";
  if (name === "") return `agentparty#${channel}`;
  const friendly = sender?.kind === "human"
    ? (sender.display_name?.trim() || sender.handle?.trim() || sender.owner?.trim() || name)
    : friendlyAgentLabel({
        name,
        owner: sender?.owner ?? null,
        owner_handle: null,
        owner_display_name: null,
      });
  return sanitizeFromName(withTechnicalId(friendly, name), channel);
}

/**
 * 友好名后缀技术 ID——但友好名里**已经含有**技术 name 时不重复（真机实测踩到：
 * 非哈希前缀的 name 提不出角色，会渲染成 `x · foo-agent (foo-agent)`）。
 */
function withTechnicalId(friendly: string, name: string): string {
  return friendly.includes(name) ? friendly : `${friendly} (${name})`;
}

/**
 * from-name 净化：injectChannelMessage 会硬拒含 `"` / `\r\n<>` 的 from-name（会破坏接收端
 * 的完整性自校验）。频道昵称是用户可控数据，这里把非法字符换成 `_`，别让一个昵称把整条
 * 唤醒路径打成静默失败。
 */
function sanitizeFromName(value: string, channel: string): string {
  const cleaned = value.replace(/["\r\n<>]/g, "_").trim();
  return cleaned === "" ? `agentparty#${channel}` : cleaned;
}

/** 本机缓存身份；任何读取失败都当「没有」（注入 fromName 回退频道名）。 */
export function resolveLocalIdentity(cwd?: string): CachedIdentity | null {
  try {
    return readConfig(cwd)?.identity ?? null;
  } catch {
    return null;
  }
}

/**
 * 载体的结构化结果（#867 ①）：失败时带上真实原因，供降级日志打印。
 * 载体也可以直接返回裸 boolean（老形态，测试/骨架载体在用）——此时没有原因可报，
 * 日志会明说「载体未上报原因」，而不是编一个。
 */
export interface WakeProxyForwardResult {
  ok: boolean;
  /** 失败原因（injectChannelMessage 的 InjectFailureReason，或载体自定义）。 */
  reason?: string;
  /** 细节（如 write-failed 的具体错误、socket-untrusted 的判据）。 */
  detail?: string;
}

/** 可注入的转投载体：ok=true 已转投；ok=false/抛错=未转投（降级为现行为）。 */
export type WakeProxyForwarder = (
  target: ClaudeSessionRegistryEntry,
  ref: WakeProxyRef,
) => Promise<boolean | WakeProxyForwardResult>;

/** 裸 boolean 与结构化结果的归一化。 */
function normalizeForwardResult(value: boolean | WakeProxyForwardResult): WakeProxyForwardResult {
  return typeof value === "boolean" ? { ok: value } : value;
}

/**
 * 骨架载体：无传输，恒返回 false（降级为现行为）。保留给不接 socket 面的场景/测试。
 * 这条是**真的**「无可用转投载体」——serve 的默认载体早已不是它（见 serve.ts 的
 * `?? socketWakeProxyForwarder()`）。
 */
export const noWakeProxyForwarder: WakeProxyForwarder = async (): Promise<WakeProxyForwardResult> => ({
  ok: false,
  reason: "no-carrier",
  detail: "noWakeProxyForwarder：本载体无传输",
});

export interface SocketWakeProxyForwarderOptions {
  /** 自己的回执 socket（`from:uds:<...>`）。serve 无回执 sock → 省略，接收端记 unknown。 */
  fromSock?: string;
  /** 频道昵称解析（"Message from <fromName>"）；默认用 channel 名。 */
  fromName?: (ref: WakeProxyRef) => string;
  /** 注入实现注入点（测试用）；默认真实 injectChannelMessage。 */
  inject?: typeof injectChannelMessage;
  env?: NodeJS.ProcessEnv;
}

/**
 * socket 优先载体（#844）：把 ≤512B 的 channel+seq 指针以 Claude 原生「Message from X」
 * 内联 UX 注入本机目标会话的 UDS 收件箱。
 * - 目标宣告名（display_name 或回退 claude-<12hex>）＝ Claude 原生会话 `name`，据此寻址。
 * - 任一步失败（无匹配 socket/探活失败/写入错/版本不符）→ 返回 false，attemptWakeProxy
 *   据此降级为现行为（serve 照常跑自己的 runner，即 headless resume loop 兜底）。
 *
 * 送达语义（#844）：返回 true 只代表「帧已写进对方收件箱」，**不代表已进对方对话流**
 * ——接收端 crossSessionInbound 默认 hold 时消息进待审队列且 5 分钟无人处理即被 drop。
 * 因此 serve 侧绝不能拿这个 true 去清 @ 欠账 / ack 越过该 seq：真正送达以对方回话为准。
 * 现状已符合——serve.ts 只 await attemptWakeProxy 并**丢弃返回值**，wake/ack/stuck 记账
 * 完全走独立的 qualifies 路径，转投与否都不改变现行为（「纯增量」）。改这里前先复核那点。
 *
 * TODO(#844 serve 降级集成)：当前 socket 不可用时的「serve headless resume loop stdin 注入」
 * 复用的是 serve 现行为（runner 正常处理这条 @），不是独立的 stdin 注入调用。待 serve 侧
 * 暴露显式的「把下一个 user turn 喂给 resume loop」接口后，可在此 false 分支上再挂一跳，
 * 走 ≤512B 指针的 stdin 注入而非整轮 runner。届时本 forwarder 返回值语义不变。
 */
export function socketWakeProxyForwarder(
  options: SocketWakeProxyForwarderOptions = {},
): WakeProxyForwarder {
  const inject = options.inject ?? injectChannelMessage;
  // 默认 from-name＝友好名 + 技术 ID（owner 2026-08-20：技术 ID 是身份本身，不能丢）。
  const fromName = options.fromName ?? ((ref: WakeProxyRef) => injectFromName(ref.channel));
  return async (target, ref) => {
    const result = await inject({
      // 同 #857：按 pid 寻址（registry entry.pid 与 ~/.claude/sessions/<pid>.json 同源），
      // sessionId 防 pid 复用。宣告名只作展示/回退，绝不用来寻址。
      pid: target.pid,
      sessionId: target.session_id,
      name: claudeSessionAnnounceName(target),
      body: wakeProxyNote(ref),
      fromName: fromName(ref),
      fromSock: options.fromSock,
      env: options.env,
    });
    // #867 ①：结构化失败原因**必须**透出。以前这里是 `return result.ok;`，
    // injectChannelMessage 精心构造的 6 种 {reason, detail} 全被丢掉，
    // 「目标会话已死 / socket 陈旧残留 / 同名多会话」在日志里长得一模一样。
    return result.ok ? { ok: true } : { ok: false, reason: result.reason, detail: result.detail };
  };
}

export interface WakeProxyAttempt {
  /** true 仅当载体确认转投成功；此时被唤醒会话自己去频道读 seq。 */
  forwarded: boolean;
  /** 命中的目标宣告名；null = 无本机入册目标（含死会话已被剔除的情形）。 */
  target: string | null;
  /** forwarded=false 时的真实失败原因；载体没上报则为 null（#867 ①）。 */
  reason?: string | null;
  /** 失败细节；无则 null。 */
  detail?: string | null;
}

export interface WakeProxyDeps {
  listSessions?: () => ClaudeSessionRegistryEntry[];
  forward?: WakeProxyForwarder;
  log?: (line: string) => void;
}

/**
 * serve 帧循环里的转投入口。任何一步失败（注册表读取、载体抛错、载体返回
 * false）都降级为 {forwarded:false}：serve 照常按现行为处理，消息绝不丢失。
 * 本函数绝不抛错。
 */
export async function attemptWakeProxy(
  mentions: readonly string[],
  self: string,
  ref: WakeProxyRef,
  deps: WakeProxyDeps = {},
): Promise<WakeProxyAttempt> {
  const log = deps.log ?? (() => {});
  let target: ClaudeSessionRegistryEntry | null = null;
  try {
    target = selectWakeProxyTarget(
      mentions,
      self,
      ref.channel,
      (deps.listSessions ?? listClaudeSessions)(),
      ref.server,
    );
  } catch {
    return { forwarded: false, target: null };
  }
  if (target === null) return { forwarded: false, target: null };
  const name = claudeSessionAnnounceName(target);
  try {
    const result = normalizeForwardResult(await (deps.forward ?? noWakeProxyForwarder)(target, ref));
    if (result.ok) {
      log(`serve: 唤醒代理已转投 @${name}（channel=${ref.channel} seq=${ref.seq}，≤512B 指针，正文在频道）`);
      return { forwarded: true, target: name, reason: null, detail: null };
    }
    // #867 ①：这行以前恒打「当前无可用转投载体」——那是 #841 时代的实话（默认载体
    // 是 noWakeProxyForwarder），#856 把默认载体换成真载体后就变成了**反话**：真实失败
    // 是 no-match / probe-failed / ambiguous / socket-untrusted 之一，日志却告诉运维
    // 「没有载体」，排障面被封死。现在打真实原因。
    const reason = result.reason ?? null;
    const detail = result.detail ?? null;
    log(
      `serve: @${name} 命中本机入册的 idle Claude 会话，但转投未成功（channel=${ref.channel} seq=${ref.seq}` +
        ` reason=${reason ?? "unreported"}${detail === null ? "" : ` detail=${detail}`}）` +
        "——降级为现行为，消息不丢",
    );
    return { forwarded: false, target: name, reason, detail };
  } catch (error) {
    log(
      `serve: 唤醒代理转投 @${name} 失败（channel=${ref.channel} seq=${ref.seq}` +
        ` reason=threw detail=${String(error)}）——降级为现行为，消息不丢`,
    );
    return { forwarded: false, target: name, reason: "threw", detail: String(error) };
  }
}
