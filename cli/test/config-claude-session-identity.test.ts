// #1052 #2：在 Claude 会话里跑 `party` 不必再手写 AGENTPARTY_CONFIG——config 解析沿父进程链认出
// 宿主会话，从注册表条目拿到它绑的 config。这里用真实子进程验证真实的 pid 爬链：
//   bun(party) → sh（中间 shell，模拟 Claude 的 Bash 工具）→ sh（扮演 Claude 本体，持有寻址文件）
// 只看 process.ppid 会停在中间 shell 上（没有寻址文件）——这正是要钉死的错法。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inbox-inject";
import {
  CLAUDE_SESSION_REGISTRY_DIR_ENV,
  registerClaudeSession,
} from "../src/claude-session-registry";
import { workspaceId } from "../src/config";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");
const SESSION_A = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_B = "11111111-1111-4111-8111-bbbbbbbbbbbb";

let home: string;
let registryDir: string;
let nativeDir: string;
let cwd: string;
let rest: ReturnType<typeof Bun.serve>;
let server: string;
const tokens = new Map<string, string>();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-session-identity-home-"));
  registryDir = join(home, "claude-sessions");
  mkdirSync(registryDir, { mode: 0o700 });
  chmodSync(registryDir, 0o700);
  nativeDir = mkdtempSync(join(tmpdir(), "ap-session-identity-native-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-session-identity-cwd-"));
  tokens.clear();
  // 假服务端：按 bearer token 回答 /api/me，whoami 就能在无网络下证明「用的是哪份 config」。
  rest = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      const name = tokens.get(auth.replace(/^Bearer\s+/i, ""));
      if (name === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ name, email: null, kind: "agent", role: "agent", owner: "owner", channel_scope: "dev" });
    },
  });
  server = `http://127.0.0.1:${rest.port}`;
});

afterEach(() => {
  rest.stop(true);
  for (const dir of [home, nativeDir, cwd]) rmSync(dir, { recursive: true, force: true });
});

