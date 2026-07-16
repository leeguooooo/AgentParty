import { describe, expect, test } from "bun:test";
import { shouldAlignAgentCardEnd } from "./MessageCard";

describe("agent card viewport alignment", () => {
  test("keeps the default left edge when the card fits", () => {
    expect(shouldAlignAgentCardEnd(120, 1024)).toBe(false);
  });

  test("aligns the card to the trigger end when the default edge would overflow", () => {
    expect(shouldAlignAgentCardEnd(700, 1024)).toBe(true);
    expect(shouldAlignAgentCardEnd(380, 390)).toBe(true);
  });
});
