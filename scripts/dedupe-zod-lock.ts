// zod 在 bun.lock 里必须只有一份。dependabot 的 bun 更新只抬根上的 zod，
// 依赖 zod 的包（@modelcontextprotocol/sdk、chanfana、vitest-pool-workers）会留着
// 嵌套的 "<pkg>/zod" 旧版本。两份 zod 的类型互不兼容，cli 的 tsc 会报一片
// `ZodString is not assignable to AnySchema`（#1101、#1112）。
//
// 用法：bun scripts/dedupe-zod-lock.ts [bun.lock]
//   删掉嵌套的 "<pkg>/zod" 条目后写回；之后必须删掉 node_modules 再 bun install，
//   否则旧的嵌套副本留在 node_modules 里，tsc 照样报错。
import { readFileSync, writeFileSync } from "node:fs";

// 匹配 bun.lock packages 段里的 zod 条目："zod": [...] 或 "a/b/zod": [...]
const ZOD_ENTRY = /^\s*"((?:[^"]+\/)?zod)": \["zod@([^"]+)"/gm;

export function zodEntries(lock: string): { key: string; version: string }[] {
  return [...lock.matchAll(ZOD_ENTRY)].map((m) => ({ key: m[1], version: m[2] }));
}

export function stripNestedZod(lock: string): string {
  return lock.replace(/^\s*"[^"]+\/zod": \["zod@[^\n]*\n/gm, "");
}

if (import.meta.main) {
  const path = process.argv[2] ?? "bun.lock";
  const before = readFileSync(path, "utf8");
  const after = stripNestedZod(before);
  if (after !== before) writeFileSync(path, after);
  console.log(`removed ${zodEntries(before).length - zodEntries(after).length} nested zod entries`);
}
