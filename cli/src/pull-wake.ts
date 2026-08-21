// 拉取式唤醒通道的可达性（issue #905）。
//
// 背景：#899/#901 的 codex Stop hook 是一条**拉取式**唤醒通道——会话在自己 turn 结束时
// 主动来取欠账，服务端从头到尾不知道它存在，也没有任何 presence 注册。于是 `who` 那套
// 「有没有活连接 / 有没有通知订阅」的可达性判据永远看不见它，把实际可达的身份判成
// unreachable，还顺手建议去挂 `party serve`——恰恰是 #897 里 owner 明确不要的后台 runner。
//
// 为什么不做「hook 上报能力位」：Stop hook 眼下是**全程零网络**的同步读盘路径（见
// codex-stop-wake.ts 文件头的预算说明），而 #903 正在改这条路径。往里塞一次能力位上报，
// 既要抢 #903 正在动的文件，又要给一条以「零网络」为设计前提的 hook 加上网络依赖。
// 更根本的是：上报一次就得考虑它什么时候失效——hook 被卸载、身份换机器、config 被删，
// 服务端都无从知晓，于是能力位会变成一个**永不过期的谎**，比现在的误判更难发现。
//
// 所以这里退而求其次，并且**如实标注这只是本机视角**：
//   - 本机 ~/.codex/hooks.json 里确实挂着 `party hook codex-stop`；
//   - 本机 ~/.agentparty/agents 里确实有这个身份、这个频道、这台服务器的 config。
// 两条都成立时，这条 @ 会在该身份下次在**本机**跑 codex 时被它自己取走。别的机器有没有装、
// 用户还会不会再开那个会话，本机一概不知道——所以措辞只说「本机可拉取」，绝不说「可达」。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localAgentConfigsForChannel } from "./config";

/** codex Stop hook 的命令指纹。与 hook.ts 的 codexHookSettingsJson 写入的命令一致。 */
export const CODEX_STOP_HOOK_COMMAND = "hook codex-stop";

/**
 * 一个身份的「拉取式唤醒」线索。
 *
 * scope 恒为 "local"：这是本机文件系统的观察结果，不是服务端事实。任何消费方（终端行、
 * JSON、未来的 web）都必须把它当作本机视角展示，不许升格成服务端可达性。
 */
export interface PullWakeHint {
  scope: "local";
  /** 这条拉取通道属于哪个 harness。目前只有 codex Stop hook 一种。 */
  harness: "codex";
  /** 判据清单，便于调用方解释「凭什么这么说」。 */
  evidence: ["codex_stop_hook", "local_agent_config"];
}

/** ~/.codex/hooks.json 的位置。注入 userHome 仅为单测。 */
export function codexHooksPath(userHome: string = homedir()): string {
  return join(userHome, ".codex", "hooks.json");
}

/**
 * 本机是否挂着 codex Stop hook。
 *
 * 只认 `hooks.Stop[*].hooks[*].command` 里含指纹的条目：文件不存在、JSON 坏了、形状不对
 * 一律返回 false。**读不到就当没有**——多标一个 unreachable 只是少给一条提示，
 * 错标一个「可拉取」却会让人以为消息有人接。
 */
export function hasCodexStopHook(path: string = codexHooksPath()): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;
  const stop = (hooks as Record<string, unknown>).Stop;
  if (!Array.isArray(stop)) return false;
  for (const group of stop) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) continue;
    const inner = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(inner)) continue;
    for (const entry of inner) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const command = (entry as Record<string, unknown>).command;
      if (typeof command === "string" && command.includes(CODEX_STOP_HOOK_COMMAND)) return true;
    }
  }
  return false;
}

/** 本机为该频道 + 该服务器持有 config 的身份名集合。 */
export function locallyConfiguredNames(channel: string, server: string): Set<string> {
  const names = new Set<string>();
  // currentConfigPath=null：当前身份自己也要算进来——它同样会被本机的 Stop hook 取走欠账。
  for (const hint of localAgentConfigsForChannel(channel, null)) {
    // #865：本机两台生产实例都有同名频道。不比服务器就会把隔壁实例的同名身份认成本机可拉取。
    if (hint.server !== server) continue;
    names.add(hint.name);
  }
  return names;
}

export interface PullWakeLookup {
  /** 该身份在本机是否有拉取式唤醒通道。 */
  hintFor: (name: string) => PullWakeHint | undefined;
}

/**
 * 建一次索引，供整张 who 表复用——每行各自读盘会把 who 变成 N 次目录扫描。
 * 没装 hook 时直接返回恒空的查询器，连 agents 目录都不扫。
 */
export function buildPullWakeLookup(
  channel: string,
  server: string,
  deps: { hasHook?: () => boolean; names?: (channel: string, server: string) => Set<string> } = {},
): PullWakeLookup {
  const hasHook = deps.hasHook ?? (() => hasCodexStopHook());
  if (!hasHook()) return { hintFor: () => undefined };
  const names = (deps.names ?? locallyConfiguredNames)(channel, server);
  return {
    hintFor: (name: string) =>
      names.has(name)
        ? { scope: "local", harness: "codex", evidence: ["codex_stop_hook", "local_agent_config"] }
        : undefined,
  };
}
