// party recover <chan> —— 恢复 / 重连引导（issue #991，epic #987）。
//
// 重启机器、重开会话之后，@ 你没反应。从前的修法是「翻出上次那条带 token 的 party join 长命令再跑一遍」——
// 没人记得住，而且那条命令的 token 往往已经不在剪贴板里。这个命令把「找回身份」做成第 1 步：
//
//   第 1 步  找回身份 · 本目录在 #ludo 绑的是 server（claude 档）· token 有效 ✓
//   第 2 步  版本 · CLI 0.2.216 · claude 插件 0.2.216 版本与 CLI 一致 ✓
//   第 3 步  起一个可唤醒的会话 · 本机没有会接 @ 的 Claude 会话 ✗
//            修法（做完重跑同一条 party recover ludo）：
//              party claude ludo
//
// 设计约束：
//  - **与 party join 共用步骤机和步骤实现**：第 2/3/4 步就是 join 的第 0/3/4 步（versionStep /
//    wakeableSessionStep / verifyStep，从 join.ts 导出），这里一行都不复制。只有第 1 步是本命令自己的。
//  - **身份从盘上找回，不从人手里要**：join-bindings.json 记的是 (harness, server, channel, owner) → identity
//    + config 路径（#924 加入即绑定）；token 只在 config 文件里，绝不进 argv / 日志（#676）。
//  - **token 有效与否要真问服务端**：本地有 config 不等于还能用——token 被 owner 撤了、身份被改名了，
//    只有 /api/me 知道。401/403 ⇒ 停在第 1 步，说清是 token 失效，修法是走 party join（带占位 token）。
//  - **没绑定不猜**：本机该频道没有绑定就是没接入过（或绑定文件丢了），修法只有一条：party join。
//  - **不交互**：recover 没有要问人的步骤；--yes 只为与 join 同形（接入包/技能表照抄不用改）。
import { readFileSync } from "node:fs";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { agentpartyHome } from "../config";
import { detectHarnessFromAncestry, joinBindingsPath, readJoinBindings, type BindingHarness, type JoinBinding } from "../join-binding";
import { type JoinPackHarness, mcpServerName } from "@agentparty/shared/onboarding";
import { RestError, fetchMe, type Identity } from "../rest";
import { isSlug } from "../validation";
import { runSteps, type Step } from "../onboarding/steps";
import { processStyle } from "../onboarding/color";
import { completionLine, defaultJoinDeps, verifyStep, versionStep, wakeableSessionStep, type JoinCtx, type JoinDeps } from "./join";

const RECOVER_FLAGS = ["harness"];
const HELP = `usage: party recover <channel> [--harness codex|claude|other] [--yes] [--verbose]

Recover / reconnect an identity this machine already joined (#991) — no need to remember
the original \`party join\` line or its token. Guided steps, same engine as \`party join\`:
  第 1 步 找回身份   the identity this directory bound to <channel> (~/.agentparty/join-bindings.json
                    + its config); asks the server (/api/me) whether the token still works and
                    whether the name was changed
  第 2 步 版本       = join 第 0 步: CLI version; claude plugin installed + aligned (#961/#985)
  第 3 步 起一个可唤醒的会话  = join 第 3 步: claude prints the exact \`party claude\` launch and probes
                    for an armed listener; codex brings up the wake layer and probes it
  第 4 步 真发一条 @ 验证     = join 第 4 步: one \`[wake-verify]\` @ to yourself, wait for the receipt
The first failing step prints exactly one fix command and recover stops there (exit 1).
No binding / revoked token / renamed identity ⇒ stops at 第 1 步 with the \`party join\` line to run
(token as an AGENTPARTY_TOKEN='<T>' placeholder — it is never read from disk into argv).

Options:
  --harness H    pick the binding of this harness when this directory bound the channel under
                 several (codex | claude | other). Omit to auto-detect from the process tree.
  --yes          accepted for symmetry with \`party join\`; recover never prompts`;

