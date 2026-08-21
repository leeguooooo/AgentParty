// MCP 注册治理（#898 方案 C）——只做「不重复注册 / 清理确证失效的注册 / 进程可辨认」，
// 不合并身份、不共享 daemon：一个 server 能操作本机所有身份＝权限放大，这条线上已经因为
// 身份与命名空间混淆出过 #865（跨实例误投）、#862（命名空间错配）两类事故。
//
// 本模块只提供纯函数（读一份 JSON → 分类），副作用（删注册）留在命令层，方便单测覆盖
// 「绝不碰非 party 注册」这条硬约束。
import { basename } from "node:path";

/** Claude Code 里的一条 MCP 注册。scope 为 "user" 或项目绝对路径（local scope）。 */
export interface McpRegistration {
  scope: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * 从 ~/.claude.json 解析出全部 MCP 注册（user scope + 每个 project 的 local scope）。
 * 任何形状不对的条目都直接跳过——解析阶段宁可少认，也不要把猜出来的东西送进删除路径。
 */
export function parseClaudeMcpRegistrations(raw: unknown): McpRegistration[] {
  const out: McpRegistration[] = [];
  if (raw === null || typeof raw !== "object") return out;
  const root = raw as Record<string, unknown>;
  collectScope(out, "user", root.mcpServers);
  const projects = root.projects;
  if (projects !== null && typeof projects === "object") {
    for (const [path, entry] of Object.entries(projects as Record<string, unknown>)) {
      if (entry === null || typeof entry !== "object") continue;
      collectScope(out, path, (entry as Record<string, unknown>).mcpServers);
    }
  }
  return out;
}

function collectScope(out: McpRegistration[], scope: string, servers: unknown): void {
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, spec] of Object.entries(servers as Record<string, unknown>)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) continue;
    const s = spec as Record<string, unknown>;
    const command = typeof s.command === "string" ? s.command : "";
    const args = Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [];
    const env: Record<string, string> = {};
    if (s.env !== null && typeof s.env === "object" && !Array.isArray(s.env)) {
      for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
        if (typeof v === "string") env[k] = v;
      }
    }
    out.push({ scope, name, command, args, env });
  }
}

// 「这是不是我们自己的 party mcp 注册」必须由**命令本体**判定，不能由名字判定：
// 本机同时装着 discord-use / iphone-use-mcp 等别人的 server，误删是灾难，而名字是用户可改的。
// 反过来也不能放宽：`npx party`、`sh -c "... party mcp"` 这类间接形态一律不认（＝不碰）。
const PARTY_COMMAND_BASENAMES = new Set(["party", "agentparty-runtime"]);

/** 严格判定：命令 basename 必须正好是 party 可执行文件，且第一个参数正好是 `mcp`。 */
export function isPartyMcpRegistration(reg: McpRegistration): boolean {
  if (reg.command === "") return false;
  // Windows 上可能带 .exe/.cmd 后缀；其余一律按原样比较。
  const base = basename(reg.command).replace(/\.(exe|cmd|bat)$/i, "");
  if (!PARTY_COMMAND_BASENAMES.has(base)) return false;
  return reg.args[0] === "mcp";
}

/** 注册里声明的默认频道（`party mcp --channel X`），没有就是 null。 */
export function registrationChannel(reg: McpRegistration): string | null {
  const i = reg.args.indexOf("--channel");
  if (i === -1) return null;
  const v = reg.args[i + 1];
  return v === undefined || v.startsWith("-") ? null : v;
}

/** 身份配置探针。命令层负责读盘，这里只做判定。 */
export type ConfigProbe =
  | { kind: "no-config-env" }
  | { kind: "missing"; path: string }
  | { kind: "unparseable"; path: string }
  | { kind: "no-token"; path: string }
  | { kind: "ok"; path: string; channelScope: string | null; server: string | null };

/** 远端探针（仅 --check-remote 时填）。unreachable 永远不构成「确证失效」。 */
export type RemoteProbe = "ok" | "revoked" | "unreachable";

export interface ClassifyInput {
  reg: McpRegistration;
  config: ConfigProbe;
  /** scope 为项目路径时，该目录是否还在。user scope 恒 true。 */
  scopeExists: boolean;
  remote?: RemoteProbe;
}

export interface Verdict {
  /** stale＝确证失效可删；review＝判不准，只列出交给用户；keep＝看起来还活着。 */
  action: "stale" | "review" | "keep";
  reason: string;
}

/**
 * 只把「确证失效」判成 stale。判不准一律 review（列出、不删），这是本命令的硬策略：
 * 误删一条还在用的注册＝弄坏一个正在跑的会话，比留着一条浪费 14MB 的注册严重得多。
 */
