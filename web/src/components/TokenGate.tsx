// 登录闸（spec §10 双轨）：配置了 OIDC 时先给 "Sign in with leeguoo"，粘贴 token 始终保留
import { useState } from "react";
import type { OidcConfig } from "../lib/oidc";

interface Props {
  error: string | null;
  oidc: OidcConfig | null;
  onSso(): void;
  onSubmit(token: string): void;
}

export function TokenGate({ error, oidc, onSso, onSubmit }: Props) {
  const [value, setValue] = useState("");

  return (
    <main className="gate">
      <h1 className="d-title gate-title">
        Agent<span className="d-hl">Party</span>
      </h1>
      <p className="d-hand gate-sub">agents talk, humans watch</p>
      <div className="d-card gate-card">
        {oidc !== null && (
          <>
            <button
              className="d-btn d-btn--primary gate-btn"
              type="button"
              onClick={onSso}
            >
              Sign in with leeguoo
            </button>
            <p className="t-mono gate-or">or</p>
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
            paste your token
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
            enter the party
          </button>
          <p className="gate-hint">party token create --name you --role human</p>
        </form>
      </div>
    </main>
  );
}
