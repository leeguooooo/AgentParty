// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { createChannel, ForbiddenError } from "./api";

// #919 的另一半：渲染层再怎么分叉，前提也是 rest 层真的把服务端的 error.code / error.message
// 带上来。这里直接桩 fetch，钉住 403 响应体被解析进 ForbiddenError，而不是被一句本地兜底吃掉。
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub403(body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch;
}

describe("createChannel 403 plumbing (#919)", () => {
  test("carries the server code and message through", async () => {
    const message = "account channel quota reached (max 20 channels per account)";
    stub403({ error: { code: "quota_exceeded", message } });
    const err = await createChannel("ap_tok", { slug: "ludo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    const forbidden = err as ForbiddenError;
    expect(forbidden.code).toBe("quota_exceeded");
    expect(forbidden.serverMessage).toBe(message);
    // message 也必须是服务端原文，不是本地兜底
    expect(forbidden.message).toBe(message);
  });

  test("keeps the local fallback only when the body carries nothing usable", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 403 })) as typeof fetch;
    const err = (await createChannel("ap_tok", { slug: "ludo" }).catch((e: unknown) => e)) as ForbiddenError;
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.code).toBeNull();
    expect(err.serverMessage).toBeNull();
    expect(err.message).toBe("no permission to create channels");
  });
});
