// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found in app.css: ${selector}`);
  const end = css.indexOf("}", start);
  if (end === -1) throw new Error(`unterminated rule for selector: ${selector}`);
  return css.slice(start, end);
}

describe("theme token CSS (composer / presence chips)", () => {
  test("composer attachment/upload borders and presence chips resolve to defined theme tokens", () => {
    // 未定义变量无兜底时整条 border/background 会失效（computed-value-time invalid → none/transparent）。
    // 全站不得再出现裸 var(--border) / var(--bg) / var(--accent, var(--fg))。
    expect(css).not.toMatch(/var\(--border\)/);
    expect(css).not.toMatch(/var\(--bg\)/);
    expect(css).not.toContain("var(--accent, var(--fg))");
    expect(ruleBody(".composer-attachment")).toContain("border: 1px solid var(--t-faint)");
    expect(ruleBody(".composer-upload-spinner")).toContain("border: 2px solid var(--t-faint)");
    expect(ruleBody(".composer-upload-spinner")).toContain("border-top-color: var(--t-text)");
    expect(ruleBody(".composer--dragging")).toContain("outline: 2px dashed var(--t-accent)");
  });
});
