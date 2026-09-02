// 频道页「＋ 让 agent 加入」：登录人类先给 agent 起个能认出来的名字（默认 <你>-<频道>，
// 可改成 drawstyle-review 这类），再铸一枚 channel-scoped agent token，然后进入引导。
//
// #1040 重构：从「四步门控卡片」改成「命令区 + 三盏灯」——
//   命令区：该给的命令全部直接给出，不再等上一步；「装 party」是一个开关（勾了并进同一条命令）。
//   三盏灯：已报到 / 能被唤醒 / 回了测试 @ ——只按服务端真实信号亮（presence / 历史，判据在
//   lib/joinStepper，与从前 ②③④ 一字不差），不按「命令复制过了」。
// 弹窗打开时靠频道页传进来的 WS 流（拿不到就 2–3s 轮询），关掉即停。
// 明文 token 只出现这一次（spec §10）：关掉再打开只能「重新生成」。
// 「恢复/重连」（成员详情里的「重新接上」）走同一个弹窗，三档可选：接着上次的对话（默认；
// presence.agent_session 记了上次会话 id 就精确 --resume）/ 开个新会话 / 先诊断（party recover）。
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
  buildStepperCommand,
  DEFAULT_JOIN_RUNNER,
  guessJoinPackHarness,
  type JoinPackHarness,
  type JoinPackMode,
} from "../lib/joinPack";
import {
  adoptBaselineSeen,
  checkinEvidence,
  joinBaseline,
  selfVerifiedEvidence,
  type JoinBaseline,
  findProbeSeq,
  maxSeq,
  replyEvidence,
  stepStatuses,
  verifyTimeoutTier,
  wakeableEvidence,
  type StepId,
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
  /**
   * #1009：「接入凭证」面板的引导入口。非 null 时直接打开 stepper，形态由这份 session 决定——
   * 比 recoverName 更完整（带 ② 的那条命令与 harness/mode/runner），既能走 recover 也能走带 token 的接入。
   */
  guideSession?: JoinGuideSession | null;
  /** 轮询/计时参数（测试注入）。 */
  pollIntervalMs?: number;
  tickMs?: number;
  /** 播报区填字的延迟（ms）：让空的 live region 先落地，再变内容。测试注入 0。 */
  liveNoteDelayMs?: number;
  verifyTimeoutMs?: number;
  now?: () => number;
}

/** #1009：外部（AgentTokens 面板）交过来的一次引导会话——足以直接渲染 stepper 的最小信息。 */
export interface JoinGuideSession {
  name: string;
  /** 第 ② 步的那条命令；recover 形态为 `party recover <chan>`（不含 token）。 */
  command: string;
  mode: JoinPackMode;
  harness: JoinPackHarness;
  runner: DesktopAgentRunner;
  recover: boolean;
  /** 明文 token：命令里带 token 时一并交过来，只为渲染那条安全警告；recover 形态为 null。 */
  token?: string | null;
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
  /** 引导开始时刻（浏览器时钟）：**只用于显示相对时间**，绝不参与判据。 */
  sinceTs: number;
  /** 引导开始时的服务端量快照（seq / last_seen / verified_at）——判据只比它，不碰浏览器时钟。 */
  baseline: JoinBaseline;
}

type Phase =
  | { kind: "idle" }
  | { kind: "compose" } // 起名中
  | { kind: "loading" }
  | { kind: "stepper"; session: StepperSession }
  | { kind: "error"; message: string };

