// 「知道要批准，但没有任何地方可以批准」——把死角堵上（issue #942 第二轮）。
//
// 第一轮我们以为只要把用户领到**正确的批准入口**就行（桌面版没有 TUI ⇒ 给出带信任闸的那个
// 二进制的绝对路径）。真机验证证伪了这条路：owner 跑了
// `/Applications/ChatGPT.app/Contents/Resources/codex`（0.149，带 TUI），**没有出现任何 review
// 提示**，直接进了输入框。
//
// 原因（本机 2026-08-24 逐条取证）：codex 的 startup review **只对「新的或改动过的」hook 发问**。
// owner 那几条带着 `trusted_hash` 且 `enabled = false`——codex 认为「已经问过、用户选了不启用」，
// **永远不会再问**。桌面版（app-server）连这个界面都没有。⇒ 入口不存在。
//
// 所以批准这件事只能由我们来收集：
//   主路径 —— `party hook install --codex` 当场问一句，用户敲的 y **就是用户的批准**，
//             我们把 `enabled = true` 写进 `~/.codex/config.toml`。
//   兜底   —— 不确认 / 非交互 / 定位不到时，**把用户要粘的那两段 TOML 原样打出来**，
//             而不是让他去等一个不会出现的提示。
//
// 边界（每一条都是硬的）：
//   1. 只动**我们自己装的**那两条，按**命令本体**定位（`hook codex-stop` / `hook codex-report`），
//      绝不按下标。owner 那台恰好是 stop:2:0 / session_start:2:0，但同一份文件里还住着
//      superset(0:0)、Otty(1:0)、vibe-island(3:0)——下标会随别的工具增删而变，碰到任何一条都是事故。
//   2. 绝不使用 `--dangerously-bypass-hook-trust`。我们是**收集**用户的批准，不是**取消**这道闸。
//   3. 只翻已经带着 `trusted_hash` 的行。没有 hash 就说明 codex 从没为这条命令算过哈希，
//      我们编不出来——那种情况下不写，退到兜底。
//   4. config.toml 是几千行的用户文件：逐行外科手术，写完**重新解析并逐字段比对**，
//      除了目标那几个 `enabled` 以外有任何差异就整体放弃。
//
// 顺带记下两条本轮取证的事实（不在本切片改）：
//   - codex **有** SessionEnd hook 事件（`HookEventsToml` 里就有，owner 终端也实测到
//     `clamping SessionEnd hook timeout`）。#877 判「codex 没有会话结束事件」是错的。
//   - hook 有两处来源：`~/.codex/hooks.json` 与插件缓存
//     `~/.codex/plugins/cache/agentparty/agentparty/<版本>/hooks/hooks.json`，
//     后者在信任表里用的是**插件作用域键**（`agentparty@agentparty:hooks/hooks.json:stop:0:0`），
//     与前者完全独立。但插件那份的 Stop 挂的是 `hook stop-guard`，**不是** `hook codex-stop`——
//     codex 的前台唤醒钩子只存在于 `~/.codex/hooks.json`，所以本模块只看这一处是对的。
import { sanitizeSingleLine } from "./format";

/** 我们自己装的两条 codex hook，按**命令本体**认，绝不按下标。 */
export const CODEX_OWN_HOOK_COMMANDS = [
  { kind: "codex-stop", needle: "hook codex-stop", label: "前台唤醒（被 @ 时把消息取走）" },
  { kind: "codex-report", needle: "hook codex-report", label: "会话入册（让别人看得见你在线）" },
] as const;

export type CodexOwnHookKind = (typeof CODEX_OWN_HOOK_COMMANDS)[number]["kind"];

/** 信任行的四态。`unknown` = 行在、但没有 `enabled` 字段（codex 自带插件就是这样，视为已启用）。 */
export type CodexHookTrustState = "enabled" | "disabled" | "unknown" | "absent";

