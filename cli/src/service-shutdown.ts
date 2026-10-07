// 托管服务关停是终局（worker/src/shutdown.ts：410 + `{"error":"agentparty_shut_down","message":…}`）。
//
// 常驻命令（serve 及其 supervisor、watch、daemon、mcp、claude-channel、codex 自动唤醒 supervisor）
// 原本对 4xx/断线都有各自的退避重试——对一个已经关掉的服务，那就是永远重试、永远刷日志。
// 与其在每条重试循环里各插一道判断，这里在**唯一的两个网络出口**统一识别：REST 错误
// （rest.ts extractError，所有 REST 调用都经过它）和 WebSocket 握手被拒后的探测（client.ts probeFatal）。
//
// 常驻入口在开头调 `exitOnServiceShutdown()` 声明「我是常驻的」；之后任何一处识别到关停，
// 就把服务端给的说明打一次到 stderr，以 EXIT_SERVICE_SHUT_DOWN（20）退出——不进任何退避循环。
// 没声明的（一次性命令）只是照常抛 RestError（code = "agentparty_shut_down"），由 handleRestError
// 打印并映射到同一个退出码。
//
// 桌面「值守」agent 是 launchd KeepAlive=true 的 job：不管退出码是什么 launchd 都会重新拉起。
// `party serve` 因此在退出前走 #744 既有的 selfBootoutTerminalDuty（EXIT_SERVICE_SHUT_DOWN 已列入其
// 终局清单）卸载自己那个 job——不新增任何 plist 改写。
import { EXIT_SERVICE_SHUT_DOWN } from "@agentparty/shared";
import { stripTerminalControls } from "./format";

export const SERVICE_SHUT_DOWN_CODE = "agentparty_shut_down";
export { EXIT_SERVICE_SHUT_DOWN };

export interface ServiceShutdownDeps {
  exit: (code: number) => never;
  log: (line: string) => void;
}

const defaultDeps: ServiceShutdownDeps = {
  exit: (code) => process.exit(code),
  log: (line) => console.error(line),
};

let exitMode = false;
let announced = false;
let deps: ServiceShutdownDeps = defaultDeps;
const beforeExitHooks: Array<() => void> = [];

/**
 * 退出前的收尾（best-effort，任何异常都吞掉，绝不挡退出）。目前只有 `party serve` 用：
 * 在 launchd 值守 job 下走 #744 既有的 selfBootoutTerminalDuty 自卸载，免得 KeepAlive 无限重拉。
 */
export function onServiceShutdownExit(hook: () => void): void {
  beforeExitHooks.push(hook);
}

/** 常驻入口调用：此后一旦识别到服务已关停，打印一次说明并以 EXIT_SERVICE_SHUT_DOWN 退出。 */
export function exitOnServiceShutdown(): void {
  exitMode = true;
}

/** 仅测试用：注入 exit/log，并重置进程级状态。 */
export function resetServiceShutdownForTest(next: Partial<ServiceShutdownDeps> = {}): void {
  exitMode = false;
  announced = false;
  beforeExitHooks.length = 0;
  deps = { ...defaultDeps, ...next };
}

/** 410 且 error === "agentparty_shut_down" 才算；返回给人看的说明（已剥控制字符、限长），否则 null。 */
export function serviceShutdownMessage(status: number, body: unknown): string | null {
  if (status !== 410 || body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.error !== SERVICE_SHUT_DOWN_CODE) return null;
  const raw = typeof b.message === "string" && b.message !== "" ? b.message : "Agent Party has shut down.";
  return stripTerminalControls(raw).slice(0, 500);
}

/**
 * 网络出口识别到关停时调用。常驻模式：打印一次并退出（不返回）；否则什么都不做，交给调用方照常抛错。
 */
export function noteServiceShutdown(message: string): void {
  if (!exitMode) return;
  if (!announced) {
    announced = true;
    deps.log(`party: ${message}`);
    for (const hook of beforeExitHooks.splice(0)) {
      try {
        hook();
      } catch {
        // 收尾失败不挡退出
      }
    }
  }
  deps.exit(EXIT_SERVICE_SHUT_DOWN);
}
