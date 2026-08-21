import type { DesktopAgentRunner } from "./desktopAgent";
import type { JoinPackHarness, JoinPackMode } from "./joinPack";

const RUNNERS: readonly DesktopAgentRunner[] = ["codex", "claude", "codex-sdk"];

const VAULT_KEY = "ap_agent_token_vault:v1";

export interface AgentTokenRecord {
  account: string;
  slug: string;
  name: string;
  token: string;
  command: string;
  /** #612：生成时选的接入方式；「复制接入包」按它重建同款。缺省（旧记录）按 interactive。 */
  mode?: JoinPackMode;
  /** #749：unattended 生成时选的 runner；「复制接入包」按它重建同款。缺省（旧记录）按 codex。 */
  runner?: DesktopAgentRunner;
  /** #845 第 4 点：interactive 生成时选的目标 harness；「复制接入包」按它重建同款。缺省（旧记录）按 other＝全量。 */
  harness?: JoinPackHarness;
  savedAt: number;
}

function readAll(): AgentTokenRecord[] {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is AgentTokenRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.account === "string" &&
    typeof rec.slug === "string" &&
    typeof rec.name === "string" &&
    typeof rec.token === "string" &&
    typeof rec.command === "string" &&
    typeof rec.savedAt === "number" &&
    (rec.mode === undefined || rec.mode === "interactive" || rec.mode === "unattended") &&
    (rec.runner === undefined || RUNNERS.includes(rec.runner as DesktopAgentRunner)) &&
    (rec.harness === undefined || rec.harness === "claude" || rec.harness === "codex" || rec.harness === "other")
  );
}

function writeAll(records: AgentTokenRecord[]) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(records));
}

export function listSavedAgentTokens(account: string, slug: string): AgentTokenRecord[] {
  return readAll()
    .filter((rec) => rec.account === account && rec.slug === slug)
    .sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name));
}

export function findSavedAgentToken(account: string, slug: string, name: string): AgentTokenRecord | null {
  return readAll().find((rec) => rec.account === account && rec.slug === slug && rec.name === name) ?? null;
}

export function saveAgentToken(record: AgentTokenRecord) {
  const rest = readAll().filter(
    (rec) => !(rec.account === record.account && rec.slug === record.slug && rec.name === record.name),
  );
  writeAll([record, ...rest].slice(0, 200));
}

export function removeSavedAgentToken(account: string, slug: string, name: string) {
  writeAll(readAll().filter((rec) => !(rec.account === account && rec.slug === slug && rec.name === name)));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall back to execCommand below. */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// MIN_CLI / version_ge 真值搬进 joinPack（完整包 builder 所在地），这里 re-export 保住既有
// 消费者；桌面最小包与完整包仍共用同一份，防两处漂移。版本上调历史见 joinPack 注释。
export { MIN_CLI, VERSION_GE_SNIPPET } from "./joinPack";

// MCP server 注册名规则挪到 shared 与 cli 的 party invite 共用一份（#585）；语义与来由见那边注释。
export { mcpServerName } from "@agentparty/shared/onboarding";

// #902：这里曾有第二份手写接入包（buildMinimalAgentCommand），与 joinPack 双轨并行——
// joinPack 的 harness 分档、marketplace 插件、`party hook install --codex`（#901 的 codex 唤醒
// 开关）它一样都没有，拿它接入的 codex 能发能读却叫不醒。已整体删除：接入包只有 joinPack
// 一个 builder（buildJoinPack），vault 记录的 command 字段也由它生成。别再在这里加第二份。
