// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// issue #150：「分工的内容看不完整」——.role-text (每一行分工的职责说明) 之前被
// 强制 white-space:nowrap + text-overflow:ellipsis 单行截断，长职责说明会被截掉，
// 而这段说明才是分工面板真正的内容。react-test-renderer 不跑布局/CSS，测不出视觉
// 截断，所以这里直接读 app.css 源码断言对应规则块，防止回归。

const cssPath = fileURLToPath(new URL("./app.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");

function ruleBody(selector: string): string {
  const needle = `${selector} {`;
  const start = css.indexOf(needle);
  if (start === -1) throw new Error(`selector not found in app.css: ${selector}`);
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`unterminated rule for selector: ${selector}`);
  return css.slice(start, end);
}

describe("DivisionBoard .role-text CSS (#150 truncation)", () => {
  test("does not force single-line ellipsis truncation on the responsibility text", () => {
    const body = ruleBody(".role-text");
    expect(body).not.toContain("white-space: nowrap");
    expect(body).not.toContain("text-overflow: ellipsis");
  });

  test("allows long unbroken responsibility text to wrap instead of overflowing", () => {
    const body = ruleBody(".role-text");
    expect(body).toContain("word-break");
  });
});
