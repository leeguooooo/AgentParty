// 显式粘贴入口（#1102）：安全上下文读剪贴板进草稿；非安全上下文不碰 Clipboard API 并说明原因；
// 拒绝/空剪贴板给错误文案且草稿不变；带文件走 onPickFiles。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { Composer, type ClipboardPayload } from "./Composer";

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

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
  // 自动增高的 layout effect 读 window.innerHeight；单测无 DOM，补最小桩。
  Object.defineProperty(globalThis, "window", { configurable: true, value: { innerHeight: 800 } });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  delete (globalThis as { window?: unknown }).window;
});

function render(props: Partial<Parameters<typeof Composer>[0]>, caret?: { start: number; end: number }) {
  localStorage.setItem("ap_locale", "en");
  const base = { draft: "", setDraft: () => {}, onSend: () => {}, ready: true, candidates: [], mentionStatuses: [] };
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Composer {...base} {...props} />
      </LocaleProvider>,
      {
        createNodeMock: (el) =>
          el.type === "textarea"
            ? {
                style: {},
                scrollHeight: 0,
                selectionStart: caret?.start ?? 0,
                selectionEnd: caret?.end ?? 0,
                focus() {},
                scrollIntoView() {},
                setSelectionRange() {},
              }
            : null,
      },
    );
  });
  return renderer!.root;
}

function byClass(root: ReturnType<typeof render>, cls: string) {
  return root.findAll((n) => typeof n.props.className === "string" && n.props.className.split(" ").includes(cls));
}

function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  const n = node as { children?: unknown[] };
  return (n.children ?? []).map(textOf).join("");
}

function pasteButton(root: ReturnType<typeof render>) {
  return byClass(root, "composer-paste").find((n) => n.type === "button");
}

async function clickPaste(root: ReturnType<typeof render>) {
  const btn = pasteButton(root);
  expect(btn).toBeDefined();
  await act(async () => {
    btn!.props.onClick();
    await new Promise((r) => setTimeout(r, 0));
  });
}

const payload = (text: string, files: File[] = []): ClipboardPayload => ({ text, files });

describe("Composer paste button (#1102)", () => {
  test("secure context: clipboard text fills an empty draft", async () => {
    const drafts: string[] = [];
    let reads = 0;
    const root = render({
      secureContext: true,
      setDraft: (v) => drafts.push(v),
      readClipboard: async () => { reads += 1; return payload("hello from clipboard"); },
    });
    await clickPaste(root);
    expect(reads).toBe(1);
    expect(drafts).toEqual(["hello from clipboard"]);
    expect(byClass(root, "composer-paste-error")).toHaveLength(0);
  });

  test("secure context: text is inserted at the caret of a non-empty draft", async () => {
    const drafts: string[] = [];
    const root = render(
      { secureContext: true, draft: "ab", setDraft: (v) => drafts.push(v), readClipboard: async () => payload("XY") },
      { start: 1, end: 1 },
    );
    await clickPaste(root);
    expect(drafts).toEqual(["aXYb"]);
  });

  test("secure context: permission denial shows an error and leaves the draft alone", async () => {
    const drafts: string[] = [];
    const root = render({
      secureContext: true,
      draft: "keep",
      setDraft: (v) => drafts.push(v),
      readClipboard: async () => { throw new Error("NotAllowedError"); },
    });
    await clickPaste(root);
    expect(drafts).toEqual([]);
    const err = byClass(root, "composer-paste-error");
    expect(err).toHaveLength(1);
    expect(textOf(err[0])).toContain("denied");
  });

  test("secure context: empty clipboard shows an error, draft untouched", async () => {
    const drafts: string[] = [];
    const root = render({ secureContext: true, setDraft: (v) => drafts.push(v), readClipboard: async () => payload("") });
    await clickPaste(root);
    expect(drafts).toEqual([]);
    expect(textOf(byClass(root, "composer-paste-error")[0])).toBe("clipboard is empty");
  });

  test("clipboard files go through onPickFiles, not into the draft", async () => {
    const drafts: string[] = [];
    const picked: FileList[] = [];
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const root = render({
      secureContext: true,
      setDraft: (v) => drafts.push(v),
      onPickFiles: (f) => picked.push(f),
      readClipboard: async () => payload("", [file]),
    });
    await clickPaste(root);
    expect(picked).toHaveLength(1);
    expect(picked[0]![0]).toBe(file);
    expect(drafts).toEqual([]);
    expect(byClass(root, "composer-paste-error")).toHaveLength(0);
  });

  test("insecure context (http://IP): never calls the clipboard API and explains why", async () => {
    const drafts: string[] = [];
    let reads = 0;
    const root = render({
      secureContext: false,
      setDraft: (v) => drafts.push(v),
      readClipboard: async () => { reads += 1; return payload("should not arrive"); },
    });
    const btn = pasteButton(root)!;
    expect(btn.props["aria-disabled"]).toBe(true);
    expect(btn.props.title).toContain("Cmd/Ctrl+V");
    await clickPaste(root);
    expect(reads).toBe(0);
    expect(drafts).toEqual([]);
    const err = byClass(root, "composer-paste-error");
    expect(err).toHaveLength(1);
    expect(textOf(err[0])).toContain("Cmd/Ctrl+V");
    expect(textOf(err[0])).toContain("domain");
  });
  test("desktop bridge: an insecure (http://IP) page still pastes through the native clipboard", async () => {
    const drafts: string[] = [];
    let webReads = 0;
    let nativeReads = 0;
    const root = render({
      secureContext: false,
      setDraft: (v) => drafts.push(v),
      readClipboard: async () => { webReads += 1; return payload("web"); },
      nativeClipboard: async () => { nativeReads += 1; return "from native"; },
    });
    const btn = pasteButton(root)!;
    expect(btn.props["aria-disabled"]).toBeUndefined();
    await clickPaste(root);
    expect(nativeReads).toBe(1);
    expect(webReads).toBe(0);
    expect(drafts).toEqual(["from native"]);
    expect(byClass(root, "composer-paste-error")).toHaveLength(0);
  });

  test("desktop bridge failure shows the denied error, draft untouched", async () => {
    const drafts: string[] = [];
    const root = render({
      secureContext: false,
      setDraft: (v) => drafts.push(v),
      nativeClipboard: async () => { throw new Error("not allowed"); },
    });
    await clickPaste(root);
    expect(drafts).toEqual([]);
    expect(textOf(byClass(root, "composer-paste-error")[0])).toContain("denied");
  });
});
