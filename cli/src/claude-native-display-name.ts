// 注册表展示名与 Claude 原生会话名对齐（#1052 #6）。
//
// Claude 内置 cross-session 里一个会话只有一个名字（`~/.claude/sessions/<pid>.json` 的 `name`，
// 形如 `agentparty-83`）。AgentParty 的 SessionStart hook 常常跑在 Claude 写出这个文件之前，
// 于是注册表 display_name 留 null、宣告名回退成 `claude-<12hex>`——`party who` / peers 列表里
// 是一串谁也不认识的名字，与 ListAgents 按精确名关联也永远对不上。
//
// 这里补两条路：
//   - hook 后续每一轮（PreToolUse/Stop/…，每轮一个进程）读一次原生名，读到且与条目不同就更新；
//   - announce 绑定宿主会话时读一次，读不到隔一小段再读一次（每进程一次重试），仍读不到才用回退名。
// 两条路都只在 pid + sessionId 双双吻合时才认（nativeSessionName 内置的 expectSessionId 校验），
// 绝不把别的会话的名字写进这条目。任何失败静默——hook 铁律：不抛、不阻塞。
import { nativeSessionName } from "./claude-inbox-inject";
import {
  claudeSessionAnnounceName,
  isClaudeSessionDisplayName,
  patchClaudeSessionEntry,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";

/** announce 首次读不到原生名时的重试间隔（Claude 通常在启动后百毫秒内写出寻址文件）。 */
export const ANNOUNCE_NATIVE_NAME_RETRY_MS = 500;
/** 只对刚入册（SessionStart 不久）的会话重试：老会话还没名字＝Claude 根本没写，等也没用。 */
export const ANNOUNCE_NATIVE_NAME_RETRY_WINDOW_MS = 60_000;

/**
 * 读一次原生名；读到、合法且与条目不同 ⇒ 写回注册表并返回新名；否则返回条目现有的 display_name。
 * 返回值是「此刻应当展示的注册表名」（可能仍为 null＝继续用回退名）。
 */
export function syncNativeDisplayName(
  entry: ClaudeSessionRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const name = nativeSessionName(entry.pid, { expectSessionId: entry.session_id, env });
    if (!isClaudeSessionDisplayName(name)) return entry.display_name;
    if (name === entry.display_name) return name;
    patchClaudeSessionEntry(entry.session_id, { display_name: name }, env);
    return name;
  } catch {
    return entry.display_name;
  }
}

/**
 * announce 绑定宿主会话时的宣告名：原生名优先；首次读不到就等 `retryDelayMs` 再读一次
 * （每进程对同一会话只重试一次），仍读不到才回退 `claude-<12hex>`。
 */
const retriedSessions = new Set<string>();

export async function announceDisplayName(
  entry: ClaudeSessionRegistryEntry,
  env: NodeJS.ProcessEnv = process.env,
  options: { retryDelayMs?: number; retryWindowMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  let name = syncNativeDisplayName(entry, env);
  if (name === null) {
    const key = entry.session_id.toLowerCase();
    const fresh = Date.now() - entry.registered_at < (options.retryWindowMs ?? ANNOUNCE_NATIVE_NAME_RETRY_WINDOW_MS);
    if (fresh && !retriedSessions.has(key)) {
      retriedSessions.add(key);
      await abortableDelay(options.retryDelayMs ?? ANNOUNCE_NATIVE_NAME_RETRY_MS, options.signal);
      name = syncNativeDisplayName(entry, env);
    }
  }
  return name ?? claudeSessionAnnounceName(entry);
}

/** 测试用：允许同一进程内再次重试。 */
export function resetAnnounceNativeNameRetries(): void {
  retriedSessions.clear();
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
