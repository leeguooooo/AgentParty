import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cacheSlotFileName } from "../src/cache-slot";

interface HealthSlotContract {
  channel: string;
  configPath: string;
  token: string;
  expectedFile: string;
}

const contract = JSON.parse(
  readFileSync(join(import.meta.dir, "../../shared/fixtures/health-slot-contract.json"), "utf8"),
) as HealthSlotContract;

describe("desktop health slot contract", () => {
  test("CLI derives the shared explicit-config health filename", () => {
    const tokenFingerprint = createHash("sha256")
      .update(contract.token)
      .digest("hex")
      .slice(0, 12);

    expect(cacheSlotFileName("health", contract.channel, {
      kind: "explicit",
      path: contract.configPath,
      token_fingerprint: `sha256:${tokenFingerprint}`,
    })).toBe(contract.expectedFile);
  });
});
