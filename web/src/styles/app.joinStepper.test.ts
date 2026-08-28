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
  const stepperClasses = [
    "agent-join-steps",
    "agent-join-step",
    "agent-join-step-head",
    "agent-join-step-mark",
    "agent-join-step-title",
    "agent-join-step-status",
    "agent-join-step-body",
    "agent-join-step-wait",
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

  test("步骤列表关掉浏览器默认编号——序号由 ①②③④/✓ 自己画，不许出现 1. 2. 3.", () => {
    const block = /\.agent-join-steps\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(block).toContain("list-style: none");
    // 组件确实是用 ol 渲染的（换成 ul 就不需要这条，但也不会漏判）。
    expect(component).toContain('<ol className="agent-join-steps">');
  });

  test("「等上一步完成」这类状态句与标题拉开距离，不糊成一句话", () => {
    const block = /\.agent-join-step-status\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(block).toMatch(/margin-left|padding-left/);
  });
});
