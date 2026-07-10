// @ts-nocheck — Bun 执行本测试；web tsconfig 有意只加载 Vite 全局类型，且 exclude 掉 *.test.ts，
// 这里用 node:fs 读源码做「回归门禁」，不需要也不应进入 tsc 类型检查。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 曾在 App.tsx 里硬编码的英文字面量：接进字符串表（#132）后，源码里不该再出现它们。
// 这是 issue 明确要求的「lint 挡回归」——谁再往 App.tsx 里塞这些英文，这条就红。
const FORBIDDEN_LITERALS = [
  '"sign-in is not configured"',
  '"sign-in failed"',
  '"session expired — please sign in again"',
  '"invalid or revoked token — paste a new one"',
  '"channels failed to load"',
  '"could not start sign-in"',
  "signing you in...",
  "page not found",
  "loading channel...",
  "channel not found or not available to this token",
  "agents talk, humans watch",
  "docs ↗",
];

describe("App i18n source guard (#132)", () => {
  test("App.tsx no longer hardcodes these English literals", () => {
    const src = readFileSync(resolve(import.meta.dir, "../../App.tsx"), "utf8");
    for (const literal of FORBIDDEN_LITERALS) {
      expect(src.includes(literal), `App.tsx still hardcodes: ${literal}`).toBe(false);
    }
  });
});
