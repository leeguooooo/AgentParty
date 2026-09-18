// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame, PresenceEntry, SessionOutputFrame } from "@agentparty/shared";
import type { IdentityDisplayMap } from "../lib/identityDisplay";
import { LocaleProvider } from "../i18n/locale";
import { channelReducer, initialChannelState, type ChannelState, type LiveSession } from "../state";

mock.module("../lib/markdown", () => ({
  renderMarkdown: (_source: string, _identities: IdentityDisplayMap | undefined) => "",
}));
const { LiveSessionModal, LiveSessionView, hasLiveSession, isPinnedToBottom } = await import("./LiveSessionView");
const { AgentDetailPanel } = await import("./AgentDetailModal");
const { MessageCard } = await import("./MessageCard");
const { PresenceBar } = await import("./PresenceBar");

// #1103：多入口实时看 agent 运行过程。所有入口打开的都必须是 state.liveSessions[name] 这同一份流；
// 没有流时入口禁用 + 诚实空态，绝不拿频道历史冒充终端。

let renderer: ReactTestRenderer | null = null;
const noop = () => undefined;

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "en"]]);
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
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.setInterval = globalThis.setInterval.bind(globalThis);
  win.clearInterval = globalThis.clearInterval.bind(globalThis);
  win.innerWidth = 1280;
  win.innerHeight = 800;
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
});

function out(over: Partial<SessionOutputFrame> & { lines?: SessionOutputFrame["lines"] }): SessionOutputFrame {
  return {
    type: "session_output",
    name: "builder",
    session_id: "run-1",
    task_seq: 7,
    state: "running",
    lines: [],
    ts: 1_000,
    ...over,
  };
}

function line(text: string, kind: SessionOutputFrame["lines"][number]["kind"] = "stdout") {
  return { kind, text, ts: 1 };
}

function apply(state: ChannelState, ...frames: SessionOutputFrame[]): ChannelState {
  return frames.reduce((s, frame) => channelReducer(s, { type: "frame", frame }), state);
}

function text(node: ReactTestRenderer["root"]): string {
  return node.findAll(() => true)
    .flatMap((n) => n.children.filter((c): c is string => typeof c === "string"))
    .join(" ");
}

describe("channelReducer session_output (#1103)", () => {
  test("appends to the same session, replaces on a new session id, replay snapshot replaces", () => {
    let s = apply(initialChannelState, out({ lines: [line("a")] }), out({ lines: [line("b")], ts: 2_000 }));
    expect(s.liveSessions.builder!.lines.map((l) => l.text)).toEqual(["a", "b"]);
    s = apply(s, out({ session_id: "run-2", lines: [line("c")], ts: 3_000 }));
    expect(s.liveSessions.builder!.session_id).toBe("run-2");
    expect(s.liveSessions.builder!.lines.map((l) => l.text)).toEqual(["c"]);
    s = apply(s, out({ session_id: "run-2", replay: true, lines: [line("x"), line("c")], ts: 9_000 }));
    expect(s.liveSessions.builder!.lines.map((l) => l.text)).toEqual(["x", "c"]);
    s = apply(s, out({ session_id: "run-2", state: "done", ts: 10_000 }));
    expect(s.liveSessions.builder!.state).toBe("done");
    expect(s.liveSessions.builder!.lines).toHaveLength(2);
  });

  test("removed participants lose their stream and cannot be revived by a late frame", () => {
    let s = apply(initialChannelState, out({ lines: [line("a")] }));
    s = channelReducer(s, { type: "frame", frame: { type: "participant_removed", name: "builder", removed_at: 5 } });
    expect(hasLiveSession(s.liveSessions, "builder")).toBe(false);
    s = apply(s, out({ lines: [line("late")] }));
    expect(hasLiveSession(s.liveSessions, "builder")).toBe(false);
  });
});

describe("isPinnedToBottom", () => {
  test("only near-bottom counts as following", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 790 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 200, scrollTop: 400 })).toBe(false);
  });
});

