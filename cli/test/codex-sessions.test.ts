import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexSessionsRoot,
  formatCodexSessionLine,
  isCodexThreadId,
  latestCodexSession,
  listCodexRolloutFiles,
  listCodexSessions,
  parseCodexRolloutFileName,
  summarizeCodexRolloutHead,
} from "../src/codex-sessions";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agentparty-codex-sessions-"));
  tempDirs.push(path);
  return path;
}

interface RolloutFixture {
  stamp: string;
  threadId: string;
  cwd?: string;
  originator?: string;
  source?: unknown;
  branch?: string;
  userMessage?: string;
  trailing?: string;
}

/** Write one rollout in the exact `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` shape. */
function writeRollout(root: string, fixture: RolloutFixture): string {
  const [date, time] = fixture.stamp.split("T") as [string, string];
  const [year, month, day] = date.split("-") as [string, string, string];
  const directory = join(root, year, month, day);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `rollout-${date}T${time}-${fixture.threadId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: `${date}T${time.replace(/-/g, ":")}Z`,
      type: "session_meta",
      payload: {
        session_id: fixture.threadId,
        cwd: fixture.cwd ?? "/workspace",
        originator: fixture.originator ?? "Codex Desktop",
        source: fixture.source ?? "vscode",
        git: { branch: fixture.branch ?? "main" },
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "developer", content: [] },
    }),
    ...(fixture.userMessage === undefined ? [] : [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: fixture.userMessage },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "a later turn that must not win" },
      }),
    ]),
  ];
  writeFileSync(path, `${lines.join("\n")}\n${fixture.trailing ?? ""}`);
  return path;
}

describe("codex rollout session discovery", () => {
  test("the thread id is the UUID in the rollout file name", () => {
    expect(
      parseCodexRolloutFileName(
        "rollout-2026-08-20T18-13-35-01a01e72-8187-7d63-8e4d-9a1a9daa5451.jsonl",
      ),
    ).toEqual({
      threadId: "01a01e72-8187-7d63-8e4d-9a1a9daa5451",
      startedAt: new Date(2026, 7, 20, 18, 13, 35).getTime(),
      startedAtLabel: "2026-08-20T18-13-35",
    });
    expect(parseCodexRolloutFileName("rollout-2026-08-20T18-13-35-not-a-uuid.jsonl")).toBeNull();
    expect(parseCodexRolloutFileName("notes.jsonl")).toBeNull();
    expect(isCodexThreadId("01a01e72-8187-7d63-8e4d-9a1a9daa5451")).toBe(true);
    expect(isCodexThreadId("01a01e72")).toBe(false);
    expect(isCodexThreadId("../../etc/passwd")).toBe(false);
  });

  test("$CODEX_HOME selects the sessions root", () => {
    expect(codexSessionsRoot({ CODEX_HOME: "/opt/codex" }, "/home/leo"))
      .toBe("/opt/codex/sessions");
    expect(codexSessionsRoot({}, "/home/leo")).toBe("/home/leo/.codex/sessions");
  });

  test("rollouts are enumerated newest-first across the date tree", () => {
    const root = tempDir();
    writeRollout(root, { stamp: "2026-08-19T09-00-00", threadId: "aaaaaaaa-0000-4000-8000-000000000001" });
    writeRollout(root, { stamp: "2026-08-20T18-13-35", threadId: "aaaaaaaa-0000-4000-8000-000000000002" });
    writeRollout(root, { stamp: "2026-07-01T23-59-59", threadId: "aaaaaaaa-0000-4000-8000-000000000003" });
    mkdirSync(join(root, "notes"), { recursive: true });
    expect(listCodexRolloutFiles(root).map((file) => file.threadId)).toEqual([
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000001",
      "aaaaaaaa-0000-4000-8000-000000000003",
    ]);
    expect(listCodexRolloutFiles(join(root, "missing"))).toEqual([]);
  });

  test("the head yields cwd, originator, branch, and the first human turn", () => {
    const root = tempDir();
    writeRollout(root, {
      stamp: "2026-08-20T18-13-35",
      threadId: "bbbbbbbb-0000-4000-8000-000000000001",
      cwd: "/Users/leo/github.com/agentparty",
      originator: "Codex Desktop",
      source: "vscode",
      branch: "feat/887",
      userMessage: "wake the session I am looking at",
    });
    const [session] = listCodexSessions(root);
    expect(session).toMatchObject({
      threadId: "bbbbbbbb-0000-4000-8000-000000000001",
      cwd: "/Users/leo/github.com/agentparty",
      originator: "Codex Desktop",
      source: "vscode",
      branch: "feat/887",
      summary: "wake the session I am looking at",
    });
    expect(formatCodexSessionLine(session!)).toContain("bbbbbbbb-0000-4000-8000-000000000001");
    expect(formatCodexSessionLine(session!)).toContain("2026-08-20 18:13:35");
    expect(formatCodexSessionLine(session!)).toContain("@feat/887");
    expect(formatCodexSessionLine(session!)).toContain("wake the session I am looking at");
  });

  test("a subagent source object is not rendered as a description", () => {
    const root = tempDir();
    writeRollout(root, {
      stamp: "2026-08-20T18-13-35",
      threadId: "bbbbbbbb-0000-4000-8000-000000000002",
      source: { subagent: "review" },
    });
    expect(listCodexSessions(root)[0]?.source).toBeNull();
  });

  test("a head cut mid-line is tolerated and never yields a partial record", () => {
    const head = `${JSON.stringify({
      type: "session_meta",
      payload: { cwd: "/workspace", originator: "Codex Desktop", source: "vscode" },
    })}\n{"type":"event_msg","payload":{"type":"user_m`;
    expect(summarizeCodexRolloutHead(head)).toEqual({
      cwd: "/workspace",
      originator: "Codex Desktop",
      source: "vscode",
      branch: null,
      summary: null,
    });
  });

  test("a rollout whose head is larger than the read window still lists", () => {
    const root = tempDir();
    writeRollout(root, {
      stamp: "2026-08-20T18-13-35",
      threadId: "cccccccc-0000-4000-8000-000000000001",
      userMessage: "visible turn",
      trailing: `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", pad: "x".repeat(4096) } })}\n`,
    });
    const [session] = listCodexSessions(root, { headBytes: 64 });
    expect(session?.threadId).toBe("cccccccc-0000-4000-8000-000000000001");
    expect(session?.summary).toBeNull();
    expect(listCodexSessions(root)[0]?.summary).toBe("visible turn");
  });

  test("--resume-last picks the newest rollout and honours a cwd filter", () => {
    const root = tempDir();
    writeRollout(root, {
      stamp: "2026-08-20T10-00-00",
      threadId: "dddddddd-0000-4000-8000-000000000001",
      cwd: "/other",
    });
    writeRollout(root, {
      stamp: "2026-08-20T18-13-35",
      threadId: "dddddddd-0000-4000-8000-000000000002",
      cwd: "/workspace",
    });
    expect(latestCodexSession(root)?.threadId).toBe("dddddddd-0000-4000-8000-000000000002");
    expect(latestCodexSession(root, { cwd: "/other" })?.threadId)
      .toBe("dddddddd-0000-4000-8000-000000000001");
    expect(latestCodexSession(tempDir())).toBeNull();
  });
});
