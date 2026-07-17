import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 原子写文本（tmp+rename）：settings 这类「用户手写、半截即毁」的文件绝不能直写。 */
export function atomicWriteText(path: string, text: string, mode: number = 0o644): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function atomicWriteJson(path: string, value: unknown, mode: number = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode });
    renameSync(tmp, path);
    chmodSync(path, mode);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
