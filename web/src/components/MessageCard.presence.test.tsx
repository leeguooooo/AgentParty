// #274：鼠标移到任意 Agent 名字处都展示他正在工作的任务和状态——MessageCard 的发送者名
// 与 @提及悬停 title 追加 presence 三行（status/task/queued）；presence 查不到该名字时不加空行。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

// Markdown 正文经 DOMPurify（需真实 DOM）；本用例只关心悬停 title，桩掉渲染避免拉起 DOM。
mock.module("../lib/markdown", () => ({ renderMarkdown: (s: string) => s }));
const { AGENT_CARD_HOVER_DELAY_MS, MessageCard, agentInfoTitleBits, presenceTitleBits } = await import("./MessageCard");

let renderer: ReactTestRenderer | null = null;
let windowEvents: TestEventTarget;
let documentEvents: TestEventTarget;
let triggerLeft: number;
const insidePopoverTarget = {};

const noop = () => undefined;

class TestEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  innerWidth = 1024;

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

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
  windowEvents = new TestEventTarget();
  documentEvents = new TestEventTarget();
  triggerLeft = 120;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowEvents });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentEvents });
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

function presenceEntry(overrides: Partial<PresenceEntry>): PresenceEntry {
  return {
    name: "planner",
    state: "working",
    note: null,
    ts: 1_700_000_000_000,
    ...overrides,
  } as PresenceEntry;
}

function render(msg: MsgFrame, extra: Record<string, unknown> = {}, locale: "en" | "zh" = "en") {
  localStorage.setItem("ap_locale", locale);
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
      {
        createNodeMock(element) {
          const className = String((element.props as { className?: string }).className ?? "");
          if (className.includes("msg-agent-popover")) {
            return { contains: (target: unknown) => target === insidePopoverTarget };
          }
          if (className.includes("msg-agent-trigger")) {
            return {
              blur: noop,
              getBoundingClientRect: () => ({ left: triggerLeft }),
            };
          }
          return {};
        },
      },
    );
  });
  return renderer!.root;
}

function textContent(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : textContent(child)).join("");
}

function senderCardText(root: ReactTestInstance): string {
  const card = root.find((n) => n.type === "aside" && String(n.props.id ?? "").startsWith("agent-info-") && !String(n.props.id).includes("-mention-"));
  return textContent(card);
}

function mentionCard(root: ReactTestInstance): ReactTestInstance {
  return root.find((n) => n.type === "aside" && String(n.props.id ?? "").includes("-mention-"));
}