export interface CodexHookTarget {
  kind: CodexOwnHookKind;
  label: string;
  /** hooks.json 里的事件名（`Stop` / `SessionStart`）。 */
  event: string;
  group: number;
  index: number;
  /** `config.toml` 的 `[hooks.state."<key>"]` 键。 */
  key: string;
  command: string;
  state: CodexHookTrustState;
  /** 信任行里的 `trusted_hash`；没有为 null。没有 hash 就不能就地翻。 */
  trustedHash: string | null;
}

/**
 * hooks.json 的事件名 → 信任表键里的事件段。
 * 本机实测对照：`PermissionRequest`→`permission_request`、`PostToolUse`→`post_tool_use`、
 * `SessionStart`→`session_start`、`Stop`→`stop`、`SessionEnd`→`session_end`。
 */
export function trustEventName(event: string): string {
  return event
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `config.toml` 里 `[hooks.state]` 那张表；没有返回 null（＝这个 codex 版本没有信任闸）。 */
export function codexTrustTable(config: unknown): Record<string, unknown> | null {
  const hooks = asObject(asObject(config)?.hooks ?? null);
  return asObject(hooks?.state ?? null);
}

function trustStateOf(table: Record<string, unknown> | null, key: string): {
  state: CodexHookTrustState;
  trustedHash: string | null;
} {
  if (table === null) return { state: "unknown", trustedHash: null };
  const row = asObject(table[key] ?? null);
  if (table[key] === undefined) return { state: "absent", trustedHash: null };
  if (row === null) return { state: "unknown", trustedHash: null };
  const hash = typeof row.trusted_hash === "string" ? row.trusted_hash : null;
  if (row.enabled === false) return { state: "disabled", trustedHash: hash };
  if (row.enabled === true) return { state: "enabled", trustedHash: hash };
  // 行在、但没写 enabled —— codex 自带插件就是这个形状，实测按「已启用」跑。
  return { state: "unknown", trustedHash: hash };
}

/**
 * 在 hooks.json 里找出**我们自己那几条**，连同它们在信任表里的现状。
 *
 * 只按命令本体匹配；同一条命令在同一事件下出现多次时全部列出（去重交给调用方，
 * 反正每一条都是我们的）。
 */
export function findCodexOwnHooks(
  hooksPath: string,
  hooksJson: unknown,
  config: unknown,
): CodexHookTarget[] {
  const out: CodexHookTarget[] = [];
  const hooks = asObject(asObject(hooksJson)?.hooks ?? null);
  if (hooks === null) return out;
  const table = codexTrustTable(config);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (let g = 0; g < groups.length; g += 1) {
      const entries = asObject(groups[g])?.hooks;
      if (!Array.isArray(entries)) continue;
      for (let h = 0; h < entries.length; h += 1) {
        const command = asObject(entries[h])?.command;
        if (typeof command !== "string") continue;
        const own = CODEX_OWN_HOOK_COMMANDS.find((c) => command.includes(c.needle));
        if (own === undefined) continue;
        const key = `${hooksPath}:${trustEventName(event)}:${String(g)}:${String(h)}`;
        out.push({
          kind: own.kind,
          label: own.label,
          event,
          group: g,
          index: h,
          key,
          command,
          ...trustStateOf(table, key),
        });
      }
    }
  }
  return out;
}

export type CodexTrustWriteRefusal =
  | "config-unparsable"
  | "no-targets"
  | "row-missing"
  | "hash-missing"
  | "row-ambiguous"
  | "enabled-unrecognized"
  | "verify-failed";

export interface CodexTrustWriteChange {
  key: string;
  /** 改之前那一行的原文（没有 enabled 行时为 null，表示是新插入的）。 */
  before: string | null;
  after: string;
}

export type CodexTrustWriteResult =
  | { ok: true; text: string; changes: CodexTrustWriteChange[] }
  | { ok: false; reason: CodexTrustWriteRefusal; detail: string };

/** TOML 里的裸键 vs 引号键：我们的键一定是带引号的（里面有 `/` 和 `:`）。 */
function tableHeaderFor(key: string): string {
  return `[hooks.state."${key}"]`;
}

