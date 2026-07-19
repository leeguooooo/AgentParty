// bun 单测预载：注入 __PARTY_CLI_VERSION__（Vite 在构建/开发时用 define 注入的同一个符号）。
// 真源是 cli/package.json（release-version.ts 每次发布同步）。有了它，releaseVersion.ts 在测试里
// 也解析到真实发布版，兜底字面量成为纯防御死码，版本闸不再有「第二个会漂移的真源」（见 PR #658 复审）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const version = (JSON.parse(readFileSync(fileURLToPath(new URL("../../cli/package.json", import.meta.url)), "utf8")) as { version: string }).version;
(globalThis as { __PARTY_CLI_VERSION__?: string }).__PARTY_CLI_VERSION__ = version;
