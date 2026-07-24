import { describe, expect, test } from "bun:test";
import {
  beginCharterRead,
  beginCharterWrite,
  canApplyCharterRead,
  canApplyCharterWrite,
  commitCharterWrite,
  createCharterRequestGeneration,
  finishCharterWrite,
  invalidateCharterRequests,
} from "./charterRequestGeneration";

describe("charter request generations", () => {
  test("PUT pending rejects welcome and decision-ledger GET snapshots before and after the write commits", () => {
    const generation = createCharterRequestGeneration();
    const put = beginCharterWrite(generation);
    expect(put).not.toBeNull();

    const welcomeRefresh = beginCharterRead(generation);
    const ledgerRefresh = beginCharterRead(generation);
    expect(canApplyCharterRead(generation, welcomeRefresh)).toBe(false);
    expect(canApplyCharterRead(generation, ledgerRefresh)).toBe(false);

    expect(commitCharterWrite(generation, put!)).toBe(true);
    expect(finishCharterWrite(generation, put!)).toBe(true);
    expect(canApplyCharterRead(generation, welcomeRefresh)).toBe(false);
    expect(canApplyCharterRead(generation, ledgerRefresh)).toBe(false);
  });

  test("starting a PUT invalidates an older GET snapshot", () => {
    const generation = createCharterRequestGeneration();
    const staleRead = beginCharterRead(generation);
    const put = beginCharterWrite(generation);

    expect(put).not.toBeNull();
    expect(canApplyCharterRead(generation, staleRead)).toBe(false);
    expect(commitCharterWrite(generation, put!)).toBe(true);
    expect(finishCharterWrite(generation, put!)).toBe(true);
  });

  test("a failed PUT keeps GET snapshots started while pending obsolete", () => {
    const generation = createCharterRequestGeneration();
    const put = beginCharterWrite(generation);
    expect(put).not.toBeNull();
    const refreshDuringWrite = beginCharterRead(generation);

    expect(canApplyCharterRead(generation, refreshDuringWrite)).toBe(false);
    // Model the rejection path: no commit, only the guarded finally cleanup.
    expect(finishCharterWrite(generation, put!)).toBe(true);
    expect(canApplyCharterRead(generation, refreshDuringWrite)).toBe(false);
  });

  test("same-channel token refresh does not invalidate the pending PUT or its saving cleanup", () => {
    const generation = createCharterRequestGeneration();
    const put = beginCharterWrite(generation);
    expect(put).not.toBeNull();

    // Rotating the token refreshes channel data with a GET, but the channel
    // lifecycle remains the same and must not invalidate the in-flight write.
    const tokenRefresh = beginCharterRead(generation);
    expect(canApplyCharterWrite(generation, put!)).toBe(true);
    expect(canApplyCharterRead(generation, tokenRefresh)).toBe(false);
    expect(commitCharterWrite(generation, put!)).toBe(true);
    expect(finishCharterWrite(generation, put!)).toBe(true);
    expect(canApplyCharterRead(generation, tokenRefresh)).toBe(false);
  });

  test("an obsolete write cannot publish state or clear the latest saving indicator", () => {
    const generation = createCharterRequestGeneration();
    const obsoleteWrite = beginCharterWrite(generation);
    expect(obsoleteWrite).not.toBeNull();

    invalidateCharterRequests(generation);
    const latestWrite = beginCharterWrite(generation);
    expect(latestWrite).not.toBeNull();

    expect(canApplyCharterWrite(generation, obsoleteWrite!)).toBe(false);
    expect(finishCharterWrite(generation, obsoleteWrite!)).toBe(false);
    expect(canApplyCharterWrite(generation, latestWrite!)).toBe(true);
    expect(finishCharterWrite(generation, latestWrite!)).toBe(true);
  });
});
