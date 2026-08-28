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
// #924 之后这里多了一档，而且是**唯一不靠反推的一档**：`join-binding`。加入频道的那一刻
// （`party init`）我们确切知道身份，那时就把 (harness, server, channel, owner) → identity
// 落了盘（见 join-binding.ts）。下面其余各档降级为兜底——它们只在没有绑定（老机器、手搓接入）
// 时才轮得到。真机上四档同时全灭的那台机器（#924 现场），靠的就是这一档。
//
// 解析优先级（越靠前越硬）：
//   1. `env`              —— 会话进程自己带着 `AGENTPARTY_CONFIG`（hook 是 codex 的子进程，
//                            天然继承）。这是唯一「会话自己说了算」的信号，最硬。
//   2. `join-binding`     —— 加入时落盘的绑定（#924）。同 harness 同频道有多条时，用「该 codex
//                            进程下看得见哪些身份」做**佐证**收窄：绑定给答案，进程给旁证。
//                            佐证与绑定完全对不上 ⇒ 这些绑定不属于本 harness 实例（终端 codex
//                            与桌面 codex 各自加入过同一频道就是这样），不硬用，继续往下走。
//   3. `session-registry` —— 按 `session_id` 回查本机 codex 会话注册表条目里记下的
//                            identity + server（#906 在 claude 侧同款），再映射回本地 config。
//   4. `mcp-registration` —— 该 codex 进程下挂着的 agentparty MCP 子进程的 `AGENTPARTY_CONFIG`。
//                            接入包正是把身份写进 MCP 注册的 env（`codex mcp add --env …`），
//                            所以这条能把「照接入包装好、但没在 shell 里 export」的常见形态救回来。
//                            该进程下有两个以上不同身份 ⇒ 歧义 ⇒ 放弃（owner 的 ChatGPT.app
//                            app-server 就是这样多路复用的，真机实测）。
//   5. `cwd-unique`       —— 退到 cwd 绑定的 config，但**只在本机该频道不存在第二个身份时**
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
// 判据只有一份：`party mcp` 进程的识别词表与 MCP 注册治理共用（复制一份出去必漂移，#622 教训）。
import { looksLikePartyMcpCommand } from "./mcp-registry";
import {
  findJoinBindings,
  joinBindingsPath,
  readJoinBindings,
  type JoinBinding,
} from "./join-binding";

export { looksLikePartyMcpCommand };

