import { describe, expect, test } from "bun:test";
import { historyFallbackRecovered } from "./historyRecovery";

describe("history REST fallback recovery", () => {
  test("clears the stale history error once the websocket is open", () => {
    expect(historyFallbackRecovered("open")).toBe(true);
  });

  test("keeps the error while the websocket is not usable", () => {
    expect(historyFallbackRecovered("connecting")).toBe(false);
    expect(historyFallbackRecovered("reconnecting")).toBe(false);
    expect(historyFallbackRecovered("closed")).toBe(false);
  });
});
