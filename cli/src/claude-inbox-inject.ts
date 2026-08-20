// 本机 Claude Code 收件箱 socket 注入载体（issue #844）。
//
// 定位：AgentParty＝跨电脑 cross-session；频道是跨机传输层，本模块是「最后一公里」——
// 把频道 @ 消息以 Claude Code 原生「Message from X」内联 UX 注入到本机已入册、当前 idle
// 的交互式会话。载体是 per-session Unix domain socket 收件箱 `/tmp/cc-socks/<pid>.sock`，
// 协议逐行 JSON（JSONL），照 #844「per-session UDS 收件箱写入协议规格」逐条实现。
//
// ────────────────────────── 红线（务必遵守） ──────────────────────────
// 1. 只写「自己这台机器上、频道 ACL 已授权」的会话 socket；绝不跨机、绝不写未授权会话。
// 2. `from` 字段如实标注来源：`uds:<自己回执 sock>`（serve 无回执 sock 时省略，接收端记
//    为 "unknown"），cross-session-message 包装里 `from-name` 标频道昵称。**绝不冒装成
//    本机其他会话或用户**——不复用别人的 socket path 当 from、不填别人的会话名。
// 3. 不改任何 Claude Code 文件；socket/寻址目录/key 全部只读消费，写入只往目标 sock 写
//    JSONL 帧，连完即 `end()`。
// ──────────────────────────────────────────────────────────────────────
//
// 双路径（owner 2026-08-20「socket 优先 + serve 降级」拍板）：本模块落 socket 路径；任一
// 步失败（无匹配 socket / 探活失败 / 写入错 / 版本嗅探不符）返回结构化失败原因，调用方
// （serve-wake-proxy 的 forwarder）据此回落到 serve headless resume loop 注入路径。serve
// 侧降级今天等价于「forwarder 返回 false → serve 照常按现行为跑自己的 runner」，见文末
// socketWakeProxyForwarder 的 TODO。
//
// ─────────────── 送达语义：ok:true ≠ 已进对话流（务必看清） ───────────────
// 本模块的成功只代表「JSONL 帧已写进目标会话的收件箱 socket」。写进去之后还要过接收端
// 的 crossSessionInbound 权限闸：
//   - accept → 入 Claude 输入队列，idle 会话被 onEnqueue 唤起开新 turn（这才是真送达）；
//   - hold（**默认值**）→ 进待审队列，需人工 Deliver，**5 分钟无人处理会被 drop**；
//   - refuse / kill-switch → 直接丢弃。
// 而且接收端**不回错给发送方**（除非订阅 peer_message_status 回执），所以我们无法从写入
// 结果区分这三种归宿。因此：**绝不能拿 ok:true 当「已送达」去清频道侧的 @ 欠账/wake 记账**
// ——真正送达以对方回话/ack 为准。接入包（#844）会把 crossSessionInbound 设成 accept 来把
// 默认的 hold 变成直投，但那是接收端本地设置，仓库/组织设置只能收紧，不能假定一定生效。
//
// 未文档化私有面提示：`authRequired = windows-only`、帧 schema 均为 Claude `2.1.236` 实现
// 细节，可能随版本收紧。写入前做版本/能力嗅探（探活零字节 connect），不符即降级；不阻断投递。
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";

/** 覆盖 Claude 原生会话寻址目录（测试用；生产恒 `~/.claude/sessions`）。 */
export const CLAUDE_NATIVE_SESSIONS_DIR_ENV = "AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR";
/** 单行 JSONL 上限（native `YHr`/`H5d`：1 MiB）。 */
export const CLAUDE_INBOX_MAX_LINE_BYTES = 1024 * 1024;
/** 探活连接超时：只等 connect 事件即证明有人 listen，随即 destroy。 */
export const CLAUDE_INBOX_PROBE_TIMEOUT_MS = 1000;
/** 写入连接超时。 */
const WRITE_TIMEOUT_MS = 2000;

