// party up — 入门三道门（token → init 绑频道 → serve 常驻）收敛成一条幂等命令（#837）。
// 已就绪的环节跳过、缺的环节补上：可当健康自愈命令反复跑。
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import {
  agentpartyHome,
  durableConfigPointerPath,
  explicitConfigPath,
  readConfig,
  readState,
} from "../config";
import { buildHealthReport } from "./health";
import { readHealthCache } from "../health-cache";
import { isPartyBinaryPath } from "../upgrade";
import { isSlug, normalizeServerUrl } from "../validation";

const UP_FLAGS = ["server", "channel", "runner"];
const RUNNERS = ["claude", "codex", "codex-sdk"] as const;
type UpRunner = (typeof RUNNERS)[number];
// 与 health.ts 一致：> 2x WS 心跳周期
const STALE_AFTER_MS = 90_000;

const HELP = `usage: party up [channel-url-or-invite-url-or-slug] [--server URL] [--channel C] [--runner claude|codex|codex-sdk]

One idempotent command: token → bind channel (party init) → resident serve runner.
Each step is checked first and only fixed when missing — safe to re-run as a health self-heal.

Accepts a join/invite URL like https://host/c/<slug>?t=<token>, or a bare channel slug.
Token sources (in order): URL ?t= → AGENTPARTY_TOKEN env → existing config.

Steps:
  auth   no usable token → explain how to get one (invite pack / AGENTPARTY_TOKEN)
  bind   config/channel missing or changed → equivalent of party init
  serve  runner not healthy → spawn \`party serve <channel> --runner <r> --replay-backlog\`
         (--replay-backlog drains the offline @-backlog immediately; standby is serve,
          never watch --once)`;

// ── 纯逻辑（单测覆盖）─────────────────────────────────────────

export interface UpTarget {
  server: string | null;
  channel: string | null;
  token: string | null;
}

/** 解析位置参数：频道/邀请 URL（https://host/c/slug?t=token）或裸 slug。 */
export function parseUpTarget(arg: string | undefined): UpTarget | { error: string } {
  if (arg === undefined || arg === "") return { server: null, channel: null, token: null };
  if (/^https?:\/\//i.test(arg)) {
    let url: URL;
    try {
      url = new URL(arg);
    } catch {
      return { error: `无法解析 URL：${arg}` };
    }
    const m = url.pathname.match(/^\/c\/([a-z0-9][a-z0-9-]{0,63})\/?$/);
    if (!m) return { error: `URL 不是频道链接（期望 /c/<slug>）：${arg}` };
    const server = normalizeServerUrl(url.origin);
    if (server === null) return { error: `URL 的 server 部分不合法：${arg}` };
    const t = url.searchParams.get("t");
    return { server, channel: m[1]!, token: t !== null && t !== "" ? t : null };
  }
  if (isSlug(arg)) return { server: null, channel: arg, token: null };
  return { error: `既不是频道 URL 也不是合法 slug：${arg}` };
}

export type UpStep = "auth" | "bind" | "serve";

export interface UpState {
  hasToken: boolean;
  needBind: boolean;
  runnerHealthy: boolean;
}

/** 幂等分支判定：只列出缺的环节。全就绪 → []。 */
export function planUp(s: UpState): UpStep[] {
  const steps: UpStep[] = [];
  if (!s.hasToken) steps.push("auth");
  if (s.needBind) steps.push("bind");
  if (!s.runnerHealthy) steps.push("serve");
  return steps;
}

export interface BindInputs {
  cfgServer: string | undefined;
  cfgToken: string | undefined;
  boundChannel: string | undefined;
  server: string;
  token: string;
  channel: string;
}

/** config/state 与目标一致才算已绑定；token/server/channel 任一漂移都要重新 init。 */
export function needsBind(i: BindInputs): boolean {
  return i.cfgServer !== i.server || i.cfgToken !== i.token || i.boundChannel !== i.channel;
}

// ── 副作用注入（单测里 mock，绝不真起 daemon）──────────────────

export interface UpDeps {
  readHealth: (channel: string) => { healthy: boolean; pid?: number };
  runInit: (argv: string[]) => Promise<number>;
  spawnServe: (channel: string, runner: UpRunner) => number | null;
}

