// #147：状态时间线整句重复 —— worker 把同一句话既写进 note 又写进 blocked_reason，
// 拼接后成「… · blocked …」的重复。blockedReasonDuplicatesNote 决定该不该单列 blocked。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { blockedReasonDuplicatesNote } from "./MessageCard";

describe("状态行去重 (#147)", () => {
  test("note 与 blocked_reason 同文 → 判为重复（不单列 blocked）", () => {
    expect(blockedReasonDuplicatesNote("污染「受阻」语义", "污染「受阻」语义")).toBe(true);
  });

  test("首尾空白不影响判定（trim 后相同也算重复）", () => {
    expect(blockedReasonDuplicatesNote("  同一句  ", "同一句")).toBe(true);
  });

  test("原因与 note 不同 → 不判重复（两者都有信息，都保留）", () => {
    expect(blockedReasonDuplicatesNote("在做 A", "等 human 解 guard")).toBe(false);
  });

  test("note 为空 → 不判重复（否则空 note + 有 blocked 会误删 blocked）", () => {
    expect(blockedReasonDuplicatesNote("", "loop guard tripped")).toBe(false);
    expect(blockedReasonDuplicatesNote(null, "loop guard tripped")).toBe(false);
    expect(blockedReasonDuplicatesNote(undefined, "loop guard tripped")).toBe(false);
  });

  test("blocked_reason 为空 → 不判重复", () => {
    expect(blockedReasonDuplicatesNote("在做 A", null)).toBe(false);
    expect(blockedReasonDuplicatesNote("在做 A", "")).toBe(false);
  });
});
