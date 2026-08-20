// #858：同 owner 同角色的两个 agent 显示名撞车时，消息头要带上技术区分码；
// 不撞名的身份显示必须完全不变（不给所有人加尾巴）。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { buildIdentityDisplay } from "../lib/identityDisplay";

mock.module("../lib/markdown", () => ({ renderMarkdown: (s: string) => s }));
const { MessageCard } = await import("./MessageCard");

let renderer: ReactTestRenderer | null = null;
const noop = () => undefined;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

class TestEventTarget {
  innerWidth = 1024;
  addEventListener() {}
  removeEventListener() {}
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new TestEventTarget() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: new TestEventTarget() });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

const OWNER = "lark:on_b81feb6f84d5225a462349bb36499262";

function msg(senderName: string): MsgFrame {
  return {
    type: "msg",
    seq: 7,
    sender: { name: senderName, kind: "agent", owner: OWNER },
    kind: "message",
    body: "hi",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_700_000_000_000,
  } as MsgFrame;
}

function identities(...names: string[]) {
  return buildIdentityDisplay({
    channelIdentities: [
      { name: "human-session", display: "leo", kind: "human", account: OWNER },
      ...names.map((name) => ({ name, display: name, kind: "agent" as const, account: OWNER })),
    ],
    mentionOptions: [],
    messages: [],
    participants: [],
    presence: {},
  });
}

function render(frame: MsgFrame, identityDisplay: ReturnType<typeof identities>) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <MessageCard
          msg={frame}
          self={null}
          quotedMessage={null}
          identityDisplay={identityDisplay}
          canModerate={false}
          onReply={noop}
          onEdit={noop}
          onRetract={noop}
          canCreateTask={false}
          onCreateTask={noop}
          editing={false}
          editDraft={frame.body}
          editSaving={false}
          actionError={null}
          busy={false}
          onEditDraftChange={noop}
          onEditCancel={noop}
          onEditSave={noop}
        />
      </LocaleProvider>,
      { createNodeMock: () => ({ blur: noop, getBoundingClientRect: () => ({ left: 120 }), contains: () => false }) },
    );
  });
  return renderer!.root;
}

function codes(root: ReactTestInstance): string[] {
  return root
    .findAll((n) => String((n.props as { className?: string }).className ?? "").includes("identity-disambiguator"))
    .map((n) => n.children.map((c) => (typeof c === "string" ? c : "")).join(""));
}

describe("MessageCard 身份区分码（#858）", () => {
  test("撞名时消息头带上哈希尾部区分码", () => {
    const map = identities("lark-ad72b3f97491-agentparty", "lark-ad72b3f9749e-agentparty");
    const root = render(msg("lark-ad72b3f97491-agentparty"), map);
    expect(codes(root)).toContain("·97491");
  });

  test("不撞名时消息头不出现任何区分码", () => {
    const map = identities("lark-ad72b3f97491-agentparty");
    const root = render(msg("lark-ad72b3f97491-agentparty"), map);
    expect(codes(root)).toEqual([]);
  });
});
