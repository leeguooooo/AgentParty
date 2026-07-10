// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "../i18n/locale";
import { DesktopPairingStrings } from "../i18n/strings/DesktopPairing";
import type { DesktopPairingResponse, DesktopPairingState } from "../lib/desktopPairing";
import { DesktopPairingGate, DesktopPairingGateView } from "./DesktopPairingGate";

const pairing: DesktopPairingResponse = {
  pairing_id: "pair-1",
  device_code: "device-code",
  user_code: "AB12C-DE34F",
  verification_uri: "https://agentparty.leeguoo.com/pair",
  verification_uri_complete: "https://agentparty.leeguoo.com/pair?code=AB12C-DE34F",
  expires_in: 300,
  interval: 3,
};

function state(phase: DesktopPairingState["phase"], error: string | null = null): DesktopPairingState {
  return { phase, intervalSeconds: phase === "slow_down" ? 9 : 3, error };
}

function renderView(phase: DesktopPairingState["phase"], value: DesktopPairingResponse | null = null): string {
  return renderToStaticMarkup(
    <LocaleProvider>
      <DesktopPairingGateView
        state={state(phase)}
        pairing={value}
        onStart={() => {}}
        onCancel={() => {}}
      />
    </LocaleProvider>,
  );
}

describe("DesktopPairingGate", () => {
  test("registers independent English and Chinese copy for every visible state", () => {
    const keys = [
      "DesktopPairing.title",
      "DesktopPairing.start",
      "DesktopPairing.pending",
      "DesktopPairing.slowDown",
      "DesktopPairing.cancel",
      "DesktopPairing.denied",
      "DesktopPairing.expired",
      "DesktopPairing.cancelled",
      "DesktopPairing.error",
      "DesktopPairing.retry",
    ];
    for (const locale of ["en", "zh"] as const) {
      for (const key of keys) expect(DesktopPairingStrings[locale][key]).toBeTruthy();
    }
  });

  test("renders a pairing-only desktop sign-in entry", () => {
    const html = renderToStaticMarkup(
      <LocaleProvider><DesktopPairingGate onAuthenticated={() => {}} /></LocaleProvider>,
    );
    expect(html).toContain("Pair this desktop");
    expect(html).toContain("Start pairing");
    expect(html).not.toContain("ap-token");
    expect(html).not.toContain("Sign in with");
  });

  test("shows the fixed-format code and cancellation while polling", () => {
    for (const phase of ["pending", "slow_down"] as const) {
      const html = renderView(phase, pairing);
      expect(html).toContain("AB12C-DE34F");
      expect(html).toContain("Cancel");
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain(phase === "slow_down" ? "server asked us to slow down" : "Waiting for approval");
    }
  });

  test("offers a clean restart after denial, expiry, cancellation, or an error", () => {
    for (const phase of ["denied", "expired", "cancelled", "error"] as const) {
      const html = renderView(phase);
      expect(html).toContain("Try again");
      expect(html).not.toContain("AB12C-DE34F");
    }
  });
});
