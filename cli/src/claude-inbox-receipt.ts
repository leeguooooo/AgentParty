// Claude Code 原生投递回执（`peer_message_status`）的接收端 + 「注入并订阅回执」的编排。
//
// 协议正本：open-cross-session `docs/wake-protocol.md` §6（两仓共用，正本在那边）；本文件的监听/
// 解析部分移植自 open-cross-session `src/claude-receipt.ts`（同一版权人）。
//
// 协议（Claude Code 2.1.285 真机实测，未文档化私有面，可能随版本变）：
// user 帧带 `from: "uds:<path>"` 和 `msg_id` 时，接收端会把这条消息的归宿作为 JSONL 控制帧
// 连到 <path> 写回来：
//   {"type":"control","action":"peer_message_status","status":<s>,"reason":"…",
//    "from":"uds:<接收端 sock>","orig_msg_id":"<我们的 msg_id>","msgV":1,"msg_id":"…"}
// - `held`：crossSessionInbound 闸门把它扣下了（实测写入后 30–50 ms 到）；之后还会有一条终态：
//   `delivered`（有人点了投递）或 `expired`（5 分钟超时 / 待审队列被挤 / 会话退出）。
// - 拒绝在线上是 `status:"expired", status_detail:"refused"`；队列满是 `dropped`（带 drop_reason）；
//   另有 `denied`。
// - 策略是 accept 时**一条回执都不发**，消息直接进对话。所以「窗口内没有回执」只能读作
//   「协议没报告被扣 / 被拒」，不是「对方读了」。
//
// 接收端对回执地址的校验决定了这里的形状：
// - 地址必须是 `uds:` + 匹配 /^\/\S*\.sock$/ 的路径，并且和接收端自己的 socket **同目录**
//   （/tmp/cc-socks/<16 hex>.sock 挨着 /tmp/cc-socks/<pid>.sock）。
// - 回执按「写入那条消息的进程 pid」发（socket 对端凭据），所以**写帧的进程必须就是监听这个
//   socket 的进程**，而且要活到终态回执到来。open-cross-session 的 CLI 是一次性进程，只能另起一个
//   脱离终端的 helper；这里的调用方（`party serve`）本身常驻，直接在本进程里监听即可。
//
// 「Claude 的目录只读消费」的唯一例外在这里：我们在 Claude 的 socket 目录里建**一个**临时
// socket 文件（0600），用完必删（close() + 进程退出钩子）。进程被 SIGKILL 时那个文件会留下：
// 它只是一个没人监听的 0600 socket，除此之外不建、不改、不删那个目录里的任何东西。
// Windows 上回执地址得是命名管道，还要带我们不该发布的认证材料——不做，调用方保持旧行为。
//
// 记账纪律不变：回执只用来**告诉人**消息被扣/被拒；`accepted` 不是已读回执。任何 @ 欠账 /
// wake 记账仍然只认对方回话。

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import {
  injectChannelMessage,
  resolveSessionSocketByPid,
  type InjectChannelMessageInput,
  type InjectResult,
} from "./claude-inbox-inject";

/** 写帧后等第一条回执的窗口。实测 held 在 30–50 ms 内到；给一个数量级的余量。 */
export const RECEIPT_FIRST_WINDOW_MS = 400;
/** Claude 待审队列的保留时长：5 分钟无人 Deliver 即丢。 */
export const CLAUDE_HOLD_TTL_MS = 5 * 60 * 1000;
/** 等终态回执的额外余量（接收端定时器抖动、事件循环忙）。 */
export const RECEIPT_TERMINAL_MARGIN_MS = 60 * 1000;
/** 等终态期间多久看一眼目标还在不在。 */
export const RECEIPT_TARGET_POLL_MS = 2000;
/** 连续这么多次看不到目标会话才认定它没了（sessions 文件会瞬时读不到）。 */
const TARGET_GONE_CONFIRMATIONS = 3;
/** 同时挂着的回执监听上限；超过就走不带回执的旧路径（@ 风暴时不在 Claude 的目录里堆文件）。 */
export const RECEIPT_MAX_PENDING = 16;
/** 置为 `1` 关闭回执订阅，回到不带 `from` 的旧行为。 */
export const CLAUDE_RECEIPTS_DISABLE_ENV = "AGENTPARTY_NO_CLAUDE_RECEIPTS";

