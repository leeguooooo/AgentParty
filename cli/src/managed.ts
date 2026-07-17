// Managed profile lane（#578 front/worker 双 lane）的共享件（#581 Phase 2）：
// supervisor（serve）与角色裁剪的 MCP server（party mcp --managed）之间的文件握手协议、
// front 血缘解析、worker 附件工作区围栏。serve.ts 与 mcp-managed.ts 都从这里取——
// 生产/消费两侧的事实源只有这一份（#578 的教训：前缀协议两侧相隔百行，改一侧全线挂）。
import { appendFileSync, closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { MsgFrame } from "@agentparty/shared";
import { fetchMessages } from "./rest";

/** 供 MCP server 每次工具调用即读的 lane 清单（attach 时写一次）。 */
export interface ManagedLaneManifest {
  version: 1;
  server: string;
  channel: string;
  role: "front" | "worker";
  /** 本 lane 的 child identity 名。 */
  self: string;
  front: string;
  worker: string;
  owner_account: string;
  /** child token config 的绝对路径（0600，supervisor 写）。 */
  config: string;
  /** worker 附件围栏根；front 恒 null（禁主机文件附件，#578 边界不变）。 */
  attachment_root: string | null;
}

/** 每个 wake 开始前由 supervisor 覆写；工具调用即读即用，天然跟上当前 wake。 */
export interface ManagedWakeState {
  version: 1;
  seq: number;
  frame: MsgFrame;
  delivery: { id: string; cause: string; work_id: string | null; continuation_ref: string | null } | null;
  /** welcome 声明的 owner 决策应答人绑定；false 时 front 决策工具 fail closed（同 #578 语义）。 */
  owner_decision_binding: boolean;
}

/** 工具 handler 落盘、supervisor 回合结束后消费的动作回执（NDJSON，一行一动作）。 */
export interface ManagedActionRecord {
  action: "channel_reply" | "worker_dispatch" | "worker_feedback" | "owner_decision" | "worker_report";
  seq: number;
  /** owner_decision 专有：服务端即时 resolution 状态。 */
  decision_state?: "pending" | "auto_resolved";
  at: number;
}

export const MANAGED_MANIFEST_FILE = "managed.json";
export const MANAGED_WAKE_FILE = "wake.json";
export const MANAGED_CONFIG_FILE = "config.json";

function outcomeFile(stateDir: string, seq: number): string {
  return join(stateDir, `outcome-${seq}.ndjson`);
}

export function writeManagedManifest(stateDir: string, manifest: ManagedLaneManifest): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, MANAGED_MANIFEST_FILE), JSON.stringify(manifest) + "\n", { mode: 0o600 });
}

export function readManagedManifest(stateDir: string): ManagedLaneManifest {
  const raw = JSON.parse(readFileSync(join(stateDir, MANAGED_MANIFEST_FILE), "utf8")) as ManagedLaneManifest;
  if (raw.version !== 1 || (raw.role !== "front" && raw.role !== "worker")) {
    throw new Error(`unsupported managed lane manifest at ${stateDir}`);
  }
  return raw;
}

export function writeManagedWake(stateDir: string, wake: ManagedWakeState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateDir, MANAGED_WAKE_FILE), JSON.stringify(wake) + "\n", { mode: 0o600 });
}

export function readManagedWake(stateDir: string): ManagedWakeState {
  const raw = JSON.parse(readFileSync(join(stateDir, MANAGED_WAKE_FILE), "utf8")) as ManagedWakeState;
  if (raw.version !== 1) throw new Error(`unsupported managed wake state at ${stateDir}`);
  return raw;
}

export function appendManagedAction(stateDir: string, seq: number, record: ManagedActionRecord): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(outcomeFile(stateDir, seq), JSON.stringify(record) + "\n", { mode: 0o600 });
}

/**
 * 新 wake 开工前清掉同 seq 的历史回执（supervisor 在 prepare 里调）：消息编辑会复用原 seq 但
 * 产生新 delivery，旧回执绝不能替新回合充数（CodeRabbit #592 finding）。
 */
export function clearManagedActions(stateDir: string, seq: number): void {
  rmSync(outcomeFile(stateDir, seq), { force: true });
}

