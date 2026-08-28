import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const SKILL = readFileSync("skills/agentparty/SKILL.md", "utf8");

/**
 * 2026-08-26 真机事故：owner 把接入包贴进 codex，codex 先读了本技能，照 Intent 表里
 * 「Join a channel」那一行拼出 `party init --token …`，撞上 `--token requires a value` 退出 1。
 *
 * 那一行早于 `party join`（#944/#948），教的是它出现之前的两步流程。接入包承诺「一条命令」，
 * 技能却把 agent 引向另一条路——**而 agent 扫的是这张表，不是散文**。
 *
 * 这里钉的不是「文里出现过 party join」（散文早就写了，事故照样发生），而是
 * **Intent 表里那一行的命令单元格**给出的是哪条命令。
 */
function joinRow(): string {
  const row = SKILL.split("\n").find((l) => l.startsWith("| Join a channel"));
  if (!row) throw new Error("Intent 表里找不到「Join a channel」这一行");
  return row;
}

/**
 * 只取命令单元格里的**代码片段**（反引号内），不看散文。
 *
 * 整行扫描会把行内那句「别拿 `party init` 手搓」也算成「还在教 init」——我第一版就是这么
 * 自己红了自己的。判「教的是哪条命令」必须只看代码，判「有没有讲清代价」才看散文。
 */
function joinCommands(): string[] {
  const cells = joinRow().split("|");
  // 0 是行首空串，1 是 Intent，其余合起来是命令单元格（命令里含 `\|` 转义会被拆开）。
  const cell = cells.slice(2).join("|");
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/**
 * 命令单元格里真正的 party **调用**。
 *
 * 行内那句「别拿 `party init` 手搓」也是反引号片段，但它是**散文里的提及**、不是给 agent
 * 照抄的命令。区分靠「带不带参数」：可照抄的加入命令必然带 `--server/--channel/...`，
 * 光杆的 `party init` 是在指代它、不是在教它。
 */
function partyInvocations(): string[] {
  return joinCommands().filter((c) => /(^|\s)party\s+[a-z-]+\s+-/.test(c));
}

describe("SKILL.md 的加入频道指引", () => {
  it("命令单元格里唯一的 party 调用是 party join", () => {
    const subs = partyInvocations().map((c) => {
      const m = c.match(/(?:^|\s)party\s+([a-z-]+)/);
      return m ? m[1] : c;
    });
    expect({ 调用: subs }).toEqual({ 调用: ["join"] });
  });

  it("token 由 AGENTPARTY_TOKEN 环境变量前缀传入，不进 argv（#676）", () => {
    const cmd = partyInvocations()[0] ?? "";
    expect({
      环境变量前缀: /^AGENTPARTY_TOKEN=\S+\s+party\s+join\b/.test(cmd),
      // #676：--token/-t 会把 token 写进 argv，同机 `ps -axww` 可读，还落 shell history。
      token进argv: /(^|\s)(--token|-t)(\s|=|$)/.test(cmd),
    }).toEqual({ 环境变量前缀: true, token进argv: false });
  });

  it("join 命令带齐了必需参数，不是半截", () => {
    const cmd = partyInvocations()[0] ?? "";
    const missing = ["--server", "--channel", "--as"].filter((f) => !cmd.includes(f));
    expect({ 缺的参数: missing }).toEqual({ 缺的参数: [] });
  });

  it("说明里点明了「半截 join」和「静默失败」两件事", () => {
    const prose = joinRow().replace(/`[^`]+`/g, "");
    expect({
      提了半截: /hand-roll|partial join/i.test(prose),
      提了静默: /silent/i.test(prose),
    }).toEqual({ 提了半截: true, 提了静默: true });
  });
});
