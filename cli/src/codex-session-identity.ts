// codex hook 的会话身份解析（issue #917）。
//
// 为什么要有这一层：codex 的 hook payload 只带 `cwd` / `session_id`，此前 SessionStart 入册
// 与 Stop 前台唤醒都用 `readConfig(cwd)` 当身份——那是**按目录猜**。真机上同一个 worktree
// 会绑着十几个身份（#907），而且分属两台生产实例（#865），于是：
//   - 唤醒查询用了另一个身份的 token、另一台服务器 ⇒ 恒查不到，静默失效（#917 现场）；
//   - 更坏的一侧：万一那个身份恰好有待处理的 @，就会把别人的 @ 注入进本会话——
//     频道、seq、正文全是真的，收信方毫无破绽（#906/#865 反复证明过的静默误投）。
//
// 因此这里的铁律是：**宁可不叫，也绝不猜。** 解析不出唯一身份就返回 refusal，
// 调用方放行并把原因写进日志。判定始终带上 server 维度（#865）。
//
// 解析优先级（越靠前越硬）：
//   1. `env`              —— 会话进程自己带着 `AGENTPARTY_CONFIG`（hook 是 codex 的子进程，
//                            天然继承）。这是唯一「会话自己说了算」的信号，最硬。
//   2. `session-registry` —— 按 `session_id` 回查本机 codex 会话注册表条目里记下的
//                            identity + server（#906 在 claude 侧同款），再映射回本地 config。
//   3. `mcp-registration` —— 该 codex 进程下挂着的 agentparty MCP 子进程的 `AGENTPARTY_CONFIG`。
//                            接入包正是把身份写进 MCP 注册的 env（`codex mcp add --env …`），
//                            所以这条能把「照接入包装好、但没在 shell 里 export」的常见形态救回来。
//                            该进程下有两个以上不同身份 ⇒ 歧义 ⇒ 放弃（owner 的 ChatGPT.app
//                            app-server 就是这样多路复用的，真机实测）。
//   4. `cwd-unique`       —— 退到 cwd 绑定的 config，但**只在本机该频道不存在第二个身份时**
//                            才算数。单身份机器（绝大多数）行为逐字不变；多身份机器一律放弃。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  agentpartyHome,
  explicitConfigPath,
  localAgentConfigsForChannel,
  readConfig,
  type Config,
  type LocalAgentConfigHint,
} from "./config";
import {
  listCodexSessions,
  normalizeSessionRegistryIdentity,
  normalizeSessionRegistryServer,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";
import { healServerUrl } from "./validation";

export type CodexHookIdentitySource =
  | "env"
  | "session-registry"
  | "mcp-registration"
  | "cwd-unique";

export interface CodexHookIdentity {
  source: CodexHookIdentitySource;
  /** 解析到的 config 文件路径；cwd 档可能为 null（历史行为不依赖路径）。 */
  configPath: string | null;
  /** 已 heal 过的实例 URL。判定必须带上它（#865）。 */
  server: string;
  token: string;
  /** 频道身份（`config.identity.name`）；人类账号 config 没有则 null。 */
  name: string | null;
  /**
   * cursor / 欠账是否该按 config 作用域读（`loadCursorForConfig`）。
   * env 档由 `process.env.AGENTPARTY_CONFIG` 天然作用域化，cwd 档保持历史的 cwd 作用域，
   * 其余两档解析出的是**本进程 env 之外**的身份，只有 config 作用域才是它真正的游标。
   */
  configScopedState: boolean;
}

export type CodexHookIdentityRefusal =
  | "no-channel"
  | "env-config-unusable"
  | "registry-identity-unresolvable"
  | "ambiguous"
  | "no-identity";

export type CodexHookIdentityResolution =
  | { ok: true; identity: CodexHookIdentity }
  | { ok: false; reason: CodexHookIdentityRefusal; detail: string };

export interface CodexHookIdentityDeps {
  /** 本进程显式指定的 config 路径（＝会话自己带的 `AGENTPARTY_CONFIG`）。 */
  explicitConfigPath: () => string | null;
  readConfigFile: (path: string) => Config | null;
  readCwdConfig: (cwd: string) => Config | null;
  /** 本机绑定该频道的所有 agent config（诊断索引，不含 token 之外的判断）。 */
  candidates: (channel: string) => LocalAgentConfigHint[];
  codexSessions: () => ClaudeSessionRegistryEntry[];
  /** 给定 codex 进程下可见的 agentparty MCP 注册所用的 config 路径（已去重）。 */
  mcpConfigPaths: (pid: number) => string[];
  /** codex 本体的 pid——hook 是它的子进程，故取 `process.ppid`。 */
  pid: number;
}

export interface CodexHookIdentityInput {
  cwd: string;
  channel: string | null;
  sessionId: string | null;
  deps: CodexHookIdentityDeps;
}

function readConfigFileSync(path: string): Config | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config;
  } catch {
    return null;
  }
}

