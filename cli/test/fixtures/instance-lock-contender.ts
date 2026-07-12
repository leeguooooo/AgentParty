import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { InstanceKind } from "../../src/instance-lock";

const [kind, channel, lockDir, startFile, readyDir, contenderId, contenderCountText] = process.argv.slice(2) as [
  InstanceKind,
  string,
  string,
  string,
  string,
  string,
  string,
];
const contenderCount = Number(contenderCountText);
const target = join(lockDir, `${kind}-${channel}.lock`);
const realReadFileSync = fs.readFileSync;
const realWriteFileSync = fs.writeFileSync;
const realReaddirSync = fs.readdirSync;

mock.module("node:fs", () => ({
  ...fs,
  readFileSync(path: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1]) {
    const body = realReadFileSync(path, options as never);
    if (String(path) === target && String(body).includes('"pid":999999')) {
      realWriteFileSync(join(readyDir, contenderId), "ready");
      while (realReaddirSync(readyDir).length < contenderCount) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    return body;
  },
}));

const { acquireInstanceLock } = await import("../../src/instance-lock");

while (!fs.existsSync(startFile)) await Bun.sleep(5);

const lock = acquireInstanceLock(kind, channel, lockDir);
console.log(JSON.stringify({ ok: lock.ok, heldByPid: lock.heldByPid, pid: process.pid, at: Date.now() }));
if (lock.ok) {
  await Bun.sleep(500);
  lock.release?.();
}
