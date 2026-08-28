// 频道页「＋ 让 agent 加入」：登录人类先给 agent 起个能认出来的名字（默认 <你>-<频道>，
// 可改成 drawstyle-review 这类），再铸一枚 channel-scoped agent token，然后进入**分步引导**（#1005）：
//   ① 装 party → ② 在 agent 里跑接入命令 → ③ 起一个可唤醒的会话 → ④ 验证 → ✅ 接入完成
// 每一步的 ✓ 来自服务端真实信号（presence / 历史，判据在 lib/joinStepper），不是本地猜；
// 弹窗打开时靠频道页传进来的 WS 流（拿不到就 2–3s 轮询），关掉即停。
// 明文 token 只出现这一次（spec §10）：关掉再打开只能「重新生成」。
// 「恢复/重连」（成员详情里的「重新接上」）走同一个 stepper，② 换成 `party recover <chan>`（#991）。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import { WAKE_VERIFY_PREFIX } from "@agentparty/shared";
import { INSTALL_SH_RAW_URL } from "@agentparty/shared/onboarding";
import {
  AuthError,
  type ChannelCharter,
  ConflictError,
  createChannelAgent,
  fetchChannelPresence,
  fetchMessages,
  ForbiddenError,
  rotateChannelAgent,
  ValidationError,
} from "../lib/api";
import { copyText, saveAgentToken } from "../lib/agentTokenVault";
import {
  buildJoinPack,
  DEFAULT_JOIN_RUNNER,
  guessJoinPackHarness,
  type JoinPackHarness,
  type JoinPackMode,
} from "../lib/joinPack";
import {
  checkinEvidence,
  findProbeSeq,
  maxSeq,
  replyEvidence,
  stepStatuses,
  verifyTimeoutTier,
  wakeableEvidence,
  type StepId,
  type StepStatus,
  type VerifyProbe,
} from "../lib/joinStepper";
import { desktopAgentAdapter, type DesktopAgentAdapter, type DesktopAgentRunner } from "../lib/desktopAgent";
import { isDesktopRuntime, pickDirectory as pickDirectoryDefault } from "../lib/desktopRuntime";
import { DesktopInstallButton } from "./DesktopInstall";

// #616 phase 4 的常驻是 launchd（macOS-only）：非 mac 桌面端不渲染接管按钮，
// 免得点了必然吃后端 unsupported 错误。
function isMacDesktop(): boolean {
  return isDesktopRuntime() && /mac/i.test(globalThis.navigator?.userAgent ?? "");
}
import { apiOrigin } from "../lib/base";
import { forbiddenText } from "../lib/forbidden";
import { useT, type TFunc } from "../i18n/useT";
import { useDismissableLayer } from "./useDismissableLayer";
import { useModalFocusTrap } from "./useModalFocusTrap";
import "../i18n/strings/AgentJoin";

interface Props {
  slug: string;
  /** 测试注入；生产恒为默认值。 */
  dutyAdapter?: Pick<DesktopAgentAdapter, "dutyAdopt">;
  desktopDetect?: () => boolean;
  pickDirectory?: (title?: string) => Promise<string | null>;
  token: string; // 当前登录人类会话 token（铸造凭据）
  namePrefix: string; // 生成 agent 名的前缀来源（email/name 前缀，退回 slug）
  inviterName: string; // 邀请人在频道里的身份名，报到时 @ 他让他知道你来了
  charter: ChannelCharter | null;
  accountKey: string;
  active?: boolean;
  onActiveChange?(open: boolean): void;
  /**
   * 频道页的实时 presence / 历史（WS 流）。传了就直接用（不轮询）；缺省时弹窗打开期间每 pollIntervalMs
   * 拉一次 /presence + /messages，关掉即停（#1005）。
   */
  presence?: PresenceEntry[];
  messages?: MsgFrame[];
  /** 以当前登录用户身份发一条普通消息（第 ④ 步的测试 @）。返回 false = 没连上、没发出去。缺省则不渲染按钮。 */
  sendMessage?: (body: string, mention: string) => boolean;
  /** 「恢复/重连」入口（#1005）：非 null 时直接打开 recover 形态的 stepper（② = party recover <chan>）。 */
  recoverName?: string | null;
  /** 轮询/计时参数（测试注入）。 */
  pollIntervalMs?: number;
  tickMs?: number;
  verifyTimeoutMs?: number;
  now?: () => number;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const RESERVED = new Set(["system"]);
// 完整接入包 builder（含 MIN_CLI 版本闸、charter 快照、待命指引）在 lib/joinPack ——
// 与 vault「复制接入包」共用同一份，两个入口的产物逐字节同构（#584 复盘）。

// 从前缀清洗出一个合法的名字词根（小写、仅 [a-z0-9._-]、去首尾非字母数字）。
function cleanBase(prefix: string): string {
  const base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 24);
  return base || "agent";
}

