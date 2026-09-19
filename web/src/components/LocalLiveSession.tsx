// #1103 item 1：桌面「本机 Agent」面板的 live 入口。直接读本机 runner 的输出快照（serve 写的 tap 文件），
// 不经频道 WS；复用 LiveSessionModal 渲染。只读：没有输入框、不接管键盘，发话仍走频道。
import { useEffect, useState } from "react";
import type { LiveSession } from "../state";
import type { LocalLiveTarget } from "../lib/localLiveOutput";
import { LiveSessionModal } from "./LiveSessionView";

/** 轮询间隔：serve 最多每 500ms 刷一次 tap，1s 足够跟上又不空耗。 */
export const LOCAL_LIVE_POLL_MS = 1_000;

export interface LocalLiveSessionModalProps {
  name: string;
  display: string;
  target: LocalLiveTarget;
  read: (target: LocalLiveTarget, name: string) => Promise<LiveSession | null>;
  onClose: () => void;
  pollMs?: number;
}

export function LocalLiveSessionModal({ name, display, target, read, onClose, pollMs = LOCAL_LIVE_POLL_MS }: LocalLiveSessionModalProps) {
  const [session, setSession] = useState<LiveSession | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await read({ kind: target.kind, id: target.id }, name);
        if (!cancelled) setSession(next);
      } catch {
        // 读失败（旧壳/文件被替换中）：保留上一屏，下一拍再试
      }
      if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [read, target.kind, target.id, name, pollMs]);
  return <LiveSessionModal name={name} display={display} session={session} onClose={onClose} />;
}