export function readManagedActions(stateDir: string, seq: number): ManagedActionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(outcomeFile(stateDir, seq), "utf8");
  } catch {
    return [];
  }
  const records: ManagedActionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as ManagedActionRecord);
    } catch {
      // 半行（进程被杀在 append 中途）只丢那一行，不作废整个回合的已完成动作。
    }
  }
  return records;
}

export class ManagedActionError extends Error {}

/**
 * worker 附件围栏（从 serve.ts 的 resolveRunnerAttachmentPath 迁来，#581）：
 * root=null 一律拒（front 禁主机文件附件）；有 root 时 realpath 后必须落在 root 实路径下，
 * symlink 逃逸在这里被拒。读取的是解析后的真实目标，不是模型给的（可能是链接的）路径。
 */
export function resolveManagedAttachmentPath(path: string, attachmentRoot: string | null): string {
  if (attachmentRoot === null) {
    throw new ManagedActionError("managed front host-file attachments are disabled");
  }
  const realRoot = realpathSync(attachmentRoot);
  if (!statSync(realRoot).isDirectory()) {
    throw new ManagedActionError(`runner attachment root is not a directory: ${attachmentRoot}`);
  }
  if (!isAbsolute(path)) throw new ManagedActionError(`attachment path must be absolute: ${path}`);
  const realPath = realpathSync(path);
  const fromRoot = relative(realRoot, realPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ManagedActionError(`runner attachment escapes allowed workspace: ${path}`);
  }
  return realPath;
}

/**
 * 附件快照（#592 评审的 TOCTOU 修复）：realpath 围栏校验和上传打开之间，worker 可把工作区内
 * 文件换成指向外部的 symlink。这里在校验后立刻以 O_NOFOLLOW 打开、fstat 验普通文件、
 * 从同一个 fd 读出字节，再落到 supervisor 私有目录（工作区之外）的不可变快照——上传只碰快照，
 * 模型此后怎么动工作区都影响不到已读内容。
 */
export const MANAGED_ATTACHMENT_SIZE_LIMIT = 25 * 1024 * 1024;

export function snapshotManagedAttachment(path: string, attachmentRoot: string | null, snapshotDir: string): string {
  const realPath = resolveManagedAttachmentPath(path, attachmentRoot);
  let fd: number;
  try {
    fd = openSync(realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new ManagedActionError(`runner attachment is not a plain readable file: ${path}`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new ManagedActionError(`runner attachment is not a regular file: ${path}`);
    }
    // 读入内存之前先按上传上限拒超大文件——否则模型可用一个巨型文件把本进程 OOM（#592 评审）。
    if (opened.size > MANAGED_ATTACHMENT_SIZE_LIMIT) {
      throw new ManagedActionError(`runner attachment exceeds 25MB limit: ${path}`);
    }
    // O_NOFOLLOW 只挡最后一段 symlink；祖先目录仍可能在 realpath 之后被换成指向工作区外的
    // 链接。开 fd 后重新做一次 realpath+围栏校验，并以 dev/ino 核对「校验过的路径」就是
    // 「已打开的这个文件」——fd 的身份不可再被换。同 uid 的 hardlink/主动拷贝不在本围栏的
    // 威胁模型内（sandbox 本就允许模型读全盘，围栏的价值是边界显式，不是保密）。
    const recheck = resolveManagedAttachmentPath(path, attachmentRoot);
    const rechecked = statSync(recheck);
    if (rechecked.dev !== opened.dev || rechecked.ino !== opened.ino) {
      throw new ManagedActionError(`runner attachment changed during validation: ${path}`);
    }
    const bytes = readFileSync(fd);
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    // 保留 basename（上传链按文件名定 content-type/展示名）；同名冲突加序号，
    // 只对 EEXIST 重试——磁盘满等永久错误必须立即冒出去（#592 评审）。
    let target = join(snapshotDir, basename(realPath));
    for (let index = 1; ; index += 1) {
      try {
        writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        target = join(snapshotDir, `${index}-${basename(realPath)}`);
      }
    }
    return target;
  } finally {
    closeSync(fd);
  }
}

/**
 * owner 决策的原子预约（#592 评审）：并发工具调用都可能在回执尚未落盘时通过读检查。
 * O_EXCL 锁文件是同一 wake 内的原子闸——先到先得，后来者直接拒；post 失败时释放预约。
 */
export function reserveManagedExclusive(stateDir: string, seq: number, action: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, `${action}-${seq}.lock`);
  try {
    closeSync(openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ManagedActionError(`${action} already issued for this wake`);
    }
    throw error;
  }
  return () => rmSync(lockPath, { force: true });
}

