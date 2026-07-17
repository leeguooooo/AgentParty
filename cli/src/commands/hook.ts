// party hook — Claude Code hooks 接入点（issue #602）。
// `party hook report` 挂在模型 session 的 PreToolUse/Stop/Notification 等 hook 上，
// 把「正在干什么」落成本地 activity 文件，由 serve 的任务心跳帧捎带给频道 presence。
//
// 铁律（hook 跑在模型的工具调用热路径上）：
//   1. stdout 永远为空——hook 的 stdout 会被灌进模型上下文；
//   2. 任何失败都静默 exit 0——exit 2 会 block 模型的工具调用，坏 JSON/写盘失败都不配阻断模型；
//   3. 不走网络——上行由 serve 心跳负责，这里只写文件。
import { join } from "node:path";
import { activityFromHookEvent, writeActivityFile } from "../activity";
import { agentpartyHome } from "../config";
import { isHelpArg } from "../args";

const HELP = `usage: party hook report

Claude Code hook adapter (issue #602). Wire it into a session's hook config:

  { "hooks": { "PreToolUse": [ { "hooks": [ { "type": "command", "command": "party hook report" } ] } ] } }

Reads the hook event JSON from stdin and records a local activity snapshot
(what tool is running / waiting on permission / compacting / idle). A local
\`party serve\` picks the snapshot up and reports it with its presence
heartbeat — the channel sees what the agent is actually doing, not just busy.

Target file: $AP_ACTIVITY_FILE when set (serve-managed runners), otherwise
~/.agentparty/state/activity/<session_id>.json.

Never blocks the model: any failure exits 0 silently, stdout stays empty.`;

// stdin 兜底上限：hook payload 正常几 KB，超过说明喂错了东西，读满即止防内存放大。
const MAX_STDIN_BYTES = 256 * 1024;

// 未走 serve 托管（无 AP_ACTIVITY_FILE）时按 session_id 落到全局 state 目录。
// session_id 直接进路径，白名单校验防穿越。
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    chunks.push(buf);
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).toString("utf8", 0, Math.min(total, maxBytes));
}

export function activityTargetFile(
  env: Record<string, string | undefined>,
  payload: Record<string, unknown>,
  home: string,
): string | null {
  const explicit = env.AP_ACTIVITY_FILE;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  return join(home, "state", "activity", `${sessionId}.json`);
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  if (argv[0] !== "report") {
    // 唯一会写 stderr 的分支：人在终端敲错子命令。真 hook 调用恒为 `hook report`，不受影响。
    console.error(HELP);
    return 1;
  }
  try {
    const raw = await readStdin(MAX_STDIN_BYTES);
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload !== "object" || payload === null) return 0;
    const record = payload as Record<string, unknown>;
    const activity = activityFromHookEvent(record, Date.now());
    if (activity === null) return 0;
    const target = activityTargetFile(process.env, record, agentpartyHome());
    if (target === null) return 0;
    writeActivityFile(target, activity);
  } catch {
    // 静默：hook 绝不阻断模型（exit 2 才 block，这里连非零都不给）。
  }
  return 0;
}