function session(over: Partial<LiveSession> = {}): LiveSession {
  return {
    name: "builder",
    session_id: "run-42",
    task_seq: 7,
    state: "running",
    lines: [line("compiling"), line("▸ Bash", "tool")],
    updated_at: 1,
    ...over,
  };
}

describe("LiveSessionView (#1103)", () => {
  test("auto-follows new lines, stops following once the user scrolls up, shows jump button", () => {
    const screen = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
    const renderView = (s: LiveSession) =>
      createElement(LocaleProvider, null, createElement(LiveSessionView, { name: "builder", display: "builder", session: s }));
    act(() => {
      renderer = create(renderView(session()), {
        createNodeMock: (el) => ((el.props as { role?: string }).role === "log" ? screen : null),
      });
    });
    expect(screen.scrollTop).toBe(1000);

    // 新行到达 → 贴底
    screen.scrollHeight = 1500;
    act(() => renderer!.update(renderView(session({ lines: [...session().lines, line("more")] }))));
    expect(screen.scrollTop).toBe(1500);

    // 用户上翻 → 新行不再把视图拽回去
    screen.scrollTop = 300;
    const log = renderer!.root.find((n) => n.props.role === "log");
    act(() => log.props.onScroll({ currentTarget: screen }));
    screen.scrollHeight = 2000;
    act(() => renderer!.update(renderView(session({ lines: [...session().lines, line("more"), line("again")] }))));
    expect(screen.scrollTop).toBe(300);
    const jump = renderer!.root.find((n) => n.type === "button" && String(n.props.className).includes("live-session-jump"));
    act(() => jump.props.onClick());
    expect(screen.scrollTop).toBe(2000);
  });

  test("terminal/disconnect states keep the last screen and say why", () => {
    for (const [state, phrase] of [
      ["done", "finished"],
      ["blocked", "did not complete"],
      ["disconnected", "runner disconnected"],
    ] as const) {
      act(() => {
        renderer = create(createElement(LocaleProvider, null, createElement(LiveSessionView, {
          name: "builder", display: "builder", session: session({ state }),
        })));
      });
      const all = text(renderer!.root);
      expect(all).toContain(phrase);
      expect(all).toContain("compiling");
      act(() => renderer!.unmount());
      renderer = null;
    }
  });
});

function presenceOf(name: string): PresenceEntry {
  const now = Date.now();
  return { name, kind: "agent", state: "working", note: null, ts: now, last_seen: now, live: true } as PresenceEntry;
}

function historyMessage(): MsgFrame {
  return {
    type: "msg", seq: 3, sender: { name: "builder", kind: "agent" }, kind: "message",
    body: "OLD CHANNEL HISTORY LINE", mentions: [], reply_to: null, state: null, note: null, status: null, ts: 1,
  } as unknown as MsgFrame;
}

