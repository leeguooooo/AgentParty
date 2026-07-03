// party token create — 需要 ADMIN_SECRET 环境变量
import type { TokenRole } from "@agentparty/shared";
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import { createToken, handleRestError, revokeToken } from "../rest";
import { isName, normalizeServerUrl } from "../validation";

const ROLES: TokenRole[] = ["agent", "human", "readonly"];
const TOKEN_FLAGS = ["server", "name", "role", "owner"];
const OWNER_MAX = 128;
const OWNER_RE = /^[\x20-\x7e]{1,128}$/;

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, TOKEN_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "name", "role", "owner"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = readConfig();
  const server = normalizeServerUrl(str(flags.server) ?? cfg?.server ?? "");
  if (!server) {
    console.error("no valid server, run party init or pass --server");
    return 1;
  }
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("ADMIN_SECRET env var required");
    return 1;
  }
  const sub = positionals[0];
  try {
    switch (sub) {
      case "create": {
        const name = str(flags.name);
        const role = str(flags.role) ?? "agent";
        const owner = str(flags.owner);
        if (!name || !ROLES.includes(role as TokenRole)) {
          console.error("usage: party token create --name n --role agent|human|readonly [--owner label]");
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        if (owner !== undefined && (owner.length > OWNER_MAX || !OWNER_RE.test(owner))) {
          console.error(`--owner must be printable ascii, <= ${OWNER_MAX} chars`);
          return 1;
        }
        const res = await createToken(server, adminSecret, name, role as TokenRole, owner);
        // 明文 token 只出现这一次
        console.log(JSON.stringify(res));
        return 0;
      }
      case "revoke": {
        const name = str(flags.name) ?? positionals[1];
        if (!name) {
          console.error("usage: party token revoke <name>");
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        await revokeToken(server, adminSecret, name);
        console.log(`revoked ${name}`);
        return 0;
      }
      default:
        console.error("usage: party token create|revoke");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
