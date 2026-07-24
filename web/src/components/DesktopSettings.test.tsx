// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopSettingsStrings } from "../i18n/strings/DesktopSettings";
import {
  applyAutostartSetting,
  DesktopSettings,
  DesktopSettingsPanel,
  isDesktopSettingsOutsideClick,
  loadAutostartSetting,
  loadDesktopVersionInfo,
  shouldDismissDesktopSettings,
  type DesktopSettingsRuntime,
  updateDesktopSettingsFocus,
} from "./DesktopSettings";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const translations: Record<string, string> = {
  "DesktopSettings.control.label": "Application settings",
  "DesktopSettings.panel.title": "Application settings",
  "DesktopSettings.autostart.label": "Launch at login",
  "DesktopSettings.autostart.description": "Open AgentParty when you sign in.",
  "DesktopSettings.autostart.loading": "Reading system setting",
  "DesktopSettings.autostart.error": "Couldn't read or update this system setting.",
  "DesktopSettings.version.desktop": "Desktop",
  "DesktopSettings.version.channel": "Release",
  "DesktopSettings.version.server": "Server",
  "DesktopSettings.version.build": "Build",
  "DesktopSettings.version.unavailable": "Unavailable",
  "DesktopSettings.release.production": "Production",
  "DesktopSettings.release.preview": "Preview",
  "DesktopSettings.release.development": "Development",
  "DesktopSettings.release.previewWarning": "This preview may ask for Keychain access again.",
};
const t = (key: string) => translations[key] ?? key;

function runtime(overrides: Partial<DesktopSettingsRuntime> = {}): DesktopSettingsRuntime {
  return {
    isDesktopRuntime: () => true,
    isAutostartEnabled: async () => false,
    setAutostartEnabled: async () => true,
    getAppVersion: async () => "0.2.89",
    getReleaseInfo: async () => ({ distribution: "production", notarized: true }),
    ...overrides,
  };
}

function renderSettings(runtimeValue: DesktopSettingsRuntime): string {
  return renderToStaticMarkup(
    <LocaleProvider><DesktopSettings runtime={runtimeValue} /></LocaleProvider>,
  );
}

async function renderEmbeddedSettings(runtimeValue: DesktopSettingsRuntime): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(
      <LocaleProvider><DesktopSettings runtime={runtimeValue} embedded /></LocaleProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return renderer!;
}

describe("DesktopSettings", () => {
  test("registers independent English and Chinese copy", () => {
    for (const locale of ["en", "zh"] as const) {
      expect(DesktopSettingsStrings[locale]["DesktopSettings.control.label"]).toBeTruthy();
      expect(DesktopSettingsStrings[locale]["DesktopSettings.autostart.label"]).toBeTruthy();
      expect(DesktopSettingsStrings[locale]["DesktopSettings.autostart.error"]).toBeTruthy();
      expect(DesktopSettingsStrings[locale]["DesktopSettings.version.desktop"]).toBeTruthy();
      expect(DesktopSettingsStrings[locale]["DesktopSettings.version.server"]).toBeTruthy();
    }
  });

  test("renders nothing outside the Tauri desktop runtime", () => {
    const html = renderSettings(runtime({ isDesktopRuntime: () => false }));

    expect(html).toBe("");
  });

  test("renders an accessible settings trigger with the project sprite", () => {
    const html = renderSettings(runtime());

    expect(html).toContain("ap-sprite--settings");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="desktop-settings-panel"');
    expect(html).not.toContain("emoji");
    expect(html).not.toContain("<svg");
  });
});

describe("DesktopSettingsPanel", () => {
  test("exposes the launch-at-login toggle as a keyboard-operable switch", () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsPanel
        enabled={true}
        pending={false}
        error={false}
        versions={{
          desktop: "0.2.88",
          server: "0.2.89",
          commit: "048e06e5d1b5",
          release: { distribution: "production", notarized: true },
        }}
        t={t}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain('id="desktop-settings-panel"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Launch at login");
    expect(html).toContain("Desktop");
    expect(html).toContain("0.2.88");
    expect(html).toContain("Server");
    expect(html).toContain("0.2.89");
    expect(html).toContain("048e06e");
    expect(html).toContain("Production");
    expect(html).not.toContain("Keychain access again");
  });

  test("disables the switch while reading or writing and renders a short error", () => {
    const html = renderToStaticMarkup(
      <DesktopSettingsPanel
        enabled={false}
        pending={true}
        error={true}
        versions={{
          desktop: null,
          server: null,
          commit: null,
          release: { distribution: "preview", notarized: false },
        }}
        t={t}
        onToggle={() => {}}
      />,
    );

    expect(html).toContain("disabled");
    expect(html).toContain("read or update this system setting.");
    expect(html).toContain("Keychain access again");
  });
});