// 默认建议名：<你>-<频道>，直观且大概率唯一；占用了让用户自己改（不再塞随机后缀糊弄）。
function suggestName(prefix: string, slug: string): string {
  const name = `${cleanBase(prefix)}-${slug}`.slice(0, 64);
  return NAME_RE.test(name) && !RESERVED.has(name) ? name : cleanBase(prefix);
}

/** 一次分步引导会话（铸出来的 / 恢复的）。关掉后明文 token 与含 token 的命令一律丢弃。 */
interface StepperSession {
  name: string;
  mode: JoinPackMode;
  harness: JoinPackHarness;
  runner: DesktopAgentRunner;
  recover: boolean;
  /** 明文 token：只在铸出/重铸的这一次弹窗里存在；关掉即丢（#1005）。 */
  token: string | null;
  /** 第 ② 步的命令：interactive/unattended 含 token（token 丢了就 null）；recover 恒为 party recover <chan>。 */
  command: string | null;
  /** 引导开始时刻：只认这之后的报到/活动（铸出来没接入过的身份也可能留 offline 旧行）。 */
  sinceTs: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "compose" } // 起名中
  | { kind: "loading" }
  | { kind: "stepper"; session: StepperSession }
  | { kind: "error"; message: string };

export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SH_RAW_URL} | sh`;

/** 第 ③ 步「起一个可唤醒的会话」的命令：与 CLI `party join` 第 3 步印的修法同一条（#979 / #989）。 */
export function wakeableSessionCommand(slug: string, harness: JoinPackHarness): string {
  if (harness === "claude") return `party claude ${slug}`;
  if (harness === "codex") return `party serve ${slug} --runner codex`;
  return `party serve ${slug}`;
}

function relativeAge(t: TFunc, ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 5) return t("AgentJoin.age.now");
  if (secs < 60) return t("AgentJoin.age.secs", { n: secs });
  return t("AgentJoin.age.mins", { n: Math.round(secs / 60) });
}

// 「命令 + 复制按钮」块——四步里每条命令都用它，免得文案/样式/按钮行为漂移（#724 CodeRabbit）。
// data-cmd 标出是哪条命令（install / join / session），测试与样式都按它定位。
function CommandBlock({
  id,
  command,
  copied,
  onCopy,
  t,
}: {
  id: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
  t: TFunc;
}) {
  return (
    <div className="agent-join-cmd" data-cmd={id}>
      <pre className="t-mono agent-join-cmd-text">{command}</pre>
      <button type="button" className="d-btn agent-join-copy" data-cmd={id} onClick={onCopy}>
        {copied ? t("AgentJoin.copied") : t("AgentJoin.copy")}
      </button>
    </div>
  );
}

const STEP_MARK: Record<StepId, string> = { 1: "①", 2: "②", 3: "③", 4: "④" };

function StepCard({
  id,
  status,
  title,
  summary,
  children,
  t,
}: {
  id: StepId;
  status: StepStatus;
  title: string;
  /** done 时折叠后显示的一句话；active 时显示在标题右侧的等待/状态句。 */
  summary: string | null;
  children?: React.ReactNode;
  t: TFunc;
}) {
  return (
    <li className={`agent-join-step agent-join-step--${status}`} data-step={id} data-status={status}>
      <div className="agent-join-step-head">
        <span className={`t-mono agent-join-step-mark agent-join-step-mark--${status}`} aria-hidden="true">
          {status === "done" ? "✓" : STEP_MARK[id]}
        </span>
        <span className="agent-join-step-title">{title}</span>
        {status === "pending" && <span className="agent-join-step-status t-mono">{t("AgentJoin.step.pending")}</span>}
        {status === "done" && summary !== null && (
          <span className="agent-join-step-status agent-join-step-status--done t-mono" role="status">{summary}</span>
        )}
      </div>
      {status === "active" && (
        <div className="agent-join-step-body">
          {children}
          {summary !== null && <p className="agent-join-step-wait t-mono" role="status">{summary}</p>}
        </div>
      )}
    </li>
  );
}

export function AgentJoin({
  slug,
  token,
  namePrefix,
  inviterName,
  charter,
  accountKey,
  active,
  onActiveChange,
  dutyAdapter = desktopAgentAdapter,
  desktopDetect = isMacDesktop,
  pickDirectory = pickDirectoryDefault,
  presence: presenceProp,
  messages: messagesProp,
  sendMessage,
  recoverName = null,
  pollIntervalMs = 2500,
  tickMs = 1000,
  verifyTimeoutMs = 30_000,
  now: nowFn = Date.now,
}: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [name, setName] = useState("");
  // #612：无人值守值守预设——unattended 生成「装 CLI → init → party serve --runner <选中的>」的
  // 运维脚本（runner 见下方 state，缺省 codex），interactive 仍是贴给 agent harness 的完整接入包。
  const [mode, setMode] = useState<JoinPackMode>("interactive");
  // #749：无人值守常驻用哪个 runner——曾写死 claude,用户选 codex 被静默忽略。默认 codex,
  // 与桌面「转为常驻」面板(DesktopAgentPanel)的 picker 默认一致。仅 unattended 模式用到。
  const [runner, setRunner] = useState<DesktopAgentRunner>(DEFAULT_JOIN_RUNNER);
  // #845 第 4 点：interactive 包的目标 harness——只渲染对应分支把包砍薄。默认 "other"＝全量
  // （兜底，不选择时行为与旧版逐字节一致）。仅 interactive 模式用到。
  const [harness, setHarness] = useState<JoinPackHarness>("other");
  // #616 phase 4：桌面 webview 内的无人值守一键接管状态
  const [adoptState, setAdoptState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [adoptError, setAdoptError] = useState<string | null>(null);
  // 已选的工作目录（转常驻直接运行——不复制接入包，而是选目录就地跑）。
  const [adoptDir, setAdoptDir] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // #642：复制失败要给用户明确反馈，别静默——join 命令带着只展示一次的 channel-scoped token。
  const [copyErr, setCopyErr] = useState(false);
  const [rotateState, setRotateState] = useState<"idle" | "busy" | "error">("idle");
  // 第 ④ 步探针（弹窗里发出的那条测试 @）；sendErr = 没连上没发出去。
  const [probe, setProbe] = useState<VerifyProbe | null>(null);
  const [sendErr, setSendErr] = useState(false);
  // 轮询后备的数据（只有没从频道页拿到 WS 流时才填）。
  const [polled, setPolled] = useState<{ presence: PresenceEntry[]; messages: MsgFrame[] }>({ presence: [], messages: [] });
  const [now, setNow] = useState(() => nowFn());
  // 关掉未完成的引导后可「继续接入」：只留形态与开始时刻，明文 token 一律不留。
  const [lastSession, setLastSession] = useState<StepperSession | null>(null);
  // 每个身份的引导开始时刻：关掉再打开（含 recover 重开）沿用同一基线，报到证据不会因重开而丢。
  const startedAtRef = useRef(new Map<string, number>());
  const composeDialogRef = useRef<HTMLDivElement | null>(null);
  const stepperDialogRef = useRef<HTMLDivElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const open = useCallback(() => {
    onActiveChange?.(true);
    setName(suggestName(namePrefix, slug));
    setMode("interactive");
    setHarness("other");
    setNameErr(null);
    setPhase({ kind: "compose" });
  }, [namePrefix, onActiveChange, slug]);

  const reset = useCallback(() => {
    setPhase((prev) => {
      // 关掉未完成的 stepper：留下可续上的形态（不含 token / 含 token 的命令）。
      if (prev.kind === "stepper") setLastSession({ ...prev.session, token: null, command: prev.session.recover ? prev.session.command : null });
      return { kind: "idle" };
    });
    setName("");
    setCopiedKey(null);
    setCopyErr(false);
    setNameErr(null);
    setRotateState("idle");
    setProbe(null);
    setSendErr(false);
  }, []);

  const close = useCallback(() => {
    reset();
    onActiveChange?.(false);
  }, [onActiveChange, reset]);

  useEffect(() => {
    if (active === false && phase.kind !== "idle") reset();
  }, [active, phase.kind, reset]);

  const openStepper = useCallback(
    (session: StepperSession) => {
      startedAtRef.current.set(session.name, session.sinceTs);
      setCopiedKey(null);
      setCopyErr(false);
      setRotateState("idle");
      setProbe(null);
      setSendErr(false);
      setAdoptState("idle");
      setAdoptError(null);
      setAdoptDir(null); // 新 agent 的引导必须清掉上一次选的目录，否则 UI 误显残留路径
      setNow(nowFn());
      setPhase({ kind: "stepper", session });
      onActiveChange?.(true);
    },
    [nowFn, onActiveChange],
  );

  // 「恢复/重连」入口：成员详情里对离线 agent 点「重新接上」→ 同一个 stepper，② 换成 party recover <chan>。
  useEffect(() => {
    if (recoverName === null) return;
    if (phase.kind === "stepper" && phase.session.name === recoverName && phase.session.recover) return;
    const sinceTs = startedAtRef.current.get(recoverName) ?? nowFn();
    openStepper({
      name: recoverName,
      mode: "interactive",
      harness: guessJoinPackHarness(recoverName),
      runner: DEFAULT_JOIN_RUNNER,
      recover: true,
      token: null,
      command: `party recover ${slug}`,
      sinceTs,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoverName, slug]);

  const dialogOpen = phase.kind === "compose" || phase.kind === "loading" || phase.kind === "stepper";
  const composeOpen = phase.kind === "compose" || phase.kind === "loading";
  const stepperOpen = phase.kind === "stepper";
  useDismissableLayer({ active: dialogOpen, onDismiss: close, dismissOnEscape: false });
  // compose 与 stepper 是两个互斥对话框，各自一个 trap——否则 mint 完成后焦点仍留在已卸载的输入框上。
  useModalFocusTrap({
    active: composeOpen,
    containerRef: composeDialogRef,
    initialFocusRef: nameInputRef,
    onEscape: close,
  });
  useModalFocusTrap({
    active: stepperOpen,
    containerRef: stepperDialogRef,
    onEscape: close,
  });

  // 时钟：stepper 打开期间每 tickMs 走一格（「刚刚」相对时间 + 第 ④ 步超时判定），关掉即停。
  useEffect(() => {
    if (!stepperOpen) return;
    const timer = setInterval(() => setNow(nowFn()), tickMs);
    return () => clearInterval(timer);
  }, [nowFn, stepperOpen, tickMs]);

  // 轮询后备：频道页传了 WS 流就不轮询；缺哪份拉哪份，弹窗关掉即停。
  const needPresencePoll = stepperOpen && presenceProp === undefined;
  const needMessagesPoll = stepperOpen && messagesProp === undefined;
  useEffect(() => {
    if (!needPresencePoll && !needMessagesPoll) return;
    let disposed = false;
    const tick = async () => {
      const [p, m] = await Promise.all([
        needPresencePoll ? fetchChannelPresence(token, slug).catch(() => null) : Promise.resolve(null),
        needMessagesPoll ? fetchMessages(token, slug, { limit: 100 }).catch(() => null) : Promise.resolve(null),
      ]);
      if (disposed) return;
      setPolled((prev) => ({ presence: p ?? prev.presence, messages: m ?? prev.messages }));
    };
    void tick();
    const timer = setInterval(() => void tick(), pollIntervalMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [needMessagesPoll, needPresencePoll, pollIntervalMs, slug, token]);

  const presence = presenceProp ?? polled.presence;
  const messages = messagesProp ?? polled.messages;

  const mint = useCallback(async () => {
    const wanted = name.trim();
    if (!NAME_RE.test(wanted) || RESERVED.has(wanted)) {
      setNameErr(t("AgentJoin.nameError"));
      return;
    }
    setNameErr(null);
    setPhase({ kind: "loading" });
    try {
      const agent = await createChannelAgent(slug, wanted, token);
      // #530：接入包的 server 必须是真实后端。桌面版(Tauri)里 location.origin 是 tauri://localhost /
      // http://tauri.localhost / dev 的 127.0.0.1:5173，agent 拿去 `party init --server` 会因非 http(s)
      // 报错或连不上。优先用打包注入的 apiBase(VITE_API_BASE=真后端)，仅同源 web 部署(apiBase 为空)回退 location.origin。
      const server = apiOrigin();
      const command = buildJoinPack(mode, {
        slug,
        agentName: agent.name,
        agentToken: agent.token,
        server,
        inviterName,
        charter,
        runner,
        harness,
        t,
      });
      const sinceTs = nowFn();
      saveAgentToken({
        account: accountKey,
        slug,
        name: agent.name,
        token: agent.token,
        command,
        mode,
        runner,
        harness,
        savedAt: sinceTs,
      });
      setLastSession(null);
      openStepper({ name: agent.name, mode, harness, runner, recover: false, token: agent.token, command, sinceTs });
    } catch (err) {
      // 同名占用 → 停在起名步，让用户换个有意义的名字（不静默塞随机后缀）
      if (err instanceof ConflictError) {
        setNameErr(t("AgentJoin.nameConflict"));
        setPhase({ kind: "compose" });
        return;
      }
      const message =
        err instanceof AuthError
          ? t("AgentJoin.errAuth")
          : err instanceof ForbiddenError
            ? forbiddenText(err, t, "AgentJoin.errForbidden")
            : err instanceof ValidationError
              ? t("AgentJoin.errValidation")
              : t("AgentJoin.errGeneric");
      setPhase({ kind: "error", message });
    }
  }, [accountKey, charter, harness, inviterName, mode, name, nowFn, openStepper, runner, slug, token, t]);

  // 「重新生成」：关掉再打开后明文 token 已丢（只出现一次），要再贴命令就 rotate 一枚新的（旧的立即作废）。
  const regenerate = useCallback(async () => {
    if (phase.kind !== "stepper" || rotateState === "busy") return;
    const { session } = phase;
    setRotateState("busy");
    try {
      const agent = await rotateChannelAgent(token, slug, session.name);
      const command = buildJoinPack(session.mode, {
        slug,
        agentName: agent.name,
        agentToken: agent.token,
        server: apiOrigin(),
        inviterName,
        charter,
        runner: session.runner,
        harness: session.harness,
        t,
      });
      saveAgentToken({
        account: accountKey,
        slug,
        name: agent.name,
        token: agent.token,
        command,
        mode: session.mode,
        runner: session.runner,
        harness: session.harness,
        savedAt: nowFn(),
      });
      setRotateState("idle");
      setCopiedKey(null);
      setCopyErr(false);
      setPhase({ kind: "stepper", session: { ...session, token: agent.token, command } });
    } catch {
      setRotateState("error");
    }
  }, [accountKey, charter, inviterName, nowFn, phase, rotateState, slug, t, token]);

  // 无人值守直接运行：选工作目录（不手填、不复制接入包）→ dutyAdopt 就地落成 launchd 常驻。
  const adopt = useCallback(async () => {
    if (phase.kind !== "stepper" || phase.session.token === null || adoptState === "busy" || adoptState === "done") return;
    const dir = await pickDirectory(phase.session.name);
    if (dir === null) return; // 取消选目录 = 放弃
    setAdoptDir(dir);
    setAdoptState("busy");
    setAdoptError(null);
    try {
      await dutyAdapter.dutyAdopt({
        server: apiOrigin(),
        token: phase.session.token,
        name: phase.session.name,
        channel: slug,
        runner: phase.session.runner,
        workdir: dir,
      });
      setAdoptState("done");
    } catch (err) {
      setAdoptState("error");
      setAdoptError(err instanceof Error ? err.message : String(err));
    }
  }, [adoptState, dutyAdapter, phase, slug, pickDirectory]);

  const copy = useCallback(async (key: string, text: string) => {
    const ok = await copyText(text);
    setCopiedKey(ok ? key : null);
    setCopyErr(!ok);
  }, []);

  // 第 ④ 步：以当前用户身份发一条普通 `@name ping`（不是 [wake-verify] 验证帧），等它回帖。
  const sendProbe = useCallback(() => {
    if (phase.kind !== "stepper" || sendMessage === undefined) return;
    const body = t("AgentJoin.step4.probeBody", { name: phase.session.name });
    const baselineSeq = maxSeq(messages);
    const ok = sendMessage(body, phase.session.name);
    setSendErr(!ok);
    if (ok) setProbe({ baselineSeq, sentAt: nowFn(), body });
  }, [messages, nowFn, phase, sendMessage, t]);

  const resume = useCallback(() => {
    if (lastSession === null) return;
    openStepper({ ...lastSession, sinceTs: startedAtRef.current.get(lastSession.name) ?? lastSession.sinceTs });
  }, [lastSession, openStepper]);

  // ---- 四步判据（全部来自 presence / 历史）----
  const session = phase.kind === "stepper" ? phase.session : null;
  const checkin = useMemo(
    () => (session === null ? null : checkinEvidence(messages, presence, session.name, session.sinceTs)),
    [messages, presence, session],
  );
  const wakeable = useMemo(
    () => (session === null || checkin === null ? null : wakeableEvidence(presence, session.name, now)),
    [checkin, now, presence, session],
  );
  const probeSeq = useMemo(() => (probe === null ? null : findProbeSeq(messages, probe)), [messages, probe]);
  const reply = useMemo(
    () => (session === null || probe === null ? null : replyEvidence(messages, session.name, probe, probeSeq)),
    [messages, probe, probeSeq, session],
  );
  // agent 自己跑 `party wake verify`（#996 的验证帧形态）：它以自己身份发 `[wake-verify] @自己`，
  // 再回一条 reply_to 指向它——这一对出现在历史里同样算 ④ 过；presence.wake.verified_at 由 DO 盖
  // （只认服务端观测到的成功唤醒），晚于引导开始也算。
  const selfVerified = useMemo(() => {
    if (session === null) return false;
    const entry = presence.find((p) => p.name === session.name);
    const verifiedAt = entry?.wake?.verified_at;
    if (typeof verifiedAt === "number" && verifiedAt >= session.sinceTs) return true;
    const frames = messages.filter((m) => m.sender.name === session.name && m.ts >= session.sinceTs);
    const probes = new Set(frames.filter((m) => m.body.startsWith(WAKE_VERIFY_PREFIX)).map((m) => m.seq));
    return frames.some((m) => m.reply_to !== null && probes.has(m.reply_to));
  }, [messages, presence, session]);
  const verified = reply !== null || selfVerified;
  const probeTimedOut = probe !== null && reply === null && now - probe.sentAt >= verifyTimeoutMs;
  const timeoutTier = useMemo(
    () => (session === null || !probeTimedOut ? null : verifyTimeoutTier(presence, session.name, probeSeq)),
    [presence, probeSeq, probeTimedOut, session],
  );
  const statuses = stepStatuses({ checkin: checkin !== null, wakeable: wakeable !== null, verified });
  const complete = statuses[4] === "done";

  useEffect(() => {
    if (complete && lastSession !== null && session !== null && lastSession.name === session.name) setLastSession(null);
  }, [complete, lastSession, session]);

  const unattended = session?.mode === "unattended";
  const step2Summary =
    checkin === null
      ? t("AgentJoin.step2.waiting")
      : checkin.seq !== null
        ? t("AgentJoin.step2.done", { name: session?.name ?? "", seq: checkin.seq, age: relativeAge(t, checkin.ts, now) })
        : t("AgentJoin.step2.doneNoSeq", { name: session?.name ?? "", age: relativeAge(t, checkin.ts, now) });
  const step3Summary =
    statuses[3] === "pending"
      ? null
      : wakeable === null
        ? t(unattended ? "AgentJoin.step3.waitingUnattended" : "AgentJoin.step3.waiting")
        : `${t(unattended ? "AgentJoin.step3.doneUnattended" : "AgentJoin.step3.done", { name: session?.name ?? "" })}${
            wakeable.verified ? ` ${t("AgentJoin.step3.verifiedTag")}` : ""
          }`;
  const step4Summary =
    statuses[4] === "pending"
      ? null
      : reply !== null
        ? t("AgentJoin.step4.done", { secs: (reply.elapsedMs / 1000).toFixed(1) })
        : selfVerified
          ? t("AgentJoin.step4.doneSelf")
          : timeoutTier !== null
            ? t(`AgentJoin.step4.timeout.${timeoutTier}`, { secs: Math.round(verifyTimeoutMs / 1000) })
            : probe === null
              ? null
              : probeSeq === null
                ? t("AgentJoin.step4.sent")
                : t("AgentJoin.step4.sentSeq", { seq: probeSeq });

  return (
    <div className="agent-join">
      <button
        type="button"
        className="d-btn d-btn--primary agent-join-btn"
        onClick={open}
        disabled={phase.kind === "loading"}
      >
        {phase.kind === "loading" ? t("AgentJoin.minting") : t("AgentJoin.open")}
      </button>
      {lastSession !== null && phase.kind === "idle" && (
        <button type="button" className="d-btn agent-join-resume" onClick={resume}>
          {t("AgentJoin.resume", { name: lastSession.name })}
        </button>
      )}

      {phase.kind === "error" && (
        <p className="banner banner--red agent-join-err" role="alert">
          {phase.message}
        </p>
      )}

      {composeOpen && (
        <div
          ref={composeDialogRef}
          className="agent-join-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t("AgentJoin.dialogNameLabel")}
          tabIndex={-1}
        >
          <div className="agent-join-scrim" onClick={close} />
          <div className="d-card agent-join-card">
            <header className="agent-join-card-head">
              <h2 className="d-title agent-join-title">
                {t("AgentJoin.titlePrefix")} <span className="d-hl">#{slug}</span>
              </h2>
              <button type="button" className="agent-join-close t-mono" onClick={close} aria-label={t("AgentJoin.close")}>
                ✕
              </button>
            </header>

            <p className="agent-join-lead">{t("AgentJoin.lead", { examples: "drawstyle-review, leo-debug" })}</p>

            <label className="agent-join-namerow">
              <span className="agent-join-namelabel t-mono">{t("AgentJoin.nameFieldLabel")}</span>
              <input
                ref={nameInputRef}
                className="t-mono agent-join-nameinput"
                value={name}
                autoFocus
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && phase.kind === "compose") mint();
                }}
                placeholder={`${slug}-review`}
                disabled={phase.kind === "loading"}
              />
            </label>
            {nameErr !== null && (
              <p className="banner banner--red agent-join-namewarn" role="alert">
                {nameErr}
              </p>
            )}
            <p className="agent-join-hint t-mono">{t("AgentJoin.nameHint")}</p>

            <fieldset className="agent-join-mode">
              <legend className="agent-join-namelabel t-mono">{t("AgentJoin.modeLabel")}</legend>
              {(["interactive", "unattended"] as const).map((value) => (
                <label key={value} className="agent-join-mode-option">
                  <input
                    type="radio"
                    name="agent-join-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    disabled={phase.kind === "loading"}
                  />
                  <span className="t-mono">
                    {t(value === "interactive" ? "AgentJoin.modeInteractive" : "AgentJoin.modeUnattended")}
                  </span>
                  <span className="agent-join-mode-desc">
                    {t(value === "interactive" ? "AgentJoin.modeInteractiveDesc" : "AgentJoin.modeUnattendedDesc")}
                  </span>
                </label>
              ))}
            </fieldset>

            {/* #845 第 4 点：interactive 包的目标 harness 三选——只渲染对应分支。仅 interactive 显示。 */}
            {mode === "interactive" && (
              <fieldset className="agent-join-mode agent-join-harness">
                <legend className="agent-join-namelabel t-mono">{t("AgentJoin.harnessLabel")}</legend>
                {(["claude", "codex", "other"] as const).map((value) => (
                  <label key={value} className="agent-join-mode-option">
                    <input
                      type="radio"
                      name="agent-join-harness"
                      value={value}
                      checked={harness === value}
                      onChange={() => setHarness(value)}
                      disabled={phase.kind === "loading"}
                    />
                    <span className="t-mono">
                      {t(
                        value === "claude"
                          ? "AgentJoin.harnessClaude"
                          : value === "codex"
                            ? "AgentJoin.harnessCodex"
                            : "AgentJoin.harnessOther",
                      )}
                    </span>
                  </label>
                ))}
                <p className="agent-join-hint t-mono">{t("AgentJoin.harnessHint")}</p>
              </fieldset>
            )}

            {/* #749：无人值守常驻的 runner 选择——曾写死 claude,用户选 codex 被忽略。仅 unattended 显示。 */}
            {mode === "unattended" && (
              <label className="agent-join-runner">
                <span className="agent-join-namelabel t-mono">{t("AgentJoin.runnerLabel")}</span>
                <select
                  className="t-mono agent-join-runner-select"
                  name="agent-join-runner"
                  value={runner}
                  onChange={(e) => setRunner(e.target.value as DesktopAgentRunner)}
                  disabled={phase.kind === "loading"}
                >
                  {(["codex", "claude", "codex-sdk"] as const).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="agent-join-actions">
              <button
                type="button"
                className="d-btn d-btn--primary"
                onClick={mint}
                disabled={phase.kind === "loading"}
              >
                {phase.kind === "loading" ? t("AgentJoin.minting") : t("AgentJoin.generate")}
              </button>
            </div>
          </div>
        </div>
      )}

      {session !== null && (
        <div
          ref={stepperDialogRef}
          className="agent-join-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t(session.recover ? "AgentJoin.stepper.titleRecover" : "AgentJoin.stepper.title", { name: session.name })}
          tabIndex={-1}
        >
          <div className="agent-join-scrim" onClick={close} />
          <div className="d-card agent-join-card agent-join-card--stepper">
            <header className="agent-join-card-head">
              <h2 className="d-title agent-join-title">
                {/* 中英句式不同，两边都走「前缀 + 名字 + 后缀」，避免某个语言只剩半句（coderabbit on #1006）。 */}
                <>
                  {t(session.recover ? "AgentJoin.stepper.titleRecoverPrefix" : "AgentJoin.stepper.titlePrefix")}{" "}
                  <span className="d-hl">{session.name}</span>{" "}
                  {t(session.recover ? "AgentJoin.stepper.titleRecoverSuffix" : "AgentJoin.stepper.titleSuffix")}
                </>
              </h2>
              <button type="button" className="agent-join-close t-mono" onClick={close} aria-label={t("AgentJoin.close")}>
                ✕
              </button>
            </header>

            <p className="agent-join-lead">{t(session.recover ? "AgentJoin.stepper.leadRecover" : "AgentJoin.stepper.lead")}</p>

            <ol className="agent-join-steps">
              {/* ① 装 party：网页看不见目标机，报到（②）即证明装了——② 过了一起打 ✓。 */}
              <StepCard id={1} status={statuses[1]} title={t("AgentJoin.step1.title")} summary={null} t={t}>
                <p className="agent-join-hint">{t("AgentJoin.step1.hint")}</p>
                <CommandBlock
                  id="install"
                  command={INSTALL_COMMAND}
                  copied={copiedKey === "install"}
                  onCopy={() => void copy("install", INSTALL_COMMAND)}
                  t={t}
                />
              </StepCard>

              {/* ② 跑接入命令：interactive = party join（含 token，只出现一次）；unattended = serve 脚本；recover = party recover。 */}
              <StepCard
                id={2}
                status={statuses[2]}
                title={t(
                  session.recover
                    ? "AgentJoin.step2.titleRecover"
                    : unattended
                      ? "AgentJoin.step2.titleUnattended"
                      : "AgentJoin.step2.title",
                )}
                summary={step2Summary}
                t={t}
              >
                {session.recover ? (
                  <>
                    <p className="agent-join-hint">{t("AgentJoin.step2.recoverHint")}</p>
                    <CommandBlock
                      id="join"
                      command={session.command ?? `party recover ${slug}`}
                      copied={copiedKey === "join"}
                      onCopy={() => void copy("join", session.command ?? `party recover ${slug}`)}
                      t={t}
                    />
                  </>
                ) : session.command === null ? (
                  // 关掉再打开：明文 token 已丢（只出现一次）——只能重新生成一枚。
                  <div className="agent-join-regen">
                    <p className="agent-join-hint">{t("AgentJoin.step2.tokenHidden")}</p>
                    <button
                      type="button"
                      className="d-btn agent-join-regen-btn"
                      disabled={rotateState === "busy"}
                      onClick={() => void regenerate()}
                    >
                      {t(rotateState === "busy" ? "AgentJoin.step2.regenerating" : "AgentJoin.step2.regenerate")}
                    </button>
                    {rotateState === "error" && (
                      <p className="banner banner--red" role="alert">{t("AgentJoin.errRotate")}</p>
                    )}
                  </div>
                ) : unattended ? (
                  desktopDetect() ? (
                    // 桌面：选工作目录 + 直接就地运行（不复制接入包）。手动命令收进折叠作后备。
                    <div className="agent-join-adopt">
                      <p className="agent-join-hint">{t("AgentJoin.doneLeadUnattended")}</p>
                      <button
                        type="button"
                        className="d-btn d-btn--primary agent-join-adopt-btn"
                        disabled={adoptState === "busy" || adoptState === "done"}
                        onClick={() => void adopt()}
                      >
                        {t(
                          adoptState === "busy"
                            ? "AgentJoin.adoptBusy"
                            : adoptState === "done"
                              ? "AgentJoin.adoptDone"
                              : "AgentJoin.adoptButton",
                        )}
                      </button>
                      {adoptDir !== null && <span className="agent-join-hint t-mono agent-join-adopt-dir">{adoptDir}</span>}
                      <span className="agent-join-hint t-mono">
                        {adoptState === "done" ? t("AgentJoin.adoptDoneHint") : t("AgentJoin.adoptHint")}
                      </span>
                      {adoptState === "error" && adoptError !== null && (
                        <p className="banner banner--red" role="alert">{adoptError}</p>
                      )}
                      <details className="agent-join-manual">
                        <summary>{t("AgentJoin.manualSummary")}</summary>
                        <CommandBlock
                          id="join"
                          command={session.command}
                          copied={copiedKey === "join"}
                          onCopy={() => void copy("join", session.command ?? "")}
                          t={t}
                        />
                      </details>
                    </div>
                  ) : (
                    // web：无人值守首选桌面版（选目录一键常驻）；没装则给手动贴命令的教程。
                    <>
                      <div className="agent-join-install-desktop">
                        <p className="agent-join-lead">{t("AgentJoin.installDesktopLead")}</p>
                        <DesktopInstallButton
                          className="d-btn d-btn--primary agent-join-install-btn"
                          label={t("AgentJoin.installDesktopBtn")}
                        />
                      </div>
                      <p className="agent-join-hint">{t("AgentJoin.manualWebLead")}</p>
                      <CommandBlock
                        id="join"
                        command={session.command}
                        copied={copiedKey === "join"}
                        onCopy={() => void copy("join", session.command ?? "")}
                        t={t}
                      />
                    </>
                  )
                ) : (
                  // interactive：复制接入命令，贴进 agent 自己的 harness。
                  <>
                    <p className="agent-join-hint">{t("AgentJoin.doneLead")}</p>
                    <CommandBlock
                      id="join"
                      command={session.command}
                      copied={copiedKey === "join"}
                      onCopy={() => void copy("join", session.command ?? "")}
                      t={t}
                    />
                  </>
                )}
                {copyErr && (
                  <p className="banner banner--red agent-join-copyerr" role="alert">
                    {t("AgentJoin.errCopy")}
                  </p>
                )}
                {session.token !== null && (
                  <p className="banner banner--yellow agent-join-warn" role="status">
                    {t("AgentJoin.tokenWarn")}
                  </p>
                )}
              </StepCard>

              {/* ③ 起一个可唤醒的会话：presence live 且可被 @ 唤醒（party who 同口径）；unattended = serve 已挂上。 */}
              <StepCard
                id={3}
                status={statuses[3]}
                title={t(unattended ? "AgentJoin.step3.titleUnattended" : "AgentJoin.step3.title")}
                summary={step3Summary}
                t={t}
              >
                {unattended ? (
                  <p className="agent-join-hint">{t("AgentJoin.step3.hintUnattended")}</p>
                ) : (
                  <>
                    <p className="agent-join-hint">
                      {t(
                        session.harness === "claude"
                          ? "AgentJoin.step3.hintClaude"
                          : session.harness === "codex"
                            ? "AgentJoin.step3.hintCodex"
                            : "AgentJoin.step3.hintOther",
                      )}
                    </p>
                    <CommandBlock
                      id="session"
                      command={wakeableSessionCommand(slug, session.harness)}
                      copied={copiedKey === "session"}
                      onCopy={() => void copy("session", wakeableSessionCommand(slug, session.harness))}
                      t={t}
                    />
                  </>
                )}
              </StepCard>

              {/* ④ 验证：会话里 party wake verify，或从这里以当前用户身份发一条普通 @ 等回帖。 */}
              <StepCard id={4} status={statuses[4]} title={t("AgentJoin.step4.title")} summary={step4Summary} t={t}>
                <p className="agent-join-hint">
                  {t("AgentJoin.step4.hint")} <code>party wake verify {slug}</code>
                  {sendMessage !== undefined ? ` ${t("AgentJoin.step4.or")}` : ""}
                </p>
                {sendMessage !== undefined ? (
                  <div className="agent-join-probe">
                    <button
                      type="button"
                      className="d-btn d-btn--primary agent-join-probe-btn"
                      disabled={probe !== null && !probeTimedOut}
                      onClick={sendProbe}
                    >
                      {t(probe !== null && probeTimedOut ? "AgentJoin.step4.retry" : "AgentJoin.step4.probe", { name: session.name })}
                    </button>
                    {sendErr && (
                      <p className="banner banner--red agent-join-senderr" role="alert">{t("AgentJoin.step4.sendFailed")}</p>
                    )}
                  </div>
                ) : (
                  <p className="agent-join-hint t-mono">{t("AgentJoin.stepper.sendUnavailable")}</p>
                )}
              </StepCard>
            </ol>

            {complete && (
              <p className="banner banner--green agent-join-complete" role="status">
                {t("AgentJoin.stepper.complete", { name: session.name })}
              </p>
            )}

            <p className="agent-join-hint t-mono">
              {t("AgentJoin.footerHint")} <a href="/docs">/docs</a>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
