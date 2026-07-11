// party serve 本地连接健康探针（#254）：watchdog 不能只凭 pgrep 判断 serve 是否真的还在收帧——
// 进程/launchd 状态是"活着"的必要条件，不是充分条件；socket 僵住或陷入重连循环时 PID 依旧健在。
// 这里落一份 workspace 级的 health.json，与 statusline-cache.ts 同源同规范（tmp+rename 原子写、
// 0600、last-writer-wins）；serve 在 WS 生命周期转场（open/reconnecting/关闭）与每次收到服务端
// frame 时各写一次，写入频率跟着 ping 心跳节奏（~25s）走，空闲频道也不会假新鲜。
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentpartyHome, workspaceId } from "./config";

export interface HealthCache {
  v: 1;
  pid: number;
  channel: string;
  /** 真实 WS 生命周期上报的连接状态；不由 presence 自报或 PID 推断（issue #254 契约①）。 */
  ws_connected: boolean;
  /** 最近一次收到服务端 frame（含 pong）的时间戳；watchdog 用它判断新鲜度。 */
  last_frame_at: number | null;
  /** 当前是否处于退避重连中；busy runner 不应影响这个字段（契约⑥，由 serve 侧保证）。 */
  reconnecting: boolean;
  /** 本进程生命周期内进入过 reconnecting 状态的次数（不是重连尝试次数，是"掉线过几回"）。 */
  reconnect_count: number;
  /** 最近一次 fatal/close 错误的简述；不含 token、消息正文、prompt（契约⑤）。 */
  last_error: string | null;
  /** 当前这次连上是从什么时候开始的；重连后刷新，断开时清空。 */
  connected_since: number | null;
  updated_at: number;
}

export type HealthPatch = Partial<Omit<HealthCache, "v" | "pid" | "updated_at">>;

export function healthCachePath(cwd: string = process.cwd()): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "health.json");
}

export function readHealthCache(cwd: string = process.cwd()): HealthCache | null {
  try {
    const body = JSON.parse(readFileSync(healthCachePath(cwd), "utf8")) as HealthCache;
    return body.v === 1 ? body : null;
  } catch {
    return null;
  }
}

// 字段级合并：patch 里显式传的 key（哪怕值是 null/false/0）一律采纳，未提到的 key 保留旧值。
// 不能用 `??` 兜底——`last_frame_at: null` 这类"显式清空"跟"没传"在 `??` 下无法区分。
function pick<K extends keyof HealthPatch>(patch: HealthPatch, key: K, fallback: HealthCache[K]): HealthCache[K] {
  return key in patch ? (patch[key] as HealthCache[K]) : fallback;
}

export function writeHealthCache(patch: HealthPatch, cwd: string = process.cwd(), now: number = Date.now()): HealthCache {
  const prev = readHealthCache(cwd);
  const next: HealthCache = {
    v: 1,
    pid: process.pid,
    channel: pick(patch, "channel", prev?.channel ?? ""),
    ws_connected: pick(patch, "ws_connected", prev?.ws_connected ?? false),
    last_frame_at: pick(patch, "last_frame_at", prev?.last_frame_at ?? null),
    reconnecting: pick(patch, "reconnecting", prev?.reconnecting ?? false),
    reconnect_count: pick(patch, "reconnect_count", prev?.reconnect_count ?? 0),
    last_error: pick(patch, "last_error", prev?.last_error ?? null),
    connected_since: pick(patch, "connected_since", prev?.connected_since ?? null),
    updated_at: now,
  };

  const path = healthCachePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${now}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return next;
}

/** serve 退出时的终局标记：只清自己写的记录（pid 匹配），不踩另一个仍在跑的 serve（#254 同 statusline 的并发准则）。 */
export function clearHealthCache(cwd: string = process.cwd(), now: number = Date.now()): void {
  const current = readHealthCache(cwd);
  if (!current || current.pid !== process.pid) return;
  writeHealthCache({ ws_connected: false, reconnecting: false, connected_since: null }, cwd, now);
}
