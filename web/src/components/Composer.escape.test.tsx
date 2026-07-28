// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { Composer } from "./Composer";

let renderer: ReactTestRenderer | null = null;

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
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerHeight: 844 } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function render(onEscape: () => void) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Composer
          draft="@a"
          setDraft={() => undefined}
          onSend={() => undefined}
          onEscape={onEscape}
          ready
          candidates={[{ name: "alice", display: "Alice", kind: "agent", tier: "online", group: "unowned agents" }]}
          mentionStatuses={[]}
        />
      </LocaleProvider>,
    );
  });
  const textarea = renderer!.root.findByProps({ className: "composer-input t-mono" });
  return { root: renderer!.root, textarea };
}

function keyEvent(key: string, isComposing = false) {
  return { key, preventDefault() {}, nativeEvent: { isComposing }, shiftKey: false, metaKey: false, ctrlKey: false };
}

describe("Composer Escape handling (#357)", () => {
  test("searching a human shows the readable owner group and all of that human's agents", () => {
    const account = "lark:on_luis";
    const candidates = [
      {
        name: "luis",
        display: "Luis",
        kind: "human" as const,
        tier: "online" as const,
        group: account,
        account,
        ownerDisplay: "Luis",
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        name: `agent-${index + 1}`,
        display: `agent-${index + 1}`,
        kind: "agent" as const,
        tier: "recent" as const,
        group: account,
        account,
        ownerDisplay: "Luis",
      })),
    ];
    act(() => {
      renderer = create(
        <LocaleProvider>
          <Composer
            draft="@luis"
            setDraft={() => undefined}
            onSend={() => undefined}
            ready
            candidates={candidates}
            mentionStatuses={[]}
          />
        </LocaleProvider>,
      );
    });

    const textarea = renderer!.root.findByProps({ className: "composer-input t-mono" });
    act(() => textarea.props.onClick({ currentTarget: { value: "@luis", selectionStart: 5 } }));

    expect(renderer!.root.findAllByProps({ role: "option" })).toHaveLength(11);
    expect(renderer!.root.findAllByProps({ className: "mention-group" })[0]?.children).toEqual(["Luis"]);
    expect(renderer!.root.findAllByProps({ className: "mention-owner t-mono" })).toHaveLength(10);
  });

  test("typing an owner after the full menu cannot retain another owner's duplicate session rows", () => {
    const luisAccount = "lark:on_luis";
    const wangAccount = "lark:on_wang";
    const candidates = [
      {
        name: "karl",
        display: "karl",
        kind: "human" as const,
        tier: "recent" as const,
        group: wangAccount,
        account: wangAccount,
        ownerDisplay: "王路",
      },
      {
        name: "karl",
        display: "karl",
        kind: "human" as const,
        tier: "recent" as const,
        group: wangAccount,
        account: wangAccount,
        ownerDisplay: "王路",
      },
      {
        name: "luis",
        display: "Luis",
        kind: "human" as const,
        tier: "online" as const,
        group: luisAccount,
        account: luisAccount,
        ownerDisplay: "Luis",
      },
      {
        name: "奥创",
        display: "奥创",
        kind: "agent" as const,
        tier: "recent" as const,
        group: luisAccount,
        account: luisAccount,
        ownerDisplay: "Luis",
      },
    ];
    act(() => {
      renderer = create(
        <LocaleProvider>
          <Composer
            draft="@"
            setDraft={() => undefined}
            onSend={() => undefined}
            ready
            candidates={candidates}
            mentionStatuses={[]}
          />
        </LocaleProvider>,
      );
    });

    const textarea = renderer!.root.findByProps({ className: "composer-input t-mono" });
    act(() => textarea.props.onClick({ currentTarget: { value: "@", selectionStart: 1 } }));
    expect(renderer!.root.findAllByProps({ role: "option" })).toHaveLength(3);

    act(() => textarea.props.onChange({ target: { value: "@luis", selectionStart: 5 } }));
    expect(
      renderer!.root.findAllByProps({ className: "mention-name t-mono" }).map((node) => node.children[0]),
    ).toEqual(["Luis", "奥创"]);
    expect(renderer!.root.findAllByProps({ className: "mention-group" }).map((node) => node.children[0])).toEqual([
      "Luis",
    ]);
  });

  test("focuses and reveals the composer when reply mode starts", () => {
    const focus = mock(() => undefined);
    const scrollIntoView = mock(() => undefined);
    const composer = (focusRequest: number | null) => (
      <LocaleProvider>
        <Composer
          draft=""
          setDraft={() => undefined}
          onSend={() => undefined}
          focusRequest={focusRequest}
          ready
          candidates={[]}
          mentionStatuses={[]}
        />
      </LocaleProvider>
    );

    act(() => {
      renderer = create(
        composer(null),
        {
          createNodeMock: (element) =>
            element.type === "textarea"
              && (element.props as { className?: string }).className?.includes("composer-input") === true
              ? { focus, scrollIntoView, style: {}, scrollHeight: 80 }
              : {},
        },
      );
    });

    expect(focus).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => renderer!.update(composer(3)));

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  test("mention menu consumes the first Escape before reply cancellation", () => {
    let cancelled = 0;
    const { root, textarea } = render(() => { cancelled += 1; });
    act(() => textarea.props.onClick({ currentTarget: { value: "@a", selectionStart: 2 } }));
    expect(root.findAllByProps({ role: "listbox" })).toHaveLength(1);

    act(() => textarea.props.onKeyDown(keyEvent("Escape")));
    expect(root.findAllByProps({ role: "listbox" })).toHaveLength(0);
    expect(cancelled).toBe(0);

    act(() => textarea.props.onKeyDown(keyEvent("Escape")));
    expect(cancelled).toBe(1);
  });

  test("IME composition does not close mentions or cancel reply mode", () => {
    let cancelled = 0;
    const { root, textarea } = render(() => { cancelled += 1; });
    act(() => textarea.props.onClick({ currentTarget: { value: "@a", selectionStart: 2 } }));

    act(() => textarea.props.onKeyDown(keyEvent("Escape", true)));
    expect(root.findAllByProps({ role: "listbox" })).toHaveLength(1);
    expect(cancelled).toBe(0);
  });
});
