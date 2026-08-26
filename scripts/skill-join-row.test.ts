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
 * **Intent 表里那一行本身**给的是哪条命令。
 */
function joinRow(): string {
  const row = SKILL.split("\n").find((l) => l.startsWith("| Join a channel"));
  if (!row) throw new Error("Intent 表里找不到「Join a channel」这一行");
  return row;
}

describe("SKILL.md 的加入频道指引", () => {
  it("Intent 表的 join 行给的是 party join，不是手搓 party init", () => {
    const row = joinRow();
    expect({
      用了join: row.includes("party join"),
      // 只抓「拿 init 当加入命令」的用法；散文里提一句「别用 init」不算数
      还在教init: /party init\s+--/.test(row),
    }).toEqual({ 用了join: true, 还在教init: false });
  });

  it("token 只经 AGENTPARTY_TOKEN 环境变量，不落 argv（#676）", () => {
    const row = joinRow();
    expect({
      有环境变量: row.includes("AGENTPARTY_TOKEN"),
      token进了argv: /--token\b/.test(row),
    }).toEqual({ 有环境变量: true, token进了argv: false });
  });

  it("说明了为什么不能拿 init 拼——半截 join 是静默失败，不是报错", () => {
    expect(joinRow()).toContain("silently");
  });
});
