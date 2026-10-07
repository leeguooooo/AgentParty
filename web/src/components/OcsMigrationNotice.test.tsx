// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { OcsMigrationNoticeStrings } from "../i18n/strings/OcsMigrationNotice";
import {
  OCS_INSTALL_PS1,
  OCS_INSTALL_SH,
  OCS_NOTICE_STORAGE_KEY,
  OCS_REPO_URL,
  OcsMigrationNotice,
} from "./OcsMigrationNotice";

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

function mount(locale: "en" | "zh" = "en") {
  localStorage.setItem("ap_locale", locale);
  act(() => {
    renderer = create(
      <LocaleProvider>
        <OcsMigrationNotice />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function unmount() {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
}

function text(): string {
  const json = JSON.stringify(renderer!.toJSON());
  return json;
}

function dismissButtons() {
  return renderer!.root.findAll((n) => n.type === "button");
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(unmount);

describe("OcsMigrationNotice (Agent Party shutdown)", () => {
  test("first view: shows the notice, repo link and both install lines, with no dismiss button", () => {
    mount("en");
    const out = text();
    expect(out).toContain(OcsMigrationNoticeStrings.en["OcsMigrationNotice.title"]!);
    expect(out).toContain(OCS_INSTALL_SH);
    expect(out).toContain(OCS_INSTALL_PS1);
    const hrefs = renderer!.root.findAll((n) => n.type === "a").map((n) => n.props.href);
    expect(hrefs).toEqual([OCS_REPO_URL, "https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md"]);
    expect(dismissButtons()).toHaveLength(0);
    expect(localStorage.getItem(OCS_NOTICE_STORAGE_KEY)).toBe("seen");
  });

  test("states the 2026-10-31 shutdown of the hosted service in both languages", () => {
    for (const locale of ["en", "zh"] as const) {
      const strings = OcsMigrationNoticeStrings[locale];
      expect(strings["OcsMigrationNotice.title"]).toContain("2026-10-31");
      expect(strings["OcsMigrationNotice.lead"]).toContain("agentparty.leeguoo.com");
      expect(strings["OcsMigrationNotice.uninstallUrl"]).toMatch(/docs\/uninstall(\.zh)?\.md$/);
    }
  });

  test("zh copy is used under the zh locale", () => {
    mount("zh");
    expect(text()).toContain(OcsMigrationNoticeStrings.zh["OcsMigrationNotice.title"]!);
    const hrefs = renderer!.root.findAll((n) => n.type === "a").map((n) => n.props.href);
    expect(hrefs).toContain("https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.zh.md");
  });

  test("later views offer dismiss, and dismissal is remembered per browser", () => {
    mount();
    unmount();
    mount();
    const buttons = dismissButtons();
    expect(buttons).toHaveLength(1);
    act(() => buttons[0]!.props.onClick());
    expect(renderer!.toJSON()).toBeNull();
    expect(localStorage.getItem(OCS_NOTICE_STORAGE_KEY)).toBe("dismissed");
    unmount();
    mount();
    expect(renderer!.toJSON()).toBeNull();
  });

  test("unavailable storage still shows the notice (fails visible, not silent)", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        ...memoryStorage(),
        getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("denied"); },
      },
    });
    act(() => {
      renderer = create(
        <LocaleProvider>
          <OcsMigrationNotice />
        </LocaleProvider>,
      );
    });
    expect(text()).toContain(OCS_INSTALL_SH);
    expect(dismissButtons()).toHaveLength(0);
  });
});