/** 单条回执连接最多缓冲这么多字节；回执帧只有几百字节。 */
const RECEIPT_MAX_BYTES = 64 * 1024;
const RECEIPT_REASON_MAX = 200;
/** 接收端对回执路径的形状要求。 */
const REPLY_PATH_RE = /^\/\S*\.sock$/;
/** wrapCrossSessionMessage 的 from 属性字符集（`uds:` + path 整体要过）。 */
const FROM_ATTR_RE = /^[A-Za-z0-9%:_/.\-]+$/;

export type PeerReceiptStatus = "held" | "delivered" | "expired" | "refused" | "dropped" | "denied";

export interface PeerReceipt {
  status: PeerReceiptStatus;
  /** 接收端给的原因，压成一行、限长。对方可控文本，只当数据。 */
  reason?: string;
}

function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, RECEIPT_REASON_MAX);
}

/**
 * 解析一行回执。不是回执 / 不是给这条消息的 / 状态不认识 → null。
 * `orig_msg_id` 必须逐字等于我们写出去的 msg_id：那个 socket 同 uid 的进程都能连，
 * 而且一个监听只关心自己那一条——对不上的一律丢。
 */
export function parsePeerReceipt(line: string, msgId: string): PeerReceipt | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== "control" || frame.action !== "peer_message_status") return null;
  if (frame.orig_msg_id !== msgId) return null;
  const raw = frame.status;
  let status: PeerReceiptStatus;
  if (raw === "expired" && frame.status_detail === "refused") status = "refused"; // 线上形态
  else if (
    raw === "held" || raw === "delivered" || raw === "expired" ||
    raw === "refused" || raw === "dropped" || raw === "denied"
  ) status = raw;
  else return null;
  const parts = [frame.reason, frame.drop_reason]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .map(oneLine);
  const reason = oneLine([...new Set(parts)].join(" — "));
  return reason === "" ? { status } : { status, reason };
}

export interface ReceiptListener {
  /** 回执 socket 的路径（填进帧的 `from`，不带 `uds:` 前缀）。 */
  path: string;
  /** 取下一条匹配的回执；超时返回 null。已到未取的先出。 */
  next(timeoutMs: number): Promise<PeerReceipt | null>;
  /** 关监听、断开所有连接、删 socket 文件。可重复调用。 */
  close(): void;
}

export type OpenReceiptListenerResult =
  | { ok: true; listener: ReceiptListener }
  | { ok: false; reason: string };

/**
 * 在目标 socket 的同目录下选一个回执路径，并校验它过得了接收端和注入模块的检查。
 * 只做检查，不建文件。
 */
export function replySocketPathFor(
  targetSocketPath: string,
  os: NodeJS.Platform = process.platform,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (os === "win32") return { ok: false, reason: "receipts are not supported on Windows" };
  if (!isAbsolute(targetSocketPath)) return { ok: false, reason: "target socket path is not absolute" };
  const dir = dirname(targetSocketPath);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    return { ok: false, reason: `socket directory unreadable: ${String(error)}` };
  }
  // 和注入模块别处同一套：真目录、非符号链接、属本 uid。别人的目录里不建文件。
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, reason: "socket directory is not a real directory" };
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    return { ok: false, reason: `socket directory owned by uid ${stat.uid}` };
  }
  const path = join(dir, `${randomBytes(8).toString("hex")}.sock`);
  if (!REPLY_PATH_RE.test(path) || !FROM_ATTR_RE.test(`uds:${path}`)) {
    return { ok: false, reason: "reply socket path would be rejected by the receiver" };
  }
  return { ok: true, path };
}

/**
 * 建回执监听。任何一步失败都返回 { ok:false }——调用方回落到不带 `from` 的旧路径，绝不因为
 * 回执建不起来而不投消息。监听与计时器都 unref：一个等终态的回执绝不撑住宿主进程不退出。
 */
