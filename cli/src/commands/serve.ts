// party serve — 常驻监听频道，每条 @你 的消息触发一次本地命令，把「跑完就停的 session agent」
// 用外部 supervisor 唤醒（wake GOAL 的 session 型那半；有入站 URL 的 runtime 走 webhook）。
// 复用 client.connect 的自动重连帧流，真正常驻；命令串行执行（一条处理完再下一条，不并发抢跑）。
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_STREAM_ENDED, EXIT_UPGRADED, type MsgFrame } from "@agentparty/shared";
import { maybeReexecUpgrade, upgradeNotice, type CliUpgradeNotice, type UpgradeDeps } from "../upgrade";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readAccount } from "../account";
import { connect } from "../client";
import { loadCursor, loadRevCursor, resolveChannel, saveCursor, saveRevCursor } from "../config";
import { formatMsg } from "../format";
import { ensureFreshAccess, resolveAuthDetailed, type ResolvedAuthDetailed } from "../oidc-cli";
import {
  clearStatuslineListener,
  heartbeatPatch,
  lastMessageFromFrame,
  localStatuslineBase,
  unreadFromCursor,
  writeStatuslineCache,
} from "../statusline-cache";
import {
  fetchChannelCharter,
  ensureProjectAgentChannelRuntime,
  listProjectAgentInvites,
  mintProjectAgentRuntimeToken,
  postMessage,
  type ChannelCharter,
  type ChannelProjectAgentInvite,
  type ProjectAgentChannelRuntime,
  type ProjectAgentProfile,
} from "../rest";
import { isName, isSlug } from "../validation";
import { buildContext } from "./status";

const PROTOCOL_REMINDER =
  "被 @ 唤起：先读本文件 charter 了解频道约定；若发现 charter 与频道现状矛盾，视为一个待办上报。需要更多上下文再 `party history <channel 字段的频道>`；需要产出结论时，先用 `party send --reply-to <seq>` 把 final synthesis 发回频道，再 status done；别只回本地。";

// context file 里附带的最近频道消息条数上限（冷起的 runner 不用先跑 history 也有基本上下文）
const RECENT_MAX = 20;
const RECENT_BODY_MAX = 400;
const RUNNER_SESSION_FILE = "wake-session.json";
const RUNNER_LOG_FILE = "serve-runner.log";

export type RunnerHarness = "codex" | "claude";

export interface RunnerProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunnerProcessOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export type RunnerProcess = (
  args: string[],
  opts: RunnerProcessOptions,
) => Promise<RunnerProcessResult>;

interface WakeSessionState {
  harness: RunnerHarness;
  session_id: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
}

interface SdkWakeSessionState {
  harness: "codex-sdk";
  thread_id: string;
  created_at: number;
  last_wake_ts: number;
  wakes: number;
}

export interface BuiltinRunnerOptions {
  server: string;
  token: string;
  channel: string;
  harness: RunnerHarness;
  workdir: string;
  cwd?: string;
  repo?: string;
  runProcess?: RunnerProcess;
  runGit?: RunnerProcess;
  authSourceFile?: string;
  now?: () => number;
  post?: typeof postMessage;
}

export interface ThreadLike {
  id?: string | null;
  thread_id?: string | null;
  run(prompt: string, opts: { sandbox: string }): Promise<unknown>;
}

export interface CodexLike {
  startThread(): ThreadLike | Promise<ThreadLike>;
  resumeThread(threadId: string): ThreadLike | Promise<ThreadLike>;
}

export interface SdkRunnerOptions {
  server: string;
  token: string;
  channel: string;
  workdir: string;
  sandbox?: string;
  codexFactory?: () => CodexLike | Promise<CodexLike>;
  now?: () => number;
  post?: typeof postMessage;
}

export interface ProjectAgentRunContext {
  owner_account: string;
  handle: string;
  name: string;
  runner: string;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: string;
  rules: string | null;
  channel_workdir: string;
  runner_workdir: string;
}

// 把一条 @mention 的完整上下文落成 JSON 文件，命令拿路径读——避开 env/stdin 的 shell quoting/注入，
// 也让 runner 能一次拿全 channel/seq/sender/body/reply_to/recent/protocol_reminder（评审建议）。
// recent = 触发消息之前、serve 在线期间看到的最近频道消息（含自己/未 @ 的闲聊，正文截断），
// 让冷起的 runner 开箱有上下文；完整脉络仍以 party history 为准。
function buildWakeContext(
  frame: MsgFrame,
  channel: string,
  self: string,
  recent: MsgFrame[],
  charter: ChannelCharter | null = null,
  projectAgent: ProjectAgentRunContext | null = null,
  cliUpgrade: CliUpgradeNotice | null = null,
) {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  return {
    channel,
    seq: frame.seq,
    sender: frame.sender.name,
    owner: frame.sender.owner ?? null,
    kind: frame.kind,
    body,
    mentions: frame.mentions,
    reply_to: frame.seq, // 回这条就 --reply-to 它
    self,
    charter: charter?.charter ?? null,
    charter_rev: charter?.charter_rev ?? 0,
    project_agent: projectAgent,
    cli_upgrade: cliUpgrade,
    recent: recent.map((m) => ({
      seq: m.seq,
      sender: m.sender.name,
      kind: m.kind,
      body: (m.kind === "message" ? m.body : (m.note ?? "")).slice(0, RECENT_BODY_MAX),
      ts: m.ts,
    })),
    protocol_reminder: PROTOCOL_REMINDER,
  };
}

