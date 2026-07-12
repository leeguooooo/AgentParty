import { useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/ServerProfiles";
import { restoreDesktopAccessInteractive } from "../lib/desktopAuth";
import { desktopCredentialVaultForOrigin } from "../lib/desktopCredentials";
import {
  addCustomServerProfile,
  probeServerProfile,
  type ServerProbeResult,
  type ServerProfile,
  type ServerProfileStorage,
} from "../lib/serverProfiles";
import {
  DesktopServerAuthorizationRequiredError,
  DesktopServerNotPairedError,
} from "../lib/serverSwitch";

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function probeAndAddServerProfile(
  storage: ServerProfileStorage,
  input: { label: string; origin: string },
  fetcher: Fetcher = fetch,
): Promise<{ profiles: ServerProfile[]; probe: ServerProbeResult }> {
  const probe = await probeServerProfile(input.origin, fetcher);
  const profiles = addCustomServerProfile(storage, { label: input.label, origin: probe.origin });
  return { profiles, probe };
}

interface PickerProps {
  profiles: ServerProfile[];
  selectedOrigin: string;
  onSelect(origin: string): void;
  onProfilesChanged(profiles: ServerProfile[]): void;
}

export function ServerProfilePicker({ profiles, selectedOrigin, onSelect, onProfilesChanged }: PickerProps) {
  const t = useT();
  const [label, setLabel] = useState("");
  const [origin, setOrigin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [probe, setProbe] = useState<ServerProbeResult | null>(null);

  const add = async () => {
    setPending(true);
    setError(false);
    setProbe(null);
    try {
      const result = await probeAndAddServerProfile(localStorage, { label, origin });
      onProfilesChanged(result.profiles);
      onSelect(result.probe.origin);
      setProbe(result.probe);
      setLabel("");
      setOrigin("");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="server-profile-picker" aria-label={t("ServerProfiles.server")}>
      <label className="server-profile-select-label" htmlFor="desktop-pairing-server">
        {t("ServerProfiles.server")}
      </label>
      <select
        id="desktop-pairing-server"
        className="server-profile-select t-mono"
        value={selectedOrigin}
        disabled={pending}
        onChange={(event) => onSelect(event.target.value)}
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.origin}>{profile.label}</option>
        ))}
      </select>
      <details className="server-profile-add">
        <summary>{t("ServerProfiles.add.title")}</summary>
        <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
          <label htmlFor="server-profile-label">{t("ServerProfiles.add.label")}</label>
          <input
            id="server-profile-label"
            type="text"
            maxLength={80}
            value={label}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          />
          <label htmlFor="server-profile-origin">{t("ServerProfiles.add.origin")}</label>
          <input
            id="server-profile-origin"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://party.example.com"
            value={origin}
            disabled={pending}
            onChange={(event) => setOrigin(event.target.value)}
          />
          <small>{t("ServerProfiles.add.originHint")}</small>
          <button type="submit" className="d-btn" disabled={pending || !label.trim() || !origin.trim()}>
            {pending ? t("ServerProfiles.add.checking") : t("ServerProfiles.add.check")}
          </button>
        </form>
      </details>
      {error && <p className="server-profile-error" role="alert">{t("ServerProfiles.add.failed")}</p>}
      {probe !== null && (
        <div className="server-profile-providers" role="status">
          <strong>{t("ServerProfiles.providers")}</strong>
          {probe.providers.length > 0
            ? <ul>{probe.providers.map((provider) => <li key={provider.id}>{provider.label}</li>)}</ul>
            : <p>{t("ServerProfiles.providers.none")}</p>}
        </div>
      )}
    </section>
  );
}

interface SwitcherViewProps {
  profiles: ServerProfile[];
  activeOrigin: string;
  pending: boolean;
  error: string | null;
  pairTarget: string | null;
  authorizationTarget: string | null;
  retryTarget: string | null;
  onSelect(origin: string): void;
  onAddPair(): void;
  onPair(origin: string): void;
  onAuthorize(origin: string): void;
  onRetry(origin: string): void;
}

export function ServerSwitcherView({
  profiles,
  activeOrigin,
  pending,
  error,
  pairTarget,
  authorizationTarget,
  retryTarget,
  onSelect,
  onAddPair,
  onPair,
  onAuthorize,
  onRetry,
}: SwitcherViewProps) {
  const t = useT();
  return (
    <div className="server-switcher t-mono">
      <label htmlFor="active-server">{pending ? t("ServerProfiles.switching") : t("ServerProfiles.server")}</label>
      <select
        id="active-server"
        value={activeOrigin}
        disabled={pending}
        aria-invalid={error !== null}
        onChange={(event) => onSelect(event.target.value)}
      >
        {profiles.map((profile) => <option key={profile.id} value={profile.origin}>{profile.label}</option>)}
      </select>
      <button type="button" className="server-switcher-add" disabled={pending} onClick={onAddPair}>
        {t("ServerProfiles.addPair")}
      </button>
      {error !== null && (
        <div className="server-switcher-error" role="alert">
          <span>{error}</span>
          {pairTarget !== null && (
            <button type="button" onClick={() => onPair(pairTarget)}>{t("ServerProfiles.switch.pair")}</button>
          )}
          {authorizationTarget !== null && (
            <button type="button" onClick={() => onAuthorize(authorizationTarget)}>
              {t("ServerProfiles.switch.authorizeRetry")}
            </button>
          )}
          {retryTarget !== null && (
            <button type="button" onClick={() => onRetry(retryTarget)}>{t("ServerProfiles.switch.retry")}</button>
          )}
        </div>
      )}
    </div>
  );
}

