// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { fetchPendingDecisions } from "./api";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", originalFetch);
});

function mockPendingDecisionPages(
  totalPages: number,
  finalPageHasNext: boolean,
): { calls: () => number } {
  let calls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => {
      calls += 1;
      const hasNext = calls < totalPages || finalPageHasNext;
      return Response.json({
        decisions: [{
          seq: totalPages - calls + 1,
          prompt: `decision ${calls}`,
          asker: "agent",
          waiting_on_me: calls % 2 === 0,
        }],
        next_after: hasNext ? calls : null,
      });
    },
  });
  return { calls: () => calls };
}

describe("fetchPendingDecisions page limit", () => {
  test("accepts exactly 200 pages when the final page terminates", async () => {
    const mock = mockPendingDecisionPages(200, false);

    const decisions = await fetchPendingDecisions("tok", "demo");

    expect(mock.calls()).toBe(200);
    expect(decisions).toHaveLength(200);
    expect(decisions[0]?.seq).toBe(1);
    expect(decisions.at(-1)?.seq).toBe(200);
  });

  test("stops before a 201st request when page 200 advertises more data", async () => {
    const mock = mockPendingDecisionPages(200, true);

    await expect(fetchPendingDecisions("tok", "demo"))
      .rejects.toThrow("pending decisions exceeded max page count");
    expect(mock.calls()).toBe(200);
  });
});
