// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { createTask } from "./api";

const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");

afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", original);
});

function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ type: "task", id: 7, title: "t" }), { status: 200 });
    },
  });
  return calls;
}

describe("createTask REST wiring (the endpoint the panel's New task entry reuses)", () => {
  test("issues a single POST to the channel tasks endpoint with a JSON title body", async () => {
    const calls = captureFetch();

    await createTask("tok", "demo/room", { title: "ship the panel" });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toContain("/api/channels/demo%2Froom/tasks");
    expect(call!.init?.method).toBe("POST");
    expect(new Headers(call!.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(String(call!.init?.body))).toEqual({ title: "ship the panel" });
  });

  test("forwards an optional description when provided", async () => {
    const calls = captureFetch();

    await createTask("tok", "demo", { title: "t", desc: "why it matters" });

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ title: "t", desc: "why it matters" });
  });
});