export function writeContextFile(
  frame: MsgFrame,
  channel: string,
  self: string,
  recent: MsgFrame[],
  charter: ChannelCharter | null = null,
  projectAgent: ProjectAgentRunContext | null = null,
  cliUpgrade: CliUpgradeNotice | null = null,
): string {
  const path = join(tmpdir(), `agentparty-serve-${channel}-${frame.seq}.json`);
  writeFileSync(
    path,
    JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade), null, 2) + "\n",
    { mode: 0o600 },
  );
  return path;
}

const SERVE_FLAGS = ["channel", "on-mention", "all", "runner", "workdir", "repo", "auto-upgrade", "profile", "profile-once", "profile-poll-interval"];
const HELP = `usage: party serve [channel|--channel C] (--on-mention "<cmd>" | --runner codex|claude|codex-sdk) [--all]
       party serve --profile <owner>/<handle>

Stay attached to a channel and run one local command for each matching message.
The command can read the context JSON path from {file} or AP_CONTEXT_FILE.

Options:
  --channel C          serve channel C instead of the bound channel
  --on-mention "<cmd>" command to run for each wake
  --runner codex|claude|codex-sdk
                       use the built-in isolated wake runner instead of a custom command
  --workdir DIR        runner workdir (default: ~/.agentparty/runners/<channel>)
  --repo URL           clone into workdir/repo once, then git pull --ff-only before each wake
  --profile ref        run the reusable project-agent profile as one resident daemon across all invites
  --auto-upgrade       between wakes, if a newer party binary is on disk, re-exec it (issue #45)
  --all                run for every non-self message, not only @mentions`;

export interface ServeOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  sinceRev?: number; // 修订游标（hello.since_rev）
  cmd: string;
  mentionsOnly: boolean;
  builtinRunner?: BuiltinRunnerOptions;
  onCursor?: (cursor: number) => void;
  onRevCursor?: (revCursor: number) => void;
  // 测试注入点：默认用 sh -c 起子进程
  runCommand?: (
    frame: MsgFrame,
    ctx: {
      cmd: string;
      channel: string;
      self: string;
      recent: MsgFrame[];
      charter?: ChannelCharter | null;
      projectAgent?: ProjectAgentRunContext | null;
      cliUpgrade?: CliUpgradeNotice | null;
    },
  ) => Promise<void>;
  sdkRunner?: SdkRunnerOptions;
  // serve 挂上后声明自己「可被唤醒」的钩子；run() 注入真实实现，测试可省略/替换
  advertise?: () => Promise<void>;
  charter?: ChannelCharter | null;
  projectAgent?: ProjectAgentRunContext | null;
  fetchCharter?: () => Promise<ChannelCharter>;
  // 唤醒间隙发现磁盘装了更新的 party 就自动 re-exec 新版（issue #45）；默认只提示不动。
  autoUpgrade?: boolean;
  upgradeDeps?: UpgradeDeps; // 测试注入版本读取/re-exec
  out?: (line: string) => void;
  statusline?: boolean;
}

// serve 一挂上就把 presence 标成可唤醒：residency=supervised + wake.kind=serve。
// 没这一步，agent 跑了 serve 但 presence 仍是 null → 别人 party wake test @你 会判 not_auto_wakeable，
// agent 得自己再手动 party status --wake-kind serve --residency supervised 才行（外部 agent 就卡在这半天）。
export async function advertiseServeWake(auth: ResolvedAuthDetailed, channel: string): Promise<void> {
  if (!auth.server || !auth.token) return;
  await postMessage(auth.server, auth.token, channel, {
    kind: "status",
    state: "waiting",
    note: "serve supervisor 已挂上——被 @ 才唤起你一次，等待零 token",
    mentions: [],
    residency: "supervised",
    wake: { kind: "serve" },
    context: buildContext(auth),
  });
}

// 默认执行器：把上下文写成 context file → sh -c <cmd>（cmd 里的 {file} 替成路径，也放进 AP_CONTEXT_FILE）。
// 正文仍走 stdin + AP_* env 图省事；context file 是给需要稳健取全量的 runner 用。串行等它退出。
// 非零退出：打印 exit code + context file 路径（便于排查），并保留文件；成功则清理。
async function defaultRun(
  frame: MsgFrame,
  ctx: {
    cmd: string;
    channel: string;
    self: string;
    recent: MsgFrame[];
    charter?: ChannelCharter | null;
    projectAgent?: ProjectAgentRunContext | null;
    cliUpgrade?: CliUpgradeNotice | null;
  },
): Promise<void> {
  const body = frame.kind === "message" ? frame.body : (frame.note ?? "");
  const file = writeContextFile(frame, ctx.channel, ctx.self, ctx.recent, ctx.charter, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null);
  const cmd = ctx.cmd.includes("{file}") ? ctx.cmd.replaceAll("{file}", file) : ctx.cmd;
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: new TextEncoder().encode(body),
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      AP_CONTEXT_FILE: file,
      AP_CHANNEL: ctx.channel,
      AP_SEQ: String(frame.seq),
      AP_SENDER: frame.sender.name,
      AP_OWNER: frame.sender.owner ?? "",
      AP_BODY: body,
      AP_MENTIONS: frame.mentions.join(","),
      AP_SELF: ctx.self,
      AP_REPLY_TO: String(frame.seq),
    },
  });
  const code = await proc.exited;
  if (code !== 0) {
    // 保留 context file 供排查，抛错让 runServe 打印（不发频道）
    throw new Error(`command exited ${code} (context: ${file})`);
  }
  try {
    unlinkSync(file);
  } catch {
    /* 清理失败无所谓 */
  }
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function attachmentPathFromRunnerText(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[attach:([^\]\r\n]+)\]$/);
    if (!match) continue;
    const path = match[1]!;
    if (!isAbsolute(path)) throw new Error(`[attach] path must be absolute: ${path}`);
    return path;
  }
  return null;
}

