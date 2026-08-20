// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { DirectedDelivery, MsgFrame, PublicDirectedDelivery } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { ChannelStrings } from "../i18n/strings/Channel";
import type { IdentityDisplayMap } from "../lib/identityDisplay";
import type { MentionReceipt } from "../lib/wakeReceipt";

const markdownCalls: Array<{ display?: (name: string) => string }> = [];
mock.module("../lib/markdown", () => ({
  renderMarkdown: (_source: string, _identities: IdentityDisplayMap | undefined, display?: (name: string) => string) => {
    markdownCalls.push({ display });
    return "";
  },
}));
const { MessageCard } = await import("./MessageCard");

let renderer: ReactTestRenderer | null = null;
const noop = () => undefined;

function textContent(node: { children: Array<string | { children: unknown[] }> }): string {
  return node.children
    .map((child) =>
      typeof child === "string"
        ? child
        : textContent(child as { children: Array<string | { children: unknown[] }> }),
    )
    .join("");
}

beforeEach(() => {
  markdownCalls.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => "en", setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0,
  } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function renderStatus(): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
  const msg = {
    type: "msg", seq: 9, sender: { name: "builder", kind: "agent", owner: "team@example.com" }, kind: "status",
    body: "", mentions: [], reply_to: null, state: "blocked", note: "waiting for approval",
    status: { scope: ["web"], blocked_reason: "need human", summary_seq: 8, context: { worktree_label: "issue-357" } },
    ts: 1_700_000_000_000,
  } as unknown as MsgFrame;
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

function renderMessage(
  deliveries: PublicDirectedDelivery[] = [],
  receipts: MentionReceipt[] = [],
  identityDisplay?: IdentityDisplayMap,
  onOpenAgentDetail?: (name: string) => void,
): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
  const msg = {
    type: "msg", seq: 10, sender: { name: "builder", kind: "agent", owner: "team@example.com" }, kind: "message",
    body: "finished", mentions: [], reply_to: null, state: null, note: null, status: null,
    ts: 1_700_000_000_000,
  } as unknown as MsgFrame;
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      deliveries={deliveries}
      receipts={receipts}
      identityDisplay={identityDisplay}
      onOpenAgentDetail={onOpenAgentDetail}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

function renderGeneratedAgentMention(): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
  const target = "lark-461bc7018484-apple-signin-revoke";
  const owner = "lark:on_b81feb6f84d5225a462349bb36499262";
  const msg = {
    type: "msg",
    seq: 11,
    sender: { name: "builder", kind: "agent", owner: "team@example.com" },
    kind: "message",
    body: `请 @${target} 检查`,
    mentions: [target],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_700_000_000_000,
  } as unknown as MsgFrame;
  const identities: IdentityDisplayMap = {
    [target]: { display: target, kind: "agent", account: owner },
    "human-session": { display: "ZHENG TONG", kind: "human", account: owner },
  };
  const deliveries: PublicDirectedDelivery[] = [{
    id: "delivery-11-target",
    message_seq: 11,
    target_name: target,
    state: "failed",
    reply_seq: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_001_000,
  }];
  act(() => {
    renderer = create(<LocaleProvider><MessageCard
      msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
      deliveries={deliveries} identityDisplay={identities}
      onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
      editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
    /></LocaleProvider>);
  });
  return renderer!.root;
}