/**
 * 把给定几个键的 `enabled` 就地翻成 `true`。
 *
 * 逐行外科手术：只碰目标表头下面那一行，其余**逐字节保留**（这是个几千行的用户文件，
 * 整体重写会把注释、顺序、格式全洗掉）。写完重新解析并逐字段比对，只允许目标 `enabled`
 * 有差异；有任何别的差异 ⇒ 整体放弃，一个字都不写。
 */
export function enableCodexHookTrust(
  configText: string,
  keys: string[],
  parseToml: (text: string) => unknown,
): CodexTrustWriteResult {
  if (keys.length === 0) return { ok: false, reason: "no-targets", detail: "没有要启用的条目" };
  let before: unknown;
  try {
    before = parseToml(configText);
  } catch (e) {
    return {
      ok: false,
      reason: "config-unparsable",
      detail: `读不懂 config.toml（${e instanceof Error ? e.message : String(e)}）`,
    };
  }
  const lines = configText.split("\n");
  const changes: CodexTrustWriteChange[] = [];

  for (const key of keys) {
    const header = tableHeaderFor(key);
    const headerIdxs = lines
      .map((l, i) => (l.trim() === header ? i : -1))
      .filter((i) => i >= 0);
    if (headerIdxs.length === 0) {
      return { ok: false, reason: "row-missing", detail: `config.toml 里没有 ${header}` };
    }
    if (headerIdxs.length > 1) {
      return { ok: false, reason: "row-ambiguous", detail: `${header} 出现了 ${String(headerIdxs.length)} 次` };
    }
    const start = headerIdxs[0]!;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i]!.trimStart().startsWith("[")) {
        end = i;
        break;
      }
    }
    let hashLine = -1;
    let enabledLine = -1;
    for (let i = start + 1; i < end; i += 1) {
      const t = lines[i]!.trim();
      if (t.startsWith("trusted_hash")) hashLine = i;
      if (/^enabled\s*=/.test(t)) enabledLine = i;
    }
    if (hashLine < 0) {
      // 没有 hash ⇒ codex 从没为这条命令算过哈希，我们编不出来。不写。
      return { ok: false, reason: "hash-missing", detail: `${header} 里没有 trusted_hash` };
    }
    if (enabledLine < 0) {
      lines.splice(hashLine + 1, 0, "enabled = true");
      changes.push({ key, before: null, after: "enabled = true" });
      continue;
    }
    const raw = lines[enabledLine]!;
    const value = raw.trim().replace(/^enabled\s*=\s*/, "");
    if (value === "true") continue; // 已经启用，不动
    if (value !== "false") {
      return { ok: false, reason: "enabled-unrecognized", detail: `${header} 的 enabled 是 ${value}，看不懂` };
    }
    const indent = raw.slice(0, raw.length - raw.trimStart().length);
    const next = `${indent}enabled = true`;
    lines[enabledLine] = next;
    changes.push({ key, before: raw, after: next });
  }

  if (changes.length === 0) return { ok: true, text: configText, changes };
  const text = lines.join("\n");
  let after: unknown;
  try {
    after = parseToml(text);
  } catch (e) {
    return {
      ok: false,
      reason: "verify-failed",
      detail: `改完之后 config.toml 解析不了（${e instanceof Error ? e.message : String(e)}）`,
    };
  }
  const diff = onlyIntendedTrustFlagsChanged(before, after, keys);
  if (diff !== null) return { ok: false, reason: "verify-failed", detail: diff };
  return { ok: true, text, changes };
}

/**
 * 「除了目标那几个 `enabled`，别的一个字都没变」——这是整套写入的安全网。
 * 返回 null 表示通过；否则返回哪儿不对。
 */
export function onlyIntendedTrustFlagsChanged(
  before: unknown,
  after: unknown,
  keys: string[],
): string | null {
  const strip = (value: unknown): unknown => {
    const root = asObject(value);
    if (root === null) return value;
    const table = codexTrustTable(root);
    if (table === null) return value;
    // 深拷贝后把目标行的 enabled 抹掉，再整体比对——剩下的必须逐字段全等。
    const clone = JSON.parse(JSON.stringify(root)) as Record<string, unknown>;
    const cloneTable = codexTrustTable(clone);
    if (cloneTable === null) return clone;
    for (const key of keys) {
      const row = asObject(cloneTable[key] ?? null);
      if (row !== null) delete row.enabled;
    }
    return clone;
  };
  const a = JSON.stringify(strip(before));
  const b = JSON.stringify(strip(after));
  if (a !== b) return "改动超出了目标条目——已放弃写入，config.toml 一个字都没动";
  const table = codexTrustTable(after);
  for (const key of keys) {
    const row = asObject(table?.[key] ?? null);
    if (row === null || row.enabled !== true) return `${key} 没有变成 enabled = true`;
  }
  return null;
}

