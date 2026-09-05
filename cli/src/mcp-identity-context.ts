// 单进程多频道下的「本次调用用哪份身份」（#1083）。
//
// 一条注册要服务所有频道，身份就得按每次工具调用解析。最直觉的做法是临时改
// `process.env.AGENTPARTY_CONFIG` 再改回来——**那是错的**：MCP 的工具调用可以并发，两个
// 调用交错时后一个会读到前一个设的值，于是以别人的身份发言，而且不会有任何报错。
// 这正是这条路上最该防的事（同机串号在 #865 已经真实发生过一次）。
//
// 所以用 AsyncLocalStorage：每次调用有自己的一份，天然隔离，进程级状态一个字节都不改。
// 落点选在 `explicitConfigPath()` 这个瓶颈上——auth()、readConfig()、以及 captureCommand
// 在同进程内跑的那些命令模块，全都从那里取 config 路径，所以 22 个调用点一处都不用改。
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<string>();

/** 在 configPath 这个身份下跑 fn。嵌套时内层覆盖外层。 */
export function withMcpIdentity<T>(configPath: string, fn: () => T): T {
  return storage.run(configPath, fn);
}

/** 当前调用绑定的 config 路径；不在任何身份上下文里就是 null（走原来的 env 那条路）。 */
export function currentMcpIdentityPath(): string | null {
  return storage.getStore() ?? null;
}