/** 注入点：join 的那一套（步骤 2/3/4 的探活）+ 第 1 步自己的三样。 */
export interface RecoverDeps extends JoinDeps {
  /** 绑定文件路径（缺省 ~/.agentparty/join-bindings.json）。 */
  bindingsPath: string;
  /** 「本目录」——绑定里记的 cwd 与它相同的优先。 */
  cwd: string;
  /** 核 token / 名字：缺省真打 /api/me。 */
  fetchMe: (server: string, token: string) => Promise<Identity>;
  /** 进程祖先链探出的 harness（缺省 detectHarnessFromAncestry）；探不出 null。 */
  detectHarness: () => BindingHarness | null;
}

export interface RecoverOptions {
  channel: string;
  harnessFlag: JoinPackHarness | null;
  yes: boolean;
  /** #1073：印出过了的步骤里的每一条子检查；缺省只印异常的那些。 */
  verbose?: boolean;
}

/** 第 1 步找回的结果，第 2～4 步靠它组 ctx。 */
export interface RecoveredBinding {
  binding: JoinBinding;
  config: { server: string; token: string; identityName: string | null };
}

/**
 * 修法里的那条 party join（#992 形态：一句话 + 一条命令）。token 用 `'<T>'` 占位——绝不把盘上的
 * token 打进终端 / 日志（#676）；失效的 token 也没有意义，要找 owner 重新拿。
 */
export function joinCommandHint(input: { server: string | null; channel: string; agentName: string | null; harness: BindingHarness | null }): string {
  const parts = [
    "AGENTPARTY_TOKEN='<T>' party join",
    `--server ${input.server ?? "<URL>"}`,
    `--channel ${input.channel}`,
    `--as ${input.agentName ?? "<name>"}`,
    ...(input.harness !== null && input.harness !== "other" ? [`--harness ${input.harness}`] : []),
    "--yes",
  ];
  return parts.join(" ");
}

/**
 * 在本机该频道的绑定里挑出「本目录的那条」。
 * 排序：--harness 是事实（先过滤）；cwd 相同的优先；再看探测出的 harness；最后按最近加入。
 * 返回 null ＝ 本机没有该频道的绑定。
 */
export function pickBinding(
  bindings: readonly JoinBinding[],
  input: { channel: string; cwd: string; harnessFlag: BindingHarness | null; detected: BindingHarness | null },
): { chosen: JoinBinding; candidates: number } | null {
  const pool = bindings.filter((b) => b.channel === input.channel && (input.harnessFlag === null || b.harness === input.harnessFlag));
  if (pool.length === 0) return null;
  const score = (b: JoinBinding): number =>
    (b.cwd !== "" && b.cwd === input.cwd ? 2 : 0) + (input.detected !== null && b.harness === input.detected ? 1 : 0);
  const sorted = [...pool].sort((l, r) => score(r) - score(l) || r.created_at - l.created_at || l.identity.localeCompare(r.identity));
  return { chosen: sorted[0]!, candidates: pool.length };
}

/** 读绑定指向的 config：只要 server/token/identity.name 三样。读不到 / 缺 token ⇒ null。 */
function readBindingConfig(path: string): RecoveredBinding["config"] | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const c = parsed as { server?: unknown; token?: unknown; identity?: { name?: unknown } | null };
    if (typeof c.server !== "string" || c.server === "" || typeof c.token !== "string" || c.token === "") return null;
    const identityName = typeof c.identity?.name === "string" && c.identity.name !== "" ? c.identity.name : null;
    return { server: c.server, token: c.token, identityName };
  } catch {
    return null;
  }
}

interface RecoverCtx extends JoinCtx {
  recoverDeps: RecoverDeps;
  recovered: RecoveredBinding | null;
}

/**
 * 第 1 步 找回身份：绑定 → config → /api/me。三处任一断了都停在这一步，修法都是走 party join——
 * 但摘要必须说清断在哪（没绑定 / config 没了 / token 失效 / 名字被改），别让人再去猜。
 */
