// `party claude` 的本机默认启动参数（#978）。
//
// 背景：owner 这台机所有 Claude 都是 `claude --dangerously-skip-permissions` 起的；改用
// `party claude <chan>` 起会话后，每次都得手敲 `-- --dangerously-skip-permissions`，漏一次
// 就是一个卡在权限确认上的会话。要的是「配一次，之后一条命令就带上」。
//
// 硬约束：
// - `--dangerously-skip-permissions` 是高危 flag，这里**绝不**把任何参数硬编码成无条件默认。
//   默认参数只来自用户显式写下的配置（opt-in 一次），文案说清这是「本机默认」。
// - 显式 `-- <args>` 仍然生效：默认在前、显式在后（Claude CLI 后者覆盖）；同名 flag 不重复插。
// - 存储沿用现有本机偏好机制：和 `codex-auto-wake.json` 放在同一层（`$AGENTPARTY_HOME/`），
//   同样的 atomicWriteJson、同样用 `home` 注入做测试。
// - 优先级：配置文件 > 环境变量 `AGENTPARTY_CLAUDE_DEFAULT_ARGS`（兜底）> 无。
//   和 codex auto-wake 相反（那边 env 优先是为了给子进程递 `off`）；这里文件是用户主动写的
//   显式意图，不该被一个可能是很久以前 export 在 shell rc 里的变量盖掉。

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-json";

export const CLAUDE_DEFAULT_ARGS_FILE = "claude-default-args.json";
export const CLAUDE_DEFAULT_ARGS_ENV = "AGENTPARTY_CLAUDE_DEFAULT_ARGS";
/** 需要在文案里单独点名的高危 flag：配了它就等于本机所有 `party claude` 会话都跳权限。 */
export const CLAUDE_DANGEROUS_FLAGS = ["--dangerously-skip-permissions"] as const;

export type ClaudeDefaultArgsSource = "config" | "env" | "none";

export interface ClaudeDefaultArgsResolution {
  args: string[];
  source: ClaudeDefaultArgsSource;
  /** 来源的人类可读描述：配置文件路径，或环境变量名；`none` 时是「没配置时该写哪个文件」。 */
  origin: string;
}

export function claudeDefaultArgsPath(home: string): string {
  return join(home, CLAUDE_DEFAULT_ARGS_FILE);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 读配置文件里的默认参数；文件不存在 / 不是合法形状 → null（当没设过）。空数组视为「显式清空」。 */
export function readClaudeDefaultArgs(home: string): string[] | null {
  try {
    const value = JSON.parse(readFileSync(claudeDefaultArgsPath(home), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const args = (value as { args?: unknown }).args;
    return isStringArray(args) ? [...args] : null;
  } catch {
    return null;
  }
}

export function writeClaudeDefaultArgs(home: string, args: string[]): void {
  atomicWriteJson(claudeDefaultArgsPath(home), { version: 1, args: [...args] });
}

/** 清空 = 删文件，而不是写空数组：这样才是「恢复原样」（含环境变量兜底重新生效）。 */
export function clearClaudeDefaultArgs(home: string): void {
  rmSync(claudeDefaultArgsPath(home), { force: true });
}

/** 环境变量按空白切分；不支持引号——需要带空格的值请写配置文件。空串 → null。 */
export function parseClaudeDefaultArgsEnv(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).filter((part) => part !== "");
  return parts.length === 0 ? null : parts;
}

export function resolveClaudeDefaultArgs(
  env: NodeJS.ProcessEnv,
  home: string,
): ClaudeDefaultArgsResolution {
  const path = claudeDefaultArgsPath(home);
  const fromConfig = readClaudeDefaultArgs(home);
  if (fromConfig !== null) return { args: fromConfig, source: "config", origin: path };
  const fromEnv = parseClaudeDefaultArgsEnv(env[CLAUDE_DEFAULT_ARGS_ENV]);
  if (fromEnv !== null) {
    return { args: fromEnv, source: "env", origin: `环境变量 ${CLAUDE_DEFAULT_ARGS_ENV}` };
  }
  return { args: [], source: "none", origin: path };
}

/** `--model=sonnet` → `--model`；非 flag 返回 null。 */
function flagName(token: string): string | null {
  if (!token.startsWith("-") || token === "-" || token === "--") return null;
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * 把参数切成「一个 flag + 它后面紧跟的非 flag 值」的组；开头的裸位置参数自成一组。
 * 这样 `--model sonnet` 作为整体被去重，而不是只删掉 `--model` 留下一个孤零零的 `sonnet`。
 */
function groupArgs(args: string[]): string[][] {
  const groups: string[][] = [];
  for (const token of args) {
    const last = groups[groups.length - 1];
    if (flagName(token) !== null || last === undefined || flagName(last[0]!) === null) {
      groups.push([token]);
    } else {
      last.push(token);
    }
  }
  return groups;
}

/**
 * 默认参数在前、显式参数在后。显式里已经出现过同名 flag 的默认组整组丢掉——
 * 既避免 `--dangerously-skip-permissions --dangerously-skip-permissions` 这种重复，
 * 也让 `--model opus` 显式覆盖默认的 `--model sonnet` 时不留下残值。
 */
export function mergeClaudeArgs(defaultArgs: string[], explicitArgs: string[]): string[] {
  if (defaultArgs.length === 0) return [...explicitArgs];
  const explicitFlags = new Set(
    explicitArgs.map(flagName).filter((name): name is string => name !== null),
  );
  const kept = groupArgs(defaultArgs)
    .filter((group) => {
      const name = flagName(group[0]!);
      return name === null || !explicitFlags.has(name);
    })
    .flat();
  return [...kept, ...explicitArgs];
}

export function hasDangerousClaudeFlag(args: string[]): boolean {
  return args.some((arg) => (CLAUDE_DANGEROUS_FLAGS as readonly string[]).includes(arg));
}
