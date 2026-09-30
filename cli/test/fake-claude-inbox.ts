// 假的 Claude Code 收件箱：真 UDS，收帧，并按 crossSessionInbound 策略回 peer_message_status 回执。
// 移植自 open-cross-session test/fake-claude.ts（同一版权人）。
//
// 回执那一半照 Claude Code 2.1.285 的真机行为做（见 src/claude-inbox-receipt.ts 文件头）：
// - 只有带 `from: "uds:<path>"` + `msg_id` 的 user 帧才有回执；accept 策略一条都不回。
// - 回执地址必须是 /^\/\S*\.sock$/ 且和收件箱 socket 同目录，否则不回。
// - **回执只发给写入那条消息的进程**：真 Claude 连上回执 socket 后用对端凭据核对监听者 pid
//   等于写帧连接的对端 pid（expectPeerPid）。这里用 getsockopt(LOCAL_PEERPID / SO_PEERCRED)
//   做同一件事——「一个进程写帧、另一个进程监听」这种拆法在这个假收件箱面前同样收不到回执，
//   测试不会替实现把这个假设悄悄放过去。
import { dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

let getsockopt: ((fd: number, level: number, name: number, value: unknown, len: unknown) => number) | null | undefined;

/** socket 对端进程的 pid；平台不支持时返回 null。 */
export function peerPid(socket: Socket): number | null {
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return null;
  if (getsockopt === undefined) {
    try {
      const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        getsockopt: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      });
      getsockopt = lib.symbols.getsockopt as unknown as typeof getsockopt;
    } catch {
      getsockopt = null;
    }
  }
  if (getsockopt === null || getsockopt === undefined) return null;
  // macOS: getsockopt(SOL_LOCAL=0, LOCAL_PEERPID=2) → pid_t；Linux: (SOL_SOCKET=1, SO_PEERCRED=17) → {pid,uid,gid}
  const darwin = process.platform === "darwin";
  const value = new Int32Array(3);
  const len = new Uint32Array([darwin ? 4 : 12]);
  const rc = getsockopt(fd, darwin ? 0 : 1, darwin ? 2 : 17, ptr(value), ptr(len));
  return rc === 0 && value[0]! > 0 ? value[0]! : null;
}

export type InboundPolicy = "accept" | "hold" | "refuse" | "drop" | "deny";

export interface HeldMessage {
  msgId: string;
  replyPath: string;
  writerPid: number | null;
}

export interface FakeInbox {
  path: string;
  server: Server;
  /** 每条连接收到的全部字节（可能是 auth 行 + user 帧）。 */
  frames: string[];
  nextFrame(timeoutMs?: number): Promise<string>;
  /** 对带 from 的帧怎么处置；随时可改。 */
  policy: InboundPolicy;
  held: HeldMessage[];
  /** 已发出的回执（状态序列）。 */
  receipts: Array<{ status: string; origMsgId: string }>;
  /** 没发出去的回执及原因（bad-address / pid-mismatch / connect-failed）。 */
  rejected: string[];
  /** 给最早一条被扣的消息发终态回执；repeat>1 连发多条（一次性纪律的变异测试用）。 */
  resolveHeld(status: "delivered" | "expired" | "refused", options?: { reason?: string; repeat?: number }): Promise<void>;
  close(): void;
}

const REPLY_PATH_RE = /^\/\S*\.sock$/;

/**
 * 起一个假收件箱：监听 `path`，按 `policy` 对带 `from` + `msg_id` 的 user 帧回回执。
 * 用完调 close()。
 */