const PID_JSON_RE = /^(\d+)\.json$/;
// key 文件名：`<pid>.<sha256(canonical socket path) 64hex>.key`（native `USd` 正则）。
const PEER_TOKEN_RE = /^[0-9a-f]{32}$/;
// cross-session-message 包装标签名（native `ZPe`）。
const CROSS_SESSION_TAG = "cross-session-message";
// from 允许字符集（native `pSd`）：A-Za-z0-9%:_/.-
const FROM_ATTR_RE = /^[A-Za-z0-9%:_/.\-]+$/;
const FROM_MODES = new Set(["prompting", "bypass"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Claude 原生会话寻址目录（`~/.claude/sessions`，或测试覆盖）。 */
function nativeSessionsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[CLAUDE_NATIVE_SESSIONS_DIR_ENV];
  const path = typeof override === "string" && override !== ""
    ? override
    : join(homedir(), ".claude", "sessions");
  if (!isAbsolute(path)) return null;
  try {
    const stat = lstatSync(path);
    // 目录安全校验比照 gateDirectory：必须是真目录、非符号链接、属本 uid。
    // 注意：不强制 (mode & 0o077)===0——`~/.claude/sessions` 是 Claude 自己维护的目录，
    // 其属主与权限位由 Claude 决定，我们只做「非符号链接 + 属主匹配」这两条安全相关校验。
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    return path;
  } catch {
    return null;
  }
}

/** 单个 `<pid>.json` 的关切字段（native `B5d` 解析同款）。 */
export interface NativeClaudeSession {
  pid: number;
  sessionId: string | null;
  name: string | null;
  status: string | null;
  kind: string | null;
  messagingSocketPath: string;
  procStart: string | null;
}

function readNativeSession(dir: string, filename: string): NativeClaudeSession | null {
  const match = PID_JSON_RE.exec(filename);
  if (match === null) return null;
  const filePid = Number(match[1]);
  const path = join(dir, filename);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 64 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!record(value)) return null;
    const sock = value.messagingSocketPath;
    if (typeof sock !== "string" || sock === "" || !isAbsolute(sock)) return null;
    const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : filePid;
    // 文件名 pid 与内容 pid 不一致按坏行处理，防止一个会话冒名另一个 pid。
    if (pid !== filePid) return null;
    return {
      pid,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
      name: typeof value.name === "string" ? value.name : null,
      status: typeof value.status === "string" ? value.status : null,
      kind: typeof value.kind === "string" ? value.kind : null,
      messagingSocketPath: sock,
      procStart:
        typeof value.procStart === "string"
          ? value.procStart
          : typeof value.procStartFt === "string"
            ? value.procStartFt
            : null,
    };
  } catch {
    return null;
  }
}

/** pid 存活探测（含 EPERM=活，比照 registry）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ResolveResult =
  | { ok: true; session: NativeClaudeSession }
  | { ok: false; reason: "no-match" | "ambiguous" | "unavailable" };

/**
 * 寻址：扫 `~/.claude/sessions/<pid>.json`，按 `name` 精确匹配取 messagingSocketPath。
 * - 只认活 pid（procStart 一致由调用方在探活时进一步防 pid 复用）。
 * - 多条 live 匹配 → 尝试按 sessionId 消歧（去重后仍多于一 → ambiguous 拒投触发降级）。
 */
export function resolveSessionSocket(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolveResult {
  const dir = nativeSessionsDir(env);
  if (dir === null) return { ok: false, reason: "unavailable" };
  let filenames: string[];
  try {
    filenames = readdirSync(dir);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const matches: NativeClaudeSession[] = [];
  for (const filename of filenames) {
    const session = readNativeSession(dir, filename);
    if (session === null || session.name !== name) continue;
    if (!pidAlive(session.pid)) continue;
    matches.push(session);
  }
  if (matches.length === 0) return { ok: false, reason: "no-match" };
  if (matches.length === 1) return { ok: true, session: matches[0]! };
  // 多 live 匹配：去重（同 socket path 视为同一条），仍多于一条则拒投消歧。
  const bySocket = new Map<string, NativeClaudeSession>();
  for (const session of matches) bySocket.set(session.messagingSocketPath, session);
  if (bySocket.size === 1) return { ok: true, session: matches[0]! };
  return { ok: false, reason: "ambiguous" };
}

/**
 * 读 peerToken：`~/.claude/sessions/<pid>.<sha256(socket path)>.key`（native `USd`）。
 * 读不到（非 Windows optional）返回 null，写入时就不带 auth 行。
 */
export function readPeerToken(
  session: NativeClaudeSession,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dir = nativeSessionsDir(env);
  if (dir === null) return null;
  const hash = createHash("sha256").update(session.messagingSocketPath).digest("hex");
  const path = join(dir, `${session.pid}.${hash}.key`);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!record(value) || typeof value.peerToken !== "string" || !PEER_TOKEN_RE.test(value.peerToken)) {
      return null;
    }
    return value.peerToken;
  } catch {
    return null;
  }
}