function finalMessageBody(text: string, marker: string | null): string {
  const attach = attachmentPathFromRunnerText(text);
  if (attach) return readFileSync(attach, "utf8");
  return marker ? `${marker}\n${text}` : text;
}

async function defaultRunnerProcess(
  args: string[],
  opts: RunnerProcessOptions,
): Promise<RunnerProcessResult> {
  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    env: compactEnv(opts.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function readSession(path: string, harness: RunnerHarness): WakeSessionState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as WakeSessionState;
    return state.harness === harness && typeof state.session_id === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeSession(path: string, state: WakeSessionState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function readSdkSession(path: string): SdkWakeSessionState | null {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as SdkWakeSessionState;
    return state.harness === "codex-sdk" && typeof state.thread_id === "string" ? state : null;
  } catch {
    return null;
  }
}

function writeSdkSession(path: string, state: SdkWakeSessionState): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function shortSid(sid: string | null | undefined): string {
  return sid ? sid.slice(0, 8) : "unknown";
}

function appendRunnerLog(workdir: string, line: string): void {
  appendFileSync(join(workdir, RUNNER_LOG_FILE), line + "\n");
}

function parseCodexSessionId(stdout: string): string | null {
  return stdout.match(/session id:\s*([0-9a-fA-F][0-9a-fA-F-]{7,})/i)?.[1] ?? null;
}

function sdkPrompt(
  frame: MsgFrame,
  channel: string,
  self: string,
  recent: MsgFrame[],
  charter: ChannelCharter | null,
  projectAgent: ProjectAgentRunContext | null = null,
  cliUpgrade: CliUpgradeNotice | null = null,
): string {
  return JSON.stringify(buildWakeContext(frame, channel, self, recent, charter, projectAgent, cliUpgrade), null, 2) + "\n";
}

function sdkThreadId(thread: ThreadLike): string | null {
  // codex-sdk 在 run() 之前 thread id 可能还是 null（懒初始化），不能直接抛
  if (typeof thread.id === "string") return thread.id;
  if (typeof thread.thread_id === "string") return thread.thread_id;
  return null;
}

async function defaultCodexFactory(): Promise<CodexLike> {
  const specifier = "@openai/codex-sdk";
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch {
    throw new Error(
      "runner codex-sdk requires @openai/codex-sdk and Node >=18. Install it with: npm i @openai/codex-sdk",
    );
  }
  const record = mod && typeof mod === "object" ? (mod as Record<string, unknown>) : {};
  const nestedDefault = record.default && typeof record.default === "object"
    ? (record.default as Record<string, unknown>)
    : {};
  const Codex = record.Codex ?? nestedDefault.Codex ?? record.default;
  if (typeof Codex !== "function") {
    throw new Error("@openai/codex-sdk did not export Codex");
  }
  const CodexCtor = Codex as new () => CodexLike;
  return new CodexCtor();
}

export function finalText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return String(result ?? "");
  const body = result as Record<string, unknown>;
  for (const key of ["final_response", "finalResponse", "text", "message", "content", "result"]) {
    if (typeof body[key] === "string") return body[key];
  }
  return String(result);
}

function parseClaudeJson(stdout: string): { sessionId: string | null; text: string } {
  try {
    const body = JSON.parse(stdout) as Record<string, unknown>;
    const sessionId = typeof body.session_id === "string" ? body.session_id : null;
    for (const key of ["result", "text", "message", "content"]) {
      if (typeof body[key] === "string") return { sessionId, text: body[key] };
    }
    return { sessionId, text: stdout };
  } catch {
    return { sessionId: null, text: stdout };
  }
}

function prepareCodexHome(workdir: string, authSourceFile?: string): Record<string, string | undefined> {
  const codexHome = join(workdir, ".codex");
  mkdirSync(codexHome, { recursive: true });
  const authDest = join(codexHome, "auth.json");
  const authSource = authSourceFile ?? join(homedir(), ".codex", "auth.json");
  // 隔离 CODEX_HOME 会把登录态也隔离掉；只在目标缺失时拷贝一次，后续由该 home 自己刷新。
  if (!existsSync(authDest) && existsSync(authSource)) {
    copyFileSync(authSource, authDest);
  }
  return { ...process.env, CODEX_HOME: codexHome };
}

async function ensureRepo(
  opts: BuiltinRunnerOptions,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!opts.repo) return null;
  const repoDir = join(opts.workdir, "repo");
  const runGit = opts.runGit ?? defaultRunnerProcess;
  const args = existsSync(repoDir)
    ? ["git", "-C", repoDir, "pull", "--ff-only"]
    : ["git", "clone", opts.repo, repoDir];
  const res = await runGit(args, { cwd: opts.workdir, env });
  if (res.code !== 0) {
    appendRunnerLog(
      opts.workdir,
      `${new Date((opts.now ?? Date.now)()).toISOString()} repo_exit=${res.code} cmd=${args.join(" ")} stderr=${JSON.stringify(res.stderr.slice(0, 500))}`,
    );
  }
  return existsSync(repoDir) ? repoDir : null;
}

interface HarnessRun {
  result: RunnerProcessResult;
  text: string;
  sessionId: string | null;
  outFile?: string;
}

