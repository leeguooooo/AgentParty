// 附件 composer 交互（#176）：附件按钮、待发 chip、纯附件可发、移除回调。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Attachment } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { Composer } from "./Composer";

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
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

const att: Attachment = {
  key: "slug/uuid/pic.png",
  filename: "pic.png",
  content_type: "image/png",
  size: 2048,
  url: "/api/channels/slug/attachments/uuid/pic.png",
};

function render(props: Partial<Parameters<typeof Composer>[0]>) {
  localStorage.setItem("ap_locale", "en");
  const base = {
    draft: "",
    setDraft: () => {},
    onSend: () => {},
    ready: true,
    candidates: [],
    mentionStatuses: [],
  };
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Composer {...base} {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function byClass(root: ReturnType<typeof render>, cls: string) {
  return root.findAll(
    (n) => typeof n.props.className === "string" && n.props.className.split(" ").includes(cls),
  );
}

describe("Composer attachments (#176)", () => {
  test("attach button appears only when onPickFiles is wired", () => {
    expect(byClass(render({}), "composer-attach")).toHaveLength(0);
    expect(byClass(render({ onPickFiles: () => {} }), "composer-attach")).toHaveLength(1);
  });

  test("pending attachment renders a chip with the filename", () => {
    const root = render({ onPickFiles: () => {}, attachments: [att] });
    const names = byClass(root, "composer-attachment-name");
    expect(names).toHaveLength(1);
    expect(names[0]!.props.children).toBe("pic.png");
  });

  test("send is enabled with an attachment even when the draft is empty", () => {
    const root = render({ onPickFiles: () => {}, attachments: [att], draft: "" });
    const send = byClass(root, "composer-send")[0]!;
    expect(send.props.disabled).toBe(false);
  });

  test("with no draft and no attachments, send stays disabled", () => {
    const root = render({ onPickFiles: () => {}, attachments: [], draft: "" });
    expect(byClass(root, "composer-send")[0]!.props.disabled).toBe(true);
  });

  test("remove button invokes onRemoveAttachment with the key", () => {
    let removed: string | null = null;
    const root = render({
      onPickFiles: () => {},
      attachments: [att],
      onRemoveAttachment: (k: string) => {
        removed = k;
      },
    });
    const removeBtn = byClass(root, "composer-attachment-remove")[0]!;
    act(() => removeBtn.props.onClick());
    expect(removed).toBe("slug/uuid/pic.png");
  });
});
