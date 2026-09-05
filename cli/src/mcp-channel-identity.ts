// 单进程多频道下的身份解析（#1083）。
//
// 旧模型是「一个频道一条 MCP 注册」：每条注册在 argv 里绑一个 --channel、在 env 里绑一份
// AGENTPARTY_CONFIG。于是进程数 = 频道数 × 会话数，而且注册**只进不出**——`party join` 每加入
// 一个频道就往全局 config 塞一条，没有任何东西会把它删掉。实测这台机器上 5 条注册里只有 1 个
// 频道还在用，最老的一个 36 天没动过，却仍在每个 codex 会话里各起一个进程、挂 25 小时。
//
// 新模型是「一条注册，不绑频道」：频道由每次工具调用传进来，身份按频道解析。这个文件就是那个
// 解析器，也是整条路上唯一有**串号**风险的地方——解错了不会报错，只会以别人的身份发言。
//
// 因此解析顺序是「显式 > 记录 > 失败」，**绝不按时间/字典序猜**：
//   1. 调用方显式给了身份名 ⇒ 只认它，找不到就报错（绝不退回默认）
//   2. 该频道有登记的默认身份（party join 绑定时写下）⇒ 用它
//   3. 该频道在本机只有唯一一份身份 ⇒ 用它
//   4. 其余（多份且没登记默认）⇒ **失败关闭**，把候选列出来让人选
//
// 第 4 条不是保守，是必需：本机 24 个频道里 16 个有多份身份（agentparty 一个频道 15 份），
// 「挑最近验证的那个」这种启发式在这里等价于随机挑一个身份替用户说话。
import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { agentpartyHome } from "./config";

export interface AgentIdentityConfig {
  /** config 文件绝对路径——解析结果最终就是它，交给下游当 AGENTPARTY_CONFIG 用。 */
  path: string;
  server: string;
  /** 频道由 identity.channel_scope 给出：身份自带频道归属，不靠文件名猜。 */
  channel: string;
  name: string;
  verifiedAt: number | null;
}

/** 每频道默认身份的登记表：`<server> <channel>` → config 路径。 */
export type ChannelDefaults = Record<string, string>;

export function agentsDir(home: string = agentpartyHome()): string {
  return join(home, "agents");
}

export function channelDefaultsPath(home: string = agentpartyHome()): string {
  return join(home, "mcp-channel-defaults.json");
}

function defaultsKey(server: string, channel: string): string {
  // JSON 数组当键：不依赖分隔符，server 里出现任何字符都不会撞键，落盘后也仍然可读。
  return JSON.stringify([server, channel]);
}

/**
 * 列出本机所有 agent 身份配置。读坏了的文件一律跳过——一份坏 config 不该让整台机器的 MCP
 * 起不来；它的频道会退化成「没有这份身份」，走失败关闭那条路，比静默用错身份安全。
 */
