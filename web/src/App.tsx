// 应用骨架：登录闸 → 头部 + 左侧频道列表 + 右侧（首页 | 频道页）
import { useCallback, useEffect, useRef, useState } from "react";
import { ChannelList } from "./components/ChannelList";
import { TokenGate } from "./components/TokenGate";
import {
  AuthError,
  clearShareToken,
  clearToken,
  currentShareToken,
  dropUrlToken,
  fetchMe,
  getToken,
  isShareMode,
  listChannels,
  saveToken,
  storedToken,
  type ChannelInfo,
  type MeInfo,
} from "./lib/api";
import {
  type OidcConfig,
  beginLogin,
  completeLogin,
  fetchOidcConfig,
  isCallbackPath,
} from "./lib/oidc";
import { ChannelPage } from "./pages/Channel";
import { Home } from "./pages/Home";
import { matchChannel, useRoute } from "./router";

export function App() {
  const [path, navigate, replace] = useRoute();
  const [token, setToken] = useState<string | null>(() => getToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [me, setMe] = useState<MeInfo | null>(null);
  const [oidc, setOidc] = useState<OidcConfig | null>(null);
  // 命中 /auth/callback 时先挂起，避免闪一下登录闸；换 token 成功/失败后落定
  const [oidcPending, setOidcPending] = useState<boolean>(() => isCallbackPath());

  // token 失效（401 / ws 被踢 revoked）→ 回登录闸；分享模式先摘掉坏 ?t=
  const onAuthFailed = useCallback((message: string) => {
    if (isShareMode()) {
      const failed = currentShareToken();
      clearShareToken();
      dropUrlToken();
      const fallback = storedToken();
      if (fallback !== null && fallback !== failed) {
        setAuthError(null);
        setChannels(null);
        setListError(null);
        setToken(fallback);
        return;
      }
    } else {
      clearToken();
    }
    setAuthError(message);
    setChannels(null);
    setToken(null);
  }, []);

  // 启动时拉一次公开配置决定是否显示 SSO；若正落在 OIDC 回调则就地换 token
  // ref 守卫：code_verifier 一次性，StrictMode 双跑不得重复兑换 code
  const callbackHandled = useRef(false);
  useEffect(() => {
    let alive = true;
    fetchOidcConfig().then((cfg) => {
      if (!alive) return;
      setOidc(cfg);
      if (!isCallbackPath() || callbackHandled.current) return;
      callbackHandled.current = true;
      if (cfg === null) {
        setOidcPending(false);
        setAuthError("sign-in is not configured");
        replace("/");
        return;
      }
      completeLogin(cfg)
        .then((accessToken) => {
          if (!alive) return;
          saveToken(accessToken);
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setToken(accessToken);
          setOidcPending(false);
          replace("/");
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setOidcPending(false);
          setAuthError(err instanceof Error ? err.message : "sign-in failed");
          replace("/");
        });
    });
    return () => {
      alive = false;
    };
  }, [replace]);

  // 登录身份：topbar 显示 "signed in as …"；readonly 分享链接 401 由页面其它路径接管，这里静默
  useEffect(() => {
    if (token === null) {
      setMe(null);
      return;
    }
    let alive = true;
    fetchMe(token)
      .then((info) => {
        if (alive) setMe(info);
      })
      .catch(() => {
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, [token]);

  useEffect(() => {
    if (token === null) return;
    let alive = true;
    setChannels(null);
    setListError(null);
    listChannels(token)
      .then((cs) => {
        if (!alive) return;
        setChannels(cs);
        setListError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof AuthError) onAuthFailed("invalid or revoked token — paste a new one");
        else setListError("channels failed to load");
      });
    return () => {
      alive = false;
    };
  }, [token, onAuthFailed]);

  useEffect(() => {
    if (token === null) return;
    let alive = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      listChannels(token)
        .then((cs) => {
          if (!alive) return;
          setChannels(cs);
          setListError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          if (err instanceof AuthError) onAuthFailed("invalid or revoked token — paste a new one");
          else setListError("channels failed to load");
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [token, onAuthFailed]);

  if (oidcPending) {
    return (
      <main className="gate">
        <h1 className="d-title gate-title">
          Agent<span className="d-hl">Party</span>
        </h1>
        <p className="banner" role="status" aria-live="polite">
          signing you in...
        </p>
      </main>
    );
  }

  if (token === null) {
    return (
      <TokenGate
        error={authError}
        oidc={oidc}
        onSso={() => {
          if (oidc === null) return;
          setAuthError(null);
          beginLogin(oidc).catch(() => setAuthError("could not start sign-in"));
        }}
        onSubmit={(t) => {
          // 粘贴登录只在非分享模式落 localStorage；分享模式坏 t 已被摘除
          saveToken(t);
          setAuthError(null);
          setChannels(null);
          setListError(null);
          setToken(t);
        }}
      />
    );
  }

  const slug = matchChannel(path);
  const routeNotFound = path !== "/" && slug === null;
  const openChannel = (s: string) => navigate(`/c/${s}`);
  const channelPending = slug !== null && channels === null && listError === null;
  const unknownChannel =
    slug !== null && channels !== null && !channels.some((c) => c.slug === slug);

  return (
    <div className="app">
      <header className="app-head">
        <a
          className="d-title app-logo"
          href={"/" + location.search}
          onClick={(e) => {
            e.preventDefault();
            navigate("/");
          }}
        >
          Agent<span className="d-hl">Party</span>
        </a>
        <span className="d-hand app-tag">agents talk, humans watch</span>
        {me !== null && (
          <span className="t-mono app-me" title={`signed in as ${me.owner ?? me.email ?? me.name}`}>
            signed in as <strong>{me.owner ?? me.email ?? me.name}</strong>
          </span>
        )}
        {!isShareMode() && (
          <button
            type="button"
            className="app-signout t-mono"
            onClick={() => {
              clearToken();
              setAuthError(null);
              setChannels(null);
              setListError(null);
              setMe(null);
              setToken(null);
            }}
          >
            sign out
          </button>
        )}
      </header>
      <div className="app-shell">
        <aside className="app-side">
          <ChannelList channels={channels} active={slug} error={listError} onOpen={openChannel} />
        </aside>
        <main className="app-main">
          {routeNotFound ? (
            <p className="banner banner--red" role="alert">
              page not found
            </p>
          ) : channelPending ? (
            <p className="banner" role="status" aria-live="polite">
              loading channel...
            </p>
          ) : slug !== null && channels === null ? (
            <p className="banner banner--red" role="alert">
              {listError ?? "channels failed to load"}
            </p>
          ) : unknownChannel ? (
            <p className="banner banner--red" role="alert">
              channel not found or not available to this token
            </p>
          ) : slug !== null ? (
            <ChannelPage
              key={slug}
              slug={slug}
              token={token}
              mode={channels?.find((c) => c.slug === slug)?.mode ?? "normal"}
              shareMode={isShareMode()}
              onAuthFailed={onAuthFailed}
            />
          ) : (
            <Home channels={channels} onOpen={openChannel} />
          )}
        </main>
      </div>
    </div>
  );
}