export function defaultCodexHookIdentityDeps(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.ppid,
): CodexHookIdentityDeps {
  return {
    explicitConfigPath,
    readConfigFile: readConfigFileSync,
    readCwdConfig: (cwd) => readConfig(cwd),
    candidates: (channel) => localAgentConfigsForChannel(channel, null, agentpartyHome(env)),
    codexSessions: () => listCodexSessions(env),
    mcpConfigPaths: (target) => codexMcpConfigPaths(target),
    pid,
  };
}

/** 判定用的身份键：server + 频道身份。少一半都不算同一个身份（#865 + #906）。 */
function identityKey(server: string, name: string | null): string {
  return `${normalizeSessionRegistryServer(server) ?? server} ${normalizeSessionRegistryIdentity(name) ?? ""}`;
}

/**
 * 一份 config 能不能用作「本会话在该频道上的身份」。
 * token 必须在（人类账号没有 agent token 时唤醒本就无从谈起），server 必须能 heal，
 * 缓存身份若绑了另一个频道 ⇒ 不认（那是别的频道的 handle）。
 */
function usableConfig(config: Config | null, channel: string): { server: string; token: string; name: string | null } | null {
  if (config === null) return null;
  const { server, token, identity } = config;
  if (typeof server !== "string" || typeof token !== "string" || token === "") return null;
  const healed = healServerUrl(server);
  if (healed === null) return null;
  const scope = identity?.channel_scope;
  if (typeof scope === "string" && scope !== channel) return null;
  const name = typeof identity?.name === "string" && identity.name !== "" ? identity.name : null;
  return { server: healed, token, name };
}

function distinctCandidateKeys(candidates: LocalAgentConfigHint[]): Map<string, LocalAgentConfigHint> {
  const map = new Map<string, LocalAgentConfigHint>();
  for (const hint of candidates) {
    const healed = healServerUrl(hint.server);
    if (healed === null) continue;
    const key = identityKey(healed, hint.name);
    if (!map.has(key)) map.set(key, hint);
  }
  return map;
}

/**
 * 解析「本 codex 会话到底是哪个身份」。任何一步只要不唯一就返回 refusal——**绝不降级去猜**。
 */
export function resolveCodexHookIdentity(input: CodexHookIdentityInput): CodexHookIdentityResolution {
  const { cwd, channel, sessionId, deps } = input;
  if (channel === null || channel === "") {
    return { ok: false, reason: "no-channel", detail: "本 cwd 没绑频道，无从判定身份" };
  }

  // ① 会话自己带的 AGENTPARTY_CONFIG——唯一「会话说了算」的信号。
  const explicit = deps.explicitConfigPath();
  if (explicit !== null && explicit !== "") {
    const usable = usableConfig(deps.readConfigFile(explicit), channel);
    if (usable !== null) {
      return {
        ok: true,
        identity: { source: "env", configPath: explicit, ...usable, configScopedState: false },
      };
    }
    // 显式选择了身份却读不出/绑着别的频道：失败关闭。绝不悄悄换一个身份顶上。
    return {
      ok: false,
      reason: "env-config-unusable",
      detail: `AGENTPARTY_CONFIG=${explicit} 读不出可用于 #${channel} 的身份，本次放弃`,
    };
  }

  // ② session_id → 注册表条目（identity + server 都是 SessionStart 时按本表同一套规则记的）。
  if (sessionId !== null && sessionId !== "") {
    const wanted = sessionId.toLowerCase();
    const entry = deps.codexSessions().find((row) => row.session_id.toLowerCase() === wanted) ?? null;
    if (entry !== null && entry.channel === channel) {
      const name = normalizeSessionRegistryIdentity(entry.identity);
      const server = normalizeSessionRegistryServer(entry.server);
      if (name !== null && server !== null) {
        const key = identityKey(server, name);
        const matches = deps.candidates(channel).filter((hint) => {
          const healed = healServerUrl(hint.server);
          return healed !== null && identityKey(healed, hint.name) === key;
        });
        if (matches.length === 1) {
          const usable = usableConfig(deps.readConfigFile(matches[0]!.path), channel);
          if (usable !== null) {
            return {
              ok: true,
              identity: {
                source: "session-registry",
                configPath: matches[0]!.path,
                ...usable,
                configScopedState: true,
              },
            };
          }
        }
        // 条目记着身份，却映射不回唯一一份本地 config：只能放弃。回落到 cwd 猜＝正是本 issue。
        return {
          ok: false,
          reason: "registry-identity-unresolvable",
          detail:
            `注册表条目记的身份 ${name}@${server} 在本机找不到唯一对应的 config` +
            `（命中 ${matches.length} 份），本次放弃`,
        };
      }
    }
  }

  // ③ 该 codex 进程下挂着的 agentparty MCP 注册——接入包写进 env 的那份身份。
  const mcpPaths = deps.mcpConfigPaths(deps.pid);
  if (mcpPaths.length > 0) {
    const found = new Map<string, { path: string; server: string; token: string; name: string | null }>();
    for (const path of mcpPaths) {
      const usable = usableConfig(deps.readConfigFile(path), channel);
      if (usable === null) continue;
      const key = identityKey(usable.server, usable.name);
      if (!found.has(key)) found.set(key, { path, ...usable });
    }
    if (found.size === 1) {
      const only = [...found.values()][0]!;
      return {
        ok: true,
        identity: {
          source: "mcp-registration",
          configPath: only.path,
          server: only.server,
          token: only.token,
          name: only.name,
          configScopedState: true,
        },
      };
    }
    if (found.size > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        detail:
          `codex 进程 ${deps.pid} 下同时挂着 ${found.size} 个绑 #${channel} 的身份` +
          `（${[...found.values()].map((row) => `${row.name ?? "?"}@${row.server}`).join(", ")}）` +
          `——分不清本会话是哪一个，放弃。给这个会话显式设 AGENTPARTY_CONFIG 即可解决`,
      };
    }
  }

  // ④ cwd 绑定的 config——只有本机该频道不存在第二个身份时才算数。
  const cwdUsable = usableConfig(deps.readCwdConfig(cwd), channel);
  const distinct = distinctCandidateKeys(deps.candidates(channel));
  if (cwdUsable !== null) {
    const key = identityKey(cwdUsable.server, cwdUsable.name);
    const others = [...distinct.keys()].filter((candidate) => candidate !== key);
    if (others.length === 0) {
      return {
        ok: true,
        identity: { source: "cwd-unique", configPath: null, ...cwdUsable, configScopedState: false },
      };
    }
    return {
      ok: false,
      reason: "ambiguous",
      detail:
        `本机绑 #${channel} 的身份有 ${distinct.has(key) ? distinct.size : distinct.size + 1} 个，` +
        `cwd(${cwd}) 只能猜出其中一个（${cwdUsable.name ?? "?"}@${cwdUsable.server}）——按 cwd 猜必然误投，放弃。` +
        `给这个会话显式设 AGENTPARTY_CONFIG，或让接入包把身份写进该会话的 MCP 注册 env`,
    };
  }
  return {
    ok: false,
    reason: "no-identity",
    detail: `#${channel} 上解析不出本会话的身份（cwd=${cwd}），本次放弃`,
  };
}

