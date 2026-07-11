// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { useT } from "../i18n/useT";
import { FeatureTip } from "./FeatureTip";
import { TipsStrings } from "../i18n/strings/Tips";

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

function render(locale: "en" | "zh", tip: string) {
  localStorage.setItem("ap_locale", locale);
  act(() => {
    renderer = create(
      <LocaleProvider>
        <FeatureTip tip={tip} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function bubbleText(): string {
  const bubble = renderer!.root.find((n) => n.props.role === "tooltip");
  const kids = bubble.props.children;
  return Array.isArray(kids) ? kids.join("") : String(kids);
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

describe("FeatureTip (#145)", () => {
  test("renders a role=tooltip bubble carrying the resolved copy", () => {
    render("en", "Tips.wake");
    expect(bubbleText()).toBe(TipsStrings.en["Tips.wake"]);
  });

  test("resolves copy through the real dict path for zh", () => {
    render("zh", "Tips.wake");
    expect(bubbleText()).toBe(TipsStrings.zh["Tips.wake"]);
  });

  test("exposes an accessible help trigger with an aria-label", () => {
    const root = render("en", "Tips.notify");
    const trigger = root
      .findAll((n) => n.type === "button")
      .find((n) => n.props.className?.includes("feature-tip-dot"));
    if (!trigger) throw new Error("feature-tip trigger not rendered");
    expect(trigger.props["aria-label"]).toBe(TipsStrings.en["Tips.ariaHelp"]);
    // trigger points at the bubble so screen readers associate the two
    const bubble = root.find((n) => n.props.role === "tooltip");
    expect(trigger.props["aria-describedby"]).toBe(bubble.props.id);
  });
});

describe("Tips i18n (#145)", () => {
  const KEYS = ["Tips.wake", "Tips.notify", "Tips.visibility", "Tips.ariaHelp"];

  test("every tip key is present in both en and zh", () => {
    for (const key of KEYS) {
      expect(TipsStrings.en[key], `en missing ${key}`).toBeTruthy();
      expect(TipsStrings.zh[key], `zh missing ${key}`).toBeTruthy();
    }
  });

  test("zh copy is real Chinese, not the English string copied over", () => {
    for (const key of KEYS) {
      expect(TipsStrings.zh[key], `zh copied en for ${key}`).not.toBe(TipsStrings.en[key]);
    }
  });

  function Probe({ tkey }: { tkey: string }) {
    const t = useT();
    return t(tkey);
  }

  function renderT(locale: "en" | "zh", tkey: string): string {
    localStorage.setItem("ap_locale", locale);
    act(() => {
      renderer = create(
        <LocaleProvider>
          <Probe tkey={tkey} />
        </LocaleProvider>,
      );
    });
    const json = renderer!.toJSON();
    return typeof json === "string" ? json : Array.isArray(json) ? json.join("") : "";
  }

  test("renders zh copy through the real useT path", () => {
    expect(renderT("zh", "Tips.visibility")).toBe(TipsStrings.zh["Tips.visibility"]);
    expect(renderT("en", "Tips.visibility")).toBe(TipsStrings.en["Tips.visibility"]);
  });
});
