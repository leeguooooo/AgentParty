// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// issue #301：「主面板不能滚动，只有内容区域才能滚动」——外壳（#root / .app-main /
// 登录 gate）必须锁死在视口高度、绝不整体滚动，滚动只发生在指定的内容区
// （.stream 消息流 / .home 落地页网格 / gate 自身）。react-test-renderer 不跑布局/CSS，
// 测不出滚动行为，所以这里直接读 app.css 源码断言约束链，防止回归。
//
// 机理（已用真实浏览器量过）：#root 固定 100dvh，链上每层 min-height:0 让 flex 子项
// 可收缩，末端内容区用 overflow auto 自己滚；#root / .app-main 再补 overflow:hidden
// 作兜底，任何未来内容都不会把整块主面板拖着 body 一起滚。

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

describe("app shell scroll containment (#301)", () => {
  test("#root is locked to the viewport height and clips — the shell never scrolls as a whole", () => {
    const body = ruleBody("#root");
    expect(body).toContain("100dvh");
    expect(body).toContain("overflow: hidden");
  });

  test(".app-main (the main panel) does not scroll itself — it clips, content scrolls inside", () => {
    const body = ruleBody(".app-main");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow: hidden");
  });

  test(".chan constrains its own height and clips so only .stream scrolls", () => {
    const body = ruleBody(".chan");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow: hidden");
  });

  test(".stream (the message content region) is the scroll region", () => {
    const body = ruleBody(".stream");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow-y: auto");
  });

  test(".home (landing content region) scrolls internally, not the shell", () => {
    const body = ruleBody(".home");
    expect(body).toContain("overflow-y: auto");
  });

  test(".gate (login/error panel, a #root-direct surface) scrolls its own content on short viewports", () => {
    const body = ruleBody(".gate");
    // min-height:0 lets the centered flex content shrink so overflow-y:auto can engage
    // instead of spilling out and scrolling the (now clipped) shell / body.
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow-y: auto");
  });
});
