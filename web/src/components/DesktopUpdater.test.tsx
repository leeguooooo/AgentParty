// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopUpdaterState } from "../lib/desktopUpdater";
import { DesktopUpdaterStrings } from "../i18n/strings/DesktopUpdater";
import {
  DesktopUpdaterPanel,
  handleDesktopUpdaterTrayCheck,
  notifyDesktopUpdateAvailableInBackground,
  updateUpdaterDialogFocus,
} from "./DesktopUpdater";

const state = (overrides: Partial<DesktopUpdaterState>): DesktopUpdaterState => ({
  phase: "idle",
  panelOpen: true,
  currentVersion: null,
  nextVersion: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  progressPercent: null,
  error: null,
  failureStage: null,
  ...overrides,
});

const translations: Record<string, string> = {
  "DesktopUpdater.panel.title": "Desktop update",
  "DesktopUpdater.close": "Close update status",
  "DesktopUpdater.available": "A new version is ready to install.",
  "DesktopUpdater.previewWarning": "Preview build may ask for Keychain access again.",
  "DesktopUpdater.currentVersion": "Current",
  "DesktopUpdater.nextVersion": "Available",
  "DesktopUpdater.releaseNotes": "Release notes",
  "DesktopUpdater.install": "Install update",
  "DesktopUpdater.check": "Check now",
  "DesktopUpdater.retry": "Retry",
  "DesktopUpdater.error": "The update could not be completed.",
  "DesktopUpdater.error.offline": "Connect to the internet and try again.",
};
const t = (key: string) => translations[key] ?? key;

test("attempts one native notification for a hidden update when localStorage access throws", async () => {
  const storageTarget = Object.defineProperty({}, "localStorage", {
    get: () => { throw new Error("localStorage unavailable"); },
  }) as { readonly localStorage: Storage };
  let nativeNotificationAttempts = 0;

  expect(await notifyDesktopUpdateAvailableInBackground("0.2.102", true, storageTarget, async () => {
    nativeNotificationAttempts += 1;
    return true;
  })).toBe(true);

  expect(nativeNotificationAttempts).toBe(1);
});

test("deduplicates repeated and concurrent notifications when localStorage is unavailable", async () => {
  const storageTarget = Object.defineProperty({}, "localStorage", {
    get: () => { throw new Error("localStorage unavailable"); },
  }) as { readonly localStorage: Storage };
  let nativeNotificationAttempts = 0;
  let resolveDelivery: ((delivered: boolean) => void) | null = null;
  const delivery = new Promise<boolean>((resolve) => { resolveDelivery = resolve; });
  const notify = () => {
    nativeNotificationAttempts += 1;
    return delivery;
  };

  const first = notifyDesktopUpdateAvailableInBackground("0.2.103", true, storageTarget, notify);
  const second = notifyDesktopUpdateAvailableInBackground("0.2.103", true, storageTarget, notify);
  expect(first).toBe(second);
  expect(nativeNotificationAttempts).toBe(1);

  resolveDelivery!(true);
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(await notifyDesktopUpdateAvailableInBackground("0.2.103", true, storageTarget, notify)).toBe(false);
  expect(nativeNotificationAttempts).toBe(1);
});

test("deduplicates when localStorage methods throw", async () => {
  const storageTarget = {
    localStorage: {
      getItem: () => { throw new Error("read denied"); },
      setItem: () => { throw new Error("write denied"); },
    },
  };
  let nativeNotificationAttempts = 0;
  let resolveDelivery: ((delivered: boolean) => void) | null = null;
  const delivery = new Promise<boolean>((resolve) => { resolveDelivery = resolve; });
  const notify = () => {
    nativeNotificationAttempts += 1;
    return delivery;
  };

  const first = notifyDesktopUpdateAvailableInBackground("0.2.104", true, storageTarget, notify);
  const second = notifyDesktopUpdateAvailableInBackground("0.2.104", true, storageTarget, notify);
  expect(first).toBe(second);
  expect(nativeNotificationAttempts).toBe(1);

  resolveDelivery!(true);
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(await notifyDesktopUpdateAvailableInBackground("0.2.104", true, storageTarget, notify)).toBe(false);
  expect(nativeNotificationAttempts).toBe(1);
});

describe("DesktopUpdaterPanel", () => {
  test("provides localized copy for every safe error category", () => {
    const categories = ["offline", "timeout", "verification", "install", "relaunch", "generic"];

    for (const locale of ["en", "zh"] as const) {
      for (const category of categories) {
        expect(DesktopUpdaterStrings[locale][`DesktopUpdater.error.${category}`]).toBeTruthy();
      }
    }
  });

  test("renders bounded release notes as plain text", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdaterPanel
        state={state({
          phase: "available",
          currentVersion: "0.2.82",
          nextVersion: "0.2.83",
          notes: "<strong>Security update</strong>",
        })}
        t={t}
        panelRef={createRef<HTMLElement>()}
        onClose={() => {}}
        onCheck={() => {}}
        onInstall={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Release notes");
    expect(html).toContain("&lt;strong&gt;Security update&lt;/strong&gt;");
    expect(html).not.toContain("<strong>Security update</strong>");
  });

  test("renders a localized error category instead of a native error", () => {
    const html = renderToStaticMarkup(
      <DesktopUpdaterPanel
        state={state({ phase: "error", error: "offline", failureStage: "check" })}
        t={t}
        panelRef={createRef<HTMLElement>()}
        onClose={() => {}}
        onCheck={() => {}}
        onInstall={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(html).toContain("Connect to the internet and try again.");
    expect(html).not.toContain("ECONNREFUSED");
  });

  test("warns before installing a preview build but stays quiet for production", () => {
    const preview = renderToStaticMarkup(
      <DesktopUpdaterPanel
        state={state({ phase: "available", currentVersion: "0.2.98", nextVersion: "0.2.99" })}
        releaseInfo={{ distribution: "preview", notarized: false }}
        t={t}
        panelRef={createRef<HTMLElement>()}
        onClose={() => {}}
        onCheck={() => {}}
        onInstall={() => {}}
        onRetry={() => {}}
      />,
    );
    const production = renderToStaticMarkup(
      <DesktopUpdaterPanel
        state={state({ phase: "available", currentVersion: "0.2.98", nextVersion: "0.2.99" })}
        releaseInfo={{ distribution: "production", notarized: true }}
        t={t}
        panelRef={createRef<HTMLElement>()}
        onClose={() => {}}
        onCheck={() => {}}
        onInstall={() => {}}
        onRetry={() => {}}
      />,
    );

    expect(preview).toContain("Preview build may ask for Keychain access again.");
    expect(production).not.toContain("Preview build may ask for Keychain access again.");
  });
});

describe("desktop updater dialog focus", () => {
  test("focuses the dialog after opening and restores the trigger after closing", () => {
    const focused: string[] = [];
    const dialog = { focus: () => focused.push("dialog") };
    const trigger = { focus: () => focused.push("trigger") };

    updateUpdaterDialogFocus(true, false, dialog, trigger);
    updateUpdaterDialogFocus(false, true, dialog, trigger);
    updateUpdaterDialogFocus(false, false, dialog, trigger);

    expect(focused).toEqual(["dialog", "trigger"]);
  });
});

test("tray update action opens the updater and starts a manual check", () => {
  const calls: string[] = [];
  const controller = {
    openPanel: () => calls.push("open"),
    check: async (source: string) => { calls.push(`check:${source}`); },
  } as unknown as import("../lib/desktopUpdater").DesktopUpdaterController;

  handleDesktopUpdaterTrayCheck(controller);
  expect(calls).toEqual(["open", "check:manual"]);
});