describe("MessageCard touch and keyboard details (#357)", () => {
  test("identity and stable action metadata render in separate header groups", () => {
    const root = renderMessage();
    expect(root.findByProps({ id: "msg-10" }).props.tabIndex).toBe(-1);
    const main = root.findByProps({ className: "msg-head-main" });
    const meta = root.findByProps({ className: "msg-head-meta" });

    expect(main.findByProps({ className: "msg-sender msg-agent-trigger" })).toBeDefined();
    expect(meta.findByProps({ className: "d-btn msg-menu-trigger" })).toBeDefined();
    expect(meta.findByProps({ className: "msg-seq" }).children).toEqual(["#", "10"]);
    expect(meta.findByProps({ className: "msg-time" })).toBeDefined();
  });

  test("shows one compact owner-agent identity in the message header", () => {
    const root = renderMessage([], [], {
      "human-session": {
        display: "王路",
        kind: "human",
        account: "team@example.com",
      },
    });

    expect(root.findByProps({ className: "msg-sender msg-agent-trigger" }).children).toEqual(["王路 · builder"]);
    expect(root.findAllByProps({ className: "msg-owner" })).toHaveLength(0);
  });

  test("uses one compact owner-agent label without a misleading @ prefix", () => {
    const root = renderGeneratedAgentMention();
    const readable = "ZHENG TONG · apple-signin-revoke";
    expect(root.findByProps({ className: "msg-mention msg-agent-trigger" }).children.join(""))
      .toBe(readable);
    act(() => root.findByProps({ className: "msg-status-summary" }).props.onClick());
    const delivery = root.findByProps({ "data-delivery-id": "delivery-11-target" });
    expect(delivery.findByProps({ className: "t-mono" }).children.join("")).toBe(readable);
    const card = root.findByProps({ id: "agent-info-11-mention-lark-461bc7018484-apple-signin-revoke" });
    const text = textContent(card);
    expect(text).toContain("Owned byZHENG TONG");
    expect(text).toContain("Technical IDlark-461bc7018484-apple-signin-revoke");
    expect(text).not.toContain("Identityagent · lark:on_");
    expect(markdownCalls.at(-1)?.display?.("lark-461bc7018484-apple-signin-revoke"))
      .toBe("apple-signin-revoke");
  });

  test("status full detail expands by click and keyboard", () => {
    const root = renderStatus();
    expect(root.findByProps({ id: "msg-9" }).props.tabIndex).toBe(-1);
    const summary = root.findByProps({ className: "msg-status-summary" });
    expect(summary.props.tabIndex).toBe(0);
    expect(summary.props["aria-expanded"]).toBe(false);
    act(() => summary.props.onKeyDown({ key: "Enter", preventDefault() {} }));
    expect(root.findByProps({ className: "msg-status-detail t-mono" }).children.join("")).toContain("need human");
    act(() => summary.props.onClick());
    expect(root.findAllByProps({ className: "msg-status-detail t-mono" })).toHaveLength(0);
  });

  test("context ellipsis is an accessible button with inline details", () => {
    const root = renderStatus();
    const more = root.findByProps({ className: "t-mono msg-context-more" });
    expect(more.type).toBe("button");
    expect(more.props["aria-label"]).toBe("Show message context");
    expect(ChannelStrings.zh["Channel.message.context.toggle"]).not.toBe(ChannelStrings.en["Channel.message.context.toggle"]);
    expect(more.props["aria-expanded"]).toBe(false);
    act(() => more.props.onClick());
    const detail = root.findByProps({ className: "msg-context msg-context-detail" });
    const bits = detail.findAll((node) => node.type === "span" && node.props.className === "t-mono")
      .map((node) => node.children.join(""));
    expect(bits).toContain("owner:team@example.com");
    expect(bits).toContain("wt:issue-357");
  });

  test("directed delivery renders the durable state and suppresses the legacy guess for that target", () => {
    // Deliberately bypass the public prop type to prove the view remains coarse even if a caller hands it
    // a holder-only object. The reducer has a stronger allow-list test in state.test.ts.
    const maliciousDelivery: DirectedDelivery = {
      id: "delivery-10-builder",
      message_seq: 10,
      target_name: "builder",
      cause: "mention",
      state: "running",
      attempt: 2,
      lease_until: 1_700_000_090_000,
      work_id: "work-10",
      continuation_ref: "thread-10",
      reply_seq: null,
      last_error: "secret internal stack",
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_001_000,
    };
    const opened: string[] = [];
    const root = renderMessage(
      [maliciousDelivery],
      [{ name: "builder", state: "pending_wake", detail: null, at: null }],
      undefined,
      (name) => opened.push(name),
    );

    const toggle = root.findByProps({ className: "msg-status-summary" });
    expect(textContent(toggle)).toContain("1 in progress");
    expect(root.findAllByProps({ "data-delivery-id": "delivery-10-builder" })).toHaveLength(0);
    act(() => toggle.props.onClick());

    const delivery = root.findByProps({ "data-delivery-id": "delivery-10-builder" });
    expect(delivery.props.className).toContain("msg-delivery--running");
    expect(delivery.props.tabIndex).toBeUndefined();
    expect(textContent(delivery)).toContain("builder");
    expect(textContent(delivery)).toContain("running");
    expect(delivery.props.title).not.toContain("attempt 2");
    expect(delivery.props.title).not.toContain("work-10");
    expect(delivery.props.title).not.toContain("thread-10");
    expect(delivery.props.title).not.toContain("secret internal stack");
    expect(root.findAll((node) => String(node.props.className ?? "").includes("msg-receipt--pending_wake"))).toHaveLength(0);

    // 没有 read_cursor 时，可靠投递本身也必须能展开详情；按钮天然可键盘聚焦。
    expect(toggle.type).toBe("button");
    expect(toggle.props["aria-expanded"]).toBe(true);
    expect(root.findByProps({ className: "msg-status-pop" })).toBeDefined();
    expect(root.findAllByProps({ className: "msg-status-group-head" }).map((node) => node.children.join("")))
      .toContain("Reliable @ delivery");
    act(() => root.findByProps({ className: "msg-status-agent-action" }).props.onClick());
    expect(opened).toEqual(["builder"]);
  });

  test("queued shows the pending indicator while genuinely pending (#667)", () => {
    const queued: PublicDirectedDelivery = {
      id: "delivery-10-queued", message_seq: 10, target_name: "kyc-claude",
      state: "queued", reply_seq: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000,
    };
    const root = renderMessage([queued]);
    act(() => root.findByProps({ className: "msg-status-summary" }).props.onClick());
    const pill = root.findByProps({ "data-delivery-id": "delivery-10-queued" });
    expect(pill.props.className).toContain("msg-delivery--queued");
    expect(pill.props.className).not.toContain("msg-delivery--undelivered");
    expect(pill.findByProps({ className: "msg-status-name-state" }).children.join("")).toBe("queued");
    // ⏳ 家族图标：waiting，不是 failed。
    expect(pill.findByProps({ className: "msg-receipt-icon ap-sprite ap-sprite--waiting" })).toBeDefined();
  });

  test("a timed-out delivery renders a distinct terminal 'undelivered', never a permanent ⏳ (#667)", () => {
    const undelivered: PublicDirectedDelivery = {
      id: "delivery-10-undelivered", message_seq: 10, target_name: "kyc-claude",
      state: "failed", undelivered: true, reply_seq: null,
      created_at: 1_700_000_000_000, updated_at: 1_700_000_600_000,
    };
    const root = renderMessage([undelivered]);
    act(() => root.findByProps({ className: "msg-status-summary" }).props.onClick());
    const pill = root.findByProps({ "data-delivery-id": "delivery-10-undelivered" });
    // 终态与 queued 明确区分：独立类名 + 独立文案。
    expect(pill.props.className).toContain("msg-delivery--undelivered");
    expect(pill.props.className).not.toContain("msg-delivery--queued");
    expect(pill.props.className).not.toContain("msg-delivery--failed");
    expect(pill.findByProps({ className: "msg-status-name-state" }).children.join("")).toBe("undelivered");
  });

  test("replied (processed) stays visually distinct from queued (#667/#665)", () => {
    const replied: PublicDirectedDelivery = {
      id: "delivery-10-replied", message_seq: 10, target_name: "kyc-claude",
      state: "replied", reply_seq: 42, created_at: 1_700_000_000_000, updated_at: 1_700_000_600_000,
    };
    const root = renderMessage([replied]);
    act(() => root.findByProps({ className: "msg-status-summary" }).props.onClick());
    const pill = root.findByProps({ "data-delivery-id": "delivery-10-replied" });
    expect(pill.props.className).toContain("msg-delivery--replied");
    expect(pill.findByProps({ className: "msg-status-name-state" }).children.join("")).toBe("replied");
  });
});

