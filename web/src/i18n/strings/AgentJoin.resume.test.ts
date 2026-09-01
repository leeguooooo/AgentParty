// 第 ③ 步必须说清楚 resume，因为两档的默认行为**相反**：
//   交互档 `party claude <chan>` 起的是新对话；
//   常驻档 `party serve <chan> --runner claude` 每次唤醒都跑 `--resume`（cli/src/commands/serve.ts）。
// 不写清楚，人会拿着「接着上次干」的预期去跑交互档，然后发现上下文没了。
//
// 覆盖范围说明：这里钉的是「两种语言都有这句 + 组件在**正确的分支**引用它」。
// 它不覆盖真实渲染——第 ③ 步在 pending 状态下不渲染正文，要构造出已渲染态需要伪造
// 前两步的服务端证据；那种用例我上一轮试过，做不到在「把这句删掉」时变红，就没留假绿的。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strings = readFileSync(join(import.meta.dir, "AgentJoin.ts"), "utf8");
const component = readFileSync(join(import.meta.dir, "..", "..", "components", "AgentJoin.tsx"), "utf8");

describe("第③步的 resume 说明（中英都要有）", () => {
  test("两种语言各有一条交互档、一条常驻档的说明", () => {
    // 每个 key 恰好两次：en 一次、zh 一次。少一次就是漏了一种语言。
    expect(strings.split('"AgentJoin.step3.resumeClaude"').length - 1).toBe(2);
    expect(strings.split('"AgentJoin.step3.resumeUnattended"').length - 1).toBe(2);
  });

  test("交互档那句必须给出 --resume 的接法，并说明它起的是新对话", () => {
    const zh = strings.slice(strings.lastIndexOf('"AgentJoin.step3.resumeClaude"'));
    const en = strings.slice(strings.indexOf('"AgentJoin.step3.resumeClaude"'));
    for (const text of [zh.slice(0, 400), en.slice(0, 400)]) {
      expect(text).toContain("--resume");
    }
    expect(zh).toContain("新对话");
    expect(en).toContain("fresh conversation");
  });

  test("常驻档那句必须说明它自带 resume、上下文连续", () => {
    const zh = strings.slice(strings.lastIndexOf('"AgentJoin.step3.resumeUnattended"'));
    const en = strings.slice(strings.indexOf('"AgentJoin.step3.resumeUnattended"'));
    expect(zh.slice(0, 300)).toContain("自带 resume");
    expect(en.slice(0, 300)).toContain("resumes on its own");
  });

  test("组件把两句挂在正确的分支上（交互档 claude / 常驻档），别挂反", () => {
    // 注意锚点：step1 也有一处 `{unattended ? (`，必须从第 ③ 步那段切起，
    // 否则断言会落在别的分支上（第一版就切错了，测试报的正是 step1 的片段）。
    const step3 = component.slice(component.indexOf('AgentJoin.step3.hintUnattended') - 200);
    const unattendedBranch = step3.slice(0, step3.indexOf(") : ("));
    expect(unattendedBranch).toContain("AgentJoin.step3.resumeUnattended");
    expect(unattendedBranch).not.toContain("AgentJoin.step3.resumeClaude");

    // 交互分支：只给 claude（codex / other 的唤醒层不是 party claude，不该显示这句）
    const interactiveBranch = step3.slice(step3.indexOf(") : ("));
    expect(interactiveBranch).toContain('session.harness === "claude" && (');
    expect(interactiveBranch).toContain("AgentJoin.step3.resumeClaude");
  });
});
