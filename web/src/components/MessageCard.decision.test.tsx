// #284：MessageCard 渲染 decision_request 卡片——待定态给人类/moderator 渲染选项按钮，
// 已决态只读展示所选项。校验 approve/reject 与自定义选项两条路径。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

// Markdown 正文经 DOMPurify（需真实 DOM）；本用例只关心决策卡片，桩掉渲染避免拉起 DOM。
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

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

function baseMsg(overrides: Partial<MsgFrame>): MsgFrame {
  return {
    type: "msg",
    seq: 7,
    sender: { name: "planner", kind: "agent" },
    kind: "message",
    body: "here is the plan",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_700_000_000_000,
    ...overrides,
  } as MsgFrame;
}

function render(msg: MsgFrame, extra: Record<string, unknown> = {}) {
  localStorage.setItem("ap_locale", "en");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <MessageCard
          msg={msg}
          self={null}
          quotedMessage={null}
          canModerate={false}
          onReply={noop}
          onEdit={noop}
          onRetract={noop}
          canCreateTask={false}
          onCreateTask={noop}
          editing={false}
          editDraft={msg.body}
          editSaving={false}
          actionError={null}
          busy={false}
          onEditDraftChange={noop}
          onEditCancel={noop}
          onEditSave={noop}
          {...extra}
        />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function optionButtons(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("msg-decision-opt"));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("decision_request card (#284)", () => {
  test("pending approval calls approve immediately and collects reject reason inline", () => {
    const calls: Array<{ seq: number; choice: unknown }> = [];
    const root = render(
      baseMsg({ decision_request: { kind: "approval", prompt: "approve this plan?", options: ["approve", "reject"] }, decision_resolution: { state: "pending" } }),
      { canRespondDecision: true, onDecisionRespond: (seq: number, choice: unknown) => calls.push({ seq, choice }) },
    );
    const buttons = optionButtons(root);
    expect(buttons).toHaveLength(2);
    act(() => buttons[0]!.props.onClick());
    expect(calls).toEqual([{ seq: 7, choice: { action: "approve" } }]);
    act(() => buttons[1]!.props.onClick());
    expect(calls).toHaveLength(1);

    const reason = root.findByProps({ className: "task-new-desc msg-decision-reject-reason" });
    act(() => reason.props.onChange({ currentTarget: { value: "missing evidence" } }));
    const confirm = root.findByProps({ className: "task-action-btn msg-decision-reject-confirm" });
    act(() => confirm.props.onClick());
    expect(calls[1]).toEqual({ seq: 7, choice: { action: "reject", reason: "missing evidence" } });
  });

  test("inline reject can be cancelled without responding", () => {
    const calls: unknown[] = [];
    const root = render(
      baseMsg({ decision_request: { kind: "approval", prompt: "approve?", options: ["approve", "reject"] }, decision_resolution: { state: "pending" } }),
      { canRespondDecision: true, onDecisionRespond: (...args: unknown[]) => calls.push(args) },
    );
    act(() => optionButtons(root)[1]!.props.onClick());
    act(() => root.findByProps({ className: "task-action-btn msg-decision-reject-cancel" }).props.onClick());
    expect(root.findAllByProps({ className: "task-new-desc msg-decision-reject-reason" })).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("pending choice renders one button per custom option", () => {
    const calls: Array<{ seq: number; choice: unknown }> = [];
    const root = render(
      baseMsg({ decision_request: { kind: "choice", prompt: "which path?", options: ["ship", "wait", "cancel"] }, decision_resolution: { state: "pending" } }),
      { canRespondDecision: true, onDecisionRespond: (seq: number, choice: unknown) => calls.push({ seq, choice }) },
    );
    const buttons = optionButtons(root);
    expect(buttons).toHaveLength(3);
    act(() => buttons[1]!.props.onClick());
    expect(calls).toEqual([{ seq: 7, choice: { option: 1 } }]);
  });

  test("without respond permission a pending request shows no buttons", () => {
    const root = render(
      baseMsg({ decision_request: { kind: "approval", prompt: "approve?", options: ["approve", "reject"] }, decision_resolution: { state: "pending" } }),
      { canRespondDecision: false, onDecisionRespond: noop },
    );
    expect(optionButtons(root)).toHaveLength(0);
  });

  test("resolved request shows the chosen option and no buttons", () => {
    const root = render(
      baseMsg({
        decision_request: { kind: "choice", prompt: "which path?", options: ["ship", "wait"] },
        decision_resolution: { state: "resolved", chosen_index: 1, chosen_option: "wait", responder: { name: "leo", kind: "human" } },
      }),
      { canRespondDecision: true, onDecisionRespond: noop },
    );
    expect(optionButtons(root)).toHaveLength(0);
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("wait");
    expect(text).toContain("leo");
  });
});
