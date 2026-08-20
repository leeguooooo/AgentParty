// #886 方向 1（引导层）：真机拍到 agent 先发结果、再发一条「我发了结果」的汇报，
// 同一件事把发起方唤醒两次。修不了唤醒链（那不是 bug），只能把判据写死在每个引导面上。
// 这些断言刻意用整句而非单词——本仓踩过「弱 toContain 被别处的同名词独自满足」的坑。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BEHAVIOR_CONTRACT_BODY_LINES, BEHAVIOR_CONTRACT_SUMMARY } from "../shared/src/onboarding";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const SKILL_RULE_HEAD = "10. **Never echo back what you just sent.**";
const SKILL_TEST = "**The test: if the entire content of this message is a\n    restatement of the message you just sent — its text, or its seq, or \"done, sent it\" — do not\n    send it.**";
const SKILL_ROUTING = "**result → `send` once** · **progress → `status`** (see rule 3) ·";
const SKILL_RECEIPT_BOUND = "`receipt` reports *reception\n    only*: the server accepts `not_in_turn` / `queued` / `seen` and refuses a receipt on your own\n    message, so it can never mean \"done\" — a finished result is always a `send`.";

describe("#886 回声汇报的引导层", () => {
  test("SKILL.md 礼仪第 10 条：判据 + 三路分流 + receipt 边界，canonical 与 plugin 镜像逐字一致", () => {
    const canonical = read("skills/agentparty/SKILL.md");
    const mirror = read("plugins/agentparty/skills/agentparty/SKILL.md");
    for (const skill of [canonical, mirror]) {
      expect(skill).toContain(SKILL_RULE_HEAD);
      expect(skill).toContain(SKILL_TEST);
      expect(skill).toContain(SKILL_ROUTING);
      expect(skill).toContain(SKILL_RECEIPT_BOUND);
      // 第 10 条必须留在礼仪清单里（紧跟第 9 条），不能被挪进无人读的角落
      expect(skill).toMatch(/9\. \*\*Host is a soft lease[\s\S]{0,600}?10\. \*\*Never echo back what you just sent\.\*\*/);
    }
  });

  test("send / receipt 的 help 各自给出判据与边界", () => {
    const send = read("cli/src/commands/send.ts");
    expect(send).toContain(
      'Send the result once, then stop. If the entire content of a message would be a\nrestatement of the one you just sent — its text, its seq, or "done, sent it" — do\nnot send it: this command already returned that seq to you, and the echo still @s\nand wakes every reader for zero new information.',
    );
    expect(send).toContain('Result -> send. Progress ->\nparty status. "Received it, but I can\'t act this turn" -> party receipt <seq>');

    const receipt = read("cli/src/commands/receipt.ts");
    expect(receipt).toContain(
      'It reports reception only; it never means "done". A finished result is a\nparty send, sent once — and never followed by a second message restating it.',
    );
  });

  test("行为契约（每轮进上下文的单行版 + 落盘多行版）都带上这条", () => {
    expect(BEHAVIOR_CONTRACT_SUMMARY).toContain("结果发一次，别再发一条复述它的消息。");
    const body = BEHAVIOR_CONTRACT_BODY_LINES.join("\n");
    expect(body).toContain(
      "- 结果发一次就够：若一条消息的全部内容是复述你刚发出的上一条（正文、seq 或「已发送」），就别发——它零信息增量，却照样 @、照样唤醒每个读者一次。",
    );
    expect(body).toContain(
      "- 进展用 party status；「收到但这轮处理不了」用 party receipt <seq>（只表示收到，永远不代表做完）。",
    );
    // 单行版每轮都进模型上下文：可以加这一句，但不能借机把它撑成一段
    expect(BEHAVIOR_CONTRACT_SUMMARY).not.toContain("\n");
    expect(BEHAVIOR_CONTRACT_SUMMARY.length).toBeLessThan(120);
  });

  test("接入包礼仪段中英双语都写出判据（i18n 注释文案不能独自满足断言）", () => {
    const strings = read("web/src/i18n/strings/AgentJoin.ts");
    expect(strings).toContain(
      '"AgentJoin.cmd.noEcho": "# Never echo back what you just sent: if the whole content of a message is a restatement of the one you just sent (its text, its seq, or \\"done, sent it\\"), do not send it',
    );
    expect(strings).toContain(
      '"AgentJoin.cmd.noEcho": "# 绝不复述刚发出的消息：如果这条消息的全部内容就是复述你上一条（正文、seq、或「已发送」），就别发',
    );
    // joinPack 必须真的把它拼进包里——只在 i18n 里躺着等于没有
    expect(read("web/src/lib/joinPack.ts")).toContain('t("AgentJoin.cmd.noEcho"),');
  });
});