/** 供 supervisor 在新 wake 的 prepare 里连同回执一起清理。 */
export function clearManagedExclusiveLocks(stateDir: string, seq: number): void {
  rmSync(join(stateDir, `owner_decision-${seq}.lock`), { force: true });
}

export interface ManagedOrigin {
  seq: number;
  workerReportSeq?: number;
  workerDispatchSeq?: number;
}

export interface ManagedLineageOptions {
  server: string;
  token: string;
  channel: string;
  frontName: string;
  workerName: string;
  ownerAccount: string;
  fetch?: typeof fetchMessages;
}

/**
 * front 血缘解析（从 createManagedFrontResultRoute 原样迁出，#581）：把当前 wake（worker 报告 /
 * owner 决策应答 / 频道消息）追溯到最初的人类 origin，沿途校验每一跳的 principal 与链接。
 * 文本协议路由与 MCP 工具 handler 共用这一份——校验逻辑绝不双写。
 */
export function createManagedLineageResolver(opts: ManagedLineageOptions) {
  const fetch = opts.fetch ?? fetchMessages;
  const readExact = async (seq: number): Promise<MsgFrame> => {
    const message = (await fetch(opts.server, opts.token, opts.channel, Math.max(0, seq - 1), 1))
      .find((candidate) => candidate.seq === seq);
    if (message === undefined) throw new ManagedActionError(`managed front lineage message #${seq} is unavailable`);
    return message;
  };
  const resolveFrame = async (frame: MsgFrame, seen: Set<number>, depth: number): Promise<ManagedOrigin> => {
    if (depth > 12 || seen.has(frame.seq)) {
      throw new ManagedActionError("managed front lineage is cyclic or too deep");
    }
    seen.add(frame.seq);
    if (frame.sender.name === opts.workerName) {
      if (frame.sender.owner !== opts.ownerAccount || frame.reply_to === null) {
        throw new ManagedActionError("worker report principal or dispatch link could not be verified");
      }
      const dispatch = await readExact(frame.reply_to);
      if (
        dispatch.sender.name !== opts.frontName ||
        dispatch.sender.owner !== opts.ownerAccount ||
        !dispatch.mentions.includes(opts.workerName) ||
        dispatch.reply_to === null ||
        dispatch.seq >= frame.seq
      ) {
        throw new ManagedActionError("worker report dispatch lineage could not be verified");
      }
      const root = await resolveFrame(await readExact(dispatch.reply_to), seen, depth + 1);
      return {
        ...root,
        workerReportSeq: frame.seq,
        workerDispatchSeq: dispatch.seq,
      };
    }
    if (frame.decision_response !== undefined) {
      const question = await readExact(frame.decision_response.request_seq);
      if (
        frame.sender.kind !== "human" ||
        frame.sender.owner !== opts.ownerAccount ||
        frame.reply_to !== frame.decision_response.request_seq ||
        question.sender.name !== opts.frontName ||
        question.sender.owner !== opts.ownerAccount ||
        question.decision_request === undefined ||
        question.reply_to === null ||
        question.seq >= frame.seq
      ) {
        throw new ManagedActionError("owner decision question lineage could not be verified");
      }
      return resolveFrame(await readExact(question.reply_to), seen, depth + 1);
    }
    return { seq: frame.seq };
  };
  return async (
    frame: MsgFrame,
    delivery: { cause?: string; work_id: string | null; continuation_ref: string | null } | null,
  ): Promise<ManagedOrigin | null> => {
    if (frame.sender.name === opts.workerName) return resolveFrame(frame, new Set(), 0);
    if (frame.decision_response === undefined) return null;
    if (
      delivery?.cause !== "owner_answer" ||
      delivery.work_id === null ||
      delivery.continuation_ref === null ||
      frame.decision_response.work_id !== delivery.work_id ||
      frame.decision_response.continuation_ref !== delivery.continuation_ref
    ) {
      throw new ManagedActionError("owner answer delivery lineage could not be verified");
    }
    return resolveFrame(frame, new Set(), 0);
  };
}
