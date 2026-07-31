// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import "../i18n/strings/Channel";
import type { CatchupDigest, CatchupItem } from "../lib/digest";
import { CatchupPanel } from "./CatchupPanel";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function item(seq: number, kind: CatchupItem["kind"], attention: boolean): CatchupItem {
  return { seq, kind, attention, text: `message ${seq}` };
}

function digest(overrides: Partial<CatchupDigest> = {}): CatchupDigest {
  const attentionItems = [item(12, "mention", true)];
  const updateItems = [item(11, "done", false), item(10, "reply", false)];
  return {
    messages: 3,
    mentions: 1,
    openMentions: 1,
    respondedMentions: 0,
    statuses: 1,
    blocked: 0,
    done: 1,
    replies: 1,
    releases: 0,
    issues: 0,
    questions: 0,
    items: [...attentionItems, ...updateItems],
    attentionItems,
    updateItems,
    attentionCount: 1,
    updateCount: 2,
    ...overrides,
  };
}

function render(panelDigest: CatchupDigest): ReactTestInstance {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <CatchupPanel
          digest={panelDigest}
          seenSeq={9}
          latestSeq={12}
          onCaughtUp={() => undefined}
          onJump={() => undefined}
        />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function byClass(root: ReactTestInstance, className: string): ReactTestInstance[] {
  return root.findAll((node) => String(node.props.className ?? "").split(/\s+/).includes(className));
}

describe("CatchupPanel priority disclosure", () => {
  test("keeps attention visible and collapses routine updates until requested", () => {
    const root = render(digest());
    expect(byClass(root, "catchup-group--attention")).toHaveLength(1);
    expect(byClass(root, "catchup-group")).toHaveLength(1);

    const toggle = byClass(root, "catchup-updates-toggle")[0]!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    act(() => toggle.props.onClick());

    expect(byClass(root, "catchup-updates-toggle")[0]!.props["aria-expanded"]).toBe(true);
    expect(byClass(root, "catchup-group")).toHaveLength(2);
  });

  test("shows routine updates immediately when nothing needs attention", () => {
    const root = render(digest({
      attentionItems: [],
      attentionCount: 0,
      items: [item(11, "done", false), item(10, "reply", false)],
    }));
    expect(byClass(root, "catchup-group--attention")).toHaveLength(0);
    expect(byClass(root, "catchup-updates-toggle")[0]!.props["aria-expanded"]).toBe(true);
    expect(byClass(root, "catchup-group")).toHaveLength(1);
  });

  test("keeps detailed counts behind a secondary disclosure", () => {
    const root = render(digest());
    const details = byClass(root, "catchup-stats")[0]!;
    expect(details.type).toBe("details");
    expect(byClass(root, "catchup-priority-summary")).toHaveLength(1);
  });
});