export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SH_RAW_URL} | sh`;

/** 三盏灯与从前 ②③④ 的判据一一对应（data-step 沿用数字，测试与样式不用改口径）。 */
const LIGHTS: ReadonlyArray<{ id: StepId; key: "checkin" | "wakeable" | "verified" }> = [
  { id: 2, key: "checkin" },
  { id: 3, key: "wakeable" },
  { id: 4, key: "verified" },
];

/**
 * 第 ③ 步「起一个可唤醒的会话」的命令：与 CLI `party join` 第 3 步印的修法同一条（#979 / #989）。
 *
 * #1029：手上有明文 token 时给 claude 那条加 `AGENTPARTY_TOKEN=…` 前缀——重连引导要解决的
 * 正是「本地那份 token 已被撤销」，不带凭据的 `party claude <chan>` 在这个场景下必然失败
 * （owner 实测撞的就是 identity_unavailable）。`party claude` 见到它会先重绑再启动。
 *
 * 只给 claude 加：`party serve` 不认这个环境变量，给它加前缀等于给一条骗人的命令。
 * token 走环境变量而非 flag——argv 会进 `ps` 与 shell history（#111）。
 */
export function wakeableSessionCommand(
  slug: string,
  harness: JoinPackHarness,
  token?: string | null,
): string {
  if (harness === "claude") {
    // 只接受安全字符集：真 token 是 [A-Za-z0-9_-]，含引号的东西一律不拼进 shell 命令。
    const safe = typeof token === "string" && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
    return safe === null ? `party claude ${slug}` : `AGENTPARTY_TOKEN='${safe}' party claude ${slug}`;
  }
  if (harness === "codex") return `party serve ${slug} --runner codex`;
  return `party serve ${slug}`;
}

/** 第 ③ 步这条命令里是否带了明文 token（决定要不要挂安全警告）。 */
export function wakeableCommandCarriesToken(harness: JoinPackHarness, token?: string | null): boolean {
  return harness === "claude" && typeof token === "string" && /^[A-Za-z0-9_-]+$/.test(token);
}

/** 重连引导的三档（#1040）：接着上次的对话 / 开个新会话 / 先诊断。 */
export type RecoverPlan = "resume" | "fresh" | "diagnose";

/** presence 里该身份上次自报的可恢复模型会话（#522 agent_session）。 */
export interface ResumeTarget {
  harness: "claude" | "codex" | "codex-sdk";
  sessionId: string;
  cwd: string | null;
}

export function resumeTargetOf(presence: readonly PresenceEntry[], name: string): ResumeTarget | null {
  const info = presence.find((entry) => entry.name === name)?.agent_session;
  if (info === undefined || typeof info.session_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(info.session_id)) return null;
  return { harness: info.harness, sessionId: info.session_id, cwd: typeof info.cwd === "string" ? info.cwd : null };
}

/** 重连时真正用来起会话的 harness：presence 记了上次会话就以它为准，否则按名字猜的那个。 */
export function recoverHarness(fallback: JoinPackHarness, resume: ResumeTarget | null): JoinPackHarness {
  if (resume === null) return fallback;
  return resume.harness === "claude" ? "claude" : "codex";
}

/** 该 harness 下有哪些档可选：other 没有「上次会话」的概念，只剩诊断与新会话。 */
export function availableRecoverPlans(harness: JoinPackHarness): RecoverPlan[] {
  return harness === "other" ? ["diagnose", "fresh"] : ["resume", "fresh", "diagnose"];
}

/**
 * 重连命令（#1040）。
 * - resume：claude → `party claude <slug> -- --resume <sid>`（没有 sid 用 `--continue` 接最近一次）；
 *           codex → `party bridge codex <slug> --resume <thread>`（没有用 `--resume-last`）。
 * - fresh：与第 ③ 步同一条（wakeableSessionCommand）。
 * - diagnose：`party recover <slug>`。
 * token 只给 claude 那条加 AGENTPARTY_TOKEN 前缀，理由同 wakeableSessionCommand。
 */
export function recoverCommand(
  plan: RecoverPlan,
  slug: string,
  harness: JoinPackHarness,
  resume: ResumeTarget | null,
  token?: string | null,
): string {
  // 目录状态不能丢（codex stop-time review）：Claude 的会话按项目目录存放，换个目录
  // `--resume <id>` 找不到、`--continue` 会接到别的项目；join-binding 也按目录记，
  // `party recover` / `party claude` 换目录会解析不出身份。presence 记了 cwd 就先 cd 回去。
  const cd = resume !== null && resume.cwd !== null ? `cd ${shellQuote(resume.cwd)} && ` : "";
  if (plan === "diagnose") return `${cd}party recover ${slug}`;
  if (plan === "fresh") return `${cd}${wakeableSessionCommand(slug, harness, token)}`;
  if (harness === "claude") {
    const safe = typeof token === "string" && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
    const prefix = safe === null ? "" : `AGENTPARTY_TOKEN='${safe}' `;
    const tail = resume !== null && resume.harness === "claude" ? `--resume ${resume.sessionId}` : "--continue";
    return `${cd}${prefix}party claude ${slug} -- ${tail}`;
  }
  if (harness === "codex") {
    const tail = resume !== null && resume.harness !== "claude" ? `--resume ${resume.sessionId}` : "--resume-last";
    return `${cd}party bridge codex ${slug} ${tail}`;
  }
  return `${cd}party recover ${slug}`;
}

/** POSIX 单引号转义：目录名里任何字符都不许逃出引号（含单引号本身）。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 勾了「那台机器还没装」：把安装命令并在前面，一次复制。 */
export function withInstall(command: string): string {
  return `${INSTALL_COMMAND} && ${command}`;
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
  guideSession = null,
  pollIntervalMs = 2500,
  tickMs = 1000,
  liveNoteDelayMs = 150,
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
  // #1040：recover 三档与「并上安装命令」开关，每次打开引导复位。
  const [plan, setPlan] = useState<RecoverPlan>("resume");
  const [includeInstall, setIncludeInstall] = useState(false);
  // 每个身份的引导开始时刻：关掉再打开（含 recover 重开）沿用同一基线，报到证据不会因重开而丢。
  /**
   * 常驻的读屏播报区（#1005 codex review 第七轮）。live region 必须**先存在于 DOM**，
   * 之后内容变化才会被播报；整块（区域 + 文字）一起挂载时大多数读屏根本不念——
   * 上一版把 role="status" 挂在那条随 token 一起出现的 banner 上，正是这个毛病。
   * 所以把区域放在常驻的 .agent-join 根节点里（页面在它就在），token 出现后由 effect 填文字。
   */
  const [liveNote, setLiveNote] = useState("");
  const startedAtRef = useRef(new Map<string, number>());
  /** 每个身份的服务端量基线：关掉再打开、或从「继续接入」回来都沿用同一张，别把中途的活动算没发生。 */
  const baselineRef = useRef(new Map<string, JoinBaseline>());
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
      setPlan("resume");
      setIncludeInstall(false);
      startedAtRef.current.set(session.name, session.sinceTs);
      baselineRef.current.set(session.name, session.baseline);
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
    // recover：这个身份本来就有历史，只认「比打开这一刻更新」的活动（strict）。
    const baseline = baselineRef.current.get(recoverName) ?? joinBaseline(messages, presence, recoverName, true);
    openStepper({
      name: recoverName,
      baseline,
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

  // #1009：「接入凭证」面板的「接入引导 / 重新接上」——同一个 stepper，命令与形态由面板给的 session 决定。
  useEffect(() => {
    if (guideSession === null) return;
    if (
      phase.kind === "stepper" &&
      phase.session.name === guideSession.name &&
      phase.session.command === guideSession.command &&
      phase.session.recover === guideSession.recover
    ) {
      return;
    }
    const sinceTs = startedAtRef.current.get(guideSession.name) ?? nowFn();
    // 已存在的身份（面板里选中的都是），只认「比打开这一刻更新」的活动（strict）。
    const baseline =
      baselineRef.current.get(guideSession.name) ?? joinBaseline(messages, presence, guideSession.name, true);
    openStepper({
      name: guideSession.name,
      baseline,
      mode: guideSession.mode,
      harness: guideSession.harness,
      runner: guideSession.runner,
      recover: guideSession.recover,
      // 明文 token 只在这一次引导里存在（关掉即丢）；有它才渲染 ② 的安全警告。
      token: guideSession.recover ? null : (guideSession.token ?? null),
      command: guideSession.command,
      sinceTs,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideSession, slug]);

  // 文字在 effect 里填，且晚一拍：区域先以空内容落地，之后内容变化才是读屏认的 live region 更新
  // （区域与文字同一批插入时，多数读屏不念）。延迟可注入，测试不必真等。
  const tokenPresent = phase.kind === "stepper" && phase.session.token !== null;
  useEffect(() => {
    if (!tokenPresent) {
      setLiveNote("");
      return;
    }
    const timer = setTimeout(
      () => setLiveNote(`${t("AgentJoin.step2.tokenSafety")} ${t("AgentJoin.tokenWarn")}`),
      liveNoteDelayMs,
    );
    return () => clearTimeout(timer);
  }, [liveNoteDelayMs, t, tokenPresent]);

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
  // #1028：打开引导时若 presence 还没有这一行，基线是空的。把第一次看到的读数收作基线——
  // 那条可能是三天前的旧行，只当起点，不算「刚刚重新接上」。
  //
  // 判据读的是 `session.baseline`（见下面的 checkin useMemo），不是 baselineRef——所以这里
  // **必须写回 session**，只更新 ref 的话这个修复在真实弹窗里完全不生效（CodeRabbit on #1031）。
  // ref 同步更新，供「继续接入」回到引导时复用同一基线。
  useEffect(() => {
    if (phase.kind !== "stepper") return;
    const session = phase.session;
    const adopted = adoptBaselineSeen(session.baseline, presence, session.name);
    if (adopted === null) return;
    baselineRef.current.set(session.name, adopted);
    setPhase({ kind: "stepper", session: { ...session, baseline: adopted } });
  }, [phase, presence]);
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
      const packInput = {
        slug,
        agentName: agent.name,
        agentToken: agent.token,
        server,
        inviterName,
        charter,
        runner,
        harness,
        t,
      };
      // 存进 vault 的是**完整接入包**（「频道身份」面板要把它发给别人的机器，含 install 兜底）；
      // 引导里第 ② 步只展示那一条命令——install 已经是第 ① 步（#1005 owner 实测：同一条命令出现两遍）。
      const command = buildJoinPack(mode, packInput);
      const stepCommand = buildStepperCommand(mode, packInput);
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
      // 刚铸出来的新身份没有历史，它的任何一条消息都算报到（strict=false）。
      openStepper({
        name: agent.name,
        mode,
        harness,
        runner,
        recover: false,
        token: agent.token,
        command: stepCommand,
        sinceTs,
        baseline: joinBaseline(messages, presence, agent.name, false),
      });
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
      const packInput = {
        slug,
        agentName: agent.name,
        agentToken: agent.token,
        server: apiOrigin(),
        inviterName,
        charter,
        runner: session.runner,
        harness: session.harness,
        t,
      };
      const command = buildJoinPack(session.mode, packInput);
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
      setPhase({
        kind: "stepper",
        session: { ...session, token: agent.token, command: buildStepperCommand(session.mode, packInput) },
      });
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
    openStepper({
      ...lastSession,
      sinceTs: startedAtRef.current.get(lastSession.name) ?? lastSession.sinceTs,
      baseline: baselineRef.current.get(lastSession.name) ?? lastSession.baseline,
    });
  }, [lastSession, openStepper]);

  // ---- 四步判据（全部来自 presence / 历史）----
  const session = phase.kind === "stepper" ? phase.session : null;
  const checkin = useMemo(
    () => (session === null ? null : checkinEvidence(messages, presence, session.name, session.baseline)),
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
  const selfVerified = useMemo(
    () => (session === null ? false : selfVerifiedEvidence(messages, presence, session.name, session.baseline, WAKE_VERIFY_PREFIX)),
    [messages, presence, session],
  );
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
  // #1040 recover：上次会话（presence.agent_session）决定 harness 与能否精确 --resume。
  const resumeTarget = useMemo(() => (session === null ? null : resumeTargetOf(presence, session.name)), [presence, session]);
  const effectiveHarness = session === null ? "other" : session.recover ? recoverHarness(session.harness, resumeTarget) : session.harness;
  const plans = availableRecoverPlans(effectiveHarness);
  const activePlan: RecoverPlan = plans.includes(plan) ? plan : plans[0]!;
  const baseCommand =
    session === null
      ? ""
      : session.recover
        ? recoverCommand(activePlan, slug, effectiveHarness, resumeTarget, session.token)
        : (session.command ?? "");
  const mainCommand = includeInstall && !unattended && baseCommand !== "" ? withInstall(baseCommand) : baseCommand;
  const sessionCommand = session === null ? "" : wakeableSessionCommand(slug, session.harness, session.token);
  const showSessionCommand = session !== null && !session.recover && !unattended && session.command !== null;
  // 安全警告要跟**实际显示的命令**走（/code-review）：recover 选「先诊断」时命令是 party recover、
  // 没有 token，不能因为 harness 是 claude 就亮 banner。recover 直接看命令串；接入形态沿用
  // 「有明文 token 就警告」（unattended 脚本与 interactive 命令都带 token）。
  const anyCommandCarriesToken =
    session !== null &&
    (session.recover
      ? mainCommand.includes("AGENTPARTY_TOKEN=")
      : session.token !== null || (showSessionCommand && wakeableCommandCarriesToken(session.harness, session.token)));
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
          {/* 读屏播报区必须在 dialog **子树内**：overlay 是 aria-modal="true"，VoiceOver 会把
              无障碍树限制在弹窗内，挂在弹窗外面的 live region 完全不播报
              （codex stop-time review on 99f85e4）。
              同时它随弹窗挂载时是**空**的，文字由 effect 稍后填入——区域先存在、内容后变化，
              才是读屏认的 live region 更新。 */}
          <p className="agent-join-sr-only" role="status">{liveNote}</p>
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

            <p className="agent-join-lead">{t(session.recover ? "AgentJoin.plan.leadRecover" : "AgentJoin.plan.lead")}</p>

            {/* #1040：从「四步门控卡片」改成「命令区 + 三盏状态灯」。命令全部直接给出、不再等上一步；
                灯只按服务端真实信号亮（判据不变，仍在 lib/joinStepper）。recover 形态默认给
                「接着上次的对话」那一条：presence.agent_session 记了上次会话 id 就精确 --resume。 */}
            <section className="agent-join-plan">
              {session.recover && (
                <fieldset className="agent-join-plan-options">
                  <legend className="agent-join-namelabel t-mono">{t("AgentJoin.plan.label")}</legend>
                  {plans.map((value) => (
                    <label
                      key={value}
                      className={`agent-join-plan-option${activePlan === value ? " agent-join-plan-option--on" : ""}`}
                      data-plan={value}
                    >
                      <input
                        type="radio"
                        name="agent-join-plan"
                        value={value}
                        checked={activePlan === value}
                        onChange={() => setPlan(value)}
                      />
                      <span className="agent-join-plan-option-title">{t(`AgentJoin.plan.${value}`)}</span>
                      <span className="agent-join-plan-option-desc">{t(`AgentJoin.plan.${value}Desc`)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
              {session.recover && activePlan === "resume" && (
                <p className="agent-join-hint">
                  {/* 三种状态各说各的实话：有 sid 有 cwd（命令里带 cd）/ 有 sid 没 cwd（必须在原目录跑，
                      命令里没有 cd）/ 没 sid（--continue 接该目录最近一次）。 */}
                  {/* 再按 harness 分：Claude 会话按目录存放（换目录找不到），Codex 线程不按目录（从哪都能续）。 */}
                  {resumeTarget === null
                    ? t(effectiveHarness === "codex" ? "AgentJoin.plan.resumeUnknownCodex" : "AgentJoin.plan.resumeUnknown")
                    : resumeTarget.cwd === null
                      ? t(effectiveHarness === "codex" ? "AgentJoin.plan.resumeKnownNoCwdCodex" : "AgentJoin.plan.resumeKnownNoCwd", {
                          sid: resumeTarget.sessionId,
                        })
                      : t("AgentJoin.plan.resumeKnown", { sid: resumeTarget.sessionId, cwd: ` (${resumeTarget.cwd})` })}
                </p>
              )}
              {session.recover && activePlan === "diagnose" && <p className="agent-join-hint">{t("AgentJoin.plan.diagnoseHint")}</p>}
              {!session.recover && !unattended && session.command !== null && (
                <p className="agent-join-hint">{t("AgentJoin.step2.runHint")}</p>
              )}

              {/* 明文 token 的安全警告：只挂一次、排在**所有**命令之前（无人值守是长脚本，放后面会被推出视野）。 */}
              {anyCommandCarriesToken && (
                <div className="banner banner--yellow agent-join-tokenbanner">
                  <p className="agent-join-tokensafety">{t("AgentJoin.step2.tokenSafety")}</p>
                  <p className="agent-join-warn">{t("AgentJoin.tokenWarn")}</p>
                </div>
              )}

              {session.recover ? (
                <CommandBlock
                  id="join"
                  command={mainCommand}
                  copied={copiedKey === "join"}
                  onCopy={() => void copy("join", mainCommand)}
                  t={t}
                />
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
                <CommandBlock
                  id="join"
                  command={mainCommand}
                  copied={copiedKey === "join"}
                  onCopy={() => void copy("join", mainCommand)}
                  t={t}
                />
              )}

              {/* interactive 接入的第二条：起一个能被唤醒的会话。以前藏在第 ③ 步等报到才露出来——
                  现在直接给，人可以一次把两条都复制走。 */}
              {showSessionCommand && (
                <>
                  <p className="agent-join-hint">
                    {t("AgentJoin.plan.thenSession")}{" "}
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
                    command={sessionCommand}
                    copied={copiedKey === "session"}
                    onCopy={() => void copy("session", sessionCommand)}
                    t={t}
                  />
                </>
              )}

              {!unattended && (session.recover || session.command !== null) && (
                <label className="agent-join-plan-install t-mono">
                  <input
                    type="checkbox"
                    checked={includeInstall}
                    onChange={(e) => setIncludeInstall(e.target.checked)}
                  />
                  <span>{t("AgentJoin.plan.install")}</span>
                </label>
              )}
              {copyErr && (
                <p className="banner banner--red agent-join-copyerr" role="alert">
                  {t("AgentJoin.errCopy")}
                </p>
              )}
            </section>

            {/* 三盏灯：报到 / 能被唤醒 / 回了测试 @——只按 presence/历史亮，不按「命令复制过了」。
                data-step 沿用 2/3/4，判据与从前的 ②③④ 一字不差。 */}
            <ol className="agent-join-lights">
              {LIGHTS.map(({ id, key }) => {
                const status = statuses[id];
                const summary = id === 2 ? step2Summary : id === 3 ? step3Summary : step4Summary;
                return (
                  <li
                    key={key}
                    className={`agent-join-light agent-join-light--${status}`}
                    data-step={id}
                    data-light={key}
                    data-status={status}
                  >
                    <div className="agent-join-step-head">
                      <span className={`t-mono agent-join-step-mark agent-join-step-mark--${status}`} aria-hidden="true">
                        {status === "done" ? "✓" : status === "active" ? "●" : "○"}
                      </span>
                      <span className="agent-join-step-title">{t(`AgentJoin.light.${key}`)}</span>
                      {status === "done" && summary !== null ? (
                        <span className="agent-join-step-status agent-join-step-status--done t-mono" role="status">{summary}</span>
                      ) : status === "active" && summary !== null ? (
                        <span className="agent-join-step-status t-mono" role="status">{summary}</span>
                      ) : (
                        <span className="agent-join-step-status t-mono">{t("AgentJoin.light.pending")}</span>
                      )}
                    </div>
                    {key === "verified" && (
                      <div className="agent-join-step-body">
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
                      </div>
                    )}
                  </li>
                );
              })}
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
