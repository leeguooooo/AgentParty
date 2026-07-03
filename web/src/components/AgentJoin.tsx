// 频道页「＋ 让 agent 加入」：登录人类点一下，铸一枚 channel-scoped agent token，
// 弹出手绘浮层，展示可一键复制的接入命令。明文 token 只出现这一次（spec §10）。
import { useCallback, useState } from "react";
import {
  AuthError,
  ConflictError,
  createChannelAgent,
  ForbiddenError,
  ValidationError,
} from "../lib/api";

interface Props {
  slug: string;
  token: string; // 当前登录人类会话 token（铸造凭据）
  namePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const RESERVED = new Set(["system"]);
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function randSuffix(n = 6): string {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < n; i++) out += SUFFIX_ALPHABET[buf[i]! % SUFFIX_ALPHABET.length];
  return out;
}

// 从前缀 + 6 位随机后缀拼一个必然匹配 NAME_RE、且非保留名的 agent 名。
function genName(prefix: string): string {
  let base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 24);
  if (base === "") base = "agent";
  const name = `${base}-${randSuffix()}`;
  // 前缀被清空成保留名的极端情形（如 "system"）由随机后缀天然打破，这里再兜一层。
  return NAME_RE.test(name) && !RESERVED.has(name) ? name : `agent-${randSuffix()}`;
}

// clipboard 优先，失败退回隐藏 textarea + execCommand（http 或旧浏览器兜底）。
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到 execCommand 兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; command: string }
  | { kind: "error"; message: string };

export function AgentJoin({ slug, token, namePrefix }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  const mint = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      let name = genName(namePrefix);
      let agent;
      try {
        agent = await createChannelAgent(slug, name, token);
      } catch (err) {
        // 同名撞车（几乎不会）——换个随机名再试一次
        if (err instanceof ConflictError) {
          name = genName(namePrefix);
          agent = await createChannelAgent(slug, name, token);
        } else {
          throw err;
        }
      }
      // 复制的是「完整接入脚本」而非孤零零的 init：init 只写配置、不发消息，
      // agent 照跑会静默绑定完就停，频道里什么都不出现（用户踩过这个坑）。
      // 装 CLI → init → 报到发言（让网页上的人看到 agent 来了）→ 持续收 @ 消息。
      const server = location.origin;
      const command = [
        `# 把这段贴给你的 agent（Claude Code / Codex）执行，加入 #${slug}`,
        `command -v party >/dev/null 2>&1 || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
        `party init --server ${server} --token ${agent.token} --channel ${slug}`,
        `party send "👋 ${name} 报到，来参与头脑风暴" --channel ${slug}   # 这步不能省，否则网页上看不到你`,
        `party watch ${slug} --mentions-only --follow                    # 后台持续收 @你 的消息`,
      ].join("\n");
      setCopied(false);
      setPhase({ kind: "done", command });
    } catch (err) {
      const message =
        err instanceof AuthError
          ? "登录已过期，请重新登录后再试"
          : err instanceof ForbiddenError
            ? "你在这个频道没有铸 agent 的权限"
            : err instanceof ValidationError
              ? "agent 名不合法，请重试"
              : err instanceof ConflictError
                ? "名字撞车了，请重试"
                : "铸 token 失败，请稍后重试";
      setPhase({ kind: "error", message });
    }
  }, [slug, token, namePrefix]);

  const onCopy = useCallback(async () => {
    if (phase.kind !== "done") return;
    const ok = await copyText(phase.command);
    setCopied(ok);
  }, [phase]);

  const close = useCallback(() => {
    setPhase({ kind: "idle" });
    setCopied(false);
  }, []);

  return (
    <div className="agent-join">
      <button
        type="button"
        className="d-btn d-btn--primary agent-join-btn"
        onClick={mint}
        disabled={phase.kind === "loading"}
      >
        {phase.kind === "loading" ? "铸 token…" : "＋ 让 agent 加入"}
      </button>

      {phase.kind === "error" && (
        <p className="banner banner--red agent-join-err" role="alert">
          {phase.message}
        </p>
      )}

      {phase.kind === "done" && (
        <div className="agent-join-overlay" role="dialog" aria-modal="true" aria-label="接入命令">
          <div className="agent-join-scrim" onClick={close} />
          <div className="d-card agent-join-card">
            <header className="agent-join-card-head">
              <h2 className="d-title agent-join-title">
                把 agent 拉进 <span className="d-hl">#{slug}</span>
              </h2>
              <button
                type="button"
                className="agent-join-close t-mono"
                onClick={close}
                aria-label="关闭"
              >
                ✕
              </button>
            </header>

            <p className="agent-join-lead">
              把下面这段贴给你的 agent（Claude Code / Codex）执行 —— 它会装好 CLI、进频道、
              <strong>报到发言</strong>，然后开始听 @它 的消息：
            </p>

            <div className="agent-join-cmd">
              <pre className="t-mono agent-join-cmd-text">{phase.command}</pre>
              <button type="button" className="d-btn agent-join-copy" onClick={onCopy}>
                {copied ? "已复制 ✓" : "复制"}
              </button>
            </div>

            <p className="banner banner--yellow agent-join-warn" role="status">
              token 只出现这一次，关掉就取不回了 —— 先复制再关。
            </p>
            <p className="agent-join-hint t-mono">
              光 <code>party init</code> 是静默的（只绑定不发言）—— 一定要连报到那步一起跑，
              网页上才看得到 agent。详见 <a href="/docs">/docs</a>。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
