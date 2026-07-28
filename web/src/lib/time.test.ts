// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { fmtTime } from "./time";

describe("fmtTime", () => {
  test("includes month and day for timestamps on the current local day", () => {
    const now = new Date(2026, 6, 16, 18, 30, 0).getTime();
    const ts = new Date(2026, 6, 16, 9, 8, 7).getTime();
    expect(fmtTime(ts, now)).toBe("07-16 09:08:07");
  });

  test("keeps the same-year date compact", () => {
    const now = new Date(2026, 6, 16, 0, 30, 0).getTime();
    const ts = new Date(2026, 6, 15, 23, 59, 58).getTime();
    expect(fmtTime(ts, now)).toBe("07-15 23:59:58");
  });

  test("adds the year when the timestamp is from another year", () => {
    const now = new Date(2026, 0, 1, 0, 30, 0).getTime();
    const ts = new Date(2025, 11, 31, 23, 59, 58).getTime();
    expect(fmtTime(ts, now)).toBe("2025-12-31 23:59:58");
  });
});
