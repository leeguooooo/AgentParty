// 全局配置与 workspace 游标状态
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface Config {
  server: string;
  token: string;
  identity?: CachedIdentity;
}

export interface CachedIdentity {
  name: string;
  email: string | null;
  kind: string;
  role: string;
  owner: string | null;
  channel_scope: string | null;
  verified_at: number;
}

export type ConfigSourceKind = "explicit" | "workspace" | "global" | "none";

export interface ConfigSourceInfo {
  kind: ConfigSourceKind;
  path: string | null;
  workspace_id?: string;
  token_fingerprint?: string;
}

export interface ConfigWithSource {
  config: Config | null;
  source: ConfigSourceInfo;
}

export interface ChannelCursor {
  cursor: number;
  rev_cursor?: number;
}

export interface WorkspaceState {
  channel: string;
  cursor: number;
  /** 修订游标：已见过的最大 rev_seq（hello.since_rev），与消息游标并列持久化 */
  rev_cursor?: number;
  /**
   * 分频道游标（#113）。旧版把游标只绑在 `channel` 上，于是 `serve --profile` 的所有
   * 频道恒 since=0，每次重启把保留窗口里的历史 @ 逐条重放，反复拉起 runner。
   * 顶层 channel/cursor/rev_cursor 保留作绑定频道的镜像，兼容旧读者与 statusline。
   */
  cursors?: Record<string, ChannelCursor>;
  /**
   * 面包屑：init 时若用了 AGENTPARTY_CONFIG，把该显式路径记进【cwd 基准】的 state（不受 env 影响）。
   * 回落用——Claude Code 的 Bash 不跨 turn 保留 export，被唤醒回复轮没了 env 就靠它找回绑定的 agent
   * config，避免回落到人类账号会话导致冒充/串号（issue #42）。只存路径不存 token，token 仍只在该文件里。
   */
  config_path?: string;
}

export function agentpartyHome(): string {
  return process.env.AGENTPARTY_HOME || join(homedir(), ".agentparty");
}

export function explicitConfigPath(): string | null {
  return process.env.AGENTPARTY_CONFIG || null;
}

// 全局 config：跨目录默认 + 存量兼容（旧版本只写这里）。
export function globalConfigPath(): string {
  const explicit = explicitConfigPath();
  if (explicit) return explicit;
  return join(agentpartyHome(), "config.json");
}

// workspace 级 config：按 cwd 隔离，与 state 同放（state/<workspaceId>/）。
// 同机多 session 各在自己目录，token/身份互不覆盖——修「共享 config.json 被后启动的 session 冲掉」。
// 注：同一目录并发多 session 仍会撞（workspaceId 相同），那种情形用 AGENTPARTY_CONFIG
// 或 AGENTPARTY_HOME 硬隔离；AGENTPARTY_CONFIG 同时隔离 config 与 cursor state。
export function workspaceConfigPath(cwd: string = process.cwd()): string {
  const explicit = explicitConfigPath();
  if (explicit) return explicit;
  return join(agentpartyHome(), "state", workspaceId(cwd), "config.json");
}

// 兼容旧调用：优先返回存在的 workspace 级路径，否则全局路径。
export function configPath(cwd: string = process.cwd()): string {
  const ws = workspaceConfigPath(cwd);
  return existsSync(ws) ? ws : globalConfigPath();
}

export function tokenFingerprint(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
}

function sourceInfo(kind: ConfigSourceKind, path: string | null, cfg: Config | null, cwd: string): ConfigSourceInfo {
  return {
    kind,
    path,
    ...(kind === "workspace" ? { workspace_id: workspaceId(cwd) } : {}),
    ...(cfg?.token ? { token_fingerprint: tokenFingerprint(cfg.token) } : {}),
  };
}