async function runHarness(
  opts: BuiltinRunnerOptions,
  prompt: string,
  sid: string | null,
  cwd: string,
  env: Record<string, string | undefined>,
  seq: number,
): Promise<HarnessRun> {
  const runProcess = opts.runProcess ?? defaultRunnerProcess;
  if (opts.harness === "codex") {
    const outFile = join(opts.workdir, `runner-${seq}-${Date.now()}.out`);
    const base = ["--skip-git-repo-check", "--sandbox", "workspace-write", "-o", outFile, prompt];
    const args = sid ? ["codex", "exec", "resume", sid, ...base] : ["codex", "exec", ...base];
    const result = await runProcess(args, { cwd, env });
    const text = result.code === 0 && existsSync(outFile) ? readFileSync(outFile, "utf8").trimEnd() : "";
    return { result, text, sessionId: sid ? sid : parseCodexSessionId(result.stdout), outFile };
  }

  const args = sid
    ? ["claude", "-p", "--resume", sid, prompt]
    : ["claude", "-p", "--output-format", "json", prompt];
  const result = await runProcess(args, { cwd, env });
  if (sid) return { result, text: result.stdout.trimEnd(), sessionId: sid };
  const parsed = parseClaudeJson(result.stdout);
  return { result, text: parsed.text.trimEnd(), sessionId: parsed.sessionId };
}

async function postBlocked(
  opts: BuiltinRunnerOptions,
  frame: MsgFrame,
  note: string,
): Promise<void> {
  await (opts.post ?? postMessage)(opts.server, opts.token, opts.channel, {
    kind: "status",
    state: "blocked",
    note,
    mentions: [],
    blocked_reason: note,
  });
}

export function createSdkRunner(opts: SdkRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  let codexPromise: Promise<CodexLike> | null = null;
  let thread: ThreadLike | null = null;
  let session: SdkWakeSessionState | null = null;
  let queue = Promise.resolve();

  const codex = (): Promise<CodexLike> => {
    codexPromise ??= Promise.resolve((opts.codexFactory ?? defaultCodexFactory)());
    return codexPromise;
  };

  const ensureThread = async (started: number): Promise<{ thread: ThreadLike; session: SdkWakeSessionState | null }> => {
    if (thread && session) return { thread, session };
    mkdirSync(opts.workdir, { recursive: true });
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);
    const prior = readSdkSession(sessionPath);
    const client = await codex();
    if (prior) {
      thread = await client.resumeThread(prior.thread_id);
      session = prior;
      return { thread, session };
    }
    thread = await client.startThread();
    const threadId = sdkThreadId(thread);
    // thread id 懒初始化：拿不到就先不落 session 文件，等首个 run() 之后补写
    session = threadId
      ? {
          harness: "codex-sdk",
          thread_id: threadId,
          created_at: started,
          last_wake_ts: started,
          wakes: 0,
        }
      : null;
    if (session) writeSdkSession(sessionPath, session);
    return { thread, session };
  };

  const handle = async (
    frame: MsgFrame,
    ctx: {
      cmd: string;
      channel: string;
      self: string;
      recent: MsgFrame[];
      charter?: ChannelCharter | null;
      projectAgent?: ProjectAgentRunContext | null;
      cliUpgrade?: CliUpgradeNotice | null;
    },
  ): Promise<void> => {
    const started = opts.now?.() ?? Date.now();
    mkdirSync(opts.workdir, { recursive: true });
    const post = opts.post ?? postMessage;
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);

    await post(opts.server, opts.token, opts.channel, {
      kind: "status",
      state: "working",
      note: `wake ack: ${ctx.self} builtin codex-sdk runner handling seq=${frame.seq}`,
      mentions: [],
    });

    let threadId = session?.thread_id ?? null;
    try {
      const active = await ensureThread(started);
      const result = await active.thread.run(sdkPrompt(frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null), {
        sandbox: opts.sandbox ?? "full_access",
      });
      // run() 之后 thread id 一定就位；懒初始化的 session 在这里补建
      threadId = active.session?.thread_id ?? sdkThreadId(active.thread);
      if (!threadId) throw new Error("@openai/codex-sdk thread did not expose an id/thread_id after run");
      const body = finalText(result);
      const now = opts.now?.() ?? Date.now();
      const baseSession = active.session ?? {
        harness: "codex-sdk" as const,
        thread_id: threadId,
        created_at: started,
        last_wake_ts: started,
        wakes: 0,
      };
      session = {
        ...baseSession,
        last_wake_ts: now,
        wakes: baseSession.wakes + 1,
      };
      writeSdkSession(sessionPath, session);
      await post(opts.server, opts.token, opts.channel, {
        kind: "message",
        body,
        mentions: [],
        reply_to: frame.seq,
      });
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} status=ok`,
      );
    } catch (err) {
      const now = opts.now?.() ?? Date.now();
      const message = err instanceof Error ? err.message : String(err);
      if (session) {
        session = { ...session, last_wake_ts: now, wakes: session.wakes + 1 };
        writeSdkSession(sessionPath, session);
        threadId = session.thread_id;
      }
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(threadId)} duration_ms=${now - started} status=error error=${JSON.stringify(message.slice(0, 500))}`,
      );
      const note = `builtin codex-sdk runner blocked: ${message}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`;
      await post(opts.server, opts.token, opts.channel, {
        kind: "status",
        state: "blocked",
        note,
        mentions: [],
        blocked_reason: note,
      });
    }
  };

  return (frame, ctx) => {
    const next = queue.then(() => handle(frame, ctx));
    queue = next.catch(() => {});
    return next;
  };
}