function defaultSpawnServe(channel: string, runner: UpRunner): number | null {
  // 编译版二进制：execPath 即 party；dev（bun run）：execPath 是 bun，argv[1] 是入口脚本。
  const self =
    isPartyBinaryPath(process.execPath) || process.argv[1] === undefined
      ? [process.execPath]
      : [process.execPath, process.argv[1]];
  const logDir = join(agentpartyHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  // 日志落盘而非 ignore：serve 起不来时（token 失效/端口占用）还有现场可查。
  const log = openSync(join(logDir, `up-serve-${channel}.log`), "a");
  try {
    const proc = Bun.spawn(
      // --replay-backlog：挂上即逐条排空离线积压的 @（cursor-handover 教训：待命用 serve，接管先排空）。
      [...self, "serve", channel, "--runner", runner, "--replay-backlog"],
      { cwd: process.cwd(), stdin: "ignore", stdout: log, stderr: log },
    );
    proc.unref();
    return proc.pid;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: UpDeps = {
  readHealth: (channel) => {
    const r = buildHealthReport(readHealthCache(process.cwd(), channel), { channel, staleAfterMs: STALE_AFTER_MS });
    return { healthy: r.healthy, pid: r.pid };
  },
  runInit: async (argv) => (await import("./init")).run(argv),
  spawnServe: defaultSpawnServe,
};

// ── 命令入口 ────────────────────────────────────────────────

export async function run(argv: string[], deps: UpDeps = DEFAULT_DEPS): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, UP_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "channel", "runner"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const runner = (str(flags.runner) ?? "claude") as UpRunner;
  if (!RUNNERS.includes(runner)) {
    console.error(`--runner must be one of: ${RUNNERS.join(", ")}`);
    return 1;
  }
  const target = parseUpTarget(positionals[0]);
  if ("error" in target) {
    console.error(target.error);
    return 1;
  }

  const cfg = readConfig();
  const st = readState();

  // token：URL ?t= → 环境变量 → 已有 config。都没有 = auth 环节缺失且本命令无法代办。
  const envToken = process.env.AGENTPARTY_TOKEN?.trim();
  const token = target.token ?? (envToken !== undefined && envToken !== "" ? envToken : undefined) ?? cfg?.token;
  if (token === undefined || token === "") {
    console.error(
      "没有可用 token（auth 环节缺失）。三种拿法：\n" +
        "  1) 让邀请人发 join/invite URL：party up 'https://<server>/c/<slug>?t=<token>'\n" +
        "  2) 拿到 token 后：AGENTPARTY_TOKEN='<token>' party up <slug>\n" +
        "  3) 人类账号：party login --server <URL> 走浏览器登录",
    );
    return 1;
  }
  const rawServer = str(flags.server) ?? target.server ?? cfg?.server;
  if (rawServer === undefined) {
    console.error("不知道 server：传频道 URL、--server，或先 party init");
    return 1;
  }
  const server = normalizeServerUrl(rawServer);
  if (server === null) {
    console.error("server 必须是不带凭据的 http(s) URL");
    return 1;
  }
  const flagChannel = str(flags.channel);
  if (flagChannel !== undefined && !isSlug(flagChannel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const channel = flagChannel ?? target.channel ?? st?.channel ?? cfg?.identity?.channel_scope ?? undefined;
  if (channel === undefined || channel === null) {
    console.error("不知道要加入哪个频道：传频道 URL、slug 或 --channel");
    return 1;
  }

  // TMPDIR 防线（tmpdir-token-loss）：显式 config 落在临时目录时，指出持久镜像路径。
  // writeConfig 本身已自动镜像到 ~/.agentparty/agents/，这里把暗坑说出声。
  const explicit = explicitConfigPath();
  if (explicit !== null) {
    const durable = durableConfigPointerPath(explicit);
    if (durable !== explicit) {
      console.error(
        `warning: AGENTPARTY_CONFIG 指向临时目录（会被系统清掉）。已同步持久镜像：${durable}\n` +
          `  建议改用：export AGENTPARTY_CONFIG="${durable}"`,
      );
    }
  }

  const health = deps.readHealth(channel);
  const steps = planUp({
    hasToken: true,
    needBind: needsBind({
      cfgServer: cfg?.server,
      cfgToken: cfg?.token,
      boundChannel: st?.channel,
      server,
      token,
      channel,
    }),
    runnerHealthy: health.healthy,
  });

  if (steps.includes("bind")) {
    console.log(`up: 绑定频道 #${channel}（等价 party init）`);
    // token 走环境变量递给 init，不进 argv/ps。
    const prevEnv = process.env.AGENTPARTY_TOKEN;
    process.env.AGENTPARTY_TOKEN = token;
    try {
      const code = await deps.runInit(["--server", server, "--channel", channel]);
      if (code !== 0) return code;
    } finally {
      if (prevEnv === undefined) delete process.env.AGENTPARTY_TOKEN;
      else process.env.AGENTPARTY_TOKEN = prevEnv;
    }
  } else {
    console.log(`up: config 已就绪（#${channel} @ ${server}）`);
  }

  let pid: number | undefined;
  if (steps.includes("serve")) {
    const spawned = deps.spawnServe(channel, runner);
    if (spawned === null) {
      console.error("up: serve runner 拉起失败——手动跑：party serve " + channel + ` --runner ${runner} --replay-backlog`);
      return 1;
    }
    pid = spawned;
    console.log(`up: serve runner 已拉起（--runner ${runner} --replay-backlog，积压 @ 会被逐条排空）`);
  } else {
    pid = health.pid;
    console.log("up: serve runner 已在线，跳过");
  }

  const name = readConfig()?.identity?.name ?? cfg?.identity?.name ?? "(unverified)";
  console.log(`you are ${name} in ${channel}, reachable via serve (pid ${pid ?? "?"})`);
  console.log(`别人怎么找到你：party who ${channel} 里的 ${name}，@${name} 即可唤醒`);
  return 0;
}