/** 一次 `ps` 调用的上限，绝不吃满 hook 预算。 */
const PS_TIMEOUT_MS = 1_500;
const PS_MAX_CHILDREN = 16;

type SpawnLike = typeof spawnSync;

function psLines(args: string[], spawn: SpawnLike): string[] {
  try {
    const result = spawn("ps", args, {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    return result.stdout.split("\n").filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

/** 一行 `party mcp …` 才算数：既要是我们的二进制，也要真的是 mcp 子命令。 */
export function looksLikePartyMcpCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const first = tokens[0];
  if (first === undefined) return false;
  const binary = first.split("/").pop() ?? first;
  // dev 形态是 `bun /path/cli/src/index.ts mcp`：只要参数里出现 party 入口即可。
  const entryAt = tokens.findIndex((token) => /(?:^|\/)party(?:\.js|\.ts)?$/.test(token));
  const ours = binary === "party" || entryAt >= 0;
  if (!ours) return false;
  // `mcp` 必须是**入口之后的第一个非 flag 参数**，不能是命令行里任意位置出现的同名 token——
  // 否则 `party send "x" --channel mcp`、`party serve x --on-mention mcp` 会被误判成 MCP 注册
  // 进程，进而从一个毫不相干的进程里读出 AGENTPARTY_CONFIG，把 @ 判给错的身份。
  // 这正是 #917 要根除的那类「猜身份」，判据本身更不能松。
  const afterEntry = tokens.slice(Math.max(entryAt, 0) + 1);
  const sub = afterEntry.find((token) => !token.startsWith("-"));
  return sub === "mcp";
}

/**
 * 读出给定 codex 进程下所有 agentparty MCP 子进程注册时用的 `AGENTPARTY_CONFIG`（去重）。
 *
 * macOS/Linux 的 `ps eww` 会连环境变量一起打印，且只对本 uid 的进程可读——正好够用。
 * 任何失败一律返回空数组（＝这条线索不可用，调用方继续往下走或放弃）。
 */
export function codexMcpConfigPaths(pid: number, spawn: SpawnLike = spawnSync): string[] {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  if (process.platform === "win32") return [];
  const children: number[] = [];
  for (const line of psLines(["-axo", "pid=,ppid=,args="], spawn)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    if (Number(match[2]) !== pid) continue;
    if (!looksLikePartyMcpCommand(match[3]!)) continue;
    children.push(Number(match[1]));
    if (children.length >= PS_MAX_CHILDREN) break;
  }
  if (children.length === 0) return [];
  const paths: string[] = [];
  for (const line of psLines(["eww", "-o", "command=", "-p", children.join(",")], spawn)) {
    const found = /(?:^|\s)AGENTPARTY_CONFIG=(\S+)/.exec(line);
    if (found === null) continue;
    if (!paths.includes(found[1]!)) paths.push(found[1]!);
  }
  return paths;
}
