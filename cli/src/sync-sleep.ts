// 同步阻塞睡眠——仅用于同步锁竞争的极短重试(1-2ms),那些代码路径拿不到 async 上下文。
// 首选 Atomics.wait(SharedArrayBuffer),但某些运行时/沙箱里 SharedArrayBuffer 未定义
// (#738:常驻 serve 的日志被 "SharedArrayBuffer is not defined" 反复刷屏——根因是有处在模块
// 顶层就 new SharedArrayBuffer,SAB 缺席时一 import 就抛)。这里每次调用现探测 + 退化忙等,
// 既不在模块顶层分配、也保证无论环境有没有 SAB 都不再抛异常;ms 极小,忙等开销可忽略。

/** 同步睡眠 ms 毫秒。SharedArrayBuffer 可用则走 Atomics.wait,否则退化为忙等(不抛)。 */
export function sleepSyncMs(ms: number): void {
  if (ms <= 0) return;
  if (typeof SharedArrayBuffer === "function") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* SAB 不可用时的退化忙等；ms 很小(1-2ms) */
  }
}
