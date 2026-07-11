// party pause 的时刻解析（issue #180）：--for 相对时长、--resume-at 绝对 ISO、过去时间/互斥拒绝。
import { describe, expect, test } from "bun:test";
import { parseDurationMs, resolveResumeAt } from "../src/commands/pause";

const NOW = 1_800_000_000_000;

describe("parseDurationMs", () => {
  test("秒/分/时/天", () => {
    expect(parseDurationMs("90s")).toBe(90_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("1d")).toBe(86_400_000);
  });
  test("允许单位前空格、大小写", () => {
    expect(parseDurationMs("2 H")).toBe(7_200_000);
  });
  test("非法格式 → null", () => {
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs("2w")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("-2h")).toBeNull();
  });
});

describe("resolveResumeAt", () => {
  test("都不给 → 0（开放式暂停，手动恢复）", () => {
    expect(resolveResumeAt(undefined, undefined, NOW)).toBe(0);
  });
  test("--for 2h → now + 2h", () => {
    expect(resolveResumeAt(undefined, "2h", NOW)).toBe(NOW + 7_200_000);
  });
  test("--resume-at 未来 ISO → 该时刻的 epoch ms", () => {
    const iso = new Date(NOW + 3_600_000).toISOString();
    expect(resolveResumeAt(iso, undefined, NOW)).toBe(NOW + 3_600_000);
  });
  test("--resume-at 过去 → null（拒绝）", () => {
    const iso = new Date(NOW - 3_600_000).toISOString();
    expect(resolveResumeAt(iso, undefined, NOW)).toBeNull();
  });
  test("--resume-at 非法字符串 → null", () => {
    expect(resolveResumeAt("not-a-time", undefined, NOW)).toBeNull();
  });
  test("--for 与 --resume-at 互斥 → null", () => {
    const iso = new Date(NOW + 3_600_000).toISOString();
    expect(resolveResumeAt(iso, "2h", NOW)).toBeNull();
  });
  test("--for 非法时长 → null", () => {
    expect(resolveResumeAt(undefined, "later", NOW)).toBeNull();
  });
});