export function createBuiltinRunner(opts: BuiltinRunnerOptions): NonNullable<ServeOptions["runCommand"]> {
  return async (frame, ctx) => {
    const started = opts.now?.() ?? Date.now();
    mkdirSync(opts.workdir, { recursive: true });
    const env = opts.harness === "codex" ? prepareCodexHome(opts.workdir, opts.authSourceFile) : { ...process.env };
    const sessionPath = join(opts.workdir, RUNNER_SESSION_FILE);
    const prior = readSession(sessionPath, opts.harness);
    let oldSid = prior?.session_id ?? null;
    let forked = false;
    let exitCode: number | null = null;
    let finalSid = oldSid;
    const post = opts.post ?? postMessage;

    await post(opts.server, opts.token, opts.channel, {
      kind: "status",
      state: "working",
      note: `wake ack: ${ctx.self} builtin ${opts.harness} runner handling seq=${frame.seq}`,
      mentions: [],
    });

    const repoCwd = await ensureRepo(opts, env);
    const cwd = opts.cwd ?? repoCwd ?? opts.workdir;
    const contextFile = writeContextFile(frame, ctx.channel, ctx.self, ctx.recent, ctx.charter ?? null, ctx.projectAgent ?? null, ctx.cliUpgrade ?? null);
    const prompt = readFileSync(contextFile, "utf8");

    let run = await runHarness(opts, prompt, oldSid, cwd, env, frame.seq);
    exitCode = run.result.code;
    if (oldSid && run.result.code !== 0) {
      forked = true;
      run = await runHarness(opts, prompt, null, cwd, env, frame.seq);
      exitCode = run.result.code;
    }

    try {
      unlinkSync(contextFile);
    } catch {
      /* 保留失败的清理不影响唤醒结果 */
    }

    const now = opts.now?.() ?? Date.now();
    if (run.result.code !== 0) {
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(oldSid)} duration_ms=${now - started} exit=${run.result.code}`,
      );
      await postBlocked(
        opts,
        frame,
        `builtin ${opts.harness} runner blocked: exit code ${run.result.code}; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`,
      );
      return;
    }

    finalSid = run.sessionId;
    if (!finalSid) {
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=unknown duration_ms=${now - started} exit=${exitCode ?? 0} missing_session_id=true`,
      );
      await postBlocked(
        opts,
        frame,
        `builtin ${opts.harness} runner blocked: no session id parsed; log: ${join(opts.workdir, RUNNER_LOG_FILE)}`,
      );
      return;
    }

    const wakes = prior && !forked ? prior.wakes + 1 : 1;
    writeSession(sessionPath, {
      harness: opts.harness,
      session_id: finalSid,
      created_at: prior && !forked ? prior.created_at : now,
      last_wake_ts: now,
      wakes,
    });

    const marker = oldSid
      ? forked
        ? `[session reset: ${shortSid(oldSid)} → ${shortSid(finalSid)}]`
        : null
      : `[session start: ${shortSid(finalSid)}]`;
    let body: string;
    try {
      body = finalMessageBody(run.text, marker);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunnerLog(
        opts.workdir,
        `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} attach_error=${JSON.stringify(message)}`,
      );
      await postBlocked(opts, frame, `builtin ${opts.harness} runner blocked: ${message}`);
      return;
    }
    await post(opts.server, opts.token, opts.channel, {
      kind: "message",
      body,
      mentions: [],
      reply_to: frame.seq,
    });

    appendRunnerLog(
      opts.workdir,
      `${new Date(now).toISOString()} seq=${frame.seq} sid=${shortSid(finalSid)} duration_ms=${now - started} exit=${exitCode ?? 0}` +
        (forked ? ` fork=${shortSid(oldSid)}->${shortSid(finalSid)}` : ""),
    );
  };
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function safeSegment(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "agent";
}

function parseProfileRef(input: string | undefined): { owner: string; handle: string } | null {
  if (!input) return null;
  const slash = input.lastIndexOf("/");
  if (slash <= 0 || slash === input.length - 1) return null;
  const owner = input.slice(0, slash);
  const handle = input.slice(slash + 1);
  if (owner.length > 320 || /[\x00-\x1f\x7f]/.test(owner) || !isName(handle)) return null;
  return { owner, handle };
}

export interface PreparedProfileWorkspace {
  runnerWorkdir: string;
  channelWorkdir: string;
}

export interface PrepareProfileWorkspaceOptions {
  profile: ProjectAgentProfile;
  channel: string;
  runGit?: RunnerProcess;
  env?: Record<string, string | undefined>;
}