export function classifyPartyRegistration(input: ClassifyInput): Verdict {
  const { reg, config, scopeExists, remote } = input;
  // 防御性双保险：非 party 注册永远不进入判定，任何调用点写错都只会拿到 keep。
  if (!isPartyMcpRegistration(reg)) {
    return { action: "keep", reason: "not an AgentParty mcp registration — never touched" };
  }
  if (!scopeExists) {
    // 项目目录没了：这条注册已经不会被任何会话加载（也就不占进程），但我们无法在原 scope
    // 里安全地跑 `claude mcp remove`。列出来让用户自己决定，绝不代删。
    return { action: "review", reason: `project directory is gone: ${reg.scope}` };
  }
  switch (config.kind) {
    case "no-config-env":
      // 没有 AGENTPARTY_CONFIG＝身份走默认解析链（workspace/breadcrumb/global），
      // 本模块无从判定它指向谁，一律保留。
      return { action: "review", reason: "no AGENTPARTY_CONFIG pinned — identity can't be resolved offline" };
    case "missing":
      return { action: "stale", reason: `identity config no longer exists: ${config.path}` };
    case "unparseable":
      // 有可能是写到一半的文件，不是确证失效。
      return { action: "review", reason: `identity config is unreadable: ${config.path}` };
    case "no-token":
      return { action: "stale", reason: `identity config has no token: ${config.path}` };
    case "ok": {
      if (remote === "revoked") {
        return { action: "stale", reason: `server rejected this identity's token (${config.path})` };
      }
      const channel = registrationChannel(reg);
      if (channel !== null && config.channelScope !== null && config.channelScope !== channel) {
        return {
          action: "review",
          reason: `--channel ${channel} but the identity is scoped to ${config.channelScope}`,
        };
      }
      if (remote === "unreachable") {
        return { action: "keep", reason: "server unreachable — assumed alive" };
      }
      return { action: "keep", reason: "identity config looks alive" };
    }
  }
}

/** 从一份已解析的身份配置里抽出探针需要的字段。传 null 表示文件不存在。 */
export function probeFromConfigJson(path: string, parsed: unknown): ConfigProbe {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unparseable", path };
  }
  const j = parsed as Record<string, unknown>;
  const token = typeof j.token === "string" ? j.token.trim() : "";
  if (token === "") return { kind: "no-token", path };
  const identity = j.identity !== null && typeof j.identity === "object" ? (j.identity as Record<string, unknown>) : {};
  const channelScope = typeof identity.channel_scope === "string" && identity.channel_scope !== ""
    ? identity.channel_scope
    : null;
  return {
    kind: "ok",
    path,
    channelScope,
    server: typeof j.server === "string" ? j.server : null,
  };
}

// ── 进程可辨认（#898 第 3 件）────────────────────────────────────────────────
// owner 在活动监视器里看到 100+ 行一模一样的 `party`，无法排查是谁的。给 process title
// 带上频道与身份，`ps` 一眼能对上。绝不放 token 或完整路径（同机任意用户 `ps -axww` 可见）。

/** 身份标签的合法形状；只用于展示，不参与任何鉴权。 */
export const IDENTITY_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface McpServerArgv {
  channel: string | null;
  /** `--identity <label>`：纯展示用，唯一目的是让 `ps -axww` 看出这个进程是谁的。 */
  identity: string | null;
  error: string | null;
}

const MCP_USAGE = "usage: party mcp [--channel C] [--identity LABEL] | party mcp prune [--yes]";

/**
 * `party mcp` 的参数解析。`--identity` 是 #898 第 3 件的载体：process.title 在 Bun/macOS
 * 上不会写回 OS 的 argv 区（实测），所以「这个进程是谁的」只能靠 argv 本身携带。
 * 它绝不影响身份解析——身份永远来自 AGENTPARTY_CONFIG，标签写错也只是标签写错。
 */
export function parseMcpServerArgv(argv: string[]): McpServerArgv {
  const out: McpServerArgv = { channel: null, identity: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--channel" || a === "--identity") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) return { ...out, error: `${a} needs a value\n${MCP_USAGE}` };
      i += 1;
      if (a === "--channel") {
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v)) {
          return { ...out, error: "channel must match [a-z0-9][a-z0-9-]{0,63}" };
        }
        out.channel = v;
      } else {
        if (!IDENTITY_LABEL_RE.test(v)) {
          return { ...out, error: "identity label must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}" };
        }
        out.identity = v;
      }
      continue;
    }
    return { ...out, error: MCP_USAGE };
  }
  return out;
}

/** 从 AGENTPARTY_CONFIG 路径推出一个短身份标签；拿不到就返回 null。 */
export function identityLabelFromConfigPath(configPath: string | null | undefined): string | null {
  if (configPath === undefined || configPath === null || configPath === "") return null;
  const base = basename(configPath).replace(/\.json$/i, "");
  const label = base.replace(/^agentparty-/, "");
  return label === "" ? null : label;
}

export interface McpProcessTitleInput {
  /** 默认频道（`party mcp --channel X`）；无则 null。 */
  channel?: string | null;
  /** AGENTPARTY_CONFIG 的值；无则 null。 */
  configPath?: string | null;
  /** 已知的身份名（读得到 config 时优先用它）。 */
  agentName?: string | null;
  /** 子形态：普通工具面 "mcp"，serve 的 managed lane "mcp --managed"。 */
  mode?: string;
}

/**
 * `party mcp #dev [bot-dev]` —— 频道用 `#`，身份用方括号，两者缺失分别退化成 `#*` / `[?]`，
 * 保证形状恒定（ps 输出可被 grep/awk 稳定切分）。
 */
export function buildMcpProcessTitle(input: McpProcessTitleInput): string {
  const mode = input.mode === undefined || input.mode === "" ? "mcp" : input.mode;
  const channel = input.channel === undefined || input.channel === null || input.channel === "" ? "*" : input.channel;
  const identity =
    (input.agentName === undefined || input.agentName === null || input.agentName === ""
      ? null
      : input.agentName) ?? identityLabelFromConfigPath(input.configPath) ?? "?";
  return `party ${mode} #${channel} [${identity}]`;
}

/** 真正去改 process.title；失败（某些平台不支持）静默忽略——可观测性不该拖垮 server。 */
export function applyMcpProcessTitle(input: McpProcessTitleInput): string {
  const title = buildMcpProcessTitle(input);
  try {
    process.title = title;
  } catch {
    /* 平台不支持就算了 */
  }
  return title;
}