export function listAgentConfigs(home: string = agentpartyHome()): AgentIdentityConfig[] {
  let files: string[];
  try {
    files = readdirSync(agentsDir(home)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AgentIdentityConfig[] = [];
  for (const file of files) {
    const path = join(agentsDir(home), file);
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        server?: unknown;
        token?: unknown;
        identity?: { name?: unknown; channel_scope?: unknown; verified_at?: unknown };
      };
      const server = typeof raw.server === "string" ? raw.server : null;
      const channel = typeof raw.identity?.channel_scope === "string" ? raw.identity.channel_scope : null;
      const name = typeof raw.identity?.name === "string" ? raw.identity.name : null;
      // 没有 token 的 config 解析出来也不能用于发言，直接当不存在。
      if (server === null || channel === null || name === null || typeof raw.token !== "string") continue;
      out.push({
        path,
        server,
        channel,
        name,
        verifiedAt: typeof raw.identity?.verified_at === "number" ? raw.identity.verified_at : null,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function readChannelDefaults(home: string = agentpartyHome()): ChannelDefaults {
  try {
    const raw = JSON.parse(readFileSync(channelDefaultsPath(home), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: ChannelDefaults = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 记下某频道的默认身份（party join 绑定成功后调用）。原子替换：写中途崩溃不会留半截 JSON，
 * 那会让整台机器的默认表失效、把一堆频道推进失败关闭。
 */
export function recordChannelDefault(
  server: string,
  channel: string,
  configPath: string,
  home: string = agentpartyHome(),
): void {
  const current = readChannelDefaults(home);
  current[defaultsKey(server, channel)] = configPath;
  const target = channelDefaultsPath(home);
  const tmp = `${target}.tmp-${process.pid}`;
  mkdirSync(home, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

export type ChannelIdentityResolution =
  | { ok: true; config: AgentIdentityConfig; via: "explicit" | "default" | "only" }
  | { ok: false; reason: "none" | "ambiguous"; candidates: AgentIdentityConfig[]; message: string };

export interface ResolveChannelIdentityInput {
  channel: string;
  /** 调用方显式指定的身份名。给了就只认它。 */
  identity?: string | undefined;
  /** 限定服务器（一台机器可能同时连 prod 与自建实例，同名频道在两边是两回事）。 */
  server?: string | undefined;
  configs?: AgentIdentityConfig[];
  defaults?: ChannelDefaults;
}

/** 见文件头的解析顺序：显式 > 登记的默认 > 唯一 > 失败关闭。 */
export function resolveChannelIdentity(input: ResolveChannelIdentityInput): ChannelIdentityResolution {
  const configs = input.configs ?? listAgentConfigs();
  const defaults = input.defaults ?? readChannelDefaults();
  const matches = configs.filter(
    (c) => c.channel === input.channel && (input.server === undefined || c.server === input.server),
  );

  if (input.identity !== undefined) {
    const hit = dedupeSameIdentity(matches.filter((c) => c.name === input.identity));
    if (hit.length === 1) return { ok: true, config: hit[0]!, via: "explicit" };
    // 显式指定却找不到 / 撞名，绝不退回默认身份——那正是「以为用 A 发言、实际用了 B」。
    return {
      ok: false,
      reason: hit.length === 0 ? "none" : "ambiguous",
      candidates: matches,
      message:
        hit.length === 0
          ? `#${input.channel} 上没有名为 ${input.identity} 的身份${describeCandidates(matches)}`
          : `#${input.channel} 上有多份名为 ${input.identity} 的身份，分属不同实例，请用 server 限定` +
            `（候选实例：${[...new Set(hit.map((c) => c.server))].join("、")}）`,
    };
  }

  if (matches.length === 0) {
    return {
      ok: false,
      reason: "none",
      candidates: [],
      message:
        `本机没有 #${input.channel} 的身份。先加入这个频道：` +
        `AGENTPARTY_TOKEN='<token>' party join --server <URL> --channel ${input.channel} --as <name>`,
    };
  }

  for (const key of matches.map((c) => defaultsKey(c.server, c.channel))) {
    const recorded = defaults[key];
    if (recorded === undefined) continue;
    const hit = matches.find((c) => c.path === recorded);
    if (hit !== undefined) return { ok: true, config: hit, via: "default" };
  }

  const distinct = dedupeSameIdentity(matches);
  if (distinct.length === 1) return { ok: true, config: distinct[0]!, via: "only" };

  return {
    ok: false,
    reason: "ambiguous",
    candidates: distinct,
    // 说清楚「为什么不替你选」+ 两条出路。这里绝不挑一个了事：挑错不会报错，只会以别人的身份发言。
    message:
      `#${input.channel} 在本机有 ${matches.length} 份身份，没有登记默认，不替你猜——` +
      `传 identity 指定，或用 \`party join\` 重新绑定把它记为默认。${describeCandidates(matches)}`,
  };
}

/**
 * 同一个 (server, channel, name) 有多份 config 文件时，那是**同一个身份的重复配置**，不是
 * 身份歧义——挑哪份都不会以别人的名义说话，最坏只是拿到一个旧 token。此时取最近验证过的那份。
 *
 * 这个区分是必需的：owner 那台机器上 #agentparty 的 leo-claude 就有两份 config（同 server、
 * 同名），此前会被判成歧义并提示「请用 --server 限定」——而两份的 server 一模一样，
 * 那条出路根本走不通。给一条走不通的修法，比不给更糟。
 */
function dedupeSameIdentity(configs: AgentIdentityConfig[]): AgentIdentityConfig[] {
  const best = new Map<string, AgentIdentityConfig>();
  for (const c of configs) {
    const key = JSON.stringify([c.server, c.channel, c.name]);
    const prev = best.get(key);
    if (prev === undefined || (c.verifiedAt ?? -1) > (prev.verifiedAt ?? -1)) best.set(key, c);
  }
  return [...best.values()];
}

function describeCandidates(candidates: AgentIdentityConfig[]): string {
  if (candidates.length === 0) return "";
  return `（候选：${candidates.map((c) => c.name).join("、")}）`;
}