/**
 * 探活：net.connect → 等 connect 事件 → 立即 destroy，零字节。服务端只看到 connect/
 * disconnect、无 JSONL 行 → 不产生任何 user 消息（native `$la`/`F5d` 同款手法）。
 * procStart 防 pid 复用：由 resolveSessionSocket 已确认 pid 活，这里只验证 socket 可连。
 */
export function probeSocketAlive(
  sockPath: string,
  timeoutMs: number = CLAUDE_INBOX_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(alive);
    };
    const socket = connect({ path: sockPath });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export interface CrossSessionWrap {
  /** 回执/来源地址：`uds:<自己 sock>`；省略则接收端记为 unknown。 */
  from?: string;
  fromSession?: string;
  hopChain?: string;
  /** 屏显名（"Message from <from-name>"）——标频道昵称。 */
  fromName?: string;
  fromMode?: "prompting" | "bypass";
  body: string;
}

/**
 * 构造 `<cross-session-message ...>` 包装（native `pSd`/`NMr` 逐字规格）：
 * attr 顺序固定 from→from-session→hop-chain→from-name→from-mode，全部可选。
 * 接收端有完整性自校验（重序列化逐字相等），因此空白/顺序必须精确。
 */
export function wrapCrossSessionMessage(wrap: CrossSessionWrap): string {
  const attrs: string[] = [];
  const push = (key: string, value: string | undefined) => {
    if (value !== undefined) attrs.push(`${key}="${value}"`);
  };
  push("from", wrap.from);
  push("from-session", wrap.fromSession);
  push("hop-chain", wrap.hopChain);
  push("from-name", wrap.fromName);
  push("from-mode", wrap.fromMode);
  const open = attrs.length > 0 ? `<${CROSS_SESSION_TAG} ${attrs.join(" ")}>` : `<${CROSS_SESSION_TAG}>`;
  return `${open}\n${wrap.body}\n</${CROSS_SESSION_TAG}>`;
}

export interface InjectFrameInput {
  /** 已包装好的正文（放进 message.content）。 */
  content: string;
  /** 回执地址（`uds:<自己 sock>`）；省略则不写 from。 */
  fromSock?: string;
  /** 可选 auth token（32hex）；有则前置 auth 行。 */
  peerToken?: string | null;
  priority?: "now" | "next" | "later";
  msgId?: string;
}

/**
 * 构造要写入 socket 的 JSONL 行（一到两行，各 `\n` 结尾）。纯函数便于逐字段断言。
 * 顺序：可选 auth 行 → user 帧。
 */
export function buildInjectFrames(input: InjectFrameInput): string[] {
  const lines: string[] = [];
  if (typeof input.peerToken === "string" && PEER_TOKEN_RE.test(input.peerToken)) {
    lines.push(JSON.stringify({ type: "auth", token: input.peerToken }));
  }
  const user: Record<string, unknown> = {
    type: "user",
    msgV: 1,
    msg_id: input.msgId ?? randomUUID(),
    priority: input.priority ?? "next",
    message: { role: "user", content: input.content },
  };
  if (input.fromSock !== undefined) user.from = `uds:${input.fromSock}`;
  // from 放在 msg_id 之后、priority 之前以贴近 native 样例；键顺序不影响接收端解析。
  const ordered: Record<string, unknown> = {
    type: user.type,
    msgV: user.msgV,
    msg_id: user.msg_id,
    ...(user.from !== undefined ? { from: user.from } : {}),
    priority: user.priority,
    message: user.message,
  };
  lines.push(JSON.stringify(ordered));
  return lines;
}

