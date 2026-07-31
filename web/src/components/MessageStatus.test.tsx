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
