import { afterEach, describe, expect, test } from "bun:test";
import { createSquad, updateSquad } from "./api";

const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
afterEach(() => {
  if (originalFetch === undefined) Reflect.deleteProperty(globalThis, "fetch");
  else Object.defineProperty(globalThis, "fetch", originalFetch);
});
function mockFetch(body: unknown, status = 200) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}
const squad = { type: "squad", channel: "c", name: "fe", title: null, description: null, leader: null, members: ["a"], created_by: "leo", created_by_kind: "human", created_at: 1, updated_at: 1 };

describe("squad 写接口的响应形状（线上 v0.2.250 崩溃回归）", () => {
  test("worker 直接返回裸记录（真实形状）", async () => {
    mockFetch(squad, 201);
    expect((await createSquad("t", "c", "fe", { members: ["a"] })).name).toBe("fe");
    mockFetch(squad);
    expect((await updateSquad("t", "c", "fe", { members: ["a"] })).members).toEqual(["a"]);
  });
  test("{ squad } 包装也认", async () => {
    mockFetch({ squad });
    expect((await createSquad("t", "c", "fe", { members: ["a"] })).name).toBe("fe");
  });
  test("认不出的响应抛错，绝不返回 undefined", async () => {
    mockFetch({ ok: true });
    await expect(createSquad("t", "c", "fe", { members: ["a"] })).rejects.toThrow("unexpected body");
  });
});
