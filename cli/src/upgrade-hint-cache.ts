// #703：watch --once 每轮重挂都是新进程，内存节流拦不住。用磁盘时间戳把「探一次服务端版本 + 打升级
// 提示」限到每 TTL 一次（默认 6h），既避免每轮重挂都发 /api/version（延迟/请求数敏感），也不刷 stderr。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cacheSlotPath } from "./cache-slot";

// 升级提示探测节流窗口：behind-latest 是增益信号，不必频繁——6 小时一次足够温和又不烦。
export const UPGRADE_HINT_TTL_MS = 6 * 60 * 60 * 1000;

// 返回 true = 现在应探测（并已把「本次探测时间」落盘，消费掉本窗口的额度）；false = 仍在窗口内，跳过。
// 消费的是「探测」额度而非「打印」额度：即便本次探测发现已是最新，也占掉窗口，故最多每 TTL 一次网络探测。
// 全 best-effort：读不到/解析失败当作「该探测」；写失败也照常返回 true（宁可偶尔多探，不静默永不提示）。
export function shouldProbeUpgrade(
  channel: string,
  cwd: string,
  now: number,
  ttlMs: number = UPGRADE_HINT_TTL_MS,
): boolean {
  const path = cacheSlotPath("upgrade-hint", channel, cwd);
  try {
    const at = (JSON.parse(readFileSync(path, "utf8")) as { at?: unknown }).at;
    if (typeof at === "number" && now - at < ttlMs) return false;
  } catch {
    // 无记录 / 不可读 / 坏 JSON：视为该探测
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: now }));
  } catch {
    // 落盘失败（只读 home 等）：仍返回 true，本次照常探测——大不了下轮再探一次
  }
  return true;
}
