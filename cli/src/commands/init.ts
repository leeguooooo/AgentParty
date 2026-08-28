// party init — 写全局配置 + 绑定当前目录默认频道（不存在则创建）
import { join } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readIdentityRecords, sameChannelIdentityWarningLines } from "../identity-dedupe";
import {
  agentpartyHome,
  bindWorkspaceConfigPointer,
  durableConfigPointerPath,
  explicitConfigPath,
  globalConfigPath,
  readConfig,
  readConfigWithSource,
  readState,
  writeConfig,
  writeState,
  type Config,
} from "../config";
import { stripTerminalControls } from "../format";
import {
  detectHarnessFromAncestry,
  isBindingHarness,
  joinBindingsPath,
  writeJoinBinding,
  type BindingHarness,
} from "../join-binding";
import { RestError, createChannel, fetchChannelCharter, fetchMe, handleRestError, listChannels } from "../rest";
import { channelDecisionSnapshotBodyLines } from "@agentparty/shared/onboarding";
import { statuslineIdentity, writeStatuslineCache } from "../statusline-cache";
import { isSlug, normalizeServerUrl } from "../validation";
import { isWakeLang, normalizeWakeLang } from "../wake-note-i18n";

const INIT_FLAGS = ["server", "token", "channel", "harness", "lang"];
const HELP = `usage: party init --server URL --token T [--channel C] [--harness codex|claude|other]

Write local config and optionally bind this working directory to a default channel.

Options:
  --server URL    AgentParty server URL
  --token T       agent/human/readonly token（会进 argv：ps 与 shell history 可见）
  --token -       从 stdin 读 token（推荐；也可用 AGENTPARTY_TOKEN 环境变量）
  --channel C     bind the current working directory to channel C
  --harness H     which harness is joining (codex | claude | other). Defaults to
                  auto-detection from the process ancestry. Recorded as part of the
                  join-time identity binding so @-mentions can wake THIS harness (#924).
  --coexist       keep any identity this harness already had on this channel instead of
                  replacing it (default is replace — re-joining means "use this one now")
  --lang zh|en    language of wake notes injected into this agent's session (#1003).
                  Omit to auto-detect from the agent's own recent channel messages`;

/**
 * token 输入通道（#111）。
 *
 * argv 是进程的公共表面。实测（macOS）：`ps -axww -o command` 直接读到 `--token ap_…`，
 * 同机任意用户可见；`party init --token <T>` 也原样落进 ~/.zsh_history。
 *
 * 所以补两条不经 argv 的通道：环境变量 AGENTPARTY_TOKEN，和 `--token -`（从 stdin 读）。
 * `--token <T>` 仍然支持——不破坏现有脚本——但会响亮地告诉用户它泄漏到哪里。
 * 优先级：显式 --token > AGENTPARTY_TOKEN > 已有 config。
 */
export interface TokenSources {
  flagToken: string | undefined;
  envToken: string | undefined;
  prevToken: string | undefined;
}
export interface TokenDeps {
  readStdin: () => Promise<string>;
  warn: (line: string) => void;
}

