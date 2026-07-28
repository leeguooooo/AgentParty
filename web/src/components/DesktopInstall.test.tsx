// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import {
  DesktopInstallPrompt,
  PROMPT_DISMISSED_AT_KEY,
  PROMPT_REPEAT_MS,
} from "./DesktopInstall";

const originalDateNow = Date.now;
let renderer: ReactTestRenderer | null = null;
let now = 1_800_000_000_000;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  now = 1_800_000_000_000;
  Date.now = () => now;
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Date.now = originalDateNow;
});

async function renderPrompt(storage: Pick<Storage, "getItem" | "setItem">, desktop = false) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      ...storage,
      removeItem: () => {},
    },
  });
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <DesktopInstallPrompt desktop={desktop} />
      </LocaleProvider>,
    );
  });
}

describe("DesktopInstallPrompt", () => {
  test("shows in the web runtime when it has not been dismissed", async () => {
    await renderPrompt({ getItem: () => null, setItem: () => {} });

    expect(renderer!.root.findByType("aside").props.className).toBe("desktop-install-prompt");
  });

  test("stays hidden for seven days after dismissal and returns when the interval expires", async () => {
    const values = new Map<string, string>([
      [PROMPT_DISMISSED_AT_KEY, String(now - PROMPT_REPEAT_MS + 1)],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    await renderPrompt(storage);
    expect(renderer!.toJSON()).toBeNull();

    await act(async () => renderer?.unmount());
    renderer = null;
    values.set(PROMPT_DISMISSED_AT_KEY, String(now - PROMPT_REPEAT_MS));
    await renderPrompt(storage);
    expect(renderer!.root.findByType("aside")).toBeTruthy();
  });

  test("falls back to showing when storage cannot be read", async () => {
    await renderPrompt({
      getItem: () => { throw new Error("storage unavailable"); },
      setItem: () => {},
    });

    expect(renderer!.root.findByType("aside")).toBeTruthy();
  });

  test("dismisses for the current page even when storage cannot be written", async () => {
    await renderPrompt({
      getItem: () => null,
      setItem: () => { throw new Error("storage unavailable"); },
    });
    const dismiss = renderer!.root.find(
      (node) => node.type === "button" && node.props.className === "desktop-install-prompt-dismiss",
    );
    await act(async () => dismiss.props.onClick());

    expect(renderer!.toJSON()).toBeNull();
  });

  test("never renders inside the desktop runtime", async () => {
    await renderPrompt({ getItem: () => null, setItem: () => {} }, true);

    expect(renderer!.toJSON()).toBeNull();
  });
});
