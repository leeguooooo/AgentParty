// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { SettingsPanel, type SettingsMe } from "./SettingsPanel";

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
let store: Storage;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  store = memoryStorage({ ap_locale: "en" });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
});

const me: SettingsMe = { name: "alice", kind: "agent", role: "agent", handle: null, display_name: null, owner: null };

function render(props: Parameters<typeof SettingsPanel>[0]): ReactTestRenderer {
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(<LocaleProvider><SettingsPanel {...props} /></LocaleProvider>);
  });
  renderer = r;
  return r;
}
function findByClass(node: unknown, target: string): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { props?: Record<string, unknown>; children?: unknown };
  const cls = n.props?.className;
  if (typeof cls === "string" && cls.split(" ").includes(target)) return n as { props: Record<string, unknown> };
  const kids = n.children;
  if (Array.isArray(kids)) { for (const k of kids) { const hit = findByClass(k, target); if (hit) return hit; } }
  else if (kids) { const hit = findByClass(kids, target); if (hit) return hit; }
  return null;
}
function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(" ");
}

describe("SettingsPanel (#273)", () => {
  test("renders language, notifications, and account sections", () => {
    const txt = allText(render({ me, onClose: () => {}, onLogout: () => {} }));
    expect(txt).toContain("Settings");
    expect(txt).toContain("Language");
    expect(txt).toContain("@-mention notifications");
    expect(txt).toContain("Account");
    expect(txt).toContain("alice");
  });

  test("notification toggle writes ap_notify_optin to localStorage", () => {
    const r = render({ me, onClose: () => {}, onLogout: () => {} });
    expect(store.getItem("ap_notify_optin")).toBe(null);
    const toggle = findByClass(r.toJSON(), "settings-toggle");
    expect(toggle).not.toBeNull();
    void act(() => { (toggle!.props.onClick as () => void)(); });
    expect(store.getItem("ap_notify_optin")).toBe("1");
    // 再点一次关掉
    const toggle2 = findByClass(r.toJSON(), "settings-toggle");
    void act(() => { (toggle2!.props.onClick as () => void)(); });
    expect(store.getItem("ap_notify_optin")).toBe(null);
  });

  test("no account section / logout when me is null", () => {
    const txt = allText(render({ me: null, onClose: () => {}, onLogout: null }));
    expect(txt).toContain("Language");
    expect(txt).not.toContain("Account");
  });
});