const env = (): Record<string, string | undefined> => ({
  AGENTPARTY_HOME: home,
  // Claude 给子进程树打的标记；CI 里 bun test 不在 Claude 下跑，得显式给。
  CLAUDECODE: "1",
  [CLAUDE_SESSION_REGISTRY_DIR_ENV]: registryDir,
  [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: nativeDir,
});

function writeAgentConfig(name: string, token: string): string {
  const path = join(home, "agents", `${name}-dev.json`);
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(path, JSON.stringify({ server, token, identity: { name, channel_scope: "dev", owner: "owner" } }), { mode: 0o600 });
  tokens.set(token, name);
  return path;
}

/** 起一个「假 Claude」进程：先睡一会儿让测试写好寻址文件与注册表，再经中间 shell 跑 party。 */
function spawnFakeClaude(args: string, extraEnv: Record<string, string | undefined> = {}) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env(),
    AGENTPARTY_CONFIG: undefined,
    // 本测试钉的是 ps 父进程链；bun test 若在真 Claude 会话下跑，会继承这两个变量（环境变量快路），删掉。
    CLAUDE_CODE_SESSION_ID: undefined,
    CLAUDE_CODE_MESSAGING_SOCKET: undefined,
    ...extraEnv,
  };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const inner = `bun run '${indexPath}' ${args}; :`;
  return Bun.spawn(["sh", "-c", `sleep 0.6; sh -c "${inner.replaceAll('"', '\\"')}"; :`], {
    cwd,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeNativeSession(pid: number, sessionId: string, name: string): void {
  writeFileSync(
    join(nativeDir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, name, messagingSocketPath: join(nativeDir, `${pid}.sock`) }),
    { mode: 0o600 },
  );
}

function registerEntry(pid: number, sessionId: string, identity: string, configPath: string): void {
  expect(registerClaudeSession({
    session_id: sessionId,
    pid,
    display_name: null,
    channel: "dev",
    server,
    identity,
    cwd,
    config_path: configPath,
  }, { [CLAUDE_SESSION_REGISTRY_DIR_ENV]: registryDir })).toBe(true);
}

async function finish(proc: ReturnType<typeof Bun.spawn>) {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  const line = stdout.split("\n").find((l) => l.startsWith("{"));
  return { code, stdout, stderr, json: line === undefined ? null : (JSON.parse(line) as Record<string, any>) };
}

describe("identity auto-detection inside a Claude session (#1052 #2)", () => {
  test("a party command whose ancestor chain contains the Claude pid resolves the per-session config with no env var", async () => {
    // cwd 里放一份 workspace config（另一身份）：注册表那步必须排在「按 cwd 找 workspace」前面。
    const workspacePath = join(home, "state", workspaceId(cwd), "config.json");
    mkdirSync(join(workspacePath, ".."), { recursive: true });
    tokens.set("tok-cwd", "agent-cwd");
    writeFileSync(workspacePath, JSON.stringify({ server, token: "tok-cwd", identity: { name: "agent-cwd", channel_scope: "dev" } }));
    const probe = await finish(spawnFakeClaude("whoami --json"));
    expect(probe.json?.runtime?.name).toBe("agent-cwd");
    expect(probe.json?.config?.resolution).toBe("workspace");

    const configA = writeAgentConfig("agent-a", "tok-a");
    const claude = spawnFakeClaude("whoami --json");
    writeNativeSession(claude.pid, SESSION_A, "agentparty-83");
    registerEntry(claude.pid, SESSION_A, "agent-a", configA);
    const result = await finish(claude);
    expect(result.code).toBe(0);
    expect(result.json?.runtime?.name).toBe("agent-a");
    expect(result.json?.config?.resolution).toBe("claude_session_registry");
    expect(result.json?.config?.path).toBe(configA);
    // 认出的宿主必须是最外层那个 sh（持有寻址文件的假 Claude），不是中间 shell。
    expect(result.json?.config?.claude_session).toEqual({ pid: claude.pid, session_id: SESSION_A });
  }, 20_000);

  test("two sessions in the same cwd resolve to their own configs", async () => {
    const configA = writeAgentConfig("agent-a", "tok-a");
    const configB = writeAgentConfig("agent-b", "tok-b");
    const claudeA = spawnFakeClaude("whoami --json");
    const claudeB = spawnFakeClaude("whoami --json");
    writeNativeSession(claudeA.pid, SESSION_A, "agentparty-83");
    writeNativeSession(claudeB.pid, SESSION_B, "agentparty-84");
    registerEntry(claudeA.pid, SESSION_A, "agent-a", configA);
    registerEntry(claudeB.pid, SESSION_B, "agent-b", configB);
    const [a, b] = await Promise.all([finish(claudeA), finish(claudeB)]);
    expect(a.json?.runtime?.name).toBe("agent-a");
    expect(a.json?.config?.path).toBe(configA);
    expect(b.json?.runtime?.name).toBe("agent-b");
    expect(b.json?.config?.path).toBe(configB);
  }, 20_000);

  test("a stale registry entry (sessionId or pid mismatch) is ignored and resolution falls through", async () => {
    const configA = writeAgentConfig("agent-a", "tok-a");
    // 寻址文件说这个 pid 现在是会话 B；注册表里 B 没条目、A 的条目记的是同一 pid → 绝不采用 A。
    const claude = spawnFakeClaude("whoami --json");
    writeNativeSession(claude.pid, SESSION_B, "agentparty-83");
    registerEntry(claude.pid, SESSION_A, "agent-a", configA);
    const result = await finish(claude);
    expect(result.json?.config?.resolution).not.toBe("claude_session_registry");
    expect(result.json?.runtime?.name ?? null).not.toBe("agent-a");

    // pid 对不上（条目记的是另一个活着的 pid——这里用 bun test 自己）同样不认。
    const other = spawnFakeClaude("whoami --json");
    writeNativeSession(other.pid, SESSION_B, "agentparty-84");
    registerEntry(process.pid, SESSION_B, "agent-a", configA);
    const second = await finish(other);
    expect(second.json?.config?.resolution).not.toBe("claude_session_registry");

    // config 内容被同目录后来者覆盖成另一身份：identity 与条目不符 → 不认。
    const swapped = spawnFakeClaude("whoami --json");
    writeNativeSession(swapped.pid, SESSION_A, "agentparty-85");
    registerEntry(swapped.pid, SESSION_A, "agent-a", configA);
    tokens.set("tok-b", "agent-b");
    writeFileSync(configA, JSON.stringify({ server, token: "tok-b", identity: { name: "agent-b", channel_scope: "dev" } }));
    const third = await finish(swapped);
    expect(third.json?.config?.resolution).not.toBe("claude_session_registry");
  }, 30_000);

  test("explicit AGENTPARTY_CONFIG still wins over the registry", async () => {
    const configA = writeAgentConfig("agent-a", "tok-a");
    const configExplicit = writeAgentConfig("agent-explicit", "tok-explicit");
    const claude = spawnFakeClaude("whoami --json", { AGENTPARTY_CONFIG: configExplicit });
    writeNativeSession(claude.pid, SESSION_A, "agentparty-83");
    registerEntry(claude.pid, SESSION_A, "agent-a", configA);
    const result = await finish(claude);
    expect(result.json?.runtime?.name).toBe("agent-explicit");
    expect(result.json?.config?.resolution).toBe("explicit_env");
    expect(result.json?.config?.path).toBe(configExplicit);
  }, 20_000);

  test("whoami prints the resolution step for humans", async () => {
    const configA = writeAgentConfig("agent-a", "tok-a");
    const claude = spawnFakeClaude("whoami");
    writeNativeSession(claude.pid, SESSION_A, "agentparty-83");
    registerEntry(claude.pid, SESSION_A, "agent-a", configA);
    const result = await finish(claude);
    expect(result.stdout).toContain("runtime: logged in as agent-a");
    expect(result.stdout).toContain(`config-resolved-by: claude session registry (claude pid ${claude.pid}, session ${SESSION_A})`);
  }, 20_000);
});
