// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { parseChannelDeepLink } from "./channelLink";

// 桌面版「从外部工具直达频道」的 deep link（agentparty://channel/<slug>?server=<origin>）纯解析层。
// 来源是 claude-statusbar 的 `cs hud`——点某个 channel 会 open 这条链接，桌面壳收到后跳频道页。
// 它与配对邀请（agentparty://pair/...）、网页邀请链接（http(s)）靠 scheme + hostname 分流、互不干扰。
const SERVER = "https://agentparty.pwtk-dev.work";

describe("parseChannelDeepLink", () => {
  test("channel link with server → slug + normalized server origin", () => {
    const link = parseChannelDeepLink(
      `agentparty://channel/guessadmin?server=${encodeURIComponent(SERVER)}`,
    );
    expect(link).toEqual({ slug: "guessadmin", serverOrigin: SERVER });
  });

  test("channel link without server → slug + null server (channel is the primary key)", () => {
    expect(parseChannelDeepLink("agentparty://channel/general")).toEqual({
      slug: "general",
      serverOrigin: null,
    });
  });

  test("trailing slash on the channel path still parses", () => {
    expect(parseChannelDeepLink("agentparty://channel/general/")).toEqual({
      slug: "general",
      serverOrigin: null,
    });
  });

  test("hyphenated slug is accepted", () => {
    expect(parseChannelDeepLink("agentparty://channel/team-alpha-2")).toEqual({
      slug: "team-alpha-2",
      serverOrigin: null,
    });
  });

  test("server with an explicit port is preserved in the origin", () => {
    const link = parseChannelDeepLink(
      `agentparty://channel/general?server=${encodeURIComponent("http://localhost:8787")}`,
    );
    expect(link).toEqual({ slug: "general", serverOrigin: "http://localhost:8787" });
  });

  test("a malformed server degrades to null without blocking the channel jump", () => {
    expect(parseChannelDeepLink("agentparty://channel/general?server=not-a-url")).toEqual({
      slug: "general",
      serverOrigin: null,
    });
    // server 带路径 / 查询串都不是干净 origin → 忽略，仍按 slug 跳。
    expect(
      parseChannelDeepLink(
        `agentparty://channel/general?server=${encodeURIComponent("https://evil.example/c/x?t=1")}`,
      ),
    ).toEqual({ slug: "general", serverOrigin: null });
    // 非 http(s) 的 server 一律拒（降级为 null）。
    expect(
      parseChannelDeepLink(
        `agentparty://channel/general?server=${encodeURIComponent("agentparty://pair/ABCDE-12345")}`,
      ),
    ).toEqual({ slug: "general", serverOrigin: null });
  });

  test("extra query params are ignored; only server is read", () => {
    expect(
      parseChannelDeepLink(
        `agentparty://channel/general?foo=1&server=${encodeURIComponent(SERVER)}&bar=2`,
      ),
    ).toEqual({ slug: "general", serverOrigin: SERVER });
  });

  test("the pairing deep link (hostname=pair) is never mistaken for a channel", () => {
    expect(parseChannelDeepLink("agentparty://pair/ABCDE-12345")).toBeNull();
  });

  test("non-agentparty schemes are rejected", () => {
    expect(parseChannelDeepLink(`${SERVER}/c/general`)).toBeNull();
    expect(parseChannelDeepLink("javascript:alert(1)")).toBeNull();
  });

  test("non-URL garbage → null", () => {
    expect(parseChannelDeepLink("")).toBeNull();
    expect(parseChannelDeepLink("not a url")).toBeNull();
  });

  test("missing, empty, or multi-segment channel path → null", () => {
    expect(parseChannelDeepLink("agentparty://channel")).toBeNull();
    expect(parseChannelDeepLink("agentparty://channel/")).toBeNull();
    expect(parseChannelDeepLink("agentparty://channel/a/b")).toBeNull();
  });

  test("invalid slug (uppercase / path traversal / leading hyphen) → null", () => {
    expect(parseChannelDeepLink("agentparty://channel/GeneralChan")).toBeNull();
    expect(parseChannelDeepLink("agentparty://channel/..")).toBeNull();
    expect(parseChannelDeepLink("agentparty://channel/-lead")).toBeNull();
  });

  test("credentials or a fragment on the deep link are rejected", () => {
    expect(parseChannelDeepLink("agentparty://user:pass@channel/general")).toBeNull();
    expect(parseChannelDeepLink("agentparty://channel/general#frag")).toBeNull();
  });
});
