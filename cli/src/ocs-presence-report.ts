// #1113：serve / mcp 周期性把本机 ocs 会话摘要经已认证的 WS 上报给频道，网页 Presence 据此显示
// 「本机可介入」分组。浏览器跑不了 `ocs who`，只能由本机 CLI 代报。
//
// 纪律：
// - 异步子进程，绝不阻塞 serve/mcp 事件循环（`ocs who` 高负载下要 4–5s）。
// - 没装 ocs / 读失败：不报（服务端按 TTL 自然过期），也绝不影响宿主进程。
// - 同一时刻最多一个 `ocs who` 在跑；连接重连后立即补报一次。
// - AGENTPARTY_OCS_REPORT=0 关闭（隐私开关：不想让频道看到本机会话清单）。
import { execFile } from "node:child_process";
import { OCS_ROSTER_REPORT_INTERVAL_MS, type OcsRosterClientFrame, type OcsSessionReport } from "@agentparty/shared";
import { buildOcsReports, parseOcsEntries } from "./ocs-roster";

const OCS_TIMEOUT_MS = 15_000;

export type OcsAsyncExec = () => Promise<{ ok: boolean; stdout: string }>;

function defaultAsyncExec(): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    try {
      execFile(
        process.env.AGENTPARTY_OCS_BIN ?? "ocs",
        ["who", "--json"],
        { encoding: "utf8", timeout: OCS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve({ ok: err === null, stdout: typeof stdout === "string" ? stdout : "" }),
      );
    } catch {
      resolve({ ok: false, stdout: "" });
    }
  });
}

/** 读一次本机会话摘要；任何失败返回 null（= 本拍不报）。 */
export async function readOcsReports(opts: { cwd: string; exec?: OcsAsyncExec }): Promise<OcsSessionReport[] | null> {
  let res;
  try {
    res = await (opts.exec ?? defaultAsyncExec)();
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const entries = parseOcsEntries(res.stdout);
  return entries === null ? null : buildOcsReports(entries, opts.cwd);
}

export function ocsReportDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.AGENTPARTY_OCS_REPORT?.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

export interface OcsRosterReporterOptions {
  /** 发帧；返回 false 表示连接未就绪（本拍作废，等下次重连/定时）。 */
  send: (frame: OcsRosterClientFrame) => boolean;
  cwd: string;
  exec?: OcsAsyncExec;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export class OcsRosterReporter {
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: OcsRosterReporterOptions) {}

  /** 开始周期上报（幂等）。首报由调用方在连接就绪（welcome）时调 reportNow() 触发。 */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    const set = this.opts.setInterval ?? ((fn: () => void, ms: number) => {
      const h = setInterval(fn, ms);
      (h as { unref?: () => void }).unref?.();
      return h;
    });
    this.timer = set(() => void this.reportNow(), this.opts.intervalMs ?? OCS_ROSTER_REPORT_INTERVAL_MS);
  }

  /** 立即读一次并上报；已有一次在跑就复用它。永不抛。 */
  reportNow(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const sessions = await readOcsReports({ cwd: this.opts.cwd, ...(this.opts.exec === undefined ? {} : { exec: this.opts.exec }) });
        if (sessions === null || this.stopped) return;
        try {
          this.opts.send({ type: "ocs_roster", sessions });
        } catch {
          /* 连接未就绪：下次重连/定时再报 */
        }
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      (this.opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>)))(this.timer);
      this.timer = null;
    }
  }
}