describe("entries open the same stream (#1103)", () => {
  test("AgentDetailPanel: primary action + embedded terminal carry the same session id; open calls back with the name", () => {
    const opened: string[] = [];
    const live = session();
    act(() => {
      renderer = create(createElement(LocaleProvider, null, createElement(AgentDetailPanel, {
        name: "builder", display: "builder", kind: "agent", owner: null, online: true,
        presence: presenceOf("builder"), messages: [historyMessage()],
        liveSession: live, onOpenLiveSession: (n: string) => opened.push(n),
      })));
    });
    const embedded = renderer!.root.find((n) => n.props["data-live-session"] === "builder");
    expect(embedded.props["data-session-id"]).toBe("run-42");
    const entry = renderer!.root.find((n) => n.type === "button" && n.props["data-live-entry"] === "builder");
    expect(entry.props.disabled).toBe(false);
    act(() => entry.props.onClick({ stopPropagation: noop }));
    expect(opened).toEqual(["builder"]);

    // 被打开的 modal 用的是同一份 session 对象
    act(() => renderer!.unmount());
    act(() => {
      renderer = create(createElement(LocaleProvider, null, createElement(LiveSessionModal, {
        name: opened[0]!, display: "builder", session: live, onClose: noop,
      })));
    });
    expect(renderer!.root.find((n) => n.props["data-live-session"] === "builder").props["data-session-id"]).toBe("run-42");
  });

  test("AgentDetailPanel without a stream: entry disabled, honest empty copy, no channel history inside the live view", () => {
    const opened: string[] = [];
    act(() => {
      renderer = create(createElement(LocaleProvider, null, createElement(AgentDetailPanel, {
        name: "builder", display: "builder", kind: "agent", owner: null, online: true,
        presence: presenceOf("builder"), messages: [historyMessage()],
        liveSession: null, onOpenLiveSession: (n: string) => opened.push(n),
      })));
    });
    const entry = renderer!.root.find((n) => n.type === "button" && n.props["data-live-entry"] === "builder");
    expect(entry.props.disabled).toBe(true);
    act(() => entry.props.onClick({ stopPropagation: noop }));
    expect(opened).toEqual([]);
    const liveBox = renderer!.root.find((n) => n.props["data-live-session"] === "builder");
    const liveText = text(liveBox);
    expect(liveText).toContain("No live run session to follow");
    expect(liveText).not.toContain("OLD CHANNEL HISTORY LINE");
  });

  test("timeline working card opens the live session for its sender; disabled without a stream", () => {
    const opened: string[] = [];
    const statusMsg = {
      type: "status", seq: 9, sender: { name: "builder", kind: "agent" }, kind: "status",
      body: "", mentions: [], reply_to: null, state: "working", note: "on it",
      status: { scope: [], blocked_reason: null, summary_seq: null }, ts: 1_700_000_000_000,
    } as unknown as MsgFrame;
    const renderCard = (has: boolean) => createElement(LocaleProvider, null, createElement(MessageCard, {
      msg: statusMsg, self: null, quotedMessage: null, canModerate: false, onReply: noop, onEdit: noop,
      onRetract: noop, canCreateTask: false, onCreateTask: noop, editing: false, editDraft: "",
      editSaving: false, actionError: null, busy: false, onEditDraftChange: noop, onEditCancel: noop, onEditSave: noop,
      onOpenLiveSession: (n: string) => opened.push(n), hasLiveSession: () => has,
    }));
    act(() => { renderer = create(renderCard(true)); });
    const entry = renderer!.root.find((n) => n.type === "button" && n.props["data-live-entry"] === "builder");
    expect(entry.props.disabled).toBe(false);
    act(() => entry.props.onClick({ stopPropagation: noop }));
    expect(opened).toEqual(["builder"]);
    act(() => renderer!.update(renderCard(false)));
    expect(renderer!.root.find((n) => n.type === "button" && n.props["data-live-entry"] === "builder").props.disabled).toBe(true);
  });

  test("presence roster entry opens the same agent's live session", () => {
    const opened: string[] = [];
    const now = Date.now();
    act(() => {
      renderer = create(createElement(LocaleProvider, null, createElement(PresenceBar, {
        presence: {
          builder: { name: "builder", kind: "agent", state: "working", ts: now, last_seen: now, live: true },
          idle: { name: "idle", kind: "agent", state: "waiting", ts: now, last_seen: now, live: true },
        },
        participants: [{ name: "builder", kind: "agent" }, { name: "idle", kind: "agent" }],
        status: "open",
        initialRosterOpen: true,
        liveSessions: { builder: session() },
        onOpenLiveSession: (n: string) => opened.push(n),
      } as never)));
    });
    const entries = renderer!.root.findAll((n) => n.type === "button" && n.props["data-live-entry"] !== undefined);
    const builder = entries.find((n) => n.props["data-live-entry"] === "builder")!;
    const idle = entries.find((n) => n.props["data-live-entry"] === "idle")!;
    expect(builder.props.disabled).toBe(false);
    expect(idle.props.disabled).toBe(true);
    act(() => builder.props.onClick({ stopPropagation: noop }));
    expect(opened).toEqual(["builder"]);
  });
});
