// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");
const component = readFileSync(
  fileURLToPath(new URL("../components/AgentJoin.tsx", import.meta.url)),
  "utf8",
);

/**
 * #1005 的分步引导第一次上线时 DOM 发了、CSS 一条没写：浏览器给 `<ol>` 画上 1./2./3./4.，
 * 和我们自己的 ①②③④ 双重编号，「等上一步完成」也糊在标题右边（owner 截图）。
 * 这一组钉的是「组件用到的每个 stepper 类名，样式表里都有对应规则」——漏一个就红。
 */
describe("接入引导的样式必须存在（#1005）", () => {
  // #1040：四步卡片改成「命令区 + 三盏灯」后，类名跟着换；step-head/mark/title/status/body 沿用。
  const stepperClasses = [
    "agent-join-lights",
    "agent-join-light",
    "agent-join-plan",
    "agent-join-plan-options",
    "agent-join-plan-option",
    "agent-join-plan-option--on",
    "agent-join-plan-option-title",
    "agent-join-plan-option-desc",
    "agent-join-plan-install",
    "agent-join-step-head",
    "agent-join-step-mark",
    "agent-join-step-title",
    "agent-join-step-status",
    "agent-join-step-body",
    "agent-join-probe-btn",
    "agent-join-complete",
    "agent-join-regen",
    "agent-join-resume",
    "agent-join-card--stepper",
  ];

  test("每个 stepper 类名都有 CSS 规则", () => {
    const missing = stepperClasses.filter((cls) => !new RegExp(`\\.${cls.replace(/--/g, "--")}[\\s,{:>]`).test(css));
    expect(missing).toEqual([]);
  });

  test("灯列表关掉浏览器默认编号——记号由 ✓/●/○ 自己画，不许出现 1. 2. 3.", () => {
    const block = /\.agent-join-lights\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(block).toContain("list-style: none");
    // 组件确实是用 ol 渲染的（换成 ul 就不需要这条，但也不会漏判）。
    expect(component).toContain('<ol className="agent-join-lights">');
  });

  test("「等上一步完成」这类状态句与标题拉开距离，不糊成一句话", () => {
    const block = /\.agent-join-step-status\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(block).toMatch(/margin-left|padding-left/);
  });
});