describe("desktop version information", () => {
  test("combines the native app version with the active server build identity", async () => {
    const requests: string[] = [];
    const info = await loadDesktopVersionInfo(
      runtime({ getAppVersion: async () => "0.2.88" }),
      "https://party.example.com/",
      async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({
          ok: true,
          version: "0.2.89",
          commit: "048e06e5d1b5f70eee5bbca0eb854d3aa710f473",
          deployed_at: "2026-07-10T23:27:24.905Z",
        }), { status: 200 });
      },
    );

    expect(requests).toEqual(["https://party.example.com/api/health"]);
    expect(info).toEqual({
      desktop: "0.2.88",
      server: "0.2.89",
      commit: "048e06e5d1b5f70eee5bbca0eb854d3aa710f473",
      release: { distribution: "production", notarized: true },
    });
  });

  test("keeps native and server failures independent", async () => {
    const info = await loadDesktopVersionInfo(
      runtime({ getAppVersion: async () => { throw new Error("native unavailable"); } }),
      "https://party.example.com",
      async () => new Response("not json", { status: 502 }),
    );

    expect(info).toEqual({
      desktop: null,
      server: null,
      commit: null,
      release: { distribution: "production", notarized: true },
    });
  });
});

describe("desktop autostart behavior", () => {
  test("loads the current system state during initialization", async () => {
    let reads = 0;
    const enabled = await loadAutostartSetting(runtime({
      isAutostartEnabled: async () => {
        reads += 1;
        return true;
      },
    }));

    expect(enabled).toBe(true);
    expect(reads).toBe(1);
  });

  test("writes the next state without a redundant read after success", async () => {
    const writes: boolean[] = [];
    let reads = 0;
    const result = await applyAutostartSetting(runtime({
      setAutostartEnabled: async (next) => {
        writes.push(next);
        return true;
      },
      isAutostartEnabled: async () => {
        reads += 1;
        return false;
      },
    }), true, false);

    expect(result).toEqual({ enabled: true, failed: false });
    expect(writes).toEqual([true]);
    expect(reads).toBe(0);
  });

  test("re-reads system state and reports an error after a failed write", async () => {
    const calls: string[] = [];
    const result = await applyAutostartSetting(runtime({
      setAutostartEnabled: async () => {
        calls.push("write");
        return false;
      },
      isAutostartEnabled: async () => {
        calls.push("read");
        return false;
      },
    }), true, true);

    expect(result).toEqual({ enabled: false, failed: true });
    expect(calls).toEqual(["write", "read"]);
  });

  test("leaves initialization loading and surfaces an error when the system read rejects", async () => {
    const renderer = await renderEmbeddedSettings(runtime({
      isAutostartEnabled: async () => {
        throw new Error("launchd unavailable");
      },
    }));

    const toggle = renderer.root.findByProps({ role: "switch" });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props["aria-checked"]).toBe(false);
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "read or update this system setting.",
    );

    await act(async () => renderer.unmount());
  });

  test("restores the authoritative state and unlocks the switch when a write rejects", async () => {
    const writes: boolean[] = [];
    let reads = 0;
    const renderer = await renderEmbeddedSettings(runtime({
      isAutostartEnabled: async () => {
        reads += 1;
        return reads > 1;
      },
      setAutostartEnabled: async (next) => {
        writes.push(next);
        throw new Error("native write failed");
      },
    }));

    await act(async () => {
      renderer.root.findByProps({ role: "switch" }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toggle = renderer.root.findByProps({ role: "switch" });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props["aria-checked"]).toBe(true);
    expect(renderer.root.findByProps({ role: "alert" })).toBeTruthy();
    expect(writes).toEqual([true]);
    expect(reads).toBe(2);

    await act(async () => renderer.unmount());
  });
});

describe("desktop settings dismissal", () => {
  test("closes on Escape but not unrelated keys", () => {
    expect(shouldDismissDesktopSettings({ key: "Escape" })).toBe(true);
    expect(shouldDismissDesktopSettings({ key: "Enter" })).toBe(false);
  });

  test("closes only when the pointer target is outside the settings root", () => {
    const inside = {} as Node;
    const outside = {} as Node;
    const root = { contains: (target: Node) => target === inside };

    expect(isDesktopSettingsOutsideClick(root, outside)).toBe(true);
    expect(isDesktopSettingsOutsideClick(root, inside)).toBe(false);
    expect(isDesktopSettingsOutsideClick(null, outside)).toBe(false);
  });

  test("moves focus into the popover and restores it for keyboard dismissal", () => {
    const calls: string[] = [];
    const control = { focus: () => calls.push("control") };
    const trigger = { focus: () => calls.push("trigger") };

    updateDesktopSettingsFocus(true, false, false, control, trigger);
    updateDesktopSettingsFocus(false, true, true, control, trigger);
    updateDesktopSettingsFocus(false, true, false, control, trigger);

    expect(calls).toEqual(["control", "trigger"]);
  });
});
