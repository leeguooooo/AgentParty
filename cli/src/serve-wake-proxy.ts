// serve 本机唤醒代理（issue #841 P3）。
//
// 目标：频道消息 @ 到「本机已入册、当前 idle（无自己的 delivery 连接）」的交互式
// Claude 会话时，serve 不自己起新会话处理，而是给原会话转投一条 ≤512B 的唤醒
// 通知（只带 channel+seq 指针，被唤醒会话自己回频道读正文），随后照常继续自己
// 的职责。
//
// 载体调研结论（开放问题 B，2026-08 复核）：serve 进程今天**没有**可用的最小
// 转投载体——
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
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";

/** 三不变量之一：唤醒通知只带 channel+seq 指针，且总长 ≤512 UTF-8 字节。 */
export const WAKE_PROXY_NOTE_MAX_BYTES = 512;

export interface WakeProxyRef {
  channel: string;
  seq: number;
}

/**
 * 未来载体要发的通知正文：只含 channel+seq 指针，不含消息正文。
 * 超出 512B 属于程序错误（channel ≤64 字符 + seq 数字，正常永远不会触发）。
 */
export function wakeProxyNote(ref: WakeProxyRef): string {
  const note =
    `AgentParty wake: you were mentioned in #${ref.channel} at seq=${ref.seq}. ` +
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
 * - 只认绑定同一 channel 的条目；
 * - 多个候选取最新入册（与蛰伏 announce 的选择一致）。
 * 死会话由 listClaudeSessions 的 kill(pid,0) 探活现场剔除（开放问题 C）：
 * 进程已退出的条目根本不会出现在这里，消息自然回落到现行为。
 */
export function selectWakeProxyTarget(
  mentions: readonly string[],
  self: string,
  channel: string,
  sessions: readonly ClaudeSessionRegistryEntry[],
): ClaudeSessionRegistryEntry | null {
  const wanted = new Set(mentions.filter((name) => name !== self));
  if (wanted.size === 0) return null;
  let best: ClaudeSessionRegistryEntry | null = null;
  for (const entry of sessions) {
    if (entry.channel !== channel) continue;
    if (!wanted.has(claudeSessionAnnounceName(entry))) continue;
    if (best === null || entry.registered_at >= best.registered_at) best = entry;
  }
  return best;
}

/** 可注入的转投载体：true=已转投成功；false/抛错=未转投（降级为现行为）。 */
export type WakeProxyForwarder = (
  target: ClaudeSessionRegistryEntry,
  ref: WakeProxyRef,
) => Promise<boolean>;

/**
 * 默认载体：无传输（见文件头调研结论），恒返回 false。
 * 未来载体落地后从这里替换，判定/降级骨架与测试不变。
 */
export const noWakeProxyForwarder: WakeProxyForwarder = async () => false;

export interface WakeProxyAttempt {
  /** true 仅当载体确认转投成功；此时被唤醒会话自己去频道读 seq。 */
  forwarded: boolean;
  /** 命中的目标宣告名；null = 无本机入册目标（含死会话已被剔除的情形）。 */
  target: string | null;
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
    );
  } catch {
    return { forwarded: false, target: null };
  }
  if (target === null) return { forwarded: false, target: null };
  const name = claudeSessionAnnounceName(target);
  try {
    const forwarded = await (deps.forward ?? noWakeProxyForwarder)(target, ref);
    log(
      forwarded
        ? `serve: 唤醒代理已转投 @${name}（channel=${ref.channel} seq=${ref.seq}，≤512B 指针，正文在频道）`
        : `serve: @${name} 命中本机入册的 idle Claude 会话，但当前无可用转投载体——降级为现行为（见 #841 P3）`,
    );
    return { forwarded, target: name };
  } catch (error) {
    log(`serve: 唤醒代理转投 @${name} 失败（${String(error)}）——降级为现行为，消息不丢`);
    return { forwarded: false, target: name };
  }
}
