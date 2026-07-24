// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { ConflictError, setChannelCharter } from "./api";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", originalFetch);
});

describe("setChannelCharter optimistic concurrency", () => {
  test("sends the edit base revision to the worker", async () => {
    let request: RequestInit | undefined;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (_input: string, init?: RequestInit) => {
        request = init;
        return Response.json({
          charter: "updated",
          charter_rev: 8,
          updated_at: 1,
          updated_by: "owner",
          active_decisions: [],
        });
      },
    });

    await setChannelCharter("tok", "demo", "updated", 7);

    expect(JSON.parse(String(request?.body))).toEqual({
      charter: "updated",
      expected_rev: 7,
    });
  });

  test("maps a stale revision response to ConflictError", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async () => Response.json(
        { error: { code: "conflict", message: "charter revision changed" } },
        { status: 409 },
      ),
    });

    await expect(setChannelCharter("tok", "demo", "stale", 3))
      .rejects.toBeInstanceOf(ConflictError);
  });
});
