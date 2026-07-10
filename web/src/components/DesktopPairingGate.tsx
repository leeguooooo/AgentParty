import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/DesktopPairing";
import {
  createDesktopPairing,
  createDesktopPairingSecrets,
  exchangeDesktopPairingToken,
  normalizePairingCode,
  pollDesktopPairing,
  reducePairingState,
  type DesktopPairingResponse,
  type DesktopPairingState,
} from "../lib/desktopPairing";
import { desktopCredentialVaultForOrigin, finishDesktopPairing } from "../lib/desktopCredentials";
import type { ServerProfile } from "../lib/serverProfiles";
import {
  listenForDesktopPairLinks,
  openDesktopVerificationUrl,
} from "../lib/desktopRuntime";
import { ServerProfilePicker } from "./ServerProfiles";

const INITIAL_STATE: DesktopPairingState = { phase: "idle", intervalSeconds: 3, error: null };

export function desktopAllowedServerOrigins(profiles: readonly ServerProfile[]): string[] {
  return profiles.map((profile) => profile.origin);
}

function waitForPoll(seconds: number, signal: AbortSignal, wakeRef: { current: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      if (wakeRef.current === finish) wakeRef.current = null;
      resolve();
    };
    const timer = window.setTimeout(finish, seconds * 1000);
    wakeRef.current = finish;
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function deviceMetadata(): Promise<{ name: string; platform: string; appVersion: string }> {
  let appVersion = "unknown";
  try {
    const app = await import("@tauri-apps/api/app");
    appVersion = await app.getVersion();
  } catch {
    // The pairing remains usable when version metadata is unavailable.
  }
  const platform = navigator.platform || "desktop";
  return { name: `AgentParty on ${platform}`, platform, appVersion };
}

interface ViewProps {
  state: DesktopPairingState;
  pairing: DesktopPairingResponse | null;
  onStart(): void;
  onCancel(): void;
  onExit?: () => void;
  serverPicker?: ReactNode;
}

export function DesktopPairingGateView({ state, pairing, onStart, onCancel, onExit, serverPicker }: ViewProps) {
  const t = useT();
  const active = state.phase === "creating" || state.phase === "pending" || state.phase === "slow_down";
  const terminal = state.phase === "denied" || state.phase === "expired" || state.phase === "cancelled" || state.phase === "error";
  const statusKey = state.phase === "slow_down"
    ? "DesktopPairing.slowDown"
    : state.phase === "pending"
      ? "DesktopPairing.pending"
      : state.phase === "creating"
        ? "DesktopPairing.creating"
        : state.phase === "denied"
          ? "DesktopPairing.denied"
          : state.phase === "expired"
            ? "DesktopPairing.expired"
            : state.phase === "cancelled"
              ? "DesktopPairing.cancelled"
              : "DesktopPairing.error";

  return (
    <main className="gate desktop-pairing-gate">
      <h1 className="d-title gate-title">Agent<span className="d-hl">Party</span></h1>
      <p className="gate-sub">{t("DesktopPairing.title")}</p>
      <section className="d-card gate-card desktop-pairing-card" aria-labelledby="desktop-pairing-title">
        <h2 id="desktop-pairing-title">{t("DesktopPairing.title")}</h2>
        <p>{t("DesktopPairing.subtitle")}</p>
        {!active && serverPicker}
        {pairing !== null && (state.phase === "pending" || state.phase === "slow_down") && (
          <div className="desktop-pairing-code-block">
            <span>{t("DesktopPairing.codeLabel")}</span>
            <strong className="desktop-pairing-code t-mono">{pairing.user_code}</strong>
          </div>
        )}
        {active && (
          <p className="desktop-pairing-status" role="status" aria-live="polite">{t(statusKey)}</p>
        )}
        {terminal && (
          <p className={`banner${state.phase === "denied" || state.phase === "error" ? " banner--red" : ""}`} role="status">
            {state.error ?? t(statusKey)}
          </p>
        )}
        <div className="desktop-pairing-actions">
          {active ? (
            <button type="button" className="d-btn" onClick={onCancel}>{t("DesktopPairing.cancel")}</button>
          ) : (
            <button type="button" className="d-btn d-btn--primary" onClick={onStart}>
              {terminal ? t("DesktopPairing.retry") : t("DesktopPairing.start")}
            </button>
          )}
          {!active && onExit !== undefined && (
            <button type="button" className="d-btn" onClick={onExit}>{t("ServerProfiles.addPair.cancel")}</button>
          )}
        </div>
      </section>
    </main>
  );
}

interface Props {
  profiles: ServerProfile[];
  selectedOrigin: string;
  onSelectOrigin(origin: string): void;
  onProfilesChanged(profiles: ServerProfile[]): void;
  onAuthenticated(accessToken: string, origin: string): void;
  onExit?: () => void;
}

export function DesktopPairingGate({
  profiles,
  selectedOrigin,
  onSelectOrigin,
  onProfilesChanged,
  onAuthenticated,
  onExit,
}: Props) {
  const t = useT();
  const [state, dispatch] = useReducer(reducePairingState, INITIAL_STATE);
  const [pairing, setPairing] = useState<DesktopPairingResponse | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const secretsRef = useRef<Awaited<ReturnType<typeof createDesktopPairingSecrets>> | null>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const allowedOrigins = desktopAllowedServerOrigins(profiles);

  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    void listenForDesktopPairLinks(allowedOrigins, (link) => {
      if (!alive || pairing === null) return;
      const sameCode = normalizePairingCode(link.userCode) === pairing.user_code;
      const sameServer = link.serverOrigin === null || link.serverOrigin === selectedOrigin;
      if (sameCode && sameServer) wakeRef.current?.();
    }).then((unlisten) => {
      if (alive) cleanup = unlisten;
      else unlisten();
    });
    return () => {
      alive = false;
      cleanup();
    };
  }, [pairing?.pairing_id]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    secretsRef.current = null;
    setPairing(null);
    dispatch({ type: "cancel" });
    onExit?.();
  };

  const start = async () => {
    controllerRef.current?.abort();
    const serverOrigin = selectedOrigin;
    if (!allowedOrigins.includes(serverOrigin)) {
      dispatch({ type: "fail", message: t("DesktopPairing.error") });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setPairing(null);
    dispatch({ type: "start" });
    try {
      const secrets = await createDesktopPairingSecrets();
      secretsRef.current = secrets;
      const created = await createDesktopPairing(serverOrigin, secrets, await deviceMetadata());
      if (controller.signal.aborted) return;
      setPairing(created);
      dispatch({ type: "created", intervalSeconds: created.interval });
      if (!(await openDesktopVerificationUrl(created.verification_uri_complete, allowedOrigins))) {
        throw new Error(t("DesktopPairing.browserFailed"));
      }
      const result = await pollDesktopPairing({
        intervalSeconds: created.interval,
        expiresInSeconds: created.expires_in,
        signal: controller.signal,
        wait: (seconds, signal) => waitForPoll(seconds, signal, wakeRef),
        exchange: (signal) => exchangeDesktopPairingToken(
          serverOrigin,
          created.device_code,
          secrets.codeVerifier,
          fetch,
          signal,
        ),
        onEvent: (event) => dispatch(event.type === "authorization_pending"
          ? { type: "authorization_pending" }
          : event.type === "slow_down"
            ? { type: "slow_down", retryAfterSeconds: event.retryAfterSeconds }
            : { type: event.type }),
      });
      if (result.type === "approved") {
        const accessToken = await finishDesktopPairing(
          result.tokens,
          secrets.deviceSecret,
          serverOrigin,
          desktopCredentialVaultForOrigin(serverOrigin),
        );
        secretsRef.current = null;
        dispatch({ type: "approved" });
        onAuthenticated(accessToken, serverOrigin);
      } else if (result.type === "cancelled") {
        dispatch({ type: "cancel" });
      } else {
        dispatch({ type: result.type });
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      dispatch({ type: "fail", message: cause instanceof Error ? cause.message : t("DesktopPairing.error") });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  return (
    <DesktopPairingGateView
      state={state}
      pairing={pairing}
      onStart={() => void start()}
      onCancel={cancel}
      onExit={onExit}
      serverPicker={(
        <ServerProfilePicker
          profiles={profiles}
          selectedOrigin={selectedOrigin}
          onSelect={onSelectOrigin}
          onProfilesChanged={onProfilesChanged}
        />
      )}
    />
  );
}
