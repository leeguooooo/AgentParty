// 全局配置与 workspace 游标状态
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Config {
  server: string;
  token: string;
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

export interface WorkspaceState {
  channel: string;
  cursor: number;
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
    return { config: null, source: sourceInfo("none", null, null, cwd) };
  }
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

export function readState(cwd: string = process.cwd()): WorkspaceState | null {
  try {
    return JSON.parse(readFileSync(statePath(cwd), "utf8")) as WorkspaceState;
  } catch {
    return null;
  }
}

export function writeState(st: WorkspaceState, cwd: string = process.cwd()): void {
  const p = statePath(cwd);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(st, null, 2) + "\n");
}

export function resolveChannel(explicit?: string, cwd?: string): string | null {
  if (explicit) return explicit;
  return readState(cwd)?.channel ?? null;
}

// 游标只在频道与 workspace 绑定频道一致时读写
export function loadCursor(channel: string, cwd?: string): number {
  const st = readState(cwd);
  return st && st.channel === channel ? st.cursor : 0;
}

export function saveCursor(channel: string, cursor: number, cwd?: string): void {
  const st = readState(cwd);
  if (!st || st.channel !== channel) return;
  if (cursor <= st.cursor) return;
  writeState({ channel, cursor }, cwd);
}
