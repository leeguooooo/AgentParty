// 回执徽标（#828）。这条测试真正要守的是**位置**而不是文案：回执必须留在消息头的元数据里，
// 绝不能进 .msg-body。手搓版当年就是长得像本人发言，三条一模一样的机器人回执让协作方判断
// 「没人接活」，进而越界改了别人的仓库。一旦哪次重构把它挪进正文流，这个坑就原样回来了。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

mock.module("../lib/markdown", () => ({ renderMarkdown: (s: string) => s }));
const { MessageCard } = await import("./MessageCard");

let renderer: ReactTestRenderer | null = null;
const noop = () => undefined;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => "en", setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0,
  } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(msg: MsgFrame): ReactTestInstance {
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

function receiptBadges(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((n) => n.type === "span" && String(n.props.className ?? "").includes("msg-receipt"));
}

function textOf(node: ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap((n) => n.children.filter((c): c is string => typeof c === "string"))
    .join("");
}

const base = {
  type: "msg", seq: 7, kind: "message", body: "please pick this up", mentions: [], reply_to: null,
  state: null, note: null, status: null, ts: 1_700_000_000_000,
  sender: { name: "asker", kind: "agent" },
} as const;

describe("MessageCard receipts (#828)", () => {
  test("renders a badge naming who received it", () => {
    const msg = {
      ...base,
      receipts: [{ by: { name: "leo-claude", kind: "agent" }, reason: "not_in_turn", ts: 1_700_000_000_001 }],
    } as unknown as MsgFrame;
    const badges = receiptBadges(render(msg));
    expect(badges).toHaveLength(1);
    expect(textOf(badges[0]!)).toContain("leo-claude");
  });

  test("the badge stays out of the message body", () => {
    const msg = {
      ...base,
      receipts: [{ by: { name: "leo-claude", kind: "agent" }, reason: "not_in_turn", ts: 1_700_000_000_001 }],
    } as unknown as MsgFrame;
    const root = render(msg);
    const body = root.findAll((n) => String(n.props?.className ?? "").includes("msg-body"));
    expect(body.length).toBeGreaterThan(0);
    for (const node of body) {
      expect(textOf(node)).not.toContain("leo-claude");
    }
  });

  test("the title says it is a receipt, not a reply and not done", () => {
    const msg = {
      ...base,
      receipts: [{ by: { name: "leo-claude", kind: "agent" }, reason: "not_in_turn", note: "next turn", ts: 1 }],
    } as unknown as MsgFrame;
    const title = String(receiptBadges(render(msg))[0]!.props.title ?? "");
    expect(title).toContain("not in a turn");
    expect(title).toContain("next turn");
    expect(title).toContain("not a reply");
  });

  test("no receipts → no badge", () => {
    expect(receiptBadges(render(base as unknown as MsgFrame))).toHaveLength(0);
  });
});
