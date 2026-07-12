import { existsSync, writeFileSync } from "node:fs";
import { saveCursor } from "../../src/config";

const [cwd, channel, rawIndex, readyPrefix, goPrefix, donePrefix, rawRounds] = process.argv.slice(2);
if (!cwd || !channel || !rawIndex || !readyPrefix || !goPrefix || !donePrefix || !rawRounds) process.exit(2);

const index = Number(rawIndex);
const rounds = Number(rawRounds);
const waiter = new Int32Array(new SharedArrayBuffer(4));
for (let round = 1; round <= rounds; round++) {
  writeFileSync(`${readyPrefix}-${round}`, "ready\n");
  while (!existsSync(`${goPrefix}-${round}`)) Atomics.wait(waiter, 0, 0, 1);
  saveCursor(channel, round * 1_000 + index, cwd);
  writeFileSync(`${donePrefix}-${round}`, "done\n");
}