export async function prepareProfileChannelWorkspace(opts: PrepareProfileWorkspaceOptions): Promise<PreparedProfileWorkspace> {
  const root = join(
    homedir(),
    ".agentparty",
    "project-agents",
    safeSegment(opts.profile.owner_account),
    safeSegment(opts.profile.handle),
  );
  const runnerWorkdir = join(root, "sessions", safeSegment(opts.channel));
  mkdirSync(runnerWorkdir, { recursive: true });
  const runGit = opts.runGit ?? defaultRunnerProcess;
  const env = opts.env ?? process.env;

  if (opts.profile.worktree_strategy !== "branch") {
    const channelWorkdir =
      opts.profile.worktree_strategy === "shared" && opts.profile.workdir
        ? expandHomePath(opts.profile.workdir)
        : runnerWorkdir;
    mkdirSync(channelWorkdir, { recursive: true });
    return { runnerWorkdir, channelWorkdir };
  }

  const baseDir = opts.profile.workdir ? expandHomePath(opts.profile.workdir) : join(root, "source");
  if (!existsSync(baseDir)) {
    if (!opts.profile.repo_url) {
      mkdirSync(baseDir, { recursive: true });
    } else {
      mkdirSync(join(root, "source-parent"), { recursive: true });
      const clone = await runGit(["git", "clone", opts.profile.repo_url, baseDir], { cwd: root, env });
      if (clone.code !== 0) {
        throw new Error(`git clone failed for project agent profile: ${clone.stderr || clone.stdout}`);
      }
    }
  }

  const worktreeDir = join(root, "worktrees", safeSegment(opts.channel));
  if (!existsSync(worktreeDir) && existsSync(join(baseDir, ".git"))) {
    mkdirSync(join(root, "worktrees"), { recursive: true });
    const branch = `agentparty/${safeSegment(opts.profile.handle)}/${safeSegment(opts.channel)}`;
    const added = await runGit(["git", "-C", baseDir, "worktree", "add", "-B", branch, worktreeDir, opts.profile.base_branch], {
      cwd: root,
      env,
    });
    if (added.code !== 0) {
      throw new Error(`git worktree add failed for #${opts.channel}: ${added.stderr || added.stdout}`);
    }
  } else if (!existsSync(worktreeDir)) {
    mkdirSync(worktreeDir, { recursive: true });
  }
  return { runnerWorkdir, channelWorkdir: worktreeDir };
}

export interface ProfileServeOptions {
  server: string;
  humanToken: string;
  ownerAccount: string;
  handle: string;
  mentionsOnly: boolean;
  once?: boolean;
  pollIntervalMs?: number;
  out?: (line: string) => void;
  runGit?: RunnerProcess;
  mintRuntime?: typeof mintProjectAgentRuntimeToken;
  listInvites?: typeof listProjectAgentInvites;
  ensureChannelRuntime?: typeof ensureProjectAgentChannelRuntime;
  runChannelServe?: (opts: ServeOptions) => Promise<number>;
  post?: typeof postMessage;
  sleep?: (ms: number) => Promise<void>;
}

function profileContext(profile: ProjectAgentProfile, prepared: PreparedProfileWorkspace): ProjectAgentRunContext {
  return {
    owner_account: profile.owner_account,
    handle: profile.handle,
    name: profile.name,
    runner: profile.runner,
    repo_url: profile.repo_url,
    workdir: profile.workdir,
    base_branch: profile.base_branch,
    worktree_strategy: profile.worktree_strategy,
    rules: profile.rules,
    channel_workdir: prepared.channelWorkdir,
    runner_workdir: prepared.runnerWorkdir,
  };
}