export function readConfigWithSource(cwd: string = process.cwd()): ConfigWithSource {
  const explicit = explicitConfigPath();
  if (explicit) {
    try {
      const cfg = JSON.parse(readFileSync(explicit, "utf8")) as Config;
      return { config: cfg, source: sourceInfo("explicit", explicit, cfg, cwd) };
    } catch {
      return { config: null, source: sourceInfo("explicit", explicit, null, cwd) };
    }
  }

  const ws = workspaceConfigPath(cwd);
  try {
    const cfg = JSON.parse(readFileSync(ws, "utf8")) as Config;
    return { config: cfg, source: sourceInfo("workspace", ws, cfg, cwd) };
  } catch {
    /* 试全局来源 */
  }

  const global = globalConfigPath();
  try {
    const cfg = JSON.parse(readFileSync(global, "utf8")) as Config;
    return { config: cfg, source: sourceInfo("global", global, cfg, cwd) };
  } catch {
    /* 试面包屑指针 */
  }

  // 面包屑回落（issue #42）：cwd-state 记了 config_path 就顺着找回绑定的 agent config——
  // 这是 Claude 唤醒回复轮丢了 AGENTPARTY_CONFIG env 后不冒充人类账号的关键兜底。
  try {
    const st = JSON.parse(readFileSync(cwdStatePath(cwd), "utf8")) as WorkspaceState;
    if (st.config_path) {
      const cfg = JSON.parse(readFileSync(st.config_path, "utf8")) as Config;
      return { config: cfg, source: sourceInfo("explicit", st.config_path, cfg, cwd) };
    }
  } catch {
    /* 无指针或指向的文件已删 */
  }
  return { config: null, source: sourceInfo("none", null, null, cwd) };
}

export function readConfig(cwd: string = process.cwd()): Config | null {
  return readConfigWithSource(cwd).config;
}

export function writeConfig(cfg: Config, cwd: string = process.cwd()): void {
  const body = JSON.stringify(cfg, null, 2) + "\n";
  const explicit = explicitConfigPath();
  if (explicit) {
    mkdirSync(dirname(explicit), { recursive: true });
    writeFileSync(explicit, body, { mode: 0o600 });
    chmodSync(explicit, 0o600);
    return;
  }
  // 配置里有 token 明文，收紧到仅属主可读写；对已存在的文件补 chmod
  // 双写：① workspace 级（本目录/session 专属，读取时优先）② 全局（跨目录默认 + 存量兼容）。
  // 读取偏好 workspace，故全局被并发覆盖也不会串号。
  for (const p of [workspaceConfigPath(cwd), globalConfigPath()]) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body, { mode: 0o600 });
    chmodSync(p, 0o600);
  }
}

export function slugifyBasename(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "workspace";
}

// <目录basename-slug>-<sha256(cwd)前16位>
export function workspaceId(cwd: string = process.cwd()): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return `${slugifyBasename(basename(cwd))}-${hash}`;
}

export function workspaceLabel(cwd: string = process.cwd()): string {
  return basename(cwd) || "workspace";
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const res = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status !== 0) return null;
    const out = String(res.stdout).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

export function worktreeLabel(cwd: string = process.cwd()): string | undefined {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return undefined;
  const branch = gitOutput(cwd, ["branch", "--show-current"]);
  const head = branch ?? gitOutput(cwd, ["rev-parse", "--short", "HEAD"]);
  return head === null ? basename(root) : `${basename(root)}:${head}`;
}

export function statePath(cwd: string = process.cwd()): string {
  const explicit = explicitConfigPath();
  if (explicit) return join(dirname(explicit), `${basename(explicit)}.state`, "state.json");
  return join(agentpartyHome(), "state", workspaceId(cwd), "state.json");
}

// cwd 基准的 state 路径，永远无视 AGENTPARTY_CONFIG——面包屑指针写这里，回复轮（无 env）才找得到。
export function cwdStatePath(cwd: string = process.cwd()): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "state.json");
}

