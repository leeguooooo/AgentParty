// 应用骨架：登录闸 → 头部 + 左侧频道列表 + 右侧（首页 | 频道页）
import { useCallback, useEffect, useState } from "react";
import { ChannelList } from "./components/ChannelList";
import { TokenGate } from "./components/TokenGate";
import {
  AuthError,
  clearShareToken,
  clearToken,
  currentShareToken,
  dropUrlToken,
  getToken,
  isShareMode,
  listChannels,
  saveToken,
  storedToken,
  type ChannelInfo,
} from "./lib/api";
import { ChannelPage } from "./pages/Channel";
import { Home } from "./pages/Home";
import { matchChannel, useRoute } from "./router";

export function App() {
  const [path, navigate] = useRoute();
  const [token, setToken] = useState<string | null>(() => getToken());
  const [authError, setAuthError] = useState<string | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

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

  if (token === null) {
    return (
      <TokenGate
        error={authError}
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
        {!isShareMode() && (
          <button
            type="button"
            className="app-signout t-mono"
            onClick={() => {
              clearToken();
              setAuthError(null);
              setChannels(null);
              setListError(null);
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
