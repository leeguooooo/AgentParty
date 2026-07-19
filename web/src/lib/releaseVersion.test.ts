import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { RELEASE_CLI_VERSION } from "./releaseVersion";

// 版本闸的真源是 cli/package.json（release-version.ts 每次发布同步）。产物经 Vite define 注入，
// bun 单测经 test/inject-cli-version.ts 预载注入——两条路径都必须解析到发布版，否则接入脚本的
// need= 与 tooltip 会悄悄漂移。这条断言把「releaseVersion 退回兜底字面量 / 注入没接上」变成当场失败。
test("RELEASE_CLI_VERSION 对齐 cli/package.json 的发布版（杜绝第二个会漂移的版本真源）", () => {
  const cliVersion = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../cli/package.json", import.meta.url)), "utf8")) as { version: string }).version;
  expect(RELEASE_CLI_VERSION).toBe(cliVersion);
});
