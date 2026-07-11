// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopInvitePaste } from "./DesktopInvitePaste";

// 桌面粘贴入口必须真把解析结果接到对应回调（#297 wiring 门禁）：
//   /join/<code> → onParticipate(code)；/c/<slug>?t= → onWatch(slug, token)；/c/<slug> → onOpen(slug)。
// 换错回调这些断言就红——这是「组件真被 wire 进去且分流正确」的护栏。
const SERVER = "https://agentparty.leeguoo.com";

let renderer: ReactTestRenderer | null = null;

interface Calls {
  participate: string[];
  watch: Array<{ slug: string; token: string }>;
  open: string[];
}

function render(calls: Calls, opts?: { readClipboard?: () => Promise<string>; origin?: string }) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <DesktopInvitePaste
          activeOrigin={opts?.origin ?? SERVER}
          onParticipate={(code) => calls.participate.push(code)}
          onWatch={(slug, token) => calls.watch.push({ slug, token })}
          onOpen={(slug) => calls.open.push(slug)}
          readClipboard={opts?.readClipboard}
        />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

function expand(r: ReactTestRenderer) {
  const toggle = r.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("invite-paste-btn"))[0]!;
  act(() => (toggle.props.onClick as () => void)());
}

function typeUrl(r: ReactTestRenderer, url: string) {
  const input = r.root.findAll((n) => n.type === "input")[0]!;
  act(() => (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: url } }));
}

function clickJoin(r: ReactTestRenderer) {
  const btn = r.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("d-btn--primary"))[0]!;
  act(() => (btn.props.onClick as () => void)());
}

function clickDetect(r: ReactTestRenderer) {
  const btn = r.root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("invite-paste-detect"))[0]!;
  act(() => (btn.props.onClick as () => void)());
}

function text(r: ReactTestRenderer, className: string): string | null {
  const nodes = r.root.findAll((n) => String(n.props.className ?? "").includes(className));
  return nodes.length === 0 ? null : nodes.map((n) => n.children.join("")).join("");
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("DesktopInvitePaste wiring", () => {
  let calls: Calls;
  beforeEach(() => {
    calls = { participate: [], watch: [], open: [] };
  });

  test("participate link routes to onParticipate with the code", () => {
    const r = render(calls);
    expand(r);
    typeUrl(r, `${SERVER}/join/abc123`);
    clickJoin(r);
    expect(calls.participate).toEqual(["abc123"]);
    expect(calls.watch).toEqual([]);
    expect(calls.open).toEqual([]);
  });

  test("watch link routes to onWatch with slug + token", () => {
    const r = render(calls);
    expand(r);
    typeUrl(r, `${SERVER}/c/devchan?t=ap_watchtoken`);
    clickJoin(r);
    expect(calls.watch).toEqual([{ slug: "devchan", token: "ap_watchtoken" }]);
    expect(calls.participate).toEqual([]);
  });

  test("plain channel link routes to onOpen with slug", () => {
    const r = render(calls);
    expand(r);
    typeUrl(r, `${SERVER}/c/devchan`);
    clickJoin(r);
    expect(calls.open).toEqual(["devchan"]);
    expect(calls.watch).toEqual([]);
  });

  test("wrong-host invite shows an error naming both hosts and fires no callback", () => {
    const r = render(calls);
    expand(r);
    typeUrl(r, "https://evil.example.com/join/abc");
    clickJoin(r);
    expect(calls.participate).toEqual([]);
    const err = text(r, "invite-paste-error");
    expect(err).not.toBeNull();
    expect(err).toContain("evil.example.com");
    expect(err).toContain("agentparty.leeguoo.com");
  });

  test("malformed invite shows an error and fires no callback", () => {
    const r = render(calls);
    expand(r);
    typeUrl(r, "not a link");
    clickJoin(r);
    expect(calls.participate).toEqual([]);
    expect(text(r, "invite-paste-error")).not.toBeNull();
  });

  test("detect from clipboard prefills + prompts but does NOT auto-join (user still confirms)", async () => {
    const r = render(calls, { readClipboard: () => Promise.resolve(`${SERVER}/join/frompaste`) });
    expand(r);
    await act(async () => clickDetect(r));
    // 检测阶段不触发加入——只回填 + 提示
    expect(calls.participate).toEqual([]);
    expect(text(r, "invite-paste-detected")).not.toBeNull();
    // 用户确认后才加入，用的是剪贴板检测回填进来的链接
    clickJoin(r);
    expect(calls.participate).toEqual(["frompaste"]);
  });

  test("clipboard read failure surfaces the clipboard error", async () => {
    const r = render(calls, { readClipboard: () => Promise.reject(new Error("blocked")) });
    expand(r);
    await act(async () => clickDetect(r));
    expect(text(r, "invite-paste-error")).not.toBeNull();
    expect(calls.participate).toEqual([]);
  });
});
