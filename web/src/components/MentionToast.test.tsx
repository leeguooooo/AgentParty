// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { MentionHeaderNotice, MentionToast, type MentionToastItem } from "./MentionToast";

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k, v); },
    removeItem: (k) => { values.delete(k); },
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: "en" }) });
  // ToastCard 的 useEffect 用 window.setTimeout；bun test 无 DOM window，指向 globalThis 的定时器。
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
});

// 找到 className 含 target 的第一个节点，返回其 props
function findByClass(node: unknown, target: string): Record<string, unknown> | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { props?: Record<string, unknown>; children?: unknown };
  const cls = n.props?.className;
  if (typeof cls === "string" && cls.split(" ").includes(target)) return n.props!;
  const kids = n.children;
  if (Array.isArray(kids)) {
    for (const k of kids) { const hit = findByClass(k, target); if (hit) return hit; }
  } else if (kids) {
    const hit = findByClass(kids, target); if (hit) return hit;
  }
  return null;
}

describe("MentionToast 悬停看全文 (#280)", () => {
  test("toast body 把完整正文挂到 title 上（body 只显截断预览）", () => {
    const item: MentionToastItem = {
      seq: 1,
      sender: { name: "alice", kind: "agent" },
      body: "这是截断的预览…",
      fullBody: "这是完整的很长很长的正文，悬停时应该能看到全部内容而不是被截断的预览。",
    };
    void act(() => {
      renderer = create(
        <LocaleProvider>
          <MentionToast items={[item]} channel="dev" identityDisplay={{}} onJump={() => {}} onDismiss={() => {}} />
        </LocaleProvider>,
      );
    });
    const bodyProps = findByClass(renderer!.toJSON(), "mention-toast-body");
    expect(bodyProps).not.toBeNull();
    // #280 核心：完整正文挂在 title 上（悬停可见），可见文本仍是截断预览
    expect(bodyProps!.title).toBe(item.fullBody);
  });

  test("缺 fullBody 时 title 回退到 body（向后兼容）", () => {
    const item: MentionToastItem = { seq: 2, sender: { name: "bob", kind: "agent" }, body: "short" };
    void act(() => {
      renderer = create(
        <LocaleProvider>
          <MentionToast items={[item]} channel="dev" identityDisplay={{}} onJump={() => {}} onDismiss={() => {}} />
        </LocaleProvider>,
      );
    });
    const bodyProps = findByClass(renderer!.toJSON(), "mention-toast-body");
    expect(bodyProps!.title).toBe("short");
  });
});

describe("MentionHeaderNotice (#476)", () => {
  test("renders the latest mention in one header notice with a backlog count", () => {
    const items: MentionToastItem[] = [
      { seq: 1, sender: { name: "alice", kind: "agent" }, body: "first" },
      { seq: 2, sender: { name: "bob", kind: "agent" }, body: "second", fullBody: "second full body" },
    ];
    const jumps: number[] = [];
    const dismisses: number[] = [];
    void act(() => {
      renderer = create(
        <LocaleProvider>
          <MentionHeaderNotice
            items={items}
            channel="dev"
            identityDisplay={{}}
            onJump={(seq) => jumps.push(seq)}
            onDismiss={(seq) => dismisses.push(seq)}
          />
        </LocaleProvider>,
      );
    });

    const root = renderer!.root;
    const jump = root.findByProps({ className: "mention-header-jump" });
    expect(jump.props.title).toBe("second full body");
    expect(root.findByProps({ className: "mention-header-title" }).children.join("")).toContain("bob mentioned you in #dev");
    expect(root.findByProps({ className: "t-mono mention-header-count" }).children.join("")).toBe("+1");

    void act(() => jump.props.onClick());
    expect(jumps).toEqual([2]);

    const dismiss = root.findByProps({ className: "mention-header-dismiss" });
    void act(() => dismiss.props.onClick());
    expect(dismisses).toEqual([2]);
  });

  test("renders nothing when there are no mentions", () => {
    void act(() => {
      renderer = create(
        <LocaleProvider>
          <MentionHeaderNotice items={[]} channel="dev" identityDisplay={{}} onJump={() => {}} onDismiss={() => {}} />
        </LocaleProvider>,
      );
    });

    expect(renderer!.toJSON()).toBeNull();
  });
});