function mentionTrigger(root: ReactTestInstance): ReactTestInstance {
  return root.find((n) => n.type === "button" && String(n.props.className ?? "").includes("msg-mention"));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

describe("presenceTitleBits (#274)", () => {
  test("presence 查不到该名字 → 空数组（不加空行）", () => {
    expect(presenceTitleBits(undefined)).toEqual([]);
  });

  test("busy 优先于声明的 state；task/queued 都有则三行齐全", () => {
    expect(presenceTitleBits(presenceEntry({ state: "working", busy: true, current_task: 510, queue_depth: 2 }))).toEqual([
      "status: busy",
      "task: #510",
      "queued: 2",
    ]);
  });

  test("不忙时 status 取 presence state；queue_depth 为 0 不列 queued", () => {
    expect(presenceTitleBits(presenceEntry({ state: "blocked", queue_depth: 0 }))).toEqual(["status: blocked"]);
  });
});

describe("agentInfoTitleBits (#448)", () => {
  test("优先展示频道公开分工，并附 agent 当前 note 与状态", () => {
    expect(agentInfoTitleBits(
      presenceEntry({ role: "worker", note: "正在核对迁移" }),
      {
        name: "planner",
        role: "reviewer",
        responsibility: "检查发布风险与回归范围",
        assigned_by: "host",
        assigned_at: 1,
      },
    )).toEqual([
      "role: reviewer",
      "responsibility: 检查发布风险与回归范围",
      "note: 正在核对迁移",
      "status: working",
    ]);
  });

  test("没有公开分工时回退到 agent 自报 role，空 note 不占行", () => {
    expect(agentInfoTitleBits(presenceEntry({ role: "worker", note: "  " }), undefined)).toEqual([
      "role: worker",
      "status: working",
    ]);
  });
});

describe("发送者即时信息卡/@提及悬停展示实时状态 (#274/#490)", () => {
  test("传入 presence map 时 sender 信息卡展示状态、当前任务和排队", () => {
    const root = render(baseMsg({}), {
      presence: { planner: presenceEntry({ state: "working", busy: true, current_task: 510, queue_depth: 2 }) },
    });
    const card = senderCardText(root);
    expect(card).toContain("Current work#510 · working");
  });

  test("sender 与 @ 都使用完整信息卡展示公开职责", () => {
    const role = {
      name: "planner",
      role: "worker",
      responsibility: "先读 issue，再实现和验证",
      assigned_by: "host",
      assigned_at: 1,
    };
    const root = render(baseMsg({ mentions: ["planner"] }), {
      presence: { planner: presenceEntry({ note: "实现中" }) },
      agentRoles: { planner: role },
    });
    expect(senderCardText(root)).toContain("Role & divisionworker · 先读 issue，再实现和验证");
    expect(senderCardText(root)).toContain("Current work实现中 · working");
    expect(textContent(mentionCard(root))).toContain("Role & divisionworker · 先读 issue，再实现和验证");
    expect(textContent(mentionCard(root))).toContain("Current work实现中 · working");
  });

  test("移动端点击 @提及会显式打开信息卡，再次点击关闭", () => {
    const root = render(baseMsg({ mentions: ["planner"] }), {
      presence: { planner: presenceEntry({ note: "实现中" }) },
    });
    const trigger = mentionTrigger(root);
    let blurred = false;
    const clickEvent = { currentTarget: { blur: () => { blurred = true; } } };
    expect(trigger.props["aria-expanded"]).toBe(false);
    act(() => trigger.props.onClick(clickEvent));
    expect(mentionTrigger(root).props["aria-expanded"]).toBe(true);
    expect(mentionCard(root).parent?.props.className).toContain("msg-agent-popover--open");
    act(() => mentionTrigger(root).props.onClick(clickEvent));
    expect(mentionTrigger(root).props["aria-expanded"]).toBe(false);
    expect(mentionCard(root).parent?.props.className).toContain("msg-agent-popover--closed");
    expect(blurred).toBe(true);
  });

  test("鼠标悬停 @提及不会立刻弹出，短暂停留后才展示信息卡", async () => {
    const root = render(baseMsg({ mentions: ["planner"] }), {
      presence: { planner: presenceEntry({ note: "实现中" }) },
    });
    const popover = mentionCard(root).parent!;

    act(() => popover.props.onMouseEnter());
    expect(mentionCard(root).parent?.props.className).not.toContain("msg-agent-popover--hover-open");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AGENT_CARD_HOVER_DELAY_MS + 20));
    });
    expect(mentionCard(root).parent?.props.className).toContain("msg-agent-popover--hover-open");

    act(() => mentionCard(root).parent?.props.onMouseLeave());
    expect(mentionCard(root).parent?.props.className).not.toContain("msg-agent-popover--hover-open");
  });

  test("信息卡打开和 resize 会重算边缘对齐，卸载时移除监听器", () => {
    triggerLeft = 700;
    const root = render(baseMsg({ mentions: ["planner"] }));
    const clickEvent = { currentTarget: { blur: noop } };

    act(() => mentionTrigger(root).props.onClick(clickEvent));
    expect(mentionCard(root).parent?.props.className).toContain("msg-agent-popover--align-end");
    expect(windowEvents.count("resize")).toBe(1);

    triggerLeft = 120;
    act(() => windowEvents.emit("resize", {}));
    expect(mentionCard(root).parent?.props.className).not.toContain("msg-agent-popover--align-end");

    act(() => renderer?.unmount());
    renderer = null;
    expect(windowEvents.count("resize")).toBe(0);
  });

  test("打开 @提及信息卡后，站内点击保留，站外点击与 Escape 都会收起", () => {
    const root = render(baseMsg({ mentions: ["planner"] }));
    const clickEvent = { currentTarget: { blur: noop } };

    act(() => mentionTrigger(root).props.onClick(clickEvent));
    expect(documentEvents.count("pointerdown")).toBe(1);
    expect(windowEvents.count("keydown")).toBe(1);

    act(() => documentEvents.emit("pointerdown", { target: insidePopoverTarget }));
    expect(mentionTrigger(root).props["aria-expanded"]).toBe(true);

    act(() => documentEvents.emit("pointerdown", { target: {} }));
    expect(mentionTrigger(root).props["aria-expanded"]).toBe(false);
    expect(mentionCard(root).parent?.props.className).toContain("msg-agent-popover--closed");
    expect(documentEvents.count("pointerdown")).toBe(0);

    act(() => mentionTrigger(root).props.onClick(clickEvent));
    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(mentionTrigger(root).props["aria-expanded"]).toBe(false);
    expect(mentionCard(root).parent?.props.className).toContain("msg-agent-popover--closed");
    expect(windowEvents.count("keydown")).toBe(0);
  });

  test("不传 presence（或查不到该名字）时 sender 信息卡明确显示未上报", () => {
    const root = render(baseMsg({}));
    const card = senderCardText(root);
    expect(card).toContain("@planner");
    expect(card).toContain("Current workNot reported");
  });

  test("中文 locale 使用同步的信息卡文案", () => {
    const root = render(baseMsg({ mentions: ["reviewer"] }), {}, "zh");
    expect(senderCardText(root)).toContain("身份agent");
    expect(senderCardText(root)).toContain("进行中的工作未上报");
    expect(textContent(mentionCard(root))).toContain("身份未上报");
    expect(textContent(mentionCard(root))).toContain("角色与分工未上报");
  });

  test("信息卡展示 leader、分工和最近三项工作", () => {
    const recent = [
      baseMsg({ seq: 12, body: "第三项工作" }),
      baseMsg({ seq: 11, body: "第二项工作" }),
      baseMsg({ seq: 10, body: "第一项工作" }),
    ];
    const root = render(baseMsg({}), {
      presence: { planner: presenceEntry({ lineage: { parent_agent: "lead-a", root_agent: "lead-a", team_id: "team-a", depth: 1, expires_at: null } }) },
      agentRoles: {
        planner: {
          name: "planner",
          role: "worker",
          responsibility: "发布验证",
          reports_to: "lead-b",
          assigned_by: "host",
          assigned_at: 1,
        },
      },
      recentMessages: recent,
    });
    const card = senderCardText(root);
    expect(card).toContain("Leaderlead-b");
    expect(card).toContain("Role & divisionworker · 发布验证");
    expect(card).toContain("#12第三项工作");
    expect(card).toContain("#11第二项工作");
    expect(card).toContain("#10第一项工作");
  });

  test("键盘聚焦发送者后可用 Escape 收起信息卡", () => {
    const root = render(baseMsg({}));
    const trigger = root.find((n) => n.type === "button" && String(n.props.className ?? "").includes("msg-agent-trigger"));
    let blurred = false;
    act(() => {
      trigger.props.onKeyDown({
        key: "Escape",
        currentTarget: { blur: () => { blurred = true; } },
      });
    });
    expect(blurred).toBe(true);
  });

  test("@提及信息卡展示该名字的状态；presence 查不到时明确显示未上报", () => {
    const withPresence = render(baseMsg({ mentions: ["reviewer"] }), {
      presence: { reviewer: presenceEntry({ name: "reviewer", state: "waiting", current_task: 42 }) },
    });
    expect(textContent(mentionCard(withPresence))).toContain("Current work#42 · waiting");
    act(() => renderer?.unmount());

    const withoutPresence = render(baseMsg({ mentions: ["reviewer"] }));
    expect(textContent(mentionCard(withoutPresence))).toContain("Current workNot reported");
  });

  test("离线 @agent 从 presence 快照恢复身份和 owner，不伪装成在线参与者", () => {
    const root = render(baseMsg({ mentions: ["reviewer"] }), {
      presence: {
        reviewer: presenceEntry({ name: "reviewer", kind: "agent", account: "owner-a" }),
      },
    });
    expect(textContent(mentionCard(root))).toContain("Identityagent · owner-a");
  });

  test("离线 @human 从 identity map 恢复人类身份和账号", () => {
    const root = render(baseMsg({ mentions: ["reviewer"] }), {
      identityDisplay: {
        reviewer: { display: "Alice", kind: "human", account: "alice@example.com" },
      },
    });
    expect(textContent(mentionCard(root))).toContain("Identityhuman · alice@example.com");
  });
});
