// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { fmtTime } from "./time";

describe("fmtTime", () => {
  test("omits the date for timestamps on the current local day", () => {
    const now = new Date(2026, 6, 16, 18, 30, 0).getTime();
    const ts = new Date(2026, 6, 16, 9, 8, 7).getTime();
    expect(fmtTime(ts, now)).toBe("09:08:07");
  });

  test("adds yyyy-MM-dd for timestamps outside the current local day", () => {
    const now = new Date(2026, 6, 16, 0, 30, 0).getTime();
    const ts = new Date(2026, 6, 15, 23, 59, 58).getTime();
    expect(fmtTime(ts, now)).toBe("2026-07-15 23:59:58");
  });
});
