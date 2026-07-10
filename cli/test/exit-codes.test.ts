// #122：workflow_guard 与 429 曾塌缩成通用 exit 1 —— 恰恰是最需要「停手 / 退避」的两类错误。
// agent 拿到 exit 1 会当成普通失败，换个措辞继续发，绕着熔断打转把额度耗光。
import { describe, expect, test } from "bun:test";
import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  EXIT_RATE_LIMITED,
  EXIT_WORKFLOW_GUARD,
} from "@agentparty/shared";
import { handleRestError, RestError } from "../src/rest";

function silence<T>(fn: () => T): T {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

describe("handleRestError exit-code contract (#122)", () => {
  test("workflow_guard maps to its own terminal code, not 1", () => {
    const code = silence(() => handleRestError(new RestError(409, "workflow_guard", "no progress")));
    expect(code).toBe(EXIT_WORKFLOW_GUARD);
    expect(code).not.toBe(1);
  });

  test("429 maps to a distinct back-off code, not 1", () => {
    const byStatus = silence(() => handleRestError(new RestError(429, null, "too many")));
    const byCode = silence(() => handleRestError(new RestError(429, "rate_limited", "too many")));
    expect(byStatus).toBe(EXIT_RATE_LIMITED);
    expect(byCode).toBe(EXIT_RATE_LIMITED);
    expect(byStatus).not.toBe(1);
  });

  test("workflow_guard prints a stop-don't-retry hint (agents read stderr)", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l?: unknown) => lines.push(String(l));
    try {
      handleRestError(new RestError(409, "workflow_guard", "no progress"));
    } finally {
      console.error = orig;
    }
    expect(lines.some((l) => /do not rephrase and retry/i.test(l))).toBe(true);
  });

  test("429 prints a back-off hint", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l?: unknown) => lines.push(String(l));
    try {
      handleRestError(new RestError(429, "rate_limited", "slow down"));
    } finally {
      console.error = orig;
    }
    expect(lines.some((l) => /back off/i.test(l))).toBe(true);
  });

  test("the existing contract is unchanged", () => {
    expect(silence(() => handleRestError(new RestError(401, "unauthorized", "bad")))).toBe(EXIT_AUTH);
    expect(silence(() => handleRestError(new RestError(409, "loop_guard", "wait")))).toBe(EXIT_LOOP_GUARD);
    expect(silence(() => handleRestError(new RestError(410, "archived", "gone")))).toBe(EXIT_ARCHIVED);
    // 真正的未知错误仍然是 1
    expect(silence(() => handleRestError(new RestError(500, "boom", "server")))).toBe(1);
    expect(silence(() => handleRestError(new Error("network")))).toBe(1);
  });

  test("all exit codes are distinct (nothing shadows anything)", () => {
    const codes = [EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_ARCHIVED, EXIT_WORKFLOW_GUARD, EXIT_RATE_LIMITED];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
