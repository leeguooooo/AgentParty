// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { expect, test } from "bun:test";
import { matchPair } from "./router";

test("matches only the independent pair page route", () => {
  expect(matchPair("/pair")).toBe(true);
  expect(matchPair("/pair/")).toBe(true);
  expect(matchPair("/pair/AB12C-DE34F")).toBe(false);
  expect(matchPair("/repair")).toBe(false);
});