// #853：消息头 repo ⎇ branch · worktree chip。普通消息回落到发送者 presence 的 context。
describe("MessageCard git context chip (#853)", () => {
  function renderWithPresence(context?: Record<string, string>): ReturnType<ReactTestRenderer["root"]["findByProps"]> {
    const msg = {
      type: "msg", seq: 20, sender: { name: "builder", kind: "agent", owner: "team@example.com" }, kind: "message",
      body: "done", mentions: [], reply_to: null, state: null, note: null, status: null,
      ts: 1_700_000_000_000,
    } as unknown as MsgFrame;
    const presence = context === undefined
      ? undefined
      : { builder: { name: "builder", kind: "agent", state: "working", note: null, ts: 1, context } };
    act(() => {
      renderer = create(<LocaleProvider><MessageCard
        msg={msg} self={null} quotedMessage={null} canModerate={false} onReply={noop} onEdit={noop}
        presence={presence as never}
        onRetract={noop} canCreateTask={false} onCreateTask={noop} editing={false} editDraft=""
        editSaving={false} actionError={null} busy={false} onEditDraftChange={noop} onEditCancel={noop} onEditSave={noop}
      /></LocaleProvider>);
    });
    return renderer!.root;
  }

  test("renders repo \u2387 branch \u00b7 worktree beside header metadata", () => {
    const root = renderWithPresence({
      repo: "leeguooooo/AgentParty",
      branch: "feat/853-x",
      worktree_label: "agentparty:feat/853-x",
    });
    const chip = root.findByProps({ className: "t-mono msg-git-context" });
    expect(textContent(chip)).toBe("leeguooooo/AgentParty \u2387 feat/853-x \u00b7 agentparty:feat/853-x");
    expect(chip.props.title).toBe("leeguooooo/AgentParty \u2387 feat/853-x \u00b7 agentparty:feat/853-x");
  });

  test("omits worktree tail when absent, and no chip without repo/branch", () => {
    const withRepo = renderWithPresence({ repo: "owner/repo", branch: "main" });
    expect(textContent(withRepo.findByProps({ className: "t-mono msg-git-context" }))).toBe("owner/repo \u2387 main");
    act(() => renderer?.unmount());
    renderer = null;
    const without = renderWithPresence({ worktree_label: "agentparty:main" });
    expect(without.findAllByProps({ className: "t-mono msg-git-context" })).toHaveLength(0);
    act(() => renderer?.unmount());
    renderer = null;
    const noPresence = renderWithPresence(undefined);
    expect(noPresence.findAllByProps({ className: "t-mono msg-git-context" })).toHaveLength(0);
  });
});
