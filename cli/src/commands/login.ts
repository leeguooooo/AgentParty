// party login — 回环 PKCE 登录，把账号会话存到 account.json（0600）
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { writeAccount } from "../account";
import { readConfig } from "../config";
import { loginFlow } from "../oidc-cli";
import { normalizeServerUrl } from "../validation";

const LOGIN_FLAGS = ["server"];
const HELP = `usage: party login [--server URL]

Open a browser PKCE sign-in flow and store the account session.

Options:
  --server URL    AgentParty server URL (or AGENTPARTY_SERVER / saved config)`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, LOGIN_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const raw = str(flags.server) ?? process.env.AGENTPARTY_SERVER ?? readConfig()?.server;
  if (!raw) {
    console.error("server required; pass --server URL, set AGENTPARTY_SERVER, or run party init first");
    return 1;
  }
  const server = normalizeServerUrl(raw);
  if (server === null) {
    console.error("--server must be an http(s) URL without credentials");
    return 1;
  }
  try {
    const sess = await loginFlow(server);
    writeAccount(sess);
    console.log(`logged in as ${sess.email ?? sess.sub ?? "unknown"}`);
    return 0;
  } catch (e) {
    console.error(`login failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