function checksum(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function projectAgentChildName(handle: string, channel: string): string {
  const cleanHandle = safeSegment(handle).replace(/^[^A-Za-z0-9]+/, "") || "agent";
  const cleanChannel = safeSegment(channel).replace(/^[^A-Za-z0-9]+/, "") || "channel";
  const suffix = checksum(`${handle}/${channel}`);
  return `${cleanHandle.slice(0, 24)}-${cleanChannel.slice(0, 24)}-${suffix}`.slice(0, 64);
}

function profileReadyNote(profile: ProjectAgentProfile, channel: string, prepared: PreparedProfileWorkspace): string {
  const project = profile.repo_url ?? profile.workdir ?? "local";
  return `front agent ready: ${profile.owner_account}/${profile.handle} channel=#${channel} team=${profile.handle} project=${project} base=${profile.base_branch} worktree=${profile.worktree_strategy} cwd=${prepared.channelWorkdir}`;
}

export async function runProfileServe(opts: ProfileServeOptions): Promise<number> {
  const out = opts.out ?? ((line: string) => console.error(line));
  const mintRuntime = opts.mintRuntime ?? mintProjectAgentRuntimeToken;
  const listInvites = opts.listInvites ?? listProjectAgentInvites;
  const ensureChannelRuntime = opts.ensureChannelRuntime ?? ensureProjectAgentChannelRuntime;
  const runChannelServe = opts.runChannelServe ?? runServe;
  const post = opts.post ?? postMessage;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const runtime = await mintRuntime(opts.server, opts.humanToken, opts.handle);
  const profile = runtime.profile;
  if (profile.owner_account !== opts.ownerAccount || profile.handle !== opts.handle) {
    throw new Error(`profile token mismatch: requested ${opts.ownerAccount}/${opts.handle}, got ${profile.owner_account}/${profile.handle}`);
  }
  const running = new Map<string, Promise<number>>();
  out(`serving project agent ${profile.owner_account}/${profile.handle} — runner=${profile.runner}`);

  const startInvite = async (invite: ChannelProjectAgentInvite) => {
    const channel = invite.channel_slug;
    if (running.has(channel)) return;
    const prepared = await prepareProfileChannelWorkspace({ profile, channel, runGit: opts.runGit });
    const ctx = profileContext(profile, prepared);
    const child: ProjectAgentChannelRuntime = await ensureChannelRuntime(
      opts.server,
      runtime.token,
      channel,
      profile.owner_account,
      profile.handle,
      projectAgentChildName(profile.handle, channel),
    );
    const serveOpts: ServeOptions = {
      server: opts.server,
      token: child.token,
      channel,
      since: loadCursor(channel),
      sinceRev: loadRevCursor(channel),
      cmd: "",
      mentionsOnly: opts.mentionsOnly,
      onCursor: (c) => saveCursor(channel, c),
      onRevCursor: (r) => saveRevCursor(channel, r),
      projectAgent: ctx,
      advertise: async () => {
        const note = profileReadyNote(profile, channel, prepared);
        await post(opts.server, child.token, channel, {
          kind: "status",
          state: "waiting",
          role: "host",
          note,
          mentions: [],
          residency: "supervised",
          wake: { kind: "serve" },
          context: {
            workspace_label: `${profile.owner_account}/${profile.handle}`,
            worktree_label: `${child.name}:${profile.worktree_strategy}:${profile.base_branch}`,
          },
        });
        await post(opts.server, child.token, channel, {
          kind: "message",
          body: `${profile.name || profile.handle} joined #${channel} as front agent ${child.name}; workers should spawn under team ${profile.handle}. ${note}`,
          mentions: [],
          reply_to: null,
        });
      },
      fetchCharter: () => fetchChannelCharter(opts.server, child.token, channel),
      builtinRunner: profile.runner === "codex" || profile.runner === "claude"
        ? {
            server: opts.server,
            token: child.token,
            channel,
            harness: profile.runner,
            workdir: prepared.runnerWorkdir,
            cwd: prepared.channelWorkdir,
          }
        : undefined,
      sdkRunner: profile.runner === "codex-sdk"
        ? {
            server: opts.server,
            token: child.token,
            channel,
            workdir: prepared.runnerWorkdir,
          }
        : undefined,
    };
    if (profile.runner === "shell") {
      throw new Error("project agent runner shell is not supported by party serve --profile");
    }
    const promise = runChannelServe(serveOpts).finally(() => running.delete(channel));
    running.set(channel, promise);
    out(`attached project agent ${profile.owner_account}/${profile.handle} to #${channel}`);
  };

  for (;;) {
    const invites = await listInvites(opts.server, runtime.token, opts.handle);
    for (const invite of invites) await startInvite(invite);
    if (opts.once) {
      await Promise.all([...running.values()]);
      return 0;
    }
    await sleep(opts.pollIntervalMs ?? 5000);
  }
}

export async function runServe(o: ServeOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.error(line));
  const run = o.runCommand ?? (o.sdkRunner ? createSdkRunner(o.sdkRunner) : o.builtinRunner ? createBuiltinRunner(o.builtinRunner) : defaultRun);
  let upgraded = false;
  let nudgedUpgrade = false;
  const conn = connect(o.server, o.token, o.channel, o.since, {
    onCursor: o.onCursor,
    sinceRev: o.sinceRev,
    onRevCursor: o.onRevCursor,
  });

  let self = "";
  let code = 0;
  let advertised = false;
  let charter: ChannelCharter | null = o.charter ?? null;
  const refreshCharter = async (reason: string, expectedRev?: number) => {
    if (!o.fetchCharter) return;
    if (expectedRev !== undefined && charter !== null && charter.charter_rev >= expectedRev) return;
    try {
      charter = await o.fetchCharter();
    } catch (e) {
      out(`  charter 刷新失败（${reason}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  await refreshCharter("attach");
  // 触发消息之前的最近频道消息（滚动窗口），随 context file 递给 runner
  const recent: MsgFrame[] = [];
  out(
    `serving #${o.channel} — 每条${o.mentionsOnly ? " @你 的" : ""}消息触发一次命令（Ctrl-C 停）`,
  );
  // Heartbeat on a clock, not only on traffic — see watch.ts; a quiet channel
  // must not read as "listener down" on status bars.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (o.statusline === true) {
    heartbeat = setInterval(() => {
      writeStatuslineCache({
        ...localStatuslineBase(o.channel),
        ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
      });
    }, 60_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }
  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        if (o.statusline === true) {
          writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
            unread: unreadFromCursor(frame.last_seq, o.channel),
          });
        }
        if (typeof frame.charter_rev === "number") await refreshCharter("welcome", frame.charter_rev);
        // 挂上即声明可唤醒（best-effort，只做一次；重连再收 welcome 不重复刷）
        if (!advertised) {
          advertised = true;
          try {
            await o.advertise?.();
          } catch (e) {
            out(`  wake 能力声明失败（不影响服务，可稍后手动 party status 声明）: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        continue;
      }
      if (frame.type === "error") {
        console.error(`error: ${frame.code} ${frame.message}`);
        code =
          frame.code === "unauthorized"
            ? EXIT_AUTH
            : frame.code === "archived"
              ? EXIT_ARCHIVED
              : 1;
        break;
      }
      if (
        (frame.type === "msg" || frame.type === "status") &&
        frame.kind === "status" &&
        (frame.note ?? frame.body).startsWith("charter updated to rev ")
      ) {
        const rev = Number((frame.note ?? frame.body).match(/^charter updated to rev (\d+)/)?.[1] ?? "");
        await refreshCharter("status", Number.isInteger(rev) ? rev : undefined);
      }
      if (frame.type !== "msg") continue;
      const fromSelf = frame.sender.name === self;
      // fresh = 游标之上的新消息。历史修订快照会穿透去重被重放（seq 早已消费过），
      // 它们不是新唤醒——不 fresh 就绝不触发 runner（否则旧 @ 被编辑一次，每次重连都重跑一遍）
      const fresh = frame.seq > conn.cursor;
      const qualifies = fresh && !fromSelf && (!o.mentionsOnly || frame.mentions.includes(self));
      if (qualifies) {
        out(`▶ ${formatMsg(frame)}`);
        // 串行：本条命令跑完再消费下一帧（新帧此间缓冲在 FrameQueue），避免并发唤起互相抢
        try {
          const cliUpgrade = upgradeNotice(o.autoUpgrade === true, o.upgradeDeps);
          await run(frame, {
            cmd: o.cmd,
            channel: o.channel,
            self,
            recent: recent.slice(),
            charter,
            projectAgent: o.projectAgent ?? null,
            cliUpgrade,
          });
        } catch (e) {
          out(`  命令失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // 触发消息本身不进 recent（它就是 context 主体）；自己的/未 @ 的都算上下文
      recent.push(frame);
      if (recent.length > RECENT_MAX) recent.shift();
      // 处理（或跳过）后才推进游标，退出时未消费的留给下次补拉
      conn.ack(frame.seq);
      if (o.statusline === true) {
        writeStatuslineCache({
          ...localStatuslineBase(o.channel),
          ...heartbeatPatch("serve", Date.now(), { mentionsOnly: o.mentionsOnly }),
          unread: unreadFromCursor(frame.seq, o.channel),
          last_message: lastMessageFromFrame(frame),
        });
      }

      // 唤醒间隙的安全点：磁盘上的 party 二进制被 install.sh 换新了吗（issue #45）？
      // 此刻上一轮已 ack、游标已落盘、无进行中的 runner——re-exec 干净。--auto-upgrade 直接换，
      // 否则只播一次提示（不刷屏）。dev / 版本未变 → maybeReexecUpgrade 返回 pending=null，无副作用。
      const up = maybeReexecUpgrade(o.autoUpgrade === true, o.upgradeDeps);
      if (up.reexeced) {
        out(`serve: 磁盘已装 party v${up.pending}，已启动新版接管，本进程退出（issue #45）`);
        upgraded = true;
        break;
      }
      if (up.pending && !nudgedUpgrade) {
        nudgedUpgrade = true;
        out(`serve: 磁盘已装 party v${up.pending}（当前跑的是旧版）——重启 serve 或加 --auto-upgrade 以采用`);
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    conn.close();
    if (o.statusline === true) clearStatuslineListener();
  }
  if (upgraded) return EXIT_UPGRADED;
  // 帧流意外结束（既非终局 error 也非用户 Ctrl-C）：常驻 supervisor 语义下这是异常终止。
  // 报机器可读原因 + 非零退出，否则 --on-mention supervisor 会像 watch --follow 一样静默消失（issue #29 同源）。
  if (code === 0) {
    out(`serve exited: stream ended unexpectedly`);
    return EXIT_STREAM_ENDED;
  }
  return code;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["all", "auto-upgrade", "profile-once"] });
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const server = auth.server;
  const token = auth.token;
  const unknown = unknownFlagError(flags, SERVE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "on-mention", "runner", "workdir", "repo", "profile", "profile-poll-interval"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cmd = str(flags["on-mention"]);
  const runner = str(flags.runner);
  const profileRef = parseProfileRef(str(flags.profile));
  if (flags.profile !== undefined && !profileRef) {
    console.error("profile must be <owner>/<handle>");
    return 1;
  }
  if (profileRef) {
    if (cmd || runner || str(flags.channel) || positionals[0]) {
      console.error("party serve --profile cannot be combined with channel, --on-mention, or --runner");
      return 1;
    }
    const sess = readAccount();
    if (!sess) {
      console.error("party serve --profile requires a human login; run party login");
      return 1;
    }
    let account;
    try {
      account = await ensureFreshAccess(sess);
    } catch {
      console.error("party serve --profile requires a fresh human login; run party login");
      return 1;
    }
    const pollFlag = str(flags["profile-poll-interval"]);
    const pollIntervalMs = pollFlag === undefined ? undefined : Number(pollFlag);
    if (pollIntervalMs !== undefined && (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 500)) {
      console.error("--profile-poll-interval must be an integer >= 500 milliseconds");
      return 1;
    }
    return runProfileServe({
      server: account.session.server,
      humanToken: account.token,
      ownerAccount: profileRef.owner,
      handle: profileRef.handle,
      mentionsOnly: flags.all !== true,
      once: flags["profile-once"] === true,
      pollIntervalMs,
    });
  }
  if ((cmd ? 1 : 0) + (runner ? 1 : 0) !== 1) {
    console.error(
      'choose exactly one of --on-mention or --runner.\n' +
        '  自定义：--on-mention "<command>"（{file}=context JSON，正文在 stdin，元信息在 AP_*）。\n' +
        "  内建：--runner codex|claude|codex-sdk（自动隔离 workdir、续接 session、外层发回频道）。",
    );
    return 1;
  }
  if (runner && runner !== "codex" && runner !== "claude" && runner !== "codex-sdk") {
    console.error("--runner must be codex, claude, or codex-sdk");
    return 1;
  }
  const harness = runner === "codex" || runner === "claude" ? runner : undefined;
  const useSdkRunner = runner === "codex-sdk";
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  return runServe({
    server,
    token,
    channel,
    since: loadCursor(channel),
    sinceRev: loadRevCursor(channel),
    cmd: cmd ?? "",
    mentionsOnly: flags.all !== true,
    onCursor: (c) => saveCursor(channel, c),
    onRevCursor: (r) => saveRevCursor(channel, r),
    advertise: () => advertiseServeWake(auth, channel),
    fetchCharter: () => fetchChannelCharter(server, token, channel),
    autoUpgrade: flags["auto-upgrade"] === true,
    statusline: true,
    builtinRunner: harness
      ? {
          server,
          token,
          channel,
          harness,
          workdir: expandHomePath(str(flags.workdir) ?? join(homedir(), ".agentparty", "runners", channel)),
          repo: str(flags.repo),
        }
      : undefined,
    sdkRunner: useSdkRunner
      ? {
          server,
          token,
          channel,
          workdir: expandHomePath(str(flags.workdir) ?? join(homedir(), ".agentparty", "runners", channel)),
        }
      : undefined,
  });
}
