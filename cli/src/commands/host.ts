// party host board — derived coordinator board from presence + task ledger + retained status history.
import {
  buildHostBoard,
  type HostBoard,
  type TaskRecord,
  type TaskState,
} from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { stripTerminalControls } from "../format";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, fetchPresence, fetchRecentMessages, handleRestError, listTasks } from "../rest";
import { isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

// #204 P1：board 只由这 4 个活跃状态派生——open_claims 取 assigned/in_progress/needs_review，
// blockers 取 blocked（见 buildHostBoard / OPEN_CLAIM_STATES）。done/triage/backlog 不进 board。
const BOARD_TASK_STATES: readonly TaskState[] = ["assigned", "in_progress", "needs_review", "blocked"];
const BOARD_TASK_PAGE = 500;

// 原来 board 用一次 listTasks(limit:500) 拉「全部状态」，大量 done/backlog 会把活跃 task 挤出
// 500 窗口 → board 静默漏报活跃 claim/blocker。改为按 board-相关状态分别拉：每个活跃状态集在
// 实践中远小于 500。任一状态命中上限就把它计入 truncated，board 显性告警而不是静默漏（门禁 P1）。
async function fetchBoardTasks(
  server: string,
  token: string,
  channel: string,
): Promise<{ tasks: TaskRecord[]; truncated: TaskState[] }> {
  const pages = await Promise.all(
    BOARD_TASK_STATES.map((state) => listTasks(server, token, channel, { state, limit: BOARD_TASK_PAGE })),
  );
  const tasks = pages.flat();
  const truncated = BOARD_TASK_STATES.filter((_, i) => pages[i]!.length >= BOARD_TASK_PAGE);
  return { tasks, truncated };
}

const HOST_FLAGS = ["channel", "since", "limit", "json"];
const HELP = `usage: party host board [channel|--channel C] [--since seq] [--limit n] [--json]

Show a derived coordinator board for host/failover review.

The board is read-only and uses existing data only:
  - /api/channels/:channel/presence for host lease/residency
  - the channel task ledger for open claims, blockers, and scope conflicts (#204)
  - retained status history for host decisions, and for legacy claims with no task

Options:
  --channel C   read channel C instead of the bound channel
  --since seq   only inspect status messages after seq
  --limit n     maximum messages to inspect (default 500, max 1000). By default inspects the
                MOST RECENT messages; use --since 0 to inspect from the beginning.
  --json        emit one structured JSON frame`;

function scopeLabel(scope: string[]): string {
  return scope.length > 0 ? scope.join(",") : "(no scope)";
}

// 窗口显式化（#151 扩展）：board 只看得到「取回窗口」这一段消息，不是整条频道历史。
// 取尾能看到最新状态，但会漏报窗口之前开启、至今未关的 claim；取头则相反——两者都不健全，
// 所以必须把窗口边界摊开给人看，而不是让 board 悄悄看起来正常。
export interface BoardWindow {
  from: number; // 窗口首条 seq，无消息为 0
  to: number; // 窗口末条 seq，无消息为 0
  head: number; // 频道真实 head（独立 tail 探针拿到的）
  truncated: boolean; // to < head：窗口没看到最新消息，board 不是最新的
  missingBefore: boolean; // from > 1：窗口之前开启、至今未关的 claim 在这个窗口里不可见
}

export function describeWindow(messages: { seq: number }[], head: number): BoardWindow {
  const from = messages[0]?.seq ?? 0;
  const to = messages.at(-1)?.seq ?? 0;
  return {
    from,
    to,
    head,
    truncated: to < head,
    missingBefore: from > 1,
  };
}

export function formatWindowLines(w: BoardWindow): string[] {
  const lines = [`window: seq ${w.from}..${w.to} (channel head = ${w.head})`];
  if (w.missingBefore) {
    lines.push(`note: claims opened before seq ${w.from} are not visible in this window; raise --limit or use --since 0`);
  }
  if (w.truncated) {
    lines.push(`warn: window ends at seq ${w.to} but channel head is ${w.head} — this board is NOT current`);
  }
  return lines;
}

// #204：board 上同时存在两种 claim —— 任务台账派生的（标识是 task id）与消息折叠派生的 legacy claim
// （标识是消息 seq）。两者都渲染成 `#N` 会让运维分不清 `#1` 指 task 1 还是消息 seq 1，故显式区分前缀。
function claimRef(claim: { seq: number; task_id: number | null }): string {
  return claim.task_id === null ? `#${claim.seq}` : `task #${claim.task_id}`;
}

function printBoard(board: HostBoard, window: BoardWindow) {
  console.log(`host board ${board.channel} last_seq=${board.last_seq}`);
  for (const line of formatWindowLines(window)) console.log(line);
  console.log(`hosts: ${board.hosts.length}`);
  // #629：board 逐条行里 name/owner/scope/blocked_reason/note/decision/reason/stale_reason 等都是服务端存的
  // 参与者可控自由文本，整行剥离终端控制序列后再打印（同 format.ts/formatMsg），避免 OSC52/CSI 注入。
  for (const host of board.hosts) {
    const reason = host.stale_reason === null ? "" : ` reason=${host.stale_reason}`;
    console.log(stripTerminalControls(`- ${host.name} ${host.lease} residency=${host.residency} wake=${host.wake_kind}${reason}`));
  }
  console.log(`open claims: ${board.open_claims.length}`);
  for (const claim of board.open_claims) {
    const blocked = claim.blocked_reason === null ? "" : ` blocked=${claim.blocked_reason}`;
    const workflow = claim.workflow === null ? "" : ` workflow=${claim.workflow.workflow_id}/${claim.workflow.kind}`;
    console.log(stripTerminalControls(`- ${claimRef(claim)} ${claim.owner} ${claim.state} scope=${scopeLabel(claim.scope)}${workflow}${blocked}`));
  }
  console.log(`blockers: ${board.blockers.length}`);
  for (const blocker of board.blockers) {
    console.log(stripTerminalControls(`- ${claimRef(blocker)} ${blocker.owner} ${blocker.blocked_reason ?? blocker.note ?? "blocked"}`));
  }
  console.log(`conflicts: ${board.conflicts.length}`);
  for (const conflict of board.conflicts) {
    const claims = conflict.claims.map((claim) => `${claimRef(claim)} ${claim.owner}`).join(" vs ");
    console.log(stripTerminalControls(`- ${conflict.scope}: ${claims}`));
  }
  console.log(`decisions: ${board.decisions.length}`);
  for (const decision of board.decisions) {
    const handoff = decision.handoff_to === null ? "" : ` handoff=${decision.handoff_to}`;
    const takeover = decision.takeover_from === null ? "" : ` takeover=${decision.takeover_from}`;
    console.log(stripTerminalControls(`- #${decision.seq} ${decision.owner} ${decision.kind}: ${decision.decision}${handoff}${takeover}`));
  }
  // #204 legacy 段：没有对应 task 的历史 status claim。独立成段、不混进 open claims；给出转成 task 的命令。
  console.log(`unlinked status claims (no task, legacy): ${board.unlinked_claims.length}`);
  for (const claim of board.unlinked_claims) {
    console.log(stripTerminalControls(`- ${claimRef(claim)} ${claim.owner} ${claim.state} scope=${scopeLabel(claim.scope)}  (no task; run: party task from ${claim.seq})`));
  }
  console.log(`recommended actions: ${board.recommended_actions.length}`);
  for (const action of board.recommended_actions) {
    const human = action.requires_human ? " human" : "";
    const target = action.target === null ? "" : ` target=${action.target}`;
    const command = action.command === null ? "" : ` command=${action.command}`;
    console.log(stripTerminalControls(`- ${action.kind}${human}${target}: ${action.reason}${command}`));
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const [subcmd, ...rest] = argv;
  if (subcmd !== "board") {
    console.error("usage: party host board [channel|--channel C] [--since seq] [--limit n] [--json]");
    return 1;
  }
  const { positionals, flags } = parseArgs(rest, { booleans: ["json"] });
  const unknown = unknownFlagError(flags, HOST_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "since", "limit"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const since = parseNonNegativeIntFlag(str(flags.since), "since");
  if (typeof since === "string") {
    console.error(since);
    return 1;
  }
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 1000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  try {
    const resolvedLimit = limit ?? 500;
    // flag 是否存在才决定走向——没给 --since 就取最近窗口（tail），否则频道超过 limit 条后
    // last_seq 永久冻结在头部、loop guard blocker 永远看不到最新发言（见频道公告 rev347）。
    const sinceGiven = flags.since !== undefined;
    const [presence, messages, headProbe, boardTasks] = await Promise.all([
      fetchPresence(cfg.server, cfg.token, channel),
      sinceGiven
        ? fetchMessages(cfg.server, cfg.token, channel, since ?? 0, resolvedLimit)
        : fetchRecentMessages(cfg.server, cfg.token, channel, resolvedLimit),
      // 独立 tail 探针拿频道真实 head：取尾窗口本身推不出「后面还有没有更新」，取头窗口更推不出。
      fetchRecentMessages(cfg.server, cfg.token, channel, 1),
      // #204 open_claims / conflicts / blockers 改由任务台账派生，board 必须并行拉 tasks 一并喂进 buildHostBoard。
      // 只拉 board-相关的活跃状态，无损覆盖（done/backlog 不进 board），见 fetchBoardTasks（门禁 P1）。
      fetchBoardTasks(cfg.server, cfg.token, channel),
    ]);
    const head = headProbe.at(-1)?.seq ?? 0;
    const window = describeWindow(messages, head);
    const board = buildHostBoard(channel, presence, messages, boardTasks.tasks);
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame({ ...board, window, tasks_truncated: boardTasks.truncated } as unknown as Record<string, unknown>)));
    } else {
      printBoard(board, window);
      if (boardTasks.truncated.length > 0) {
        console.log(`⚠ board 可能不完整：状态 ${boardTasks.truncated.join("/")} 的任务超过 ${BOARD_TASK_PAGE} 条，未全部计入。`);
      }
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