// init 时把显式 config 路径记进 cwd-state（issue #42）。只在该 state 无 config_path 或指向不同路径时更新。
export function bindWorkspaceConfigPointer(configPath: string, channel: string, cwd: string = process.cwd()): void {
  const p = cwdStatePath(cwd);
  let prev: WorkspaceState | null = null;
  try {
    prev = JSON.parse(readFileSync(p, "utf8")) as WorkspaceState;
  } catch {
    /* 无既有 cwd-state */
  }
  const next: WorkspaceState = { channel, cursor: prev?.cursor ?? 0, ...prev, config_path: configPath };
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

export function readState(cwd: string = process.cwd()): WorkspaceState | null {
  try {
    return JSON.parse(readFileSync(statePath(cwd), "utf8")) as WorkspaceState;
  } catch {
    return null;
  }
}

// tmp + rename 原子替换（#113）：裸 writeFileSync 在崩溃/并发下会留下截断的 JSON，
// readState 随即返回 null → 游标退回 0 → 整个保留窗口的 @ 被重放。范本同 statusline-cache.ts。
export function writeState(st: WorkspaceState, cwd: string = process.cwd()): void {
  const p = statePath(cwd);
  mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(st, null, 2) + "\n");
  renameSync(tmp, p);
}

export function resolveChannel(explicit?: string, cwd?: string): string | null {
  if (explicit) return explicit;
  return readState(cwd)?.channel ?? null;
}

// 游标按频道键持久化（#113）。读旧格式时回落到顶层字段（绑定频道），保证升级不丢游标。
function channelCursor(st: WorkspaceState | null, channel: string): ChannelCursor {
  if (!st) return { cursor: 0 };
  const scoped = st.cursors?.[channel];
  if (scoped) return scoped;
  if (st.channel === channel) return { cursor: st.cursor, ...(st.rev_cursor === undefined ? {} : { rev_cursor: st.rev_cursor }) };
  return { cursor: 0 };
}

// 写回：分频道表是权威；绑定频道同步镜像到顶层，供 statusline 等旧读者使用。
function putChannelCursor(channel: string, next: ChannelCursor, cwd?: string): void {
  const st = readState(cwd) ?? { channel, cursor: 0 };
  const merged: WorkspaceState = {
    ...st,
    cursors: { ...(st.cursors ?? {}), [channel]: next },
  };
  if (st.channel === channel) {
    merged.cursor = next.cursor;
    if (next.rev_cursor !== undefined) merged.rev_cursor = next.rev_cursor;
  }
  writeState(merged, cwd);
}

export function loadCursor(channel: string, cwd?: string): number {
  return channelCursor(readState(cwd), channel).cursor;
}

export function saveCursor(channel: string, cursor: number, cwd?: string): void {
  const cur = channelCursor(readState(cwd), channel);
  if (cursor <= cur.cursor) return; // 单调，不回退
  putChannelCursor(channel, { ...cur, cursor }, cwd);
}

/**
 * 自己发消息后推进游标——**仅在没有空洞时**（#113）。
 * 旧实现无条件 saveCursor(channel, mySeq)，把发送前所有未消费的消息（含正 @ 我的新 mention）
 * 一起吞掉：不打印、不唤醒、不补拉。watch 侧本来就有 fromSelf 过滤（watch.ts），
 * 所以「跳过自己的回声」根本不需要动游标。
 * 这里只处理「我已经读到最新、紧接着自己发了一条」的情形，保住 statusline 的 unread=0。
 */
export function advanceCursorPastOwnMessage(channel: string, seq: number, cwd?: string): void {
  const cur = channelCursor(readState(cwd), channel);
  if (cur.cursor !== seq - 1) return; // 有空洞：那些是别人的消息，绝不跳过
  putChannelCursor(channel, { ...cur, cursor: seq }, cwd);
}

export function loadRevCursor(channel: string, cwd?: string): number {
  return channelCursor(readState(cwd), channel).rev_cursor ?? 0;
}

export function saveRevCursor(channel: string, revCursor: number, cwd?: string): void {
  const cur = channelCursor(readState(cwd), channel);
  if (revCursor <= (cur.rev_cursor ?? 0)) return;
  putChannelCursor(channel, { ...cur, rev_cursor: revCursor }, cwd);
}
