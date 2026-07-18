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

describe("issue #435 agent work board layout", () => {
  test("lays out the four status lanes as a horizontally scrollable grid", () => {
    const body = ruleBody(".agent-board-panel");
    expect(body).toContain("display: grid");
    expect(body).toContain("grid-template-columns: repeat(4, minmax(220px, 1fr))");
    expect(body).toContain("overflow-x: auto");
  });

  test("keeps task title and state readable inside each agent card", () => {
    const task = ruleBody(".agent-board-task");
    const title = ruleBody(".agent-board-task-title");
    expect(task).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    expect(title).toContain("text-overflow: ellipsis");
  });
});

describe("issue #504 team blog board layout", () => {
  test("uses compact two-column lanes with idle and offline spanning the panel", () => {
    const board = ruleBody(".team-blog .agent-board-panel");
    expect(board).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(board).toContain("overflow: visible");
    const idle = ruleBody(".team-blog .agent-board-lane--idle,\n.team-blog .agent-board-lane--offline");
    expect(idle).toContain("grid-column: 1 / -1");
    const online = ruleBody(".agent-board-live-dot.is-online");
    expect(online).toContain("background: var(--t-green)");
  });

  test("compresses only lanes explicitly marked empty and leaves offline disclosure styling intact", () => {
    const empty = ruleBody('.team-blog .agent-board-lane[data-empty="true"]');
    expect(empty).toContain("border: 0");
    expect(empty).toContain("background: transparent");
    expect(css).toContain('.team-blog .agent-board-lane:not(.agent-board-lane--offline):not([data-empty="true"]) .agent-board-lane-head');
    expect(css).not.toContain('.agent-board-lane--offline[data-empty="true"]');
  });
});

describe("issue #636 undefined CSS variables", () => {
  test("the agent board 'busy' accent tracks the themed amber token instead of a fixed blue", () => {
    expect(ruleBody(".agent-board-row--busy")).toContain("border-left-color: var(--p-busy)");
    expect(ruleBody(".agent-board-status--busy")).toContain("color: var(--p-busy)");
    // 死透的离主题蓝彻底消失
    expect(css).not.toContain("#4a9eff");
  });

  test("the agent board lanes/rows/notes no longer lean on undefined --border/--muted fallbacks", () => {
    const section = css.slice(css.indexOf(".agent-board-empty"), css.indexOf("/* #273 全局设置面板 */"));
    expect(section).not.toContain("var(--border, #2a2a2a)");
    expect(section).not.toContain("var(--muted, #888)");
    expect(section).not.toContain("var(--muted, #999)");
    expect(section).not.toContain("var(--danger, #e5534b)");
    expect(section).toContain("var(--t-faint)");
    expect(section).toContain("var(--t-muted)");
  });

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
