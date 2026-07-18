import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Pair";
import { normalizePairingCode } from "../lib/desktopPairing";
import { normalizeServerOrigin } from "../lib/serverProfiles";

// worker/src/desktop-pairing.ts 的 pairingView 计算的状态：pending 才可决策，其余均为已决/失效终态。
export type PairingStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface PairingInspection {
  pairing_id: string;
  user_code: string;
  // #638：worker 每次 inspect 都返回 status，已决（approved/denied/consumed/expired）时前端必须读它
  // 走只读态，别再渲染点了必 409 的 Approve/Deny。
  status?: PairingStatus | null;
  device?: {
    name?: string | null;
    platform?: string | null;
    app_version?: string | null;
  } | null;
  device_name?: string | null;
  platform?: string | null;
  app_version?: string | null;
  // #638：worker 发的是 expires_in（剩余秒数），此前前端读的 expires_at 永远为空，Expires 行是死字段。
  expires_in?: number | null;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type PairingDecision = "approve" | "deny";

// 把 worker 的 expires_in（剩余秒数）格式化成紧凑相对时长，供复审的「Expires」行显示。
export function formatExpiresIn(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function extractPairingCodeAndSanitizeUrl(href: string): {
  userCode: string | null;
  sanitizedPath: string;
} {
  const url = new URL(href);
  const raw = url.searchParams.get("code") ?? url.searchParams.get("user_code") ?? "";
  url.searchParams.delete("code");
  url.searchParams.delete("user_code");
  return {
    userCode: normalizePairingCode(raw),
    sanitizedPath: `${url.pathname}${url.search}${url.hash}`,
  };
}

async function pairingError(response: Response): Promise<Error> {
  if (response.status === 403) return new Error("human_required");
  return new Error(`pairing request failed (${response.status})`);
}

export async function inspectDesktopPairing(
  serverOriginInput: string,
  token: string,
  input: string,
  fetcher: Fetcher = fetch,
): Promise<PairingInspection> {
  const userCode = normalizePairingCode(input);
  if (userCode === null) throw new Error("invalid_code");
  const serverOrigin = normalizeServerOrigin(serverOriginInput);
  if (serverOrigin === null) throw new Error("invalid_server_origin");
  const response = await fetcher(`${serverOrigin}/api/desktop/pairings/inspect`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ user_code: userCode }),
  });
  if (!response.ok) throw await pairingError(response);
  const inspection = (await response.json()) as PairingInspection;
  if (!inspection.pairing_id) {
    throw new Error("invalid_pairing_response");
  }
  return { ...inspection, user_code: userCode };
}

