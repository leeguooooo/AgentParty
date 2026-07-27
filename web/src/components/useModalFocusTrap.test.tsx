// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useModalFocusTrap } from "./useModalFocusTrap";

class TestEventTarget {
  private listeners = new Map<string, Set<(event: KeyboardEvent) => void>>();

  addEventListener(type: string, listener: (event: KeyboardEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: KeyboardEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(event: Partial<KeyboardEvent> & { key: string }) {
    for (const listener of this.listeners.get("keydown") ?? []) listener(event as KeyboardEvent);
  }

  count() {
    return this.listeners.get("keydown")?.size ?? 0;
  }
}

interface FocusTarget extends Partial<HTMLElement> {
  id: string;
  focus(): void;
}

let renderer: ReactTestRenderer | null = null;
let events: TestEventTarget;
let activeElement: FocusTarget | null;
let focusOrder: string[];
let focusables: FocusTarget[];
let container: FocusTarget & Pick<HTMLElement, "contains" | "querySelectorAll">;
let initial: FocusTarget;

function target(id: string): FocusTarget {
  const node: FocusTarget = {
    id,
    isConnected: true,
    closest: () => null,
    focus: () => {
      activeElement = node;
      focusOrder.push(id);
    },
  };
  return node;
}

function Harness({
  active,
  onEscape,
  useInitial = false,
}: {
  active: boolean;
  onEscape(): void;
  useInitial?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusTrap({
    active,
    containerRef: dialogRef,
    initialFocusRef: useInitial ? initialRef : undefined,
    onEscape,
  });

  if (!active) return null;
  return (
    <div ref={dialogRef} className="dialog" tabIndex={-1}>
      <button ref={initialRef} className="initial" type="button">close</button>
    </div>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  act(() => {
    renderer = create(<Harness {...props} />, {
      createNodeMock(element) {
        const props = element.props as { className?: string };
        if (props.className === "dialog") return container;
        if (props.className === "initial") return initial;
        return {};
      },
    });
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  events = new TestEventTarget();
  activeElement = null;
  focusOrder = [];
  focusables = [target("first"), target("last")];
  initial = target("initial");
  container = Object.assign(target("dialog"), {
    contains: (candidate: Node | null) =>
      candidate === container || candidate === initial || focusables.includes(candidate as FocusTarget),
    querySelectorAll: () => focusables,
  }) as FocusTarget & Pick<HTMLElement, "contains" | "querySelectorAll">;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get activeElement() {
        return activeElement;
      },
    },
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
});

describe("useModalFocusTrap", () => {
  test("moves focus in, wraps Tab in both directions, and restores the launcher", () => {
    const launcher = target("launcher");
    activeElement = launcher;
    renderHarness({ active: true, onEscape: () => {}, useInitial: true });

    expect(activeElement).toBe(initial);
    expect(focusOrder).toEqual(["initial"]);
    expect(events.count()).toBe(1);

    activeElement = focusables[1]!;
    let prevented = 0;
    act(() => events.emit({ key: "Tab", shiftKey: false, preventDefault: () => { prevented += 1; } }));
    expect(activeElement).toBe(focusables[0]);

    activeElement = focusables[0]!;
    act(() => events.emit({ key: "Tab", shiftKey: true, preventDefault: () => { prevented += 1; } }));
    expect(activeElement).toBe(focusables[1]);
    expect(prevented).toBe(2);

    act(() => renderer?.update(<Harness active={false} onEscape={() => {}} useInitial />));
    expect(activeElement).toBe(launcher);
    expect(events.count()).toBe(0);
  });

  test("uses the latest Escape callback without re-arming the trap", () => {
    let first = 0;
    let second = 0;
    renderHarness({ active: true, onEscape: () => { first += 1; } });
    expect(events.count()).toBe(1);

    act(() => renderer?.update(<Harness active onEscape={() => { second += 1; }} />));
    expect(events.count()).toBe(1);
    act(() => events.emit({ key: "Escape" }));

    expect(first).toBe(0);
    expect(second).toBe(1);
  });

  test("falls back to the dialog when it has no focusable children", () => {
    focusables = [];
    renderHarness({ active: true, onEscape: () => {} });
    expect(activeElement).toBe(container);

    let prevented = 0;
    act(() => events.emit({ key: "Tab", preventDefault: () => { prevented += 1; } }));
    expect(prevented).toBe(1);
    expect(activeElement).toBe(container);
  });
});
