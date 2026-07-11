// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { AuthError, fetchMessagesWithRetry } from "./api";

const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", original);
});

function mockResponses(responses: Response[]): { calls: () => number } {
  let count = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => responses[count++] ?? responses.at(-1),
  });
  return { calls: () => count };
}

describe("fetchMessagesWithRetry", () => {
  test("recovers from one transient initial-history failure", async () => {
    const mock = mockResponses([
      new Response("temporary", { status: 503 }),
      Response.json({ messages: [{ type: "msg", seq: 7, body: "recovered" }] }),
    ]);

    const messages = await fetchMessagesWithRetry("tok", "demo", { limit: 50 }, {
      attempts: 2,
      delayMs: 0,
    });

    expect(mock.calls()).toBe(2);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.seq).toBe(7);
  });

  test("does not retry authentication failures", async () => {
    const mock = mockResponses([new Response("unauthorized", { status: 401 })]);

    await expect(fetchMessagesWithRetry("tok", "demo", {}, { attempts: 2, delayMs: 0 }))
      .rejects.toBeInstanceOf(AuthError);
    expect(mock.calls()).toBe(1);
  });

  test("stops after the bounded attempt count", async () => {
    const mock = mockResponses([new Response("temporary", { status: 503 })]);

    await expect(fetchMessagesWithRetry("tok", "demo", {}, { attempts: 2, delayMs: 0 }))
      .rejects.toThrow("failed (503)");
    expect(mock.calls()).toBe(2);
  });
});