export function openReceiptListener(
  targetSocketPath: string,
  msgId: string,
  os: NodeJS.Platform = process.platform,
): Promise<OpenReceiptListenerResult> {
  const chosen = replySocketPathFor(targetSocketPath, os);
  if (!chosen.ok) return Promise.resolve(chosen);
  const path = chosen.path;
  const queue: PeerReceipt[] = [];
  const waiters: Array<(receipt: PeerReceipt | null) => void> = [];
  const connections = new Set<Socket>();
  let closed = false;

  const push = (receipt: PeerReceipt) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(receipt);
    else queue.push(receipt);
  };
  const consume = (line: string) => {
    if (line.trim() === "") return;
    const receipt = parsePeerReceipt(line, msgId);
    if (receipt !== null) push(receipt);
  };
  const server: Server = createServer((socket) => {
    connections.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > RECEIPT_MAX_BYTES) {
        buffer = "";
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    const flush = () => {
      connections.delete(socket);
      if (buffer !== "") consume(buffer); // 末行没带换行也认
      buffer = "";
    };
    socket.on("end", flush);
    socket.on("close", flush);
    socket.on("error", () => connections.delete(socket));
  });

  const removeFile = () => {
    try {
      // 只删我们自己建的那个 socket：是 socket 才删，别的东西占了这个名字就不碰。
      if (lstatSync(path).isSocket()) unlinkSync(path);
    } catch {
      // 已经没了
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    (process as NodeJS.EventEmitter).removeListener("exit", removeFile);
    for (const socket of connections) socket.destroy();
    connections.clear();
    try {
      server.close();
    } catch {
      // 没监听起来
    }
    removeFile();
    for (const waiter of waiters.splice(0)) waiter(null);
  };

  return new Promise((resolve) => {
    let settled = false;
    const fail = (reason: string) => {
      if (settled) return;
      settled = true;
      close();
      resolve({ ok: false, reason });
    };
    server.once("error", (error) => fail(`listen failed: ${String(error)}`));
    // bind 时文件按 umask 建出来：只在 listen() 这一次同步调用期间收紧，调用返回立刻放回——
    // 宿主是常驻进程，umask 是进程级状态，绝不能跨 await 留着。
    const previousUmask = process.umask(0o177);
    try {
      server.listen(path, () => {
        if (settled) return;
        try {
          chmodSync(path, 0o600);
          const stat = lstatSync(path);
          if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
            throw new Error("reply socket is not ours");
          }
        } catch (error) {
          fail(`reply socket setup failed: ${String(error)}`);
          return;
        }
        settled = true;
        server.unref();
        process.once("exit", removeFile);
        resolve({
          ok: true,
          listener: {
            path,
            next: (timeoutMs) =>
              new Promise<PeerReceipt | null>((done) => {
                const ready = queue.shift();
                if (ready !== undefined) {
                  done(ready);
                  return;
                }
                if (closed || timeoutMs <= 0) {
                  done(null);
                  return;
                }
                let finished = false;
                const waiter = (receipt: PeerReceipt | null) => {
                  if (finished) return;
                  finished = true;
                  clearTimeout(timer);
                  done(receipt);
                };
                const timer = setTimeout(() => {
                  const index = waiters.indexOf(waiter);
                  if (index >= 0) waiters.splice(index, 1);
                  waiter(null);
                }, timeoutMs);
                timer.unref?.();
                waiters.push(waiter);
              }),
            close,
          },
        });
      });
    } catch (error) {
      fail(`listen failed: ${String(error)}`);
    } finally {
      process.umask(previousUmask);
    }
  });
}

/** 归一后的回执状态：没有回执 = `accepted`；held 之后到点没终态 = `unknown`。 */
export type InboxReceiptStatus = PeerReceiptStatus | "accepted" | "unknown";

export interface InboxReceiptEvent {
  /** `first`：写帧后的第一条结果；`terminal`：held 之后的终态。 */
  phase: "first" | "terminal";
  status: InboxReceiptStatus;
  reason?: string;
}

export interface InjectWithReceiptOptions {
  /** 注入实现（测试注入点）；默认真实 injectChannelMessage。 */
  inject?: typeof injectChannelMessage;
  /** 每个回执事件回调一次：first 一次，held 之后 terminal 一次。回调抛错被吞掉。 */
  onReceipt?: (event: InboxReceiptEvent) => void;
  firstWindowMs?: number;
  /** held 之后等终态的最长时间；默认 hold TTL + 余量。 */
  terminalWaitMs?: number;
  targetPollMs?: number;
  os?: NodeJS.Platform;
}

export type InjectWithReceiptResult = InjectResult & {
  /** 这次注入有没有订阅回执；false = 走的是不带 `from` 的旧路径。 */
  receipts: boolean;
  /** 订阅了回执时：回执观察结束（监听已关、文件已删）后 resolve。绝不 reject。 */
  settled?: Promise<void>;
};

