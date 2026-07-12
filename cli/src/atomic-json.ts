import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
