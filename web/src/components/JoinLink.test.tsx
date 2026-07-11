// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// 观看/参与模式选择必须把模式接进 create 调用（#186）：
//   participate → createJoinLink，watch → createShareLink。整体桩掉 ../lib/api，不打网络。
const joinCalls: Array<{ slug: string }> = [];
const shareCalls: Array<{ slug: string }> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createJoinLink: mock(async (_token: string, slug: string) => {
    joinCalls.push({ slug });
    return { code: "abc123", url: "https://x/join/abc123", channel_slug: slug, created_by: "o", created_at: 0, expires_at: null, max_uses: null, uses: 0, revoked_at: null };
  }),
  createShareLink: mock(async (_token: string, slug: string) => {
    shareCalls.push({ slug });
    return { name: "watch_deadbeef", created_at: 0, url: `https://x/c/${slug}?t=ap_watchtoken`, token: "ap_watchtoken" };
  }),
  listJoinLinks: async () => [],
  listShareLinks: async () => [],
  revokeJoinLink: async () => {},
  revokeShareLink: async () => {},
}));

const { JoinLink } = await import("./JoinLink");

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  joinCalls.length = 0;
  shareCalls.length = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render() {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <JoinLink slug="devchan" token="ap_owner" onAuthFailed={() => {}} active={true} />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

function clickPrimary(r: ReactTestRenderer) {
  const btn = r.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("d-btn--primary"))[0]!;
  act(() => {
    (btn.props.onClick as () => void)();
  });
}

describe("JoinLink invite mode selector", () => {
  test("default participate mode wires generate into createJoinLink", async () => {
    const r = render();
    clickPrimary(r);
    await act(async () => {});
    expect(joinCalls).toEqual([{ slug: "devchan" }]);
    expect(shareCalls).toEqual([]);
  });

  test("selecting watch mode wires generate into createShareLink (readonly), not createJoinLink", async () => {
    const r = render();
    const watchRadio = r.root.findAll((n) => n.type === "input" && n.props.value === "watch")[0]!;
    await act(async () => {
      (watchRadio.props.onChange as () => void)();
    });
    clickPrimary(r);
    await act(async () => {});
    expect(shareCalls).toEqual([{ slug: "devchan" }]);
    expect(joinCalls).toEqual([]);
  });
});
