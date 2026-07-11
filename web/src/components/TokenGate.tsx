// 登录闸（spec §10 双轨）：配置了 SSO provider 时先给 provider 登录，粘贴 token 始终保留
import { useState } from "react";
import type { AuthProviderConfig } from "../lib/oidc";
import { useT } from "../i18n/useT";
import { LanguageSwitcher } from "./LanguageSwitcher";
import "../i18n/strings/TokenGate";

interface Props {
  error: string | null;
  providers: AuthProviderConfig[];
  onSso(provider: AuthProviderConfig): void;
  onSubmit(token: string): void;
}

export function TokenGate({ error, providers, onSso, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const t = useT();

  return (
    <main className="gate">
      <h1 className="d-title gate-title">
        Agent<span className="d-hl">Party</span>
      </h1>
      <p className="d-hand gate-sub">{t("TokenGate.subtitle")}</p>
      <div className="d-card gate-card">
        {providers.length > 0 && (
          <>
            {providers.map((provider) => (
              <button
                key={provider.id}
                className="d-btn d-btn--primary gate-btn"
                type="button"
                onClick={() => onSso(provider)}
              >
                {provider.label}
              </button>
            ))}
            <p className="gate-social">{t("TokenGate.ssoHint")}</p>
            <p className="t-mono gate-or">{t("TokenGate.or")}</p>
          </>
        )}
        <form
          className="gate-form"
          onSubmit={(e) => {
            e.preventDefault();
            const token = value.trim();
            if (token) onSubmit(token);
          }}
        >
          <label className="t-mono gate-label" htmlFor="ap-token">
            {t("TokenGate.tokenLabel")}
          </label>
          <input
            id="ap-token"
            className="t-mono gate-input"
            type="password"
            placeholder="ap_…"
            autoComplete="off"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? "ap-token-error" : undefined}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {error !== null && (
            <p id="ap-token-error" className="banner banner--red" role="alert">
              {error}
            </p>
          )}
          <button className="d-btn gate-btn" type="submit" disabled={value.trim() === ""}>
            {t("TokenGate.submit")}
          </button>
          <p className="gate-hint">party token create --name you --role human</p>
        </form>
      </div>
      <div className="gate-lang">
        <LanguageSwitcher />
      </div>
    </main>
  );
}
