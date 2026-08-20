// Discover Codex rollout sessions so `party bridge codex --resume/--resume-last`
// can re-enter a thread the user is already looking at.
//
// Codex writes one JSONL rollout per session under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local-ts>-<uuid>.jsonl. The UUID in
// the file name is the thread id accepted by `codex resume <threadId>`; the
// first line is a `session_meta` record carrying cwd/originator/source/git, and
// the first `event_msg` of type `user_message` is the earliest human-readable
// label for the session.
import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizeSingleLine } from "./format";

/** Bytes of each rollout read while building a listing. */
export const CODEX_ROLLOUT_HEAD_BYTES = 512 * 1024;

const ROLLOUT_NAME_RE =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const THREAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexSessionSummary {
  threadId: string;
  path: string;
  /** Local wall-clock start encoded in the file name, as epoch ms. */
  startedAt: number;
  /** `2026-08-20T18-13-35` exactly as the file name spells it. */
  startedAtLabel: string;
  cwd: string | null;
  originator: string | null;
  source: string | null;
  branch: string | null;
  /** First human turn of the session, collapsed to one short line. */
  summary: string | null;
}

export function isCodexThreadId(value: string): boolean {
  return THREAD_ID_RE.test(value);
}

/** `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export function codexSessionsRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const codexHome = env.CODEX_HOME?.trim();
  return codexHome
    ? resolve(codexHome, "sessions")
    : resolve(home, ".codex", "sessions");
}

export function parseCodexRolloutFileName(
  name: string,
): { threadId: string; startedAt: number; startedAtLabel: string } | null {
  const match = ROLLOUT_NAME_RE.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, threadId] = match;
  // The file-name stamp is local wall-clock, so build a local Date. Only the
  // relative order matters for "most recent", and every rollout on one machine
  // shares the same clock.
  const startedAt = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return {
    threadId: threadId!.toLowerCase(),
    startedAt,
    startedAtLabel: `${year}-${month}-${day}T${hour}-${minute}-${second}`,
  };
}

function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Enumerate rollout files newest-first without reading any of them. The layout
 * is a fixed YYYY/MM/DD tree, so only numeric directory levels are descended.
 */
export function listCodexRolloutFiles(
  root: string,
): Array<{ path: string } & NonNullable<ReturnType<typeof parseCodexRolloutFileName>>> {
  const found: Array<{ path: string } & NonNullable<ReturnType<typeof parseCodexRolloutFileName>>> = [];
  for (const year of readdirOrEmpty(root)) {
    if (!/^\d{4}$/.test(year)) continue;
    const yearPath = join(root, year);
    for (const month of readdirOrEmpty(yearPath)) {
      if (!/^\d{2}$/.test(month)) continue;
      const monthPath = join(yearPath, month);
      for (const day of readdirOrEmpty(monthPath)) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayPath = join(monthPath, day);
        for (const name of readdirOrEmpty(dayPath)) {
          const parsed = parseCodexRolloutFileName(name);
          if (!parsed) continue;
          found.push({ path: join(dayPath, name), ...parsed });
        }
      }
    }
  }
  found.sort((a, b) =>
    b.startedAt - a.startedAt || b.startedAtLabel.localeCompare(a.startedAtLabel)
  );
  return found;
}

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function oneLine(value: string, limit = 96): string | null {
  const collapsed = sanitizeSingleLine(value).replace(/\s+/g, " ").trim();
  if (collapsed === "") return null;
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Extract the identifying fields from a rollout prefix. Truncated input is
 * expected: the caller only reads a bounded head of a possibly huge file, so
 * the trailing partial line is dropped and unparsable lines are skipped.
 */
export function summarizeCodexRolloutHead(head: string): {
  cwd: string | null;
  originator: string | null;
  source: string | null;
  branch: string | null;
  summary: string | null;
} {
  const result = {
    cwd: null as string | null,
    originator: null as string | null,
    source: null as string | null,
    branch: null as string | null,
    summary: null as string | null,
  };
  // A head cut mid-line is never valid JSON, so the trailing partial record is
  // skipped by the parse guard below rather than needing its own special case.
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { type, payload } = record as { type?: unknown; payload?: unknown };
    if (typeof payload !== "object" || payload === null) continue;
    const fields = payload as Record<string, unknown>;
    if (type === "session_meta") {
      result.cwd = stringOrNull(fields.cwd);
      result.originator = stringOrNull(fields.originator);
      result.source = stringOrNull(fields.source);
      const git = fields.git;
      if (typeof git === "object" && git !== null) {
        result.branch = stringOrNull((git as Record<string, unknown>).branch);
      }
      continue;
    }
    if (
      result.summary === null &&
      type === "event_msg" &&
      fields.type === "user_message" &&
      typeof fields.message === "string"
    ) {
      result.summary = oneLine(fields.message);
    }
  }
  return result;
}

export interface ListCodexSessionsOptions {
  limit?: number;
  /** Only sessions whose recorded cwd is exactly this path. */
  cwd?: string;
  headBytes?: number;
}

export function listCodexSessions(
  root: string,
  options: ListCodexSessionsOptions = {},
): CodexSessionSummary[] {
  const limit = options.limit ?? 20;
  const headBytes = options.headBytes ?? CODEX_ROLLOUT_HEAD_BYTES;
  const sessions: CodexSessionSummary[] = [];
  for (const file of listCodexRolloutFiles(root)) {
    if (sessions.length >= limit) break;
    let details: ReturnType<typeof summarizeCodexRolloutHead>;
    try {
      details = summarizeCodexRolloutHead(readHead(file.path, headBytes));
    } catch {
      // An unreadable rollout is not a listing failure; it simply cannot be
      // described. Its thread id is still valid, so keep the row.
      details = { cwd: null, originator: null, source: null, branch: null, summary: null };
    }
    if (options.cwd !== undefined && details.cwd !== options.cwd) continue;
    sessions.push({
      threadId: file.threadId,
      path: file.path,
      startedAt: file.startedAt,
      startedAtLabel: file.startedAtLabel,
      ...details,
    });
  }
  return sessions;
}

export function latestCodexSession(
  root: string,
  options: Omit<ListCodexSessionsOptions, "limit"> = {},
): CodexSessionSummary | null {
  return listCodexSessions(root, { ...options, limit: 1 })[0] ?? null;
}

export function formatCodexSessionLine(session: CodexSessionSummary): string {
  const when = session.startedAtLabel.replace("T", " ").replace(
    /-(\d{2})-(\d{2})$/,
    ":$1:$2",
  );
  const origin = [session.originator, session.source]
    .filter((value): value is string => value !== null)
    .join("/");
  const parts = [
    session.threadId,
    when,
    session.cwd ?? "unknown cwd",
    ...(session.branch === null ? [] : [`@${session.branch}`]),
    ...(origin === "" ? [] : [`(${origin})`]),
  ];
  return `${parts.join("  ")}${session.summary === null ? "" : `\n    ${session.summary}`}`;
}
