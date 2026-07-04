// 全局配置与 workspace 游标状态
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface Config {
  server: string;
  token: string;
}

export interface WorkspaceState {
  channel: string;
  cursor: number;
}

export function agentpartyHome(): string {
  return process.env.AGENTPARTY_HOME || join(homedir(), ".agentparty");
}

// 全局 config：跨目录默认 + 存量兼容（旧版本只写这里）。
export function globalConfigPath(): string {
  return join(agentpartyHome(), "config.json");
}

// workspace 级 config：按 cwd 隔离，与 state 同放（state/<workspaceId>/）。
// 同机多 session 各在自己目录，token/身份互不覆盖——修「共享 config.json 被后启动的 session 冲掉」。
// 注：同一目录并发多 session 仍会撞（workspaceId 相同），那种情形用 AGENTPARTY_HOME 硬隔离。
export function workspaceConfigPath(cwd: string = process.cwd()): string {
  return join(agentpartyHome(), "state", workspaceId(cwd), "config.json");
}

// 兼容旧调用：优先返回存在的 workspace 级路径，否则全局路径。
export function configPath(cwd: string = process.cwd()): string {
  const ws = workspaceConfigPath(cwd);
  return existsSync(ws) ? ws : globalConfigPath();
}

export function readConfig(cwd: string = process.cwd()): Config | null {
  // workspace 级优先（隔离），无则回退全局（跨目录默认 / 存量）
  for (const p of [workspaceConfigPath(cwd), globalConfigPath()]) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Config;
    } catch {
      /* 试下一个来源 */
    }
  }
  return null;
}

export function writeConfig(cfg: Config, cwd: string = process.cwd()): void {
  const body = JSON.stringify(cfg, null, 2) + "\n";
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

export function statePath(cwd: string = process.cwd()): string {
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