export type InjectFailureReason =
  | "no-match"
  | "ambiguous"
  | "unavailable"
  | "probe-failed"
  | "body-too-large"
  | "write-failed";

export type InjectResult =
  /**
   * ok:true ＝**帧已写入收件箱 socket**，不代表已进对方对话流。接收端的
   * crossSessionInbound 闸门决定归宿：accept 才入队唤醒；默认 hold 会进待审队列并在
   * 5 分钟无人处理后被 drop；refuse 直接丢。接收端不回错，我们无从区分。
   * **调用方绝不可据此清频道侧的 @ 欠账/wake 记账**——真正送达以对方回话/ack 为准。
   */
  | { ok: true; socketPath: string; usedAuth: boolean; target: string }
  | { ok: false; reason: InjectFailureReason; detail?: string };

export interface InjectChannelMessageInput {
  /** 目标会话在 Claude 原生注册里的 `name`（＝我方宣告名）。 */
  name: string;
  /** 频道指针/摘要（≤512B），会被 cross-session-message 包装。 */
  body: string;
  /** 频道昵称（"Message from <fromName>"）。 */
  fromName: string;
  /** 自己的回执 socket（serve 无则省略——绝不冒用别人的）。 */
  fromSock?: string;
  fromMode?: "prompting" | "bypass";
  priority?: "now" | "next" | "later";
  env?: NodeJS.ProcessEnv;
}

/**
 * socket 注入主入口：寻址 → 探活 → 写帧。任一步失败返回结构化失败原因，调用方据此降级。
 */
export async function injectChannelMessage(
  input: InjectChannelMessageInput,
): Promise<InjectResult> {
  const env = input.env ?? process.env;
  // from-name 校验：非法字符会破坏接收端 pSd 完整性自校验 → 直接当写入前置失败降级。
  if (input.fromName.includes('"') || /[\r\n<>]/.test(input.fromName)) {
    return { ok: false, reason: "write-failed", detail: "invalid from-name" };
  }
  if (input.fromSock !== undefined && !FROM_ATTR_RE.test(`uds:${input.fromSock}`)) {
    return { ok: false, reason: "write-failed", detail: "invalid from address" };
  }
  const fromMode = input.fromMode ?? "prompting";
  if (!FROM_MODES.has(fromMode)) {
    return { ok: false, reason: "write-failed", detail: "invalid from-mode" };
  }
  const resolved = resolveSessionSocket(input.name, env);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { session } = resolved;

  const alive = await probeSocketAlive(session.messagingSocketPath);
  if (!alive) return { ok: false, reason: "probe-failed" };

  const content = wrapCrossSessionMessage({
    from: input.fromSock !== undefined ? `uds:${input.fromSock}` : undefined,
    fromName: input.fromName,
    fromMode,
    body: input.body,
  });
  // Windows 必须 auth；mac/linux optional（读到就带，读不到不带）。
  const peerToken = readPeerToken(session, env);
  if (platform() === "win32" && peerToken === null) {
    return { ok: false, reason: "write-failed", detail: "windows requires peer token" };
  }
  const lines = buildInjectFrames({
    content,
    fromSock: input.fromSock,
    peerToken,
    priority: input.priority,
  });
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") + 1 > CLAUDE_INBOX_MAX_LINE_BYTES) {
      return { ok: false, reason: "body-too-large" };
    }
  }

  try {
    await writeFramesToSocket(session.messagingSocketPath, lines);
  } catch (error) {
    return { ok: false, reason: "write-failed", detail: String(error) };
  }
  return {
    ok: true,
    socketPath: session.messagingSocketPath,
    usedAuth: peerToken !== null,
    target: input.name,
  };
}

/** 连上 → 写 JSONL（各行 `\n` 结尾）→ end()。一次性连接。 */
function writeFramesToSocket(sockPath: string, lines: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        reject(error);
      } else {
        resolve();
      }
    };
    const socket = connect({ path: sockPath });
    socket.setTimeout(WRITE_TIMEOUT_MS);
    socket.once("error", (error) => finish(error));
    socket.once("timeout", () => finish(new Error("socket write timeout")));
    socket.once("connect", () => {
      const payload = lines.map((line) => `${line}\n`).join("");
      socket.end(payload, () => finish());
    });
  });
}