export async function decideDesktopPairing(
  serverOriginInput: string,
  token: string,
  inspection: PairingInspection,
  decision: PairingDecision,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const serverOrigin = normalizeServerOrigin(serverOriginInput);
  if (serverOrigin === null) throw new Error("invalid_server_origin");
  const response = await fetcher(`${serverOrigin}/api/desktop/pairings/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      pairing_id: inspection.pairing_id,
      user_code: inspection.user_code,
      decision,
    }),
  });
  if (!response.ok) throw await pairingError(response);
}

interface ReviewProps {
  inspection: PairingInspection;
  pending: boolean;
  onDecision(decision: PairingDecision): void;
}

export function PairingReview({ inspection, pending, onDecision }: ReviewProps) {
  const t = useT();
  const device = inspection.device ?? null;
  const name = device?.name ?? inspection.device_name ?? "AgentParty Desktop";
  const platform = device?.platform ?? inspection.platform ?? "-";
  const version = device?.app_version ?? inspection.app_version ?? "-";
  return (
    <section className="pair-review" aria-labelledby="pair-review-title">
      <h2 id="pair-review-title">{t("Pair.review.title")}</h2>
      <p className="pair-warning">{t("Pair.review.warning")}</p>
      <dl className="pair-device">
        <div><dt>{t("Pair.device.name")}</dt><dd>{name}</dd></div>
        <div><dt>{t("Pair.device.platform")}</dt><dd>{platform}</dd></div>
        <div><dt>{t("Pair.device.version")}</dt><dd>{version}</dd></div>
        {typeof inspection.expires_in === "number" && (
          <div><dt>{t("Pair.device.expires")}</dt><dd>{formatExpiresIn(inspection.expires_in)}</dd></div>
        )}
      </dl>
      <div className="pair-actions">
        <button type="button" className="d-btn pair-deny" disabled={pending} onClick={() => onDecision("deny")}>
          {t("Pair.deny")}
        </button>
        <button type="button" className="d-btn d-btn--primary" disabled={pending} onClick={() => onDecision("approve")}>
          {t("Pair.approve")}
        </button>
      </div>
    </section>
  );
}

// #638：已决/失效的配对以只读横幅呈现，而非可点的 Approve/Deny（点了必被 worker 409 拒）。
export function PairingResolvedNotice({ status }: { status: Exclude<PairingStatus, "pending"> }) {
  const t = useT();
  const key =
    status === "approved"
      ? "Pair.resolved.approved"
      : status === "denied"
        ? "Pair.resolved.denied"
        : status === "consumed"
          ? "Pair.resolved.consumed"
          : "Pair.resolved.expired";
  const negative = status === "denied" || status === "expired";
  return (
    <p className={`banner${negative ? " banner--red" : ""}`} role="status">
      {t(key)}
    </p>
  );
}

interface Props {
  serverOrigin: string;
  token: string;
  initialCode: string | null;
  onRequireHuman?(input: { code: string }): void;
  onDecisionComplete?(): void;
}

export function PairHumanRequiredAction({
  code,
  onRequireHuman,
}: {
  code: string;
  onRequireHuman(input: { code: string }): void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="d-btn pair-human-login"
      onClick={() => onRequireHuman({ code })}
    >
      {t("Pair.inspect.useHuman")}
    </button>
  );
}

export function PairPage({ serverOrigin, token, initialCode, onRequireHuman, onDecisionComplete }: Props) {
  const t = useT();
  const [value, setValue] = useState(initialCode ?? "");
  const [inspection, setInspection] = useState<PairingInspection | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresHuman, setRequiresHuman] = useState(false);
  const [decision, setDecision] = useState<PairingDecision | null>(null);
  const autoInspected = useRef(false);

  const inspect = async (input: string) => {
    const normalized = normalizePairingCode(input);
    if (normalized === null) {
      setError(t("Pair.code.invalid"));
      return;
    }
    setValue(normalized);
    setPending(true);
    setError(null);
    setRequiresHuman(false);
    setDecision(null);
    try {
      setInspection(await inspectDesktopPairing(serverOrigin, token, normalized));
    } catch (cause) {
      setInspection(null);
      const humanRequired = cause instanceof Error && cause.message === "human_required";
      setRequiresHuman(humanRequired);
      setError(humanRequired ? t("Pair.inspect.humanRequired") : t("Pair.inspect.failed"));
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (initialCode === null || autoInspected.current) return;
    autoInspected.current = true;
    void inspect(initialCode);
  }, [initialCode, token]);

  const submitDecision = async (next: PairingDecision) => {
    if (inspection === null) return;
    setPending(true);
    setError(null);
    try {
      await decideDesktopPairing(serverOrigin, token, inspection, next);
      setDecision(next);
      setInspection(null);
      onDecisionComplete?.();
    } catch (cause) {
      const humanRequired = cause instanceof Error && cause.message === "human_required";
      setRequiresHuman(humanRequired);
      setError(humanRequired ? t("Pair.inspect.humanRequired") : t("Pair.decision.failed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="gate pair-page">
      <h1 className="d-title gate-title">{t("Pair.title")}</h1>
      <p className="gate-sub">{t("Pair.subtitle")}</p>
      <div className="d-card gate-card pair-card">
        {decision !== null ? (
          <p className={`banner${decision === "deny" ? " banner--red" : ""}`} role="status">
            {t(decision === "approve" ? "Pair.status.approved" : "Pair.status.denied")}
          </p>
        ) : (
          <>
            <form
              action="/pair"
              className="gate-form"
              onSubmit={(event) => {
                event.preventDefault();
                void inspect(value);
              }}
            >
              <label className="gate-label" htmlFor="pair-code">{t("Pair.code.label")}</label>
              <input
                id="pair-code"
                className="gate-input pair-code-input t-mono"
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={11}
                placeholder="XXXXX-XXXXX"
                value={value}
                disabled={pending}
                onChange={(event) => setValue(event.target.value.toUpperCase())}
              />
              <button className="d-btn" type="submit" disabled={pending || value.trim() === ""}>
                {pending ? t("Pair.inspect.loading") : t("Pair.inspect")}
              </button>
            </form>
            {inspection !== null &&
              (inspection.status == null || inspection.status === "pending" ? (
                <PairingReview inspection={inspection} pending={pending} onDecision={(next) => void submitDecision(next)} />
              ) : (
                <PairingResolvedNotice status={inspection.status} />
              ))}
          </>
        )}
        {error !== null && <p className="banner banner--red" role="alert">{error}</p>}
        {requiresHuman && onRequireHuman !== undefined && (
          <PairHumanRequiredAction code={value} onRequireHuman={onRequireHuman} />
        )}
      </div>
    </main>
  );
}
