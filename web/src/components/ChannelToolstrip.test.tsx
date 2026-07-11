// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
// @ts-expect-error Bun provides node:fs for this source-level CSS contract test.
import { readFileSync } from "node:fs";
import { LocaleProvider } from "../i18n/locale";

const { ChannelToolstrip } = await import("./ChannelToolstrip");

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
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
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
});

function render(seed: Record<string, string> = {}): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_locale: "en", ...seed }),
  });
  let value!: ReactTestRenderer;
  void act(() => {
    value = create(
      <LocaleProvider>
        <ChannelToolstrip
          buttons={<button type="button">Announcement</button>}
          actions={<button type="button">Notify</button>}
        />
      </LocaleProvider>,
    );
  });
  renderer = value;
  return value;
}

function toggle(r: ReactTestRenderer) {
  return r.root.find((node) => node.props.className === "d-btn chan-toolstrip-toggle");
}

describe("ChannelToolstrip mobile collapse (#202)", () => {
  test("defaults to collapsed while keeping an accessible icon toggle", () => {
    const r = render();
    expect(r.root.findByProps({ "aria-label": "channel tools" }).props.className).toContain("chan-toolstrip--collapsed");
    expect(toggle(r).props["aria-expanded"]).toBe(false);
    expect(toggle(r).props["aria-controls"]).toBe("channel-toolstrip-content");
    expect(toggle(r).findByProps({ className: "ap-sprite ap-sprite--coordination" })).toBeDefined();
  });

  test("expands, collapses, and persists the user's choice", async () => {
    const r = render();
    await act(async () => toggle(r).props.onClick());

    expect(toggle(r).props["aria-expanded"]).toBe(true);
    expect(r.root.findByProps({ "aria-label": "channel tools" }).props.className).toContain("chan-toolstrip--expanded");
    expect(localStorage.getItem("ap_channel_tools_expanded")).toBe("1");

    await act(async () => toggle(r).props.onClick());
    expect(toggle(r).props["aria-expanded"]).toBe(false);
    expect(localStorage.getItem("ap_channel_tools_expanded")).toBe("0");
  });

  test("restores an expanded preference", () => {
    const r = render({ ap_channel_tools_expanded: "1" });
    expect(toggle(r).props["aria-expanded"]).toBe(true);
    expect(r.root.findByProps({ id: "channel-toolstrip-content" })).toBeDefined();
  });

  test("responsive CSS leaves desktop unchanged and hides only mobile collapsed content", () => {
    const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
    expect(css).toContain(".chan-toolstrip-toggle {\n  display: none;");
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip-toggle \{[\s\S]*display: inline-flex;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip--collapsed \.chan-toolstrip-content \{\s*display: none;/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.chan-toolstrip-content \{[\s\S]*overflow-x: auto;/);
  });
});
