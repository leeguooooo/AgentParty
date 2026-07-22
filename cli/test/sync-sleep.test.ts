// #738:同步睡眠不能依赖 SharedArrayBuffer——某些运行时/沙箱里它未定义,原来在模块顶层
// new SharedArrayBuffer 会让 import 直接抛,常驻 serve 日志被刷屏。
import { afterEach, describe, expect, test } from "bun:test";
import { sleepSyncMs } from "../src/sync-sleep";

const realSAB = globalThis.SharedArrayBuffer;

afterEach(() => {
  // 还原(某些用例会临时删掉 SharedArrayBuffer)
  Object.defineProperty(globalThis, "SharedArrayBuffer", { configurable: true, value: realSAB });
});

describe("sleepSyncMs (#738)", () => {
  test("SharedArrayBuffer 可用:睡够时长且不抛", () => {
    const start = Date.now();
    sleepSyncMs(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  test("SharedArrayBuffer 未定义:退化忙等,仍睡够时长、绝不抛", () => {
    // @ts-expect-error 故意删掉全局以模拟 SAB 缺席环境
    delete globalThis.SharedArrayBuffer;
    expect(typeof SharedArrayBuffer).toBe("undefined");
    const start = Date.now();
    expect(() => sleepSyncMs(5)).not.toThrow();
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
  });

  test("ms<=0 直接返回,不分配也不忙等", () => {
    expect(() => sleepSyncMs(0)).not.toThrow();
    expect(() => sleepSyncMs(-3)).not.toThrow();
  });
});
