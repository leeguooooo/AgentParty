// party board — terminal kanban projection of the channel task ledger.
import type { TaskRecord, TaskState } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchMe, handleRestError, listTasks } from "../rest";
import { isSlug, parsePositiveIntFlag } from "../validation";

const BOARD_STATES: readonly TaskState[] = ["triage", "backlog", "assigned", "in_progress", "needs_review", "blocked", "done"];
const ACTIVE_STATES = new Set<TaskState>(["assigned", "in_progress", "needs_review", "blocked"]);
const FLAGS = ["channel", "state", "assignee", "mine", "limit", "json"];

const HELP = `usage: party board [channel|--channel C] [--mine|--assignee @name] [--state S] [--limit N] [--json]

Render the channel task ledger as a compact terminal board.

Options:
  --mine          only show tasks assigned to the current identity
  --assignee @n  only show tasks assigned to a name
  --state S      filter to triage|backlog|assigned|in_progress|needs_review|done|blocked
  --limit N      max tasks to fetch (default 200, max 500)`;

function parseState(value: string | undefined): TaskState | null | undefined {
  if (value === undefined) return undefined;
  return BOARD_STATES.includes(value as TaskState) ? (value as TaskState) : null;
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatTask(task: TaskRecord): string {
  const assignee = task.assignee === null ? "unassigned" : `@${task.assignee.name}`;
  const labels = task.labels.length > 0 ? ` [${task.labels.join(",")}]` : "";
  return `  #${task.id} P${task.priority} ${assignee}${labels} ${compact(task.title)}`;
}

function summarize(tasks: TaskRecord[]) {
  const byState = new Map<TaskState, TaskRecord[]>();
  for (const state of BOARD_STATES) byState.set(state, []);
  for (const task of tasks) byState.get(task.state)?.push(task);
  const counts = Object.fromEntries(BOARD_STATES.map((state) => [state, byState.get(state)!.length]));
  const active = tasks.filter((task) => ACTIVE_STATES.has(task.state)).length;
  return {
    active,
    counts,
    columns: BOARD_STATES.map((state) => ({ state, count: byState.get(state)!.length, tasks: byState.get(state)! })),
  };
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["mine", "json"] });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "state", "assignee", "limit"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("channel required: pass --channel C or run party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const state = parseState(str(flags.state));
  if (state === null) {
    console.error("--state must be triage|backlog|assigned|in_progress|needs_review|done|blocked");
    return 1;
  }
  if (flags.mine === true && str(flags.assignee) !== undefined) {
    console.error("--mine cannot be combined with --assignee");
    return 1;
  }
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 500) ?? 200;
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  try {
    const assignee = flags.mine === true ? (await fetchMe(cfg.server, cfg.token)).name : str(flags.assignee)?.replace(/^@/, "");
    const tasks = await listTasks(cfg.server, cfg.token, channel, {
      ...(state !== undefined ? { state } : {}),
      ...(assignee !== undefined ? { assignee } : {}),
      limit,
    });
    const board = summarize(tasks);
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame({ type: "board", channel, ...board })));
      return 0;
    }
    console.log(`board #${channel} · ${tasks.length} tasks · ${board.active} active`);
    for (const column of board.columns) {
      if (column.count === 0) continue;
      console.log(`${column.state} (${column.count})`);
      for (const task of column.tasks) console.log(formatTask(task));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