export type CodexHookIdentitySource =
  | "env"
  | "join-binding"
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
  | "ambiguous-binding"
  | "harness-mismatch"
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
  /** #924：加入时落盘的 (harness, server, channel, owner) → identity 绑定。 */
  joinBindings: () => JoinBinding[];
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
    joinBindings: () => readJoinBindings(joinBindingsPath(agentpartyHome(env))),
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

  // 该 codex 进程下**看得见**哪些绑定本频道的身份。既是第 ④ 档的信号本体，也是第 ② 档
  // 绑定的佐证。最多算一次（一次 `ps`），后面各档共用。
  type UsableAt = { path: string; server: string; token: string; name: string | null };
  let mcpEvidence: Map<string, UsableAt> | null = null;
  const evidence = (): Map<string, UsableAt> => {
    if (mcpEvidence !== null) return mcpEvidence;
    const found = new Map<string, UsableAt>();
    for (const path of deps.mcpConfigPaths(deps.pid)) {
      const usable = usableConfig(deps.readConfigFile(path), channel);
      if (usable === null) continue;
      const key = identityKey(usable.server, usable.name);
      if (!found.has(key)) found.set(key, { path, ...usable });
    }
    mcpEvidence = found;
    return found;
  };

  // ② 加入即绑定（#924）——唯一不靠反推的一档。
  const bindings = findJoinBindings(deps.joinBindings(), { harness: "codex", channel });
  if (bindings.length > 0) {
    // 绑定指向的 config 已经不可用（被删、没 token、改绑了别的频道）＝这条绑定过期了，跳过它。
    // 绝不把一条过期绑定当成「解析成功」，也绝不因为它存在就放弃后面的兜底。
    let alive = bindings
      .map((binding) => ({ binding, usable: usableConfig(deps.readConfigFile(binding.config_path), channel) }))
      .filter((row): row is { binding: JoinBinding; usable: NonNullable<ReturnType<typeof usableConfig>> } =>
        row.usable !== null);
    const seen = evidence();
    if (alive.length > 0 && seen.size > 0) {
      // 佐证：这个 codex 进程下明明看得见本频道的身份，那么本会话的绑定必须在其中。
      // 一条都对不上 ⇒ 这些绑定属于**另一个 harness 实例**（终端 codex vs 桌面 codex 各自
      // 加入过同一频道）。此时不硬用绑定，落到后面就地取证的档去——那才是本实例的真相。
      alive = alive.filter((row) => seen.has(identityKey(row.usable.server, row.usable.name)));
    }
    if (alive.length > 1 && cwd !== "") {
      // 同 harness 同频道仍并存多条（不同实例 / 不同 owner，是刻意的并存）：用「在哪加入的」
      // 精确收窄一次。收窄不到唯一就放弃——绝不按「最近一次加入」瞎选。
      const byCwd = alive.filter((row) => row.binding.cwd === cwd);
      if (byCwd.length === 1) alive = byCwd;
    }
    if (alive.length === 1) {
      const only = alive[0]!;
      return {
        ok: true,
        identity: {
          source: "join-binding",
          configPath: only.binding.config_path,
          ...only.usable,
          configScopedState: true,
        },
      };
    }
    if (alive.length > 1) {
      return {
        ok: false,
        reason: "ambiguous-binding",
        detail:
          `本机在 #${channel} 上给 codex 记了 ${alive.length} 条加入绑定` +
          `（${alive.map((row) => `${row.usable.name ?? "?"}@${row.usable.server}`).join(", ")}）` +
          `——它们分属不同实例/不同 owner，分不清本会话是哪一个，放弃`,
      };
    }
  }

  // ②′ 反推各档的共同闸（#960）：**codex hook 绝不认领绑给别的 harness 的身份。**
  // 真机现场：owner 用 `party join --harness claude` 把 leo-server 绑给 claude，绑定文件如实记了
  // `harness: claude`；随后同一 cwd 里每个（别的 Claude 会话委托的）codex 都从 cwd 档反推出这个
  // 身份，替它拉起 codex 唤醒层——用户明确绑给 claude 的接收路径被 codex 抢走，`party who` 多出
  // 一个「同身份第二 runtime」。harness 只能由「装在谁的 hooks 里」决定（见 hook.ts），所以后面
  // 三档反推出来的身份若在绑定文件里明确属于另一个 harness、且没有同身份的 codex 绑定，就拒绝。
  // 同 cwd 同时绑了 claude 与 codex（各自的身份）时上面第 ② 档已经各走各的，这里不会误伤。
  const foreign = deps.joinBindings().filter((row) => row.harness !== "codex" && row.channel === channel);
  const codexBound = deps.joinBindings().filter((row) => row.harness === "codex" && row.channel === channel);
  const boundElsewhere = (
    identity: { server: string; name: string | null; configPath: string | null },
  ): JoinBinding | null => {
    if (foreign.length === 0) return null;
    const key = identityKey(identity.server, identity.name);
    const matches = (row: JoinBinding): boolean =>
      (identity.configPath !== null && row.config_path === identity.configPath) ||
      (identity.name !== null && identityKey(row.server, row.identity) === key);
    if (codexBound.some(matches)) return null;
    return foreign.find(matches) ?? null;
  };
  const harnessMismatch = (owner: JoinBinding, identity: { server: string; name: string | null }): CodexHookIdentityResolution => ({
    ok: false,
    reason: "harness-mismatch",
    detail:
      `#${channel} 上的身份 ${identity.name ?? "?"}@${identity.server} 是用 --harness ${owner.harness} 加入的` +
      `（join-bindings 如实记着），codex hook 不认领它——要让 codex 也接这个身份，用 codex 的接入包重新加入`,
  });

  // ③ session_id → 注册表条目（identity + server 都是 SessionStart 时按本表同一套规则记的）。
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
            const owner = boundElsewhere({ ...usable, configPath: matches[0]!.path });
            if (owner !== null) return harnessMismatch(owner, usable);
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

  // ④ 该 codex 进程下挂着的 agentparty MCP 注册——接入包写进 env 的那份身份。
  {
    const found = evidence();
    if (found.size === 1) {
      const only = [...found.values()][0]!;
      const owner = boundElsewhere({ server: only.server, name: only.name, configPath: only.path });
      if (owner !== null) return harnessMismatch(owner, only);
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
          `——分不清本会话是哪一个，放弃。重新跑一遍接入包即可（加入即绑定会记下本次身份）`,
      };
    }
  }

  // ⑤ cwd 绑定的 config——只有本机该频道不存在第二个身份时才算数。
  const cwdUsable = usableConfig(deps.readCwdConfig(cwd), channel);
  const distinct = distinctCandidateKeys(deps.candidates(channel));
  if (cwdUsable !== null) {
    const key = identityKey(cwdUsable.server, cwdUsable.name);
    const others = [...distinct.keys()].filter((candidate) => candidate !== key);
    if (others.length === 0) {
      const owner = boundElsewhere({ ...cwdUsable, configPath: null });
      if (owner !== null) return harnessMismatch(owner, cwdUsable);
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
        `重新跑一遍该身份的接入包即可（加入即绑定会把「这个 harness 的这个频道 = 这个身份」记下来）`,
    };
  }
  return {
    ok: false,
    reason: "no-identity",
    detail: `#${channel} 上解析不出本会话的身份（cwd=${cwd}），本次放弃`,
  };
}

