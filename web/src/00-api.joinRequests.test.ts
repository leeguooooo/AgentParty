// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
// Keep this contract test ahead of component suites: Bun's module mocks are process-global,
// and JoinLink.test intentionally replaces ../lib/api after this file has exercised the real exports.
import {
  createChannelJoinRequest,
  getMyChannelJoinRequest,
  listChannelJoinRequests,
  reviewChannelJoinRequest,
} from "./lib/api";

function mockJson(body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const request = async (path: string, init?: RequestInit) => {
    calls.push({ url: path, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, request };
}

describe("channel join request API contract", () => {
  test("submits the watch token in a JSON body, never in the URL", async () => {
    const { calls, request } = mockJson({ request: { id: "jr_1", state: "pending" } });
    await createChannelJoinRequest("human-token", "private room", "ap_watch_secret", "hello", request);

    expect(calls[0]?.url).toEndWith("/api/channels/private%20room/join-requests");
    expect(calls[0]?.url).not.toContain("ap_watch_secret");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer human-token", "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ watch_token: "ap_watch_secret", note: "hello" });
  });

  test("loads the current human's request without putting credentials in the URL", async () => {
    const { calls, request: apiRequest } = mockJson({ request: { id: "jr_1", state: "rejected", reason: "full" } });
    const request = await getMyChannelJoinRequest("human-token", "private-room", apiRequest);

    expect(request).toMatchObject({ id: "jr_1", state: "rejected", reason: "full" });
    expect(calls[0]?.url).toEndWith("/api/channels/private-room/join-requests/me");
    expect(calls[0]?.init?.headers).toEqual({ authorization: "Bearer human-token" });
  });

  test("lists pending moderator requests using the state query", async () => {
    const { calls, request } = mockJson({ requests: [{ id: "jr_1", state: "pending", requester_name: "Leo" }] });
    const requests = await listChannelJoinRequests("owner-token", "private-room", "pending", request);

    expect(requests).toHaveLength(1);
    expect(calls[0]?.url).toEndWith("/api/channels/private-room/join-requests?state=pending");
  });

  test("reviews with approve or reject plus a trimmed reason", async () => {
    const { calls: approveCalls, request: approveRequest } = mockJson({ request: { id: "jr_1", state: "approved" } });
    await reviewChannelJoinRequest("owner-token", "private-room", "jr_1", { action: "approve" }, approveRequest);
    expect(JSON.parse(String(approveCalls[0]?.init?.body))).toEqual({ action: "approve" });

    const { calls: rejectCalls, request: rejectRequest } = mockJson({ request: { id: "jr/2", state: "rejected", reason: "not now" } });
    await reviewChannelJoinRequest("owner-token", "private-room", "jr/2", { action: "reject", reason: "not now" }, rejectRequest);
    expect(rejectCalls[0]?.url).toEndWith("/api/channels/private-room/join-requests/jr%2F2/review");
    expect(JSON.parse(String(rejectCalls[0]?.init?.body))).toEqual({ action: "reject", reason: "not now" });
  });

  test("preserves the already_member terminal state", async () => {
    const { request } = mockJson({ state: "already_member" });
    expect(await createChannelJoinRequest("human-token", "private-room", "watch-token", undefined, request))
      .toMatchObject({ state: "already_member" });
  });
});
