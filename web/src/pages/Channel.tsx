// 频道页：presence 条 + 实时消息流 + 内联错误条幅 + 插话框。
// App 用 key={slug} 挂载本组件，切频道即整体重建（socket/状态零残留）。
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AgentJoin } from "../components/AgentJoin";
import { Composer } from "../components/Composer";
import { MessageCard } from "../components/MessageCard";
import { PresenceBar } from "../components/PresenceBar";
import { AuthError, ForbiddenError, fetchMessages } from "../lib/api";
import { ChannelSocket } from "../lib/ws";
import { channelReducer, initialChannelState } from "../state";

interface Props {
  slug: string;
  token: string;
  mode: "normal" | "party";
  isPublic: boolean; // 顶栏 PUBLIC 徽章（spec §4）
  shareMode: boolean;
  // 有可写人类账号会话（me.role==="human" 且非分享链接）才允许铸 agent（spec §10）
  canMintAgent: boolean;
  agentNamePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
  onAuthFailed(message: string): void;
}

const MENTION_RE = /@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;

export function ChannelPage({
  slug,
  token,
  mode,
  isPublic,
  shareMode,
  canMintAgent,
  agentNamePrefix,
  onAuthFailed,
}: Props) {
  const [state, dispatch] = useReducer(channelReducer, initialChannelState);
  const [draft, setDraft] = useState("");
  const [historyError, setHistoryError] = useState<string | null>(null);
  const sockRef = useRef<ChannelSocket | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const pendingDraftsRef = useRef<string[]>([]);
  const stickBottom = useRef(true);
  const authFailedRef = useRef(onAuthFailed);
  authFailedRef.current = onAuthFailed;

  useEffect(() => {
    const sock = new ChannelSocket(
      slug,
      token,
      {
        onFrame: (frame) => dispatch({ type: "frame", frame }),
        onStatus: (status) => dispatch({ type: "status", status }),
        onFatal: (reason) => {
          if (reason === "revoked") authFailedRef.current("token revoked — paste a new one");
          else dispatch({ type: "fatal", reason });
        },
      },
      { queryToken: shareMode },
    );
    sockRef.current = sock;
    sock.connect();
    return () => {
      sock.dispose();
      sockRef.current = null;
    };
  }, [slug, token, shareMode]);

  // 归档频道 do 在 welcome/补拉前就 1008 踢线，历史回看走 rest 兜底（spec §6「网页仍可回看」）
  useEffect(() => {
    if (!state.archived) return;
    let alive = true;
    fetchMessages(token, slug)
      .then((msgs) => {
        if (!alive) return;
        setHistoryError(null);
        for (const m of msgs) dispatch({ type: "frame", frame: m }); // 按 seq 去重，与 ws 交叠无害
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof AuthError) authFailedRef.current("token revoked — paste a new one");
        else if (err instanceof ForbiddenError) dispatch({ type: "fatal", reason: "forbidden" });
        else setHistoryError("history failed to load");
      });
    return () => {
      alive = false;
    };
  }, [state.archived, slug, token]);

  // 新消息贴底滚动；用户上翻回看时不打扰
  const lastSeq = state.messages.length > 0 ? state.messages[state.messages.length - 1]!.seq : 0;
  useEffect(() => {
    const el = streamRef.current;
    if (el !== null && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastSeq]);

  const onScroll = useCallback(() => {
    const el = streamRef.current;
    if (el !== null) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }, []);

  // 服务端 sent 确认后才清对应草稿；用户已输入的新内容不能被旧 ack 清掉。
  useEffect(() => {
    if (state.lastSentSeq <= 0) return;
    const submitted = pendingDraftsRef.current.shift();
    if (submitted === undefined) return;
    setDraft((current) => (current === submitted ? "" : current));
  }, [state.lastSentSeq]);

  const send = useCallback(() => {
    const body = draft.trim();
    if (body === "") return;
    const mentions = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]!))];
    const ok =
      sockRef.current?.send({ type: "send", kind: "message", body, mentions, reply_to: null }) ??
      false;
    // ⌘⏎ 不受按钮 disabled 门控，断线窗口内发送失败要内联提示（草稿保留）
    if (ok) pendingDraftsRef.current.push(draft);
    else dispatch({ type: "send_failed", message: "not connected — message not sent, draft kept" });
  }, [draft]);

  const canWrite = state.self !== null && !state.archived && !state.readonly;

  // 私有频道拒入（spec §3）：ws 已停止重连，给一条友好红条，不留空白 / 不无限转圈
  if (state.forbidden) {
    return (
      <div className="chan chan--forbidden">
        <p className="banner banner--red" role="alert">
          这是私有频道，你没有访问权限
        </p>
      </div>
    );
  }

  return (
    <div className="chan">
      <PresenceBar
        presence={state.presence}
        participants={state.participants}
        status={state.status}
        party={mode === "party" || state.mode === "party"}
        isPublic={isPublic}
      />
      {canMintAgent && !state.archived && (
        <div className="chan-toolbar">
          <AgentJoin slug={slug} token={token} namePrefix={agentNamePrefix} />
        </div>
      )}
      <div className="stream" ref={streamRef} onScroll={onScroll}>
        {state.messages.map((m) => (
          <MessageCard key={m.seq} msg={m} self={state.self} />
        ))}
        {state.messages.length === 0 && (
          <p className="d-empty" role="status" aria-live="polite">
            party watch {slug}
          </p>
        )}
      </div>
      {state.archived && (
        <p className="banner banner--gray" role="status" aria-live="polite">
          channel archived — read-only from here on
        </p>
      )}
      {historyError !== null && (
        <p className="banner banner--red" role="alert">
          {historyError}
        </p>
      )}
      {state.loopGuard !== null && (
        <p className="banner banner--yellow" role="alert">
          loop guard: agents hit the back-and-forth cap — a human message resets it
        </p>
      )}
      {state.readonly && !state.archived && (
        <p className="banner banner--gray" role="status" aria-live="polite">
          read-only link — you're watching the party
        </p>
      )}
      {state.sendError !== null && canWrite && (
        <p className="banner banner--red" role="alert">
          {state.sendError}
        </p>
      )}
      {canWrite && (
        <Composer draft={draft} setDraft={setDraft} onSend={send} ready={state.status === "open"} />
      )}
    </div>
  );
}
