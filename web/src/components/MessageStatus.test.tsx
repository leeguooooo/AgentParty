// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PublicDirectedDelivery } from "@agentparty/shared";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { MessageStatus } from "./MessageStatus";

let renderer: ReactTestRenderer | null = null;
let originalActEnvironment: PropertyDescriptor | undefined;
let originalLocalStorage: PropertyDescriptor | undefined;

function delivery(
  id: string,
  target: string,
  state: PublicDirectedDelivery["state"],
  overrides: Partial<PublicDirectedDelivery> = {},
): PublicDirectedDelivery {
  return {
    id,
    message_seq: 42,
    target_name: target,
    state,
    reply_seq: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_100_000,
    ...overrides,
  };
}

function renderStatus(
  deliveries: PublicDirectedDelivery[],
  onOpenAgentDetail?: (name: string) => void,
  canOpenAgentDetail?: (name: string) => boolean,
) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <MessageStatus
          receipts={[]}
          readers={[]}
          unread={[]}
          deliveries={deliveries}
          display={(name) => `owner · ${name}`}
          onOpenAgentDetail={onOpenAgentDetail}
          canOpenAgentDetail={canOpenAgentDetail}
        />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

beforeEach(() => {
  originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => key === "ap_locale" ? "zh" : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
});

afterEach(() => {
  try {
    act(() => renderer?.unmount());
    renderer = null;
  } finally {
    if (originalActEnvironment === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    else Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
    if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  }
});

describe("模块⑥：唤醒方式给用户看时用人话", () => {
  test("pending_wake 的回执把 serve 显示成「常驻待命」，不露实现名", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <MessageStatus
            receipts={[{ name: "evan", state: "pending_wake", detail: "serve", at: null }]}
            readers={[]}
            unread={[]}
            deliveries={[]}
            display={(name) => name}
          />
        </LocaleProvider>,
      );
    });
    act(() => renderer!.root.findByProps({ "aria-label": "展开消息送达详情" }).props.onClick());
    const texts: string[] = [];
    const titles: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") { texts.push(node); return; }
      if (!node || typeof node !== "object") return;
      const n = node as { props?: Record<string, unknown>; children?: unknown[] };
      if (typeof n.props?.title === "string") titles.push(n.props.title);
      for (const child of n.children ?? []) walk(child);
    };
    walk(renderer!.toJSON());
    const all = texts.join(" ") + " " + titles.join(" ");
    expect(all).toContain("常驻待命");
    expect(all).not.toMatch(/\bserve\b/);
  });
});

describe("MessageStatus delivery diagnostics (#806)", () => {
  test("collapsed state prioritizes the actionable count without repeating every target", () => {
    const r = renderStatus([
      delivery("failed", "alpha", "failed"),
      delivery("running", "beta", "running"),
      delivery("replied", "gamma", "replied", { reply_seq: 51 }),
    ]);

    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("1 位需处理");
    expect(text).not.toContain("owner · alpha");
    expect(text).not.toContain("owner · beta");
    expect(text).not.toContain("owner · gamma");
  });

  test("expanded state explains each result, shows the update time, and opens agent detail", () => {
    const opened: string[] = [];
    const r = renderStatus([
      delivery("undelivered", "alpha", "failed", { undelivered: true }),
      delivery("running", "beta", "running"),
      delivery("replied", "gamma", "replied", { reply_seq: 51 }),
    ], (name) => opened.push(name));

    const toggle = r.root.findByProps({ "aria-label": "展开消息送达详情" });
    act(() => toggle.props.onClick());

    const text = JSON.stringify(r.toJSON());
    expect(text).toContain("Agent 当前离线或没有可用唤醒通道");
    expect(text).toContain("Agent 正在处理这条消息");
    expect(text).toContain("已在消息 #51 中回复");
    expect(text).toContain("最后更新");

    const rows = r.root.findAll((node) => node.props["data-delivery-id"] !== undefined);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.props.tabIndex === undefined)).toBe(true);

    const actions = r.root.findAllByProps({ className: "msg-status-agent-action" });
    expect(actions).toHaveLength(3);
    act(() => actions[0]!.props.onClick());
    expect(opened).toEqual(["alpha"]);
  });

  test("does not render a fake focusable action when agent detail is unavailable", () => {
    const r = renderStatus([delivery("failed", "alpha", "failed")]);
    act(() => r.root.findByProps({ "aria-label": "展开消息送达详情" }).props.onClick());

    expect(r.root.findAllByProps({ className: "msg-status-agent-action" })).toHaveLength(0);
    const row = r.root.findByProps({ "data-delivery-id": "failed" });
    expect(row.props.tabIndex).toBeUndefined();
    expect(row.props.onClick).toBeUndefined();
  });

  test("does not offer agent detail for a historical target outside the current roster", () => {
    const r = renderStatus(
      [delivery("failed", "removed-agent", "failed")],
      () => undefined,
      () => false,
    );
    act(() => r.root.findByProps({ "aria-label": "展开消息送达详情" }).props.onClick());

    expect(r.root.findAllByProps({ className: "msg-status-agent-action" })).toHaveLength(0);
  });
});