/**
 * 把一次「解析不出唯一身份」翻译成**一条用户能直接粘贴执行的命令**（#924 第 4 条）。
 *
 * 静默失败的终结点在这里：日志里多写一行没人看，`party doctor` / `party who` 要能一眼
 * 看出「这台机器上这个身份叫不醒，因为 X，跑这条命令能修」。所有出口都必须给出命令，
 * 没有「无可奉告」这一档——真的没辙时也要指向重跑接入包，那是永远有效的那条路。
 */
export function codexHookIdentityFix(
  reason: CodexHookIdentityRefusal,
  ctx: { channel: string | null; server?: string | null },
): string {
  const channel = ctx.channel === null || ctx.channel === "" ? "<频道>" : ctx.channel;
  const server = ctx.server === undefined || ctx.server === null || ctx.server === ""
    ? null
    : ctx.server;
  const serverFlag = server === null ? "" : ` --server ${server}`;
  switch (reason) {
    case "no-channel":
      return `party init --channel ${channel}    # 先把这个目录绑到频道上`;
    case "env-config-unusable":
      return `unset AGENTPARTY_CONFIG            # 这个会话指着一份用不了的身份配置，去掉它或改指对的那份`;
    case "harness-mismatch":
      // 身份是绑给别的 harness 的：codex 不抢。想让 codex 也接它，就用 codex 的接入包再加入一次。
      return `party init --channel ${channel}${serverFlag} --harness codex    # 这个身份是用别的 harness 加入的，codex 不认领；要让 codex 接它，用 codex 的接入包重新加入`;
    case "ambiguous-binding":
    case "ambiguous":
    case "registry-identity-unresolvable":
    case "no-identity":
      // 重跑接入包 = 重新 `party init`，加入即绑定会把本次身份记下来，覆盖历史堆积。
      return `party mcp identities --channel ${channel}${serverFlag}    # 看清这台机器上这个频道有哪些身份，再重跑目标身份的接入包（加入即绑定会记下它）`;
  }
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
