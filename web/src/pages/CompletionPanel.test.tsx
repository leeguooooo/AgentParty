// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { MsgFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { CompletionPanel } from "./Channel";

let renderer: ReactTestRenderer | null = null;
let originalActEnvironment: PropertyDescriptor | undefined;
let originalLocalStorage: PropertyDescriptor | undefined;

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

function completion(seq = 9): MsgFrame {
  return {
    type: "msg",
    kind: "status",
    seq,
    ts: 1,
    sender: { name: "worker-a", kind: "agent" },
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    body: "done",
    completion_artifact: {
      kind: "final_synthesis",
      kickoff_seq: 1,
      replies_count: 1,
      timeout: false,
      related_issues: [],
      related_prs: [],
    },
  } as MsgFrame;
}

beforeEach(() => {
  originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  if (renderer !== null) {
    act(() => renderer!.unmount());
    renderer = null;
  }
  if (originalActEnvironment === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  else Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
  if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
});

describe("CompletionPanel", () => {
  test("keeps the active completion filter switch available while search hides completion rows", () => {
    let toggles = 0;
    act(() => {
      renderer = create(
        <LocaleProvider>
          <CompletionPanel
            completions={[completion()]}
            visible={1}
            enabled
            showItems={false}
            onToggle={() => { toggles += 1; }}
            onJump={() => {}}
          />
        </LocaleProvider>,
      );
    });

    expect(renderer!.root.findAllByProps({ className: "completion-list" })).toHaveLength(0);
    const toggle = renderer!.root.findByProps({ className: "d-btn completion-toggle is-active" });
    act(() => toggle.props.onClick());
    expect(toggles).toBe(1);
  });

  test("keeps the off switch even if the loaded completion window becomes empty", () => {
    act(() => {
      renderer = create(
        <LocaleProvider>
          <CompletionPanel
            completions={[]}
            visible={0}
            enabled
            showItems={false}
            onToggle={() => {}}
            onJump={() => {}}
          />
        </LocaleProvider>,
      );
    });

    expect(renderer!.root.findByProps({ className: "d-btn completion-toggle is-active" })).toBeTruthy();
  });
});
