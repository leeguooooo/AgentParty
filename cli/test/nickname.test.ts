// #165：party nickname <name> —— agent 设全局唯一昵称。这里只覆盖联网前的纯参数校验路径
// （help / 空 / 格式非法），不打网络；set 成功/冲突走 worker 集成测试（nickname.spec.ts）。
import { describe, expect, test } from "bun:test";
import { run } from "../src/commands/nickname";

function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  return fn()
    .then((code) => ({ code, out, err }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    });
}

describe("party nickname 参数校验（#165）", () => {
  test("--help 打印用法并 exit 0", async () => {
    const { code, out } = await capture(() => run(["--help"]));
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("party nickname <name>");
  });

  test("缺名字 → exit 1", async () => {
    const { code, err } = await capture(() => run([]));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("usage: party nickname");
  });

  test("含空格/@ 的非法昵称在联网前就被挡下 → exit 1", async () => {
    const spaced = await capture(() => run(["中 文"]));
    expect(spaced.code).toBe(1);
    expect(spaced.err.join("\n")).toContain("invalid nickname");
    const atSign = await capture(() => run(["foo@bar"]));
    expect(atSign.code).toBe(1);
    expect(atSign.err.join("\n")).toContain("invalid nickname");
  });

  test("超长（>64）昵称被挡下 → exit 1", async () => {
    const { code, err } = await capture(() => run(["字".repeat(65)]));
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("invalid nickname");
  });
});
