// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { loadDesktopReleaseInfo, parseDesktopReleaseInfo } from "./desktopRelease";

describe("desktop release identity", () => {
  test("accepts only notarized production and non-notarized preview/development identities", () => {
    expect(parseDesktopReleaseInfo({ distribution: "production", notarized: true })).toEqual({
      distribution: "production",
      notarized: true,
    });
    expect(parseDesktopReleaseInfo({ distribution: "preview", notarized: false })).toEqual({
      distribution: "preview",
      notarized: false,
    });
    expect(parseDesktopReleaseInfo({ distribution: "production", notarized: false })).toEqual({
      distribution: "development",
      notarized: false,
    });
    expect(parseDesktopReleaseInfo({ distribution: "preview", notarized: true })).toEqual({
      distribution: "development",
      notarized: false,
    });
  });

  test("fails closed when the native command is unavailable", async () => {
    expect(await loadDesktopReleaseInfo(async () => { throw new Error("missing"); })).toEqual({
      distribution: "development",
      notarized: false,
    });
  });
});