export async function resolveTokenInput(src: TokenSources, deps: TokenDeps): Promise<string | null> {
  if (src.flagToken === "-") {
    const piped = (await deps.readStdin()).trim();
    // 用户明确说了「从 stdin 读」。读不到就是错，不能静默回落到缓存里的旧 token。
    return piped === "" ? null : piped;
  }
  if (src.flagToken !== undefined && src.flagToken !== "") {
    // 绝不在警告里回显 token 本身——否则警告自己就成了第三个泄漏面。
    deps.warn(
      "warning: --token 会把 token 写进 argv：同机任意用户 `ps -axww` 可见，也会落进 shell history。" +
        " 改用 AGENTPARTY_TOKEN 环境变量，或 `--token -` 从 stdin 读。",
    );
    return src.flagToken;
  }
  const env = src.envToken?.trim();
  if (env !== undefined && env !== "") return env;
  return src.prevToken ?? null;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["coexist"] });
  const unknown = unknownFlagError(flags, [...INIT_FLAGS, "coexist"]);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "token", "channel", "harness", "lang"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const prev = readConfig();
  const server = str(flags.server) ?? prev?.server;
  const token = await resolveTokenInput(
    { flagToken: str(flags.token), envToken: process.env.AGENTPARTY_TOKEN, prevToken: prev?.token },
    { readStdin: async () => await Bun.stdin.text(), warn: (line) => console.error(line) },
  );
  if (!server || !token) {
    console.error(
      "need --server and a token. token 可以来自：--token -（stdin，推荐）、AGENTPARTY_TOKEN 环境变量、已有 config，或 --token <T>（会进 ps 与 shell history）",
    );
    return 1;
  }
  const normalizedServer = normalizeServerUrl(server);
  if (normalizedServer === null) {
    console.error("--server must be an http(s) URL without credentials");
    return 1;
  }
  // #1003：唤醒文案语言的显式覆盖。给了就写；没给保留原值；从没设过就不写这个字段（＝自动判定）。
  const langFlag = str(flags.lang);
  const lang = langFlag === undefined ? (isWakeLang(prev?.lang) ? prev.lang : undefined) : normalizeWakeLang(langFlag);
  if (langFlag !== undefined && lang === null) {
    console.error("--lang must be one of: zh, en");
    return 1;
  }
  const cfg: Config = { server: normalizedServer, token, ...(lang === undefined || lang === null ? {} : { lang }) };

  // #924：这次加入是哪个 harness 在跑。显式 --harness 永远优先；没给就从进程祖先链探测
  // （party init 是 harness 的后代进程，这是**事实**不是猜测）；探测不到就 null＝不写绑定。
  const harnessFlag = str(flags.harness);
  if (harnessFlag !== undefined && !isBindingHarness(harnessFlag)) {
    console.error("--harness must be one of: codex, claude, other");
    return 1;
  }
  const harness: BindingHarness | null = harnessFlag !== undefined
    ? harnessFlag
    : detectHarnessFromAncestry(process.ppid);
  const coexist = flags.coexist === true;

  const channel = str(flags.channel) ?? positionals[0];
  if (channel) {
    if (!isSlug(channel)) {
      console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
      return 1;
    }
    try {
      const channels = await listChannels(cfg.server, cfg.token);
      if (!channels.some((c) => c.slug === channel)) {
        try {
          await createChannel(cfg.server, cfg.token, { slug: channel, kind: "standing" });
          console.log(`created channel ${channel}`);
        } catch (e) {
          // 409 = 并发下已被建出来，视为存在
          if (!(e instanceof RestError && e.status === 409)) throw e;
        }
      }
    } catch (e) {
      return handleRestError(e);
    }
    // #907：写配置前先问真正该问的那个问题——「同一台 server、同一个频道下我是不是已经有
    // 身份了？」旧的幂等检查只认注册名，换个名字必然放行，于是同频道静默攒出十几个身份、
    // 每个都是一个常驻 MCP 进程。server 必须参与比较：两台生产实例都有同名频道（#865）。
    // 只提示不阻断：多身份本身合法，要的是让选择变显式。
    for (const line of sameChannelIdentityWarningLines(
      readIdentityRecords(join(agentpartyHome(), "agents")),
      // globalConfigPath() 在设了 AGENTPARTY_CONFIG 时就是那份显式配置＝「我自己」，
      // 排除掉它，否则同一份身份重跑 init 会自己报自己。
      { server: cfg.server, channel, selfPath: globalConfigPath() },
    )) {
      console.error(line);
    }
    writeConfig(cfg);
    const st = readState();
    writeState({ channel, cursor: st?.channel === channel ? st.cursor : 0 });
    // 用了 AGENTPARTY_CONFIG 隔离时，往 cwd-state 记面包屑：被唤醒回复轮丢了 env 也能找回本 agent
    // 的 config，不回落到人类账号会话（issue #42）。同 cwd 多 agent 仍会撞指针——那种要用不同 cwd。
    const explicit = explicitConfigPath();
    if (explicit) bindWorkspaceConfigPointer(durableConfigPointerPath(explicit), channel);
    console.log(`bound channel ${channel}`);
  } else {
    writeConfig(cfg);
  }
  console.log(`config written for ${cfg.server}`);
  const { source } = readConfigWithSource();
  console.log(
    `config: ${source.path ? `${source.kind} ${source.path}` : "none"}${source.token_fingerprint ? ` token=${source.token_fingerprint}` : ""}`,
  );
  try {
    const me = await fetchMe(cfg.server, cfg.token);
    writeConfig({
      ...cfg,
      identity: {
        name: me.name,
        email: me.email,
        kind: me.kind,
        role: me.role,
        owner: me.owner,
        owner_handle: me.owner_handle ?? null,
        owner_display_name: me.owner_display_name ?? null,
        channel_scope: me.channel_scope ?? null,
        verified_at: Date.now(),
      },
    });
    writeStatuslineCache({
      ...(channel ? { channel } : {}),
      server: cfg.server,
      identity: statuslineIdentity(me),
    });
    // #924 加入即绑定：**这一刻**我们确切知道 (harness, server, channel, owner) → identity。
    // 记下来，hook 就不必再从 cwd / 进程树 / 环境变量里反推（反推不出就静默不叫，正是根因）。
    // harness 未知时不写：一条不知道属于谁的绑定，对唤醒毫无用处，只会给后续判定添歧义。
    if (channel && harness !== null && me.name) {
      try {
        const replaced = writeJoinBinding(
          joinBindingsPath(agentpartyHome()),
          {
            harness,
            server: cfg.server,
            channel,
            owner: me.owner ?? null,
            identity: me.name,
            config_path: globalConfigPath(),
            cwd: process.cwd(),
            created_at: Date.now(),
          },
          { replace: !coexist },
        );
        console.log(
          `bound identity ${me.name} to this ${harness} harness on ${channel} @ ${cfg.server}` +
            ` — @-mentions in #${channel} will now wake THIS harness as ${me.name}`,
        );
        // 替换掉了谁必须说出来。静默替换和静默放弃一样坏——用户得知道刚才顶掉了哪个身份。
        for (const old of replaced) {
          console.log(
            `  replaced: ${old.identity} (this same ${harness} harness held it on ${channel} @ ${old.server}` +
              `; its identity config and token are untouched — re-run its join snippet to switch back,` +
              ` or use --coexist next time to keep both)`,
          );
        }
        if (replaced.length > 0) {
          // 绑定换掉了，但那些身份的 MCP 注册还在——每条注册在每个会话里都是一个常驻进程。
          // 收敛是**显式**的一步：治理命令绝不删正在被活进程使用的注册（#923），所以不能替
          // 用户在这里悄悄跑掉它。
          console.log(
            `  their MCP registrations are still there (one resident process each). To retire them:\n` +
              `    party mcp identities --keep ${me.name} --channel ${channel} --server ${cfg.server}` +
              `${harness === "other" ? "" : ` --harness ${harness}`}\n` +
              `  (dry run; add --yes to drop them. Registrations a live session is using are never removed.)`,
          );
        }
      } catch (e) {
        // 绑定写不下去只是退回 #917 的反推兜底，绝不能把接入流程打断。
        console.error(
          `warning: could not record the join-time identity binding: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else if (channel && harness === null) {
      console.error(
        "warning: could not tell which harness is joining, so no join-time identity binding was recorded." +
          " Re-run with --harness codex|claude|other so @-mentions can wake this session (#924).",
      );
    }
    const who = me.email ?? me.name;
    const owner = me.owner ? ` owner=${me.owner}` : "";
    const scope = me.channel_scope ? ` scope=${me.channel_scope}` : "";
    console.log(`runtime: ${who} (${me.kind}/${me.role})${owner}${scope}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`warning: wrote config but could not verify identity: ${message}`);
  }
  if (channel) {
    try {
      const charter = await fetchChannelCharter(cfg.server, cfg.token, channel);
      const decisionLines = channelDecisionSnapshotBodyLines(charter.active_decisions ?? []);
      if (charter.charter || decisionLines.length > 0) {
        console.log(`\n# ${channel} charter rev ${charter.charter_rev}`);
        // #372/#587 同源：charter 远端可控，直出终端前剥控制字节，防转义序列注入/输出伪造。
        if (charter.charter) console.log(stripTerminalControls(charter.charter));
        if (decisionLines.length > 0) {
          if (charter.charter) console.log("");
          for (const line of decisionLines) console.log(line);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`warning: could not fetch channel charter: ${message}`);
    }
  }
  return 0;
}