interface SwitcherProps {
  profiles: ServerProfile[];
  activeOrigin: string;
  onSwitch(origin: string, restoredAccessToken?: string): Promise<void>;
  onAddPair(): void;
  onPair(origin: string): void;
  restoreInteractive?(origin: string): Promise<string | null>;
}

function restoreServerAccessInteractive(origin: string): Promise<string | null> {
  return restoreDesktopAccessInteractive(desktopCredentialVaultForOrigin(origin), origin);
}

export function ServerSwitcher({
  profiles,
  activeOrigin,
  onSwitch,
  onAddPair,
  onPair,
  restoreInteractive = restoreServerAccessInteractive,
}: SwitcherProps) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairTarget, setPairTarget] = useState<string | null>(null);
  const [authorizationFailure, setAuthorizationFailure] = useState<DesktopServerAuthorizationRequiredError | null>(null);
  const [retryTarget, setRetryTarget] = useState<string | null>(null);

  const clearRecovery = () => {
    setPairTarget(null);
    setAuthorizationFailure(null);
    setRetryTarget(null);
  };

  const showFailure = (cause: unknown, origin: string) => {
    clearRecovery();
    if (cause instanceof DesktopServerAuthorizationRequiredError) {
      setAuthorizationFailure(cause);
      setError(t("ServerProfiles.switch.authorizationRequired"));
    } else if (cause instanceof DesktopServerNotPairedError) {
      setPairTarget(cause.origin);
      setError(t("ServerProfiles.switch.unpaired"));
    } else {
      setRetryTarget(origin);
      setError(t("ServerProfiles.switch.failed"));
    }
  };

  const select = async (origin: string) => {
    if (origin === activeOrigin || pending) return;
    setPending(true);
    setError(null);
    clearRecovery();
    try {
      await onSwitch(origin);
    } catch (cause) {
      showFailure(cause, origin);
    } finally {
      setPending(false);
    }
  };

  const authorizeAndRetry = async (failure: DesktopServerAuthorizationRequiredError) => {
    if (pending) return;
    const origin = failure.origin;
    setPending(true);
    setError(null);
    clearRecovery();
    try {
      const accessToken = await failure.authorize(restoreInteractive);
      if (accessToken === null) throw new DesktopServerNotPairedError(origin);
      await onSwitch(origin, accessToken);
    } catch (cause) {
      showFailure(cause, origin);
    } finally {
      setPending(false);
    }
  };

  return (
    <ServerSwitcherView
      profiles={profiles}
      activeOrigin={activeOrigin}
      pending={pending}
      error={error}
      pairTarget={pairTarget}
      authorizationTarget={authorizationFailure?.origin ?? null}
      retryTarget={retryTarget}
      onSelect={(origin) => void select(origin)}
      onAddPair={onAddPair}
      onPair={(origin) => {
        setError(null);
        clearRecovery();
        onPair(origin);
      }}
      onAuthorize={(origin) => {
        if (authorizationFailure?.origin === origin) void authorizeAndRetry(authorizationFailure);
      }}
      onRetry={(origin) => void select(origin)}
    />
  );
}

interface AddGateProps {
  profiles: ServerProfile[];
  activeOrigin: string;
  onPair(origin: string): void;
  onProfilesChanged(profiles: ServerProfile[]): void;
  onCancel(): void;
}

export function ServerProfileAddGate({
  profiles,
  activeOrigin,
  onPair,
  onProfilesChanged,
  onCancel,
}: AddGateProps) {
  const t = useT();
  return (
    <main className="gate desktop-server-add-gate">
      <h1 className="d-title gate-title">Agent<span className="d-hl">Party</span></h1>
      <section className="d-card gate-card" aria-labelledby="desktop-server-add-title">
        <h2 id="desktop-server-add-title">{t("ServerProfiles.addPair")}</h2>
        <p>{t("ServerProfiles.addPair.hint")}</p>
        <ServerProfilePicker
          profiles={profiles}
          selectedOrigin={activeOrigin}
          onSelect={onPair}
          onProfilesChanged={onProfilesChanged}
        />
        <div className="desktop-pairing-actions">
          <button type="button" className="d-btn" onClick={onCancel}>
            {t("ServerProfiles.addPair.cancel")}
          </button>
        </div>
      </section>
    </main>
  );
}
