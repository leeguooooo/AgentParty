import { describe, expect, test } from "vitest";
import { lockedPoolRuntimeVersion } from "../scripts/verify-test-runtime-lib.mjs";

describe("Worker test-runtime preflight", () => {
  test.each([
    ["4.20260729.0", "20260729"],
    ["5.20260730.0-alpha", "20260730"],
  ])("recognizes Miniflare %s from the Cloudflare pool lock entry", (version, runtimeDate) => {
    const lock = `
      "@cloudflare/vitest-pool-workers": ["@cloudflare/vitest-pool-workers@0.20.1", "", {
        "dependencies": { "miniflare": "${version}" }
      }]
    `;
    expect(lockedPoolRuntimeVersion(lock)).toEqual({
      version: `miniflare@${version}`,
      runtimeDate,
    });
  });

  test("does not borrow an unrelated Miniflare entry", () => {
    expect(lockedPoolRuntimeVersion('"miniflare": "5.20260730.0-alpha"')).toBeNull();
  });
});
