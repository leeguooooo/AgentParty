// 外部协作者邀请落地页（#593）：/invite/<code>。
// 未登录：先展示邀请预览（频道 + 预设昵称）+ 登录按钮，登录回来自动兑换；
// 已登录：直接兑换（入册实例 + 入频道 + 设昵称三合一），成功跳进频道。
// 兑换是一次性抢占，但同账号重放幂等——刷新/断网重试不烧码。
import { useEffect, useRef, useState } from "react";
import {
  AuthError,
  getInvitePreview,
  redeemExternalInvite,
  ValidationError,
  type InvitePreview,
} from "../lib/api";
import { beginLogin, type AuthProviderConfig } from "../lib/oidc";
import { useT } from "../i18n/useT";
import "../i18n/strings/App";
import "../i18n/strings/InviteLanding";

interface Props {
  code: string;
  token: string | null;
  providers: AuthProviderConfig[];
  providersResolved: boolean;
  /** 登录前落存 pending code（跨 OIDC 重定向），由 App 提供 */
  onBeforeLogin(): void;
  /** 兑换成功：App 负责刷新频道列表并跳转 /c/<slug> */
  onRedeemed(channelSlug: string): void;
  /** token 失效：App 清 token 回登录闸 */
  onAuthFailed(message: string): void;
}

export function InviteLanding({
  code,
  token,
  providers,
  providersResolved,
  onBeforeLogin,
  onRedeemed,
  onAuthFailed,
}: Props) {
  const t = useT();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const redeeming = useRef(false);
  // 兑换结果必须送达：App 每次 render 都会换 onRedeemed 身份，若把它放进 effect deps，
  // in-flight 请求的结果会被 cleanup 丢弃、页面卡死在「正在加入」。回调走 ref，effect 只随 token/code 重跑。
  const onRedeemedRef = useRef(onRedeemed);
  const onAuthFailedRef = useRef(onAuthFailed);
  onRedeemedRef.current = onRedeemed;
  onAuthFailedRef.current = onAuthFailed;

  useEffect(() => {
    // 组件实例会在 /invite/a → /invite/b 间复用：先清掉上一个 code 的状态
    setPreview(null);
    setPreviewError(null);
    setRedeemError(null);
    setLoginError(null);
    redeeming.current = false;
    let alive = true;
    getInvitePreview(code)
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setPreviewError(e instanceof ValidationError ? t("InviteLanding.notFound") : t("InviteLanding.failed"));
      });
    return () => {
      alive = false;
    };
  }, [code, t]);

  // 已登录 → 直接兑换。不等预览返回：兑换端点自身会校验一切状态，少一跳。
  useEffect(() => {
    if (token === null || redeeming.current) return;
    redeeming.current = true;
    redeemExternalInvite(token, code)
      .then((r) => {
        onRedeemedRef.current(r.channel_slug);
      })
      .catch((e: unknown) => {
        redeeming.current = false;
        if (e instanceof AuthError) {
          onAuthFailedRef.current(e.message);
          return;
        }
        setRedeemError(e instanceof Error ? e.message : t("InviteLanding.failed"));
      });
  }, [token, code, t]);

  const stateBlocked =
    preview !== null && preview.state !== "pending" ? t(`InviteLanding.state.${preview.state}`) : null;

  return (
    <main className="gate">
      <h1 className="d-title gate-title">
        Agent<span className="d-hl">Party</span>
      </h1>
      {previewError !== null ? (
        <p className="banner banner--red" role="alert">
          {previewError}
        </p>
      ) : preview === null ? (
        <p className="banner" role="status" aria-live="polite">
          {t("InviteLanding.loading")}
        </p>
      ) : (
        <div className="d-card gate-card">
          <p className="d-hand gate-sub">{t("InviteLanding.heading")}</p>
          <dl className="invite-preview">
            <div className="invite-preview-row">
              <dt className="t-mono">{t("InviteLanding.channelLabel")}</dt>
              <dd>{preview.channel_title ?? preview.channel_slug}</dd>
            </div>
            <div className="invite-preview-row">
              <dt className="t-mono">{t("InviteLanding.nicknameLabel")}</dt>
              <dd>@{preview.preset_handle}</dd>
            </div>
          </dl>
          {/* 兑换失败优先展示（含 410 已用/过期的服务端文案）；其次静态失效态 */}
          {redeemError !== null ? (
            <p className="banner banner--red" role="alert">
              {redeemError}
            </p>
          ) : stateBlocked !== null ? (
            <p className="banner banner--red" role="alert">
              {stateBlocked}
            </p>
          ) : token !== null ? (
            <p className="banner" role="status" aria-live="polite">
              {t("InviteLanding.joining")}
            </p>
          ) : (
            <>
              <p className="gate-social">{t("InviteLanding.signInHint")}</p>
              {loginError !== null && (
                <p className="banner banner--red" role="alert">
                  {loginError}
                </p>
              )}
              {providersResolved && providers.length === 0 ? (
                <p className="banner banner--red" role="alert">
                  {t("InviteLanding.noProviders")}
                </p>
              ) : (
                providers.map((provider) => (
                  <button
                    key={provider.id}
                    className="d-btn d-btn--primary gate-btn"
                    type="button"
                    onClick={() => {
                      setLoginError(null);
                      onBeforeLogin();
                      beginLogin(provider).catch(() => setLoginError(t("InviteLanding.loginFailed")));
                    }}
                  >
                    {provider.label ||
                      (provider.type === "oidc"
                        ? t("App.auth.oidcSignIn")
                        : t("App.auth.providerSignIn", { id: provider.id }))}
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}
    </main>
  );
}

// 实例邀请制的兜底门（#593）：没走邀请链接、直接登录的未入册账号——所有 API 都是 403
// invite_required，这里给一个输入邀请码的出口（提交即跳 /invite/<code> 走标准兑换）。
export function InviteRequiredGate({
  onSubmitCode,
  onSignOut,
}: {
  onSubmitCode(code: string): void;
  onSignOut(): void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  return (
    <main className="gate">
      <h1 className="d-title gate-title">
        Agent<span className="d-hl">Party</span>
      </h1>
      <div className="d-card gate-card">
        <p className="d-hand gate-sub">{t("InviteRequired.title")}</p>
        <p className="gate-social">{t("InviteRequired.desc")}</p>
        <form
          className="gate-form"
          onSubmit={(e) => {
            e.preventDefault();
            const code = value.trim();
            if (code) onSubmitCode(code);
          }}
        >
          <input
            className="t-mono gate-input"
            type="text"
            placeholder={t("InviteRequired.placeholder")}
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="d-btn d-btn--primary gate-btn" type="submit" disabled={value.trim() === ""}>
            {t("InviteRequired.submit")}
          </button>
        </form>
        <button type="button" className="d-btn gate-btn" onClick={onSignOut}>
          {t("InviteRequired.signOut")}
        </button>
      </div>
    </main>
  );
}
