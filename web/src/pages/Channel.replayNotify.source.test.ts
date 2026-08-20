// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
// @ts-expect-error Bun provides node:fs for this source-level contract test.
import { readFileSync } from "node:fs";

// #861 的根因是 Channel.tsx 里几处**源码形状**上的定时炸弹：游标被同步清 0、初始页失败退回
// since=0、提醒判据不看重放标记、弹窗不打时间。这些跨 effect 的时序在单测里无法完整搭起来，
// 所以用源码契约把它们钉死——任何一条被改回去，这里立刻变红。
const source: string = readFileSync(new URL("./Channel.tsx", import.meta.url), "utf8");

// loadInitialPage 的函数体（到 `}, [slug, token]);` 为止）
function loadInitialPageBody(): string {
  const start = source.indexOf("const loadInitialPage = useCallback(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("}, [slug, token]);", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("#861 游标不回退", () => {
  test("loadInitialPage 绝不把 ws 游标同步清 0（token 静默续期会让 ws effect 拿 0 建 socket）", () => {
    expect(loadInitialPageBody()).not.toMatch(/initialCursorRef\.current\s*=\s*0\s*;/);
  });

  test("初始页成功时游标单调前进，不被页尾拽回", () => {
    // 接受任一等价写法：Math.max、显式 > 守卫，或任何以自身为下界的赋值。
    const body = loadInitialPageBody();
    expect(body).toMatch(
      /initialCursorRef\.current = Math\.max\(initialCursorRef\.current,|> initialCursorRef\.current\)?\s*\{?\s*\n?\s*initialCursorRef\.current =/,
    );
  });

  test("每条消息帧都推进游标，重建 socket 才能带着已见水位重连", () => {
    // 等价写法同样放行：> 守卫赋值 或 Math.max。
    expect(source).toMatch(
      /frame\.seq > initialCursorRef\.current[\s\S]{0,80}initialCursorRef\.current = frame\.seq|initialCursorRef\.current = Math\.max\(initialCursorRef\.current, frame\.seq\)/,
    );
  });

  test("ws hello 起始游标仍取自这个 ref", () => {
    expect(source).toContain("initialCursor: initialCursorRef.current");
  });
});

describe("#861 初始页失败期间不弹历史", () => {
  test("失败分支显式标记本次降级不可信，成功分支复位", () => {
    const body = loadInitialPageBody();
    expect(body).toContain("replayUntrustedRef.current = true;");
    expect(body).toContain("replayUntrustedRef.current = false;");
  });

  test("系统通知 / 桌面角标 / 页内 toast 三个出口都被这面闸挡住", () => {
    const guards = source.match(/!replayUntrustedRef\.current/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    // 三个出口各自的判据表达式里都必须出现这面闸（不约束它排在第几个合取项）。
    // 通知：notifiedSeqRef 去重那一段
    expect(source).toMatch(/notifiedSeqRef\.current\.has\(frame\.seq\)[\s\S]{0,200}?!replayUntrustedRef\.current/);
    // 角标：nextMentionBadgeCount 调用之前
    expect(source).toMatch(/!replayUntrustedRef\.current[\s\S]{0,200}?nextMentionBadgeCount\(/);
    // toast：toastedSeqRef 去重那一段
    expect(source).toMatch(/toastedSeqRef\.current\.has\(frame\.seq\)[\s\S]{0,200}?!replayUntrustedRef\.current/);
  });
});

describe("#861 提醒带上消息自身时间", () => {
  test("系统通知正文打出 frame.ts", () => {
    expect(source).toMatch(/fmtTime\(frame\.ts[,)]/);
  });

  test("页内 toast 携带 ts 供渲染", () => {
    expect(source).toMatch(/ts: frame\.ts[,\s]/);
  });
});
