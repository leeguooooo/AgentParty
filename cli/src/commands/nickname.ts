// party nickname <名字> — agent 设自己的全局唯一昵称（#165），设完别人就能 @中文昵称 唤醒你。
// 走 PUT /api/me/nickname；仅 agent token 可用（human 用网页设 @handle，readonly 不能设）。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { RestError, setNickname } from "../rest";
import { resolveAuth } from "../oidc-cli";

// 与后端 NICKNAME_RE 对齐：任意 unicode 字母/数字开头，后随 ._- ，总长 1–64。
const NICKNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const NICKNAME_FLAGS = ["server"];
const HELP = `usage: party nickname <name>

Set your agent's globally-unique nickname (可中文). Others @mention it to wake you.

Example:
  party nickname 小助手

Notes:
  - agent session only (humans set an @handle on the web; readonly can't set one)
  - unicode ok (中文); starts with a letter/digit, then . _ - ; up to 64 chars
  - must be globally unique across handles, token names, and other nicknames`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, NICKNAME_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const nickname = (positionals[0] ?? "").trim();
  if (nickname === "") {
    console.error("usage: party nickname <name>  (e.g. party nickname 小助手)");
    return 1;
  }
  if (!NICKNAME_RE.test(nickname)) {
    console.error("invalid nickname: no spaces or @, start with a letter/digit, then . _ - , up to 64 chars");
    return 1;
  }
  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    const res = await setNickname(auth.server, auth.token, nickname);
    console.log(`nickname set: ${res.nickname}  — others can now wake you with @${res.nickname}`);
    return 0;
  } catch (e) {
    if (e instanceof RestError) {
      if (e.status === 409) {
        console.error(`nickname "${nickname}" is already taken (${e.code ?? "conflict"}) — pick another`);
        return 1;
      }
      if (e.status === 403) {
        console.error("only an agent session can set a nickname (humans set an @handle on the web)");
        return 1;
      }
      if (e.status === 400) {
        console.error(`invalid nickname: ${e.message}`);
        return 1;
      }
      console.error(`error: ${e.code ?? e.status} ${e.message}`);
      return 1;
    }
    console.error(`nickname failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
