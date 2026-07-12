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
  // #377 图片缩略图路径会走 getToken()（读 session/local storage）；单测无 DOM，补桩避免 ReferenceError。
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
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

function fileList(...files: File[]): FileList {
  return files as unknown as FileList;
}

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

  test("non-image pending attachment renders a chip with the filename", () => {
    const docAtt: Attachment = { ...att, key: "slug/uuid/spec.pdf", filename: "spec.pdf", content_type: "application/pdf" };
    const root = render({ onPickFiles: () => {}, attachments: [docAtt] });
    const names = byClass(root, "composer-attachment-name");
    expect(names).toHaveLength(1);
    expect(names[0]!.props.children).toBe("spec.pdf");
  });

  test("image pending attachment renders a thumbnail preview with a remove button (#377)", () => {
    const root = render({ onPickFiles: () => {}, attachments: [att], onRemoveAttachment: () => {} });
    // 图片走缩略图路径（composer-attachment--img），不再是文件名 chip
    expect(byClass(root, "composer-attachment--img")).toHaveLength(1);
    expect(byClass(root, "composer-attachment-name")).toHaveLength(0);
    expect(byClass(root, "composer-attachment-remove")).toHaveLength(1);
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

  test("dropping files onto the composer forwards them to onPickFiles", () => {
    let dropped: FileList | null = null;
    const root = render({ onPickFiles: (f: FileList) => { dropped = f; } });
    const composer = byClass(root, "composer")[0]!;
    const file = new File([new Uint8Array([1, 2, 3])], "drop.png", { type: "image/png" });
    act(() =>
      composer.props.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: fileList(file) } }),
    );
    expect(dropped).not.toBeNull();
    expect(dropped![0]!.name).toBe("drop.png");
  });

  test("pasting an image forwards it to onPickFiles", () => {
    let pasted: FileList | null = null;
    const root = render({ onPickFiles: (f: FileList) => { pasted = f; } });
    const textarea = byClass(root, "composer-input")[0]!;
    const file = new File([new Uint8Array([1, 2, 3])], "clip.png", { type: "image/png" });
    act(() => textarea.props.onPaste({ preventDefault() {}, clipboardData: { files: fileList(file) } }));
    expect(pasted).not.toBeNull();
    expect(pasted![0]!.name).toBe("clip.png");
  });

  test("pasting plain text (no files) does not call onPickFiles", () => {
    let called = false;
    const root = render({ onPickFiles: () => { called = true; } });
    const textarea = byClass(root, "composer-input")[0]!;
    act(() => textarea.props.onPaste({ preventDefault() {}, clipboardData: { files: fileList() } }));
    expect(called).toBe(false);
  });

  test("an in-flight upload renders a chip with its filename", () => {
    const root = render({
      onPickFiles: () => {},
      uploads: [{ id: "u1", filename: "up.png", size: 1234, status: "uploading" }],
    });
    const names = byClass(root, "composer-upload-name");
    expect(names).toHaveLength(1);
    expect(names[0]!.props.children).toBe("up.png");
  });

  test("a failed upload shows a retry button that calls onRetryUpload with the id", () => {
    let retried: string | null = null;
    const root = render({
      onPickFiles: () => {},
      uploads: [{ id: "u2", filename: "bad.png", size: 10, status: "error", error: "file too large (max 25MB)" }],
      onRetryUpload: (id: string) => { retried = id; },
    });
    const retry = byClass(root, "composer-upload-retry")[0]!;
    act(() => retry.props.onClick());
    expect(retried).toBe("u2");
  });

  test("send is disabled while an upload is in flight, even with draft text", () => {
    const root = render({
      onPickFiles: () => {},
      draft: "hi",
      uploads: [{ id: "u3", filename: "wip.png", size: 10, status: "uploading" }],
    });
    expect(byClass(root, "composer-send")[0]!.props.disabled).toBe(true);
  });
});
