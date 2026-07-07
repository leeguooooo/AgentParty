// party init — 写全局配置 + 绑定当前目录默认频道（不存在则创建）
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import {
  bindWorkspaceConfigPointer,
  explicitConfigPath,
  readConfig,
  readConfigWithSource,
  readState,
  writeConfig,
  writeState,
} from "../config";
import { RestError, createChannel, fetchChannelCharter, fetchMe, handleRestError, listChannels } from "../rest";
import { isSlug, normalizeServerUrl } from "../validation";

const INIT_FLAGS = ["server", "token", "channel"];
const HELP = `usage: party init --server URL --token T [--channel C]

Write local config and optionally bind this working directory to a default channel.

Options:
  --server URL    AgentParty server URL
  --token T       agent/human/readonly token
  --channel C     bind the current working directory to channel C`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, INIT_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "token", "channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const prev = readConfig();
  const server = str(flags.server) ?? prev?.server;
  const token = str(flags.token) ?? prev?.token;
  if (!server || !token) {
    console.error("need --server and --token (or existing config)");
    return 1;
  }
  const normalizedServer = normalizeServerUrl(server);
  if (normalizedServer === null) {
    console.error("--server must be an http(s) URL without credentials");
    return 1;
  }
  const cfg = { server: normalizedServer, token };

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
    writeConfig(cfg);
    const st = readState();
    writeState({ channel, cursor: st?.channel === channel ? st.cursor : 0 });
    // 用了 AGENTPARTY_CONFIG 隔离时，往 cwd-state 记面包屑：被唤醒回复轮丢了 env 也能找回本 agent
    // 的 config，不回落到人类账号会话（issue #42）。同 cwd 多 agent 仍会撞指针——那种要用不同 cwd。
    const explicit = explicitConfigPath();
    if (explicit) bindWorkspaceConfigPointer(explicit, channel);
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
      if (charter.charter) {
        console.log(`\n# ${channel} charter rev ${charter.charter_rev}`);
        console.log(charter.charter);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`warning: could not fetch channel charter: ${message}`);
    }
  }
  return 0;
}
