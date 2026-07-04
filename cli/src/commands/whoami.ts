// party whoami — 打印当前身份，调 /api/me 验活
import { parseArgs, unknownFlagError } from "../args";
import { handleRestError, fetchMe } from "../rest";
import { resolveAuth } from "../oidc-cli";

const WHOAMI_FLAGS = ["json", "caps"];

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv, { booleans: ["json", "caps"] });
  const unknown = unknownFlagError(flags, WHOAMI_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const json = flags.json === true;
  let auth;
  try {
    auth = await resolveAuth();
  } catch (e) {
    if (json) console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    else console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!auth) {
    if (json) console.log(JSON.stringify({ logged_in: false }));
    else console.log("not logged in");
    return 0;
  }
  try {
    const me = await fetchMe(auth.server, auth.token);
    if (json) {
      // 原样吐 /api/me（name/email/kind/role/owner…），供工具判身份/权限，免解析人类串
      console.log(JSON.stringify({ logged_in: true, server: auth.server, ...me }));
    } else {
      const who = me.email ?? me.name;
      console.log(`logged in as ${who} (${me.kind}/${me.role})`);
      // --caps：把 token 能干什么摊开，免得撞 403 才知道没权限（scoped token 尤其容易懵）
      if (flags.caps) {
        const scope = me.channel_scope ?? null;
        console.log(`  scope: ${scope ?? "none (all channels)"}`);
        const yn = (b: boolean | undefined) => (b ? "yes" : "no");
        if (me.caps) {
          console.log(
            `  can: send=${yn(me.caps.send)} create-channel=${yn(me.caps.create_channel)} mint-agents=${yn(me.caps.mint_agents)}`,
          );
        } else {
          console.log("  caps: server too old (no caps in /api/me); upgrade server");
        }
      }
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
