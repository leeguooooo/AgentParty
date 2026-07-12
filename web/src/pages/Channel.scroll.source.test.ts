// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(import.meta.dir + "/Channel.tsx", "utf8");

test("channel stream re-pins after initial paint and late desktop layout changes", () => {
  expect(source).toContain("useLayoutEffect(() => {");
  expect(source).toContain("window.requestAnimationFrame");
  expect(source).toContain("new ResizeObserver(repin)");
  expect(source).toContain('el.addEventListener("load", repin, true)');
  expect(source).toContain("pinToBottom(el, stickBottom.current)");
  expect(source).toContain("}, [sendSeen, slug]);");
});