let pendingListeners = 0;

/**
 * 注入一条消息并订阅它的原生回执。**不阻塞在回执上**：帧写完即返回（与 injectChannelMessage
 * 同一个 InjectResult），回执在后台通过 `onReceipt` 报告。
 *
 * 回落到今天的行为（不带 `from`、不监听、`receipts:false`）的情形：Windows、
 * `AGENTPARTY_NO_CLAUDE_RECEIPTS=1`、调用方没给 pid（按名字寻址没有可预先解析的 socket）、
 * 调用方自带 `fromSock`/`msgId`（它自己管回执）、目标解析不出来（交给 inject 去报真实失败原因）、
 * 监听建不起来、同时挂着的监听已到上限。帧在任何情况下只写一次。
 */
export async function injectWithReceipt(
  input: InjectChannelMessageInput,
  options: InjectWithReceiptOptions = {},
): Promise<InjectWithReceiptResult> {
  const inject = options.inject ?? injectChannelMessage;
  const env = input.env ?? process.env;
  const os = options.os ?? process.platform;
  const plain = async (): Promise<InjectWithReceiptResult> => ({ ...(await inject(input)), receipts: false });
  if (
    os === "win32" ||
    env[CLAUDE_RECEIPTS_DISABLE_ENV] === "1" ||
    input.pid === undefined ||
    input.fromSock !== undefined ||
    input.msgId !== undefined ||
    pendingListeners >= RECEIPT_MAX_PENDING
  ) return plain();
  const pid = input.pid;
  const resolveTarget = () => resolveSessionSocketByPid(pid, { expectSessionId: input.sessionId, env });
  const resolved = resolveTarget();
  if (!resolved.ok) return plain();
  const msgId = randomUUID();
  // 先占位再 await：上限检查和计数之间隔着一个 await 的话，并发的 @ 会一起越过上限。
  pendingListeners += 1;
  const opened = await openReceiptListener(resolved.session.messagingSocketPath, msgId, os);
  if (!opened.ok) {
    pendingListeners -= 1;
    return plain();
  }
  const listener = opened.listener;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    pendingListeners -= 1;
    listener.close();
  };

  let result: InjectResult;
  try {
    result = await inject({ ...input, fromSock: listener.path, msgId });
  } catch (error) {
    release();
    throw error;
  }
  if (!result.ok) {
    release();
    return { ...result, receipts: true };
  }

  const emit = (event: InboxReceiptEvent) => {
    try {
      options.onReceipt?.(event);
    } catch {
      // 回调是展示用途，绝不影响回执观察与清理。
    }
  };
  const settled = (async () => {
    try {
      const initial = await listener.next(options.firstWindowMs ?? RECEIPT_FIRST_WINDOW_MS);
      if (initial === null) {
        emit({ phase: "first", status: "accepted" });
        return;
      }
      emit({ phase: "first", ...initial });
      if (initial.status !== "held") return;
      // held：继续等终态。会话正常退出会发 expired；被 kill -9 的什么都不发——不空等满 6 分钟。
      const deadline = Date.now() + (options.terminalWaitMs ?? CLAUDE_HOLD_TTL_MS + RECEIPT_TERMINAL_MARGIN_MS);
      const pollMs = Math.max(10, options.targetPollMs ?? RECEIPT_TARGET_POLL_MS);
      let gone = 0;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          emit({ phase: "terminal", status: "unknown", reason: "no terminal receipt before the hold deadline" });
          return;
        }
        const receipt = await listener.next(Math.min(remaining, pollMs));
        if (receipt !== null) {
          if (receipt.status === "held") continue; // 重复的 held 不是终态
          // 一次性：报过终态就结束，后面再来什么回执都不管（监听随即关闭）。
          emit({ phase: "terminal", ...receipt });
          return;
        }
        gone = resolveTarget().ok ? 0 : gone + 1;
        if (gone >= TARGET_GONE_CONFIRMATIONS) {
          emit({
            phase: "terminal",
            status: "unknown",
            reason: "receiver session is gone and sent no terminal receipt",
          });
          return;
        }
      }
    } catch {
      // 观察失败不是投递失败；帧早已写出。
    } finally {
      release();
    }
  })();
  return { ...result, receipts: true, settled };
}
