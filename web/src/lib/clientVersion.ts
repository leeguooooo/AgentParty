// 发送方 CLI 版本展示 + 落后判定（#434）。
// 消息帧的 sender.client_version 是「发送时快照」；服务端 /api/version 声明当前 min_client_version。
// 低于该下限即视为落后，网页在该条消息旁标警告符号，提示升级。
//
// 版本比较规则与 worker/src/client-version.ts 的 compareClientVersions、cli/src/upgrade.ts 完全一致：
// 只认前三段数字（X.Y.Z），忽略 -beta.1 等预发行后缀，三端对 min-version 的判定不分叉。
import { useEffect, useState } from "react";
import { apiUrl } from "./base";

// a>b→1, a<b→-1, ==→0。
export function compareClientVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 发送方版本严格低于服务端最低版本 → 落后。任一为空则「未知」，一律不判落后（不误伤）。
export function isClientVersionOutdated(version: string | null | undefined, min: string | null | undefined): boolean {
  if (!version || !min) return false;
  return compareClientVersions(version, min) < 0;
}

// 服务端 /api/version 的两个版本信号，全站只拉一次并缓存；解析失败/离线一律回落 null（=未知）。
//   min_client_version：硬兼容地板（#434，鲜少上移，低于它才「太老」）——MessageCard 单条徽标用它。
//   version：服务端当前部署版本 = 最新发布列车（worker/cli/web 同一 v* tag）——#662 用它当「最新 CLI」判过时。
// 两者同源一次拉取，缓存各自更新、共用订阅者集合（各 hook 重读自己的缓存）。
let cachedMin: string | null = null;
let cachedLatest: string | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function pickString(data: unknown, key: string): string | null {
  if (data === null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fetchServerVersion(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = fetch(apiUrl("/api/version"), { headers: { accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      const min = pickString(data, "min_client_version");
      const latest = pickString(data, "version");
      let changed = false;
      if (min !== null && min !== cachedMin) {
        cachedMin = min;
        changed = true;
      }
      if (latest !== null && latest !== cachedLatest) {
        cachedLatest = latest;
        changed = true;
      }
      if (changed) for (const notify of listeners) notify();
    })
    .catch(() => {
      // 版本端点拿不到就当未知——宁可不标，也不误报。
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// 通用订阅：首个消费方触发一次拉取，拉到后所有订阅者一并重渲染。
// 非浏览器环境（如 bun 单测的 react-test-renderer）无 window，直接返回 null，不发网络请求。
function useServerVersion(read: () => string | null): string | null {
  const [value, setValue] = useState<string | null>(read);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setValue(read());
    listeners.add(update);
    if (cachedMin === null && cachedLatest === null) void fetchServerVersion();
    else update();
    return () => {
      listeners.delete(update);
    };
    // read 是稳定的模块级读取函数，无需入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

// 读取服务端最低客户端版本（硬兼容地板）。低于它才判「太老」。
export function useMinClientVersion(): string | null {
  return useServerVersion(() => cachedMin);
}

// 读取服务端当前部署版本 = 最新发布列车，作为「最新 CLI」基准（#662）。
// 低于它即「有更新版可升」，比 min 地板严格得多——owner 名下 agent 落后一个补丁也会被点名。
export function useLatestClientVersion(): string | null {
  return useServerVersion(() => cachedLatest);
}