/**
 * 兜底：用户要粘进 `config.toml` 的那几段，原样打出来。
 *
 * **这是本切片的最低交付**——哪怕我们不写、写不了、定位不到，用户也必须拿到「粘这个」，
 * 而不是「去等一个不会出现的提示」。拿不到 `trusted_hash` 的条目不编造，如实说明。
 */
export function codexTrustTomlSnippet(targets: CodexHookTarget[], configPath: string): string[] {
  const out: string[] = [];
  const fixable = targets.filter((t) => t.trustedHash !== null && t.state !== "enabled");
  const unhashed = targets.filter((t) => t.trustedHash === null && t.state !== "enabled");
  if (fixable.length > 0) {
    out.push(`手动改法：打开 ${sanitizeSingleLine(configPath)}，把下面这 ${String(fixable.length)} 段里的 enabled 改成 true`);
    out.push("（这些段【已经存在】，别重复添加；trusted_hash 保持原样不要动）：");
    for (const t of fixable) {
      out.push("");
      out.push(`  [hooks.state."${sanitizeSingleLine(t.key)}"]   # ${t.label}`);
      out.push(`  trusted_hash = "${sanitizeSingleLine(t.trustedHash!)}"`);
      out.push("  enabled = true");
    }
  }
  if (unhashed.length > 0) {
    out.push("");
    out.push(
      `另有 ${String(unhashed.length)} 条还没进过 codex 的信任表（${unhashed.map((t) => sanitizeSingleLine(t.key)).join("、")}）——` +
        "这类是「新的或改动过的」hook，codex 下次在【带信任闸的终端 TUI】里启动时会主动问你，" +
        "那时选启用即可；它的 trusted_hash 只有 codex 自己算得出，我们不编。",
    );
  }
  return out;
}

/**
 * 「这台机器上，我们那两条现在是什么状况、能不能就地修」——给修法文案用的视图。
 * 纯数据，读盘那一半在 wake-diagnosis.ts（那儿本来就管 CODEX_HOME 与这两个文件）。
 */
export interface CodexTrustRemedy {
  hooksPath: string;
  configPath: string;
  /** 我们自己那几条（按命令本体找出来的）。空 = hooks.json 里根本没有我们的条目。 */
  targets: CodexHookTarget[];
  /** 行在、有 trusted_hash、当前是 enabled=false ⇒ 我们可以就地翻。 */
  enableable: CodexHookTarget[];
  /** 还没进过信任表 ⇒ codex 下次在带闸的 TUI 里启动时会主动问。 */
  absent: CodexHookTarget[];
  /** 兜底：用户要粘的那几段 TOML。**任何一档都必须给得出**。 */
  snippet: string[];
  /** 读盘/解析失败时的人话说明；正常为空。 */
  detail: string;
}

/** 从已经读出来的两份内容算出 remedy 视图。读盘在调用方，这里保持纯函数。 */
export function buildCodexTrustRemedy(input: {
  hooksPath: string;
  configPath: string;
  hooksJson: unknown;
  config: unknown;
  detail?: string;
}): CodexTrustRemedy {
  const targets = findCodexOwnHooks(input.hooksPath, input.hooksJson, input.config);
  return {
    hooksPath: input.hooksPath,
    configPath: input.configPath,
    targets,
    enableable: targets.filter((t) => t.state === "disabled" && t.trustedHash !== null),
    absent: targets.filter((t) => t.state === "absent"),
    snippet: codexTrustTomlSnippet(targets, input.configPath),
    detail: input.detail ?? "",
  };
}