export function recoverIdentityStep(rerun: string): Step<RecoverCtx> {
  return {
    id: "recover_identity",
    title: "找回身份",
    async run(ctx) {
      const { recoverDeps: deps, slug, opts } = ctx;
      const detected = deps.detectHarness();
      const bindings = readJoinBindings(deps.bindingsPath);
      const picked = pickBinding(bindings, { channel: slug, cwd: deps.cwd, harnessFlag: opts.harnessFlag, detected });
      if (picked === null) {
        const harness = opts.harnessFlag ?? detected;
        const scope = opts.harnessFlag === null ? "" : `（${opts.harnessFlag} 档）`;
        return {
          ok: false,
          summary: `本机没有 #${slug} 的身份绑定${scope}——这台机器没接入过这个频道（或 ${deps.bindingsPath} 丢了）`,
          fix: {
            do: joinCommandHint({ server: null, channel: slug, agentName: null, harness }),
            notes: ["recover 只能找回接入过的身份；第一次接入（或绑定文件丢了）要走 party join，token 找邀请人 / owner 拿。"],
          },
        };
      }
      const { chosen, candidates } = picked;
      const detail: string[] = [`绑定：${chosen.harness} 档 · ${chosen.server} · config ${chosen.config_path}`];
      if (candidates > 1) {
        detail.push(`本机 #${slug} 有 ${candidates} 条绑定，选了${chosen.cwd === deps.cwd ? "本目录（cwd 相同）" : "最近加入"}的这条；不对就带 --harness 指定`);
      }
      const config = readBindingConfig(chosen.config_path);
      if (config === null) {
        return {
          ok: false,
          summary: `绑定指向的 config 读不到 token：${chosen.config_path}（文件没了或被改坏）`,
          detail,
          fix: {
            do: joinCommandHint({ server: chosen.server, channel: slug, agentName: chosen.identity, harness: chosen.harness }),
            notes: ["config 是 token 的唯一载体；它丢了只能重新接入（token 找 owner 重铸或重发）。"],
          },
        };
      }
      // 真问服务端：本地有 config 不等于还能用。绝不因为「探不到」就假定有效。
      let me: Identity;
      try {
        me = await deps.fetchMe(config.server, config.token);
      } catch (e) {
        if (e instanceof RestError && (e.status === 401 || e.status === 403)) {
          return {
            ok: false,
            summary: `#${slug} 上 ${chosen.identity} 的 token 已失效（服务端 ${e.status}）——被撤销或已过期`,
            detail,
            fix: {
              do: joinCommandHint({ server: config.server, channel: slug, agentName: chosen.identity, harness: chosen.harness }),
              notes: [`盘上那个 token 不能再用；找 owner 重铸 ${chosen.identity} 的 token（party token create / 邀请页），填进 AGENTPARTY_TOKEN 再接入。`],
            },
          };
        }
        const why = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          summary: `核不了 token：${config.server} 不可达（${why}）`,
          detail,
          fix: { do: `确认 ${config.server} 能访问（网络 / VPN / 服务端在线），然后重跑 ${rerun}` },
        };
      }
      const expected = config.identityName ?? chosen.identity;
      if (me.name !== expected) {
        return {
          ok: false,
          summary: `token 有效，但服务端上这个身份现在叫 ${me.name}（本机记的是 ${expected}）——名字被改过`,
          detail,
          fix: {
            do: joinCommandHint({ server: config.server, channel: slug, agentName: me.name, harness: chosen.harness }),
            notes: ["config / rules / MCP 注册名都按旧名字落的盘，@ 新名字不会唤醒它；用新名字重新接入一次即可（token 不用换）。"],
          },
        };
      }
      ctx.recovered = { binding: chosen, config };
      ctx.identity = me.name;
      ctx.agentName = me.name;
      ctx.configPath = chosen.config_path;
      ctx.mcpName = mcpServerName(me.name);
      ctx.harness = chosen.harness;
      // 后面几步（探活 / 验证）都从 readConfig() 拿 server/token——把它指到这份 config。
      process.env.AGENTPARTY_CONFIG = chosen.config_path;
      return { ok: true, summary: `本目录在 #${slug} 绑的是 ${me.name}（${chosen.harness} 档）· token 有效`, detail };
    },
  };
}

