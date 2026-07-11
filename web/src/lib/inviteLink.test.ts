// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { parseInviteUrl, resolveInviteForServer } from "./inviteLink";

// 桌面版「贴网页邀请链接进入频道」（#297）的纯解析层。桌面壳没有地址栏，用户只能粘贴
// 网页版铸出来的同一条链接（#186/#38）。这里把 URL 拆成 {server, slug/code, token} 并按
// 邀请模式分流：/join/<code>=参与，/c/<slug>?t=<token>=观看，/c/<slug>=直接打开。
const SERVER = "https://agentparty.leeguoo.com";

describe("parseInviteUrl", () => {
  test("participate link /join/<code> → participate action carrying server + code", () => {
    const r = parseInviteUrl(`${SERVER}/join/AbC_1-23xyz`);
    expect(r).toEqual({ ok: true, action: { kind: "participate", server: SERVER, code: "AbC_1-23xyz" } });
  });

  test("watch link /c/<slug>?t=<token> → watch action carrying slug + token", () => {
    const r = parseInviteUrl(`${SERVER}/c/devchan?t=ap_watchtoken`);
    expect(r).toEqual({ ok: true, action: { kind: "watch", server: SERVER, slug: "devchan", token: "ap_watchtoken" } });
  });

  test("plain channel link /c/<slug> (no token) → open action", () => {
    const r = parseInviteUrl(`${SERVER}/c/devchan`);
    expect(r).toEqual({ ok: true, action: { kind: "open", server: SERVER, slug: "devchan" } });
  });

  test("trailing slash on join and channel paths still parses", () => {
    expect(parseInviteUrl(`${SERVER}/join/abc/`)).toEqual({ ok: true, action: { kind: "participate", server: SERVER, code: "abc" } });
    expect(parseInviteUrl(`${SERVER}/c/devchan/`)).toEqual({ ok: true, action: { kind: "open", server: SERVER, slug: "devchan" } });
  });

  test("watch token is read even when other query params precede it", () => {
    const r = parseInviteUrl(`${SERVER}/c/devchan?foo=1&t=tok2`);
    expect(r).toEqual({ ok: true, action: { kind: "watch", server: SERVER, slug: "devchan", token: "tok2" } });
  });

  test("empty ?t= degrades to open (not a broken watch)", () => {
    expect(parseInviteUrl(`${SERVER}/c/devchan?t=`)).toEqual({ ok: true, action: { kind: "open", server: SERVER, slug: "devchan" } });
  });

  test("surrounding whitespace is trimmed", () => {
    const r = parseInviteUrl(`   ${SERVER}/join/abc   `);
    expect(r).toEqual({ ok: true, action: { kind: "participate", server: SERVER, code: "abc" } });
  });

  test("host case is normalized by URL parsing (server origin lowercased)", () => {
    const r = parseInviteUrl("HTTPS://AgentParty.LeeGuoo.COM/c/devchan?t=tok");
    expect(r).toEqual({ ok: true, action: { kind: "watch", server: SERVER, slug: "devchan", token: "tok" } });
  });

  test("empty / whitespace-only input → empty", () => {
    expect(parseInviteUrl("")).toEqual({ ok: false, reason: "empty" });
    expect(parseInviteUrl("   ")).toEqual({ ok: false, reason: "empty" });
  });

  test("non-URL garbage → malformed", () => {
    expect(parseInviteUrl("not a url")).toEqual({ ok: false, reason: "malformed" });
  });

  test("non-http(s) schemes are rejected as unsupported (no separate desktop scheme)", () => {
    expect(parseInviteUrl("agentparty://pair/ABCDE-12345")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseInviteUrl("javascript:alert(1)")).toEqual({ ok: false, reason: "unsupported" });
    expect(parseInviteUrl("ftp://agentparty.leeguoo.com/c/devchan")).toEqual({ ok: false, reason: "unsupported" });
  });

  test("known-host but unrecognized path → unsupported", () => {
    expect(parseInviteUrl(`${SERVER}/settings`)).toEqual({ ok: false, reason: "unsupported" });
    expect(parseInviteUrl(`${SERVER}/`)).toEqual({ ok: false, reason: "unsupported" });
  });

  test("invalid channel slug (uppercase) is not accepted as a channel", () => {
    expect(parseInviteUrl(`${SERVER}/c/DevChan`)).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("resolveInviteForServer (host validation against the paired desktop server)", () => {
  test("invite whose origin equals the active server resolves to its action", () => {
    expect(resolveInviteForServer(`${SERVER}/join/abc`, SERVER)).toEqual({
      ok: true,
      action: { kind: "participate", server: SERVER, code: "abc" },
    });
  });

  test("different host → wrong-host with both hosts for a clear error", () => {
    const r = resolveInviteForServer("https://evil.example.com/join/abc", SERVER);
    expect(r).toEqual({ ok: false, reason: "wrong-host", expectedHost: "agentparty.leeguoo.com", actualHost: "evil.example.com" });
  });

  test("same host but different port → wrong-host", () => {
    const r = resolveInviteForServer("https://agentparty.leeguoo.com:8443/join/abc", SERVER);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "wrong-host" });
  });

  test("scheme mismatch (http vs https) → wrong-host", () => {
    const r = resolveInviteForServer("http://agentparty.leeguoo.com/join/abc", SERVER);
    expect(r).toMatchObject({ ok: false, reason: "wrong-host" });
  });

  test("parse failures pass through unchanged (not reported as wrong-host)", () => {
    expect(resolveInviteForServer("", SERVER)).toEqual({ ok: false, reason: "empty" });
    expect(resolveInviteForServer("not a url", SERVER)).toEqual({ ok: false, reason: "malformed" });
    expect(resolveInviteForServer("agentparty://pair/ABCDE-12345", SERVER)).toEqual({ ok: false, reason: "unsupported" });
  });

  test("unparseable active origin never yields a false match", () => {
    const r = resolveInviteForServer(`${SERVER}/join/abc`, "not-an-origin");
    expect(r).toMatchObject({ ok: false, reason: "wrong-host" });
  });
});