describe("Claude inbox receipts on the sender's message (#1130)", () => {
  const inbox = (state: string, extra: Record<string, unknown> = {}) => ({
    target: "alpha",
    state,
    reported_by: { name: "alpha", kind: "agent" },
    ts: 1_700_000_200_000,
    ...extra,
  });

  function renderInbox(inboxReceipts: unknown, deliveries: PublicDirectedDelivery[] = []) {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <MessageStatus
            receipts={[]}
            readers={[]}
            unread={[]}
            deliveries={deliveries}
            inboxReceipts={inboxReceipts}
            display={(name) => `owner · ${name}`}
          />
        </LocaleProvider>,
      );
    });
    return renderer as ReactTestRenderer;
  }
  const expand = (r: ReactTestRenderer) => {
    const toggle = r.root.findByProps({ "aria-label": "展开消息送达详情" });
    act(() => toggle.props.onClick());
    return JSON.stringify(r.toJSON());
  };

  test("held: the collapsed line says so, even while the durable delivery is still queued", () => {
    const r = renderInbox([inbox("held")], [delivery("d1", "alpha", "queued")]);
    const collapsed = JSON.stringify(r.toJSON());
    expect(collapsed).toContain("1 位被扣留待审");
    // 没有回执时这里会写「1 位处理中」——那句会让发信人以为消息已经在对方手里。
    expect(collapsed).not.toContain("处理中");
    const text = expand(r);
    expect(text).toContain("被扣留待审 · 尚未送达");
    expect(text).toContain("5 分钟内无人批准即丢弃");
    // 可靠投递那一行照旧：回执不改它的状态。
    expect(text).toContain("已排队");
  });

  for (const [state, label] of [
    ["expired", "未送达 · 已过期"],
    ["refused", "未送达 · 被拒绝"],
    ["dropped", "未送达 · 被丢弃"],
    ["denied", "未送达 · 策略拒绝"],
  ] as const) {
    test(`${state}: shown as not delivered, with the do-not-resend hint`, () => {
      const r = renderInbox([inbox(state, { held_at: 1 })], [delivery("d1", "alpha", "queued")]);
      expect(JSON.stringify(r.toJSON())).toContain("1 位未送达");
      const text = expand(r);
      expect(text).toContain(label);
      expect(text).toContain("请勿重发");
      const row = r.root.find((node) => node.props["data-inbox-state"] === state);
      expect(String(row.props.className)).toContain("msg-inbox--not_delivered");
    });
  }

  test("delivered is never rendered as read, replied or a success state", () => {
    const r = renderInbox([inbox("delivered")], [delivery("d1", "alpha", "queued")]);
    const collapsed = JSON.stringify(r.toJSON());
    expect(collapsed).toContain("1 位处理中");
    const text = expand(r);
    expect(text).toContain("已获批准 · 进入对话（尚未回复）");
    expect(text).toContain("这不是回复");
    const row = r.root.find((node) => node.props["data-inbox-state"] === "delivered");
    expect(String(row.props.className)).toContain("msg-inbox--delivered");
    expect(row.findAll((node) => String(node.props.className ?? "").includes("ap-sprite--success"))).toHaveLength(0);
  });

  test("unknown after a hold is shown as unknown, not as delivered or failed", () => {
    const r = renderInbox([inbox("unknown")]);
    const text = expand(r);
    expect(text).toContain("被扣留 · 结局未知");
    expect(text).toContain("不会自动重发");
  });

  test("a reply settles the summary; the receipt stays as history", () => {
    const r = renderInbox([inbox("expired")], [delivery("d1", "alpha", "replied", { reply_seq: 51 })]);
    const collapsed = JSON.stringify(r.toJSON());
    expect(collapsed).not.toContain("未送达");
    expect(collapsed).toContain("1 位已回复");
    expect(expand(r)).toContain("未送达 · 已过期");
  });

  test("the receiver-controlled reason and a third-party reporter are shown as plain text", () => {
    const r = renderInbox([
      inbox("held", { reason: "<img src=x onerror=alert(1)>", reported_by: { name: "relay", kind: "agent" } }),
    ]);
    expand(r);
    const texts = r.root.findAll((node) => node.type === "span").flatMap((node) => node.children).filter((c) => typeof c === "string");
    expect(texts).toContain("接收方说明：<img src=x onerror=alert(1)>");
    expect(texts).toContain("由 owner · relay 上报");
    expect(r.root.findAll((node) => node.type === "img")).toHaveLength(0);
  });

  test("no receipts, `accepted`, an unknown future state, or a malformed field ⇒ nothing new is rendered", () => {
    for (const value of [undefined, [], "held", [inbox("accepted")], [inbox("future_state")], [{ state: "held" }]]) {
      const r = renderInbox(value, [delivery("d1", "alpha", "queued")]);
      expect(JSON.stringify(r.toJSON())).toContain("1 位处理中");
      const text = expand(r);
      expect(text).not.toContain("Claude 收件箱");
      expect(r.root.findAll((node) => node.props["data-inbox-receipts"] !== undefined)).toHaveLength(0);
      act(() => renderer?.unmount());
      renderer = null;
    }
    // 只有 accepted 时连状态条都不出现。
    const r = renderInbox([inbox("accepted")]);
    expect(r.toJSON()).toBeNull();
  });
});