// ── orchestrator ────────────────────────────────────────────────────────────
export async function runRecover(opts: RecoverOptions, deps: RecoverDeps): Promise<number> {
  const slug = opts.channel;
  const rerun = `party recover ${slug}`;
  deps.log(`party recover → #${slug}（找回本目录绑的身份，再把它重新接上）`);

  const ctx: RecoverCtx = {
    opts: { server: "", channel: slug, agentName: "", harnessFlag: opts.harnessFlag, mention: null, yes: opts.yes, coexist: false, token: "" },
    deps,
    recoverDeps: deps,
    recovered: null,
    // 第 1 步找回后覆盖；在那之前它们都是占位。
    harness: opts.harnessFlag ?? "other",
    slug,
    agentName: "",
    configPath: "",
    rulesPath: "",
    mcpName: "",
    claudePluginRestart: false,
    identity: null,
    receiveMode: "interactive",
    // #989：recover 没有第 2 步「问到了人」，第 3 步按非交互走（印命令 + 探活 + 停），与 join --yes 一致；
    // 不问「另开终端 / 在这个终端起」，也就不会把「起会话」记成待办。
    interactive: false,
    listener: null,
    launchAfterJoin: false,
  };
  // 第 2 步是 join 的第 0 步，第 3/4 步是 join 的第 3/4 步——同一份实现，只换 rerun 文案。
  const steps: Step<RecoverCtx>[] = [recoverIdentityStep(rerun), versionStep(rerun), ...harnessGatedWakeSteps()];
  // 与 join 同一套呈现：着色 + 过了的步骤只印异常子项（#1073）。
  const style = processStyle();
  const outcome = await runSteps({ steps, ctx, log: deps.log, rerun, firstIndex: 1, style, verbose: opts.verbose === true });
  deps.log("");
  if (outcome.ok) {
    deps.log(completionLine(ctx, "恢复完成"));
    return 0;
  }
  deps.log(style.bad(`恢复停在第 ${outcome.stoppedAt.index} 步（${outcome.stoppedAt.title}）——做完上面那一条，重跑同一条 ${rerun}。`));
  deps.log("在这一步完成之前：@ 你可能不会有任何反应，而且不会有任何报错——别人只会以为你在忙。");
  return 1;
}

/**
 * 第 3/4 步只对有唤醒层的 harness 有意义。harness 要到第 1 步跑完才知道（从绑定里找回），
 * 所以这里包一层：other 档两步各自直接过、只印一句说明（不假装有会话）；其余原样交给 join 的实现。
 */
function harnessGatedWakeSteps(): Step<RecoverCtx>[] {
  const wake = wakeableSessionStep();
  const verify = verifyStep();
  return [
    {
      id: wake.id,
      title: wake.title,
      run: (c) => (c.harness === "other"
        ? { ok: true, summary: `harness 是 other，没有唤醒层可起（收消息用 party watch ${c.slug} / party serve ${c.slug}）` }
        : wake.run(c)),
    },
    {
      id: verify.id,
      title: verify.title,
      run: (c) => (c.harness === "other" ? { ok: true, summary: "harness 是 other，没有可验证的唤醒层" } : verify.run(c)),
    },
  ];
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { flags, positionals } = parseArgs(argv, { booleans: ["yes", "verbose"] });
  const unknown = unknownFlagError(flags, [...RECOVER_FLAGS, "yes", "verbose"]);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, RECOVER_FLAGS);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const slug = positionals[0];
  if (slug === undefined || positionals.length > 1) {
    console.error("need exactly one channel, e.g. party recover ludo. See: party recover --help");
    return 1;
  }
  if (!isSlug(slug)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const harnessFlagRaw = str(flags.harness);
  if (harnessFlagRaw !== undefined && !["codex", "claude", "other"].includes(harnessFlagRaw)) {
    console.error("--harness must be one of: codex, claude, other");
    return 1;
  }
  const harnessFlag = (harnessFlagRaw ?? null) as JoinPackHarness | null;
  return runRecover({ channel: slug, harnessFlag, yes: flags.yes === true, verbose: flags.verbose === true }, defaultRecoverDeps(slug));
}

export function defaultRecoverDeps(slug: string): RecoverDeps {
  return {
    ...defaultJoinDeps(slug),
    bindingsPath: joinBindingsPath(agentpartyHome()),
    cwd: process.cwd(),
    fetchMe: (server, token) => fetchMe(server, token),
    detectHarness: () => detectHarnessFromAncestry(process.ppid),
  };
}
