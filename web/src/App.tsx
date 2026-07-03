// 应用骨架：登录闸 → 头部 + 左侧频道列表 + 右侧（首页 | 频道页）
import { useCallback, useEffect, useState } from "react";
import { ChannelList } from "./components/ChannelList";
import { TokenGate } from "./components/TokenGate";
import {
  AuthError,
  clearToken,
  dropUrlToken,
  getToken,
  isShareMode,
  listChannels,
  saveToken,
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
    if (isShareMode()) dropUrlToken();
    else clearToken();
    setAuthError(message);
    setChannels(null);
    setToken(null);
  }, []);

  useEffect(() => {
    if (token === null) return;
    let alive = true;
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

  if (token === null) {
    return (
      <TokenGate
        error={authError}
        onSubmit={(t) => {
          // 粘贴登录只在非分享模式落 localStorage；分享模式坏 t 已被摘除
          saveToken(t);
          setAuthError(null);
          setToken(t);
        }}
      />
    );
  }

  const slug = matchChannel(path);
  const openChannel = (s: string) => navigate(`/c/${s}`);

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
          {slug !== null ? (
            <ChannelPage
              key={slug}
              slug={slug}
              token={token}
              mode={channels?.find((c) => c.slug === slug)?.mode ?? "normal"}
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