export function fakeClaudeInbox(path: string, policy: InboundPolicy = "accept"): FakeInbox {
  const frames: string[] = [];
  const waiters: Array<(frame: string) => void> = [];
  let consumed = 0;

  const sendReceipt = (
    message: HeldMessage,
    status: string,
    extra: Record<string, string> = {},
  ): Promise<void> =>
    new Promise((resolve) => {
      if (!REPLY_PATH_RE.test(message.replyPath) || dirname(message.replyPath) !== dirname(path)) {
        inbox.rejected.push("bad-address");
        resolve();
        return;
      }
      const socket = connect({ path: message.replyPath });
      // 监听方收到终态就关：晚到的那条连接可能落在已关闭监听的 backlog 里，既不报错也不回调——
      // close 与超时兜底，别让测试挂在假收件箱上。
      socket.once("close", () => resolve());
      const giveUp = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 500);
      socket.once("close", () => clearTimeout(giveUp));
      socket.once("error", () => {
        inbox.rejected.push("connect-failed");
        resolve();
      });
      socket.once("connect", () => {
        const listenerPid = peerPid(socket);
        // expectPeerPid：监听回执的进程必须就是写那条消息的进程。
        if (listenerPid !== null && message.writerPid !== null && listenerPid !== message.writerPid) {
          inbox.rejected.push("pid-mismatch");
          socket.destroy();
          resolve();
          return;
        }
        const frame = {
          type: "control",
          action: "peer_message_status",
          status,
          from: `uds:${path}`,
          orig_msg_id: message.msgId,
          msgV: 1,
          msg_id: randomUUID(),
          ...extra,
        };
        inbox.receipts.push({ status, origMsgId: message.msgId });
        socket.end(`${JSON.stringify(frame)}\n`, () => resolve());
      });
    });

  const onUserFrame = (line: string, writerPid: number | null) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type !== "user" || typeof frame.from !== "string" || typeof frame.msg_id !== "string") return;
    if (!frame.from.startsWith("uds:")) return;
    const message: HeldMessage = { msgId: frame.msg_id, replyPath: frame.from.slice(4), writerPid };
    switch (inbox.policy) {
      case "accept":
        return; // 直接进对话，不回任何东西
      case "hold":
        inbox.held.push(message);
        void sendReceipt(message, "held", { reason: "Your message is waiting for the recipient's approval." });
        return;
      case "refuse":
        void sendReceipt(message, "expired", {
          status_detail: "refused",
          reason: "The recipient refuses cross-session messages.",
        });
        return;
      case "drop":
        void sendReceipt(message, "dropped", {
          reason: "The recipient's queue is full.",
          drop_reason: "queue_full",
        });
        return;
      case "deny":
        void sendReceipt(message, "denied", { reason: "Denied by policy." });
    }
  };

  const server = createServer((socket) => {
    const writerPid = peerPid(socket); // 趁对端还连着取
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (buffer === "") return; // 探活连接
      frames.push(buffer);
      waiters.shift()?.(buffer);
      for (const line of buffer.split("\n")) if (line.trim() !== "") onUserFrame(line, writerPid);
    });
  });
  server.listen(path);

  const inbox: FakeInbox = {
    path,
    server,
    frames,
    policy,
    held: [],
    receipts: [],
    rejected: [],
    nextFrame: (timeoutMs = 4000) =>
      new Promise<string>((resolve, reject) => {
        if (consumed < frames.length) {
          resolve(frames[consumed++]!);
          return;
        }
        waiters.push((frame) => {
          consumed++;
          resolve(frame);
        });
        setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs);
      }),
    resolveHeld: async (status, options = {}) => {
      const message = inbox.held.shift();
      if (message === undefined) throw new Error("no held message");
      const reason = options.reason ??
        (status === "expired"
          ? "Your held message expired without approval and was not delivered."
          : status === "refused"
            ? "The recipient refused your message."
            : "Delivered.");
      for (let i = 0; i < (options.repeat ?? 1); i++) {
        await sendReceipt(
          message,
          status === "refused" ? "expired" : status,
          status === "refused" ? { status_detail: "refused", reason } : { reason },
        );
      }
    },
    close: () => server.close(),
  };
  return inbox;
}

/** user 帧（连接字节的最后一行）解析成对象。 */
export function userFrame(raw: string): { from?: string; msg_id: string; message: { content: string } } {
  return JSON.parse(raw.trim().split("\n").at(-1)!) as { from?: string; msg_id: string; message: { content: string } };
}
