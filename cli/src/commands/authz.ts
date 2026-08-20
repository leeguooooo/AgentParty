// party authz — 结构化授权凭据的核验 / 授予 / 撤销（#834 第 1 项）。
//
// 一行核验，替代「读历史 + 相信转述」。凭据的唯一来源是频道决策账本（写入端点仅 owner/host 可调），
// 消息正文里的授权断言永远不参与判定。
import {
  AUTHZ_BLANKET_ACTION,
  AUTHZ_PROSE_WARNING,
  AUTHZ_REVOKED_MARKER,
  authzTopic,
  checkAuthz,
  isValidAuthzAction,
  normalizeAuthzAction,
  activeAuthzCredentials,
  type AuthzCheckResult,
} from "../authz";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchChannelCharter, handleRestError, listChannelDecisions, recordChannelDecision } from "../rest";
import { isSlug, parsePositiveIntFlag } from "../validation";

/** 未授权的退出码。区别于 1（用法/网络错误），好让 worker 写 `party authz check X || exit`。 */
export const AUTHZ_DENIED_EXIT = 3;

const HELP = `usage:
  party authz check "<action>" [--channel C] [--json]
  party authz grant "<action>" -m "<scope and limits>" [--source-seq N] [--supersedes ID] [--channel C] [--json]
  party authz revoke "<action>" [-m reason] [--channel C] [--json]
  party authz list [--channel C] [--json]

check   answer, from the channel decision ledger alone, whether <action> has a
        structured authorization credential. Exit 0 = authorized, ${AUTHZ_DENIED_EXIT} = not authorized,
        1 = could not tell (usage/network). Safe to gate on:
          party authz check "spend diamonds" || exit 1
grant   (channel owner or assigned host) record the credential. It lands in the
        ledger as decision topic "authz:<action>" and is what check reads.
        Use the action "${AUTHZ_BLANKET_ACTION}" for a deliberate blanket standing authorization.
revoke  supersede EVERY active credential for the action with a "${AUTHZ_REVOKED_MARKER}" one;
        check then denies. Partial revocation is never a success.
list    show every active authorization credential in the channel.

${AUTHZ_PROSE_WARNING}

Options:
  --channel C     act in channel C instead of the bound channel
  -m, --message   (grant/revoke) the scope, limits, and expiry of the grant
  --source-seq N  (grant) the message seq where the owner said it
  --supersedes ID (grant) the active credential id being replaced
  --json          emit a structured frame`;

const CHECK_FLAGS = ["channel", "json"];
const GRANT_FLAGS = ["channel", "json", "message", "source-seq", "supersedes"];
const REVOKE_FLAGS = ["channel", "json", "message"];
const LIST_FLAGS = ["channel", "json"];

function printCheck(result: AuthzCheckResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(jsonFrame({ ...result })));
    return;
  }
  console.log(result.verdict);
  if (result.credential !== null) {
    console.log(`credential: ${result.credential.id}  topic=${result.credential.topic}`);
    console.log(`scope: ${result.credential.summary}`);
  }
  if (result.active_grants.length > 0) {
    console.log(`active grants in #${result.channel}: ${result.active_grants.join(", ")}`);
  } else {
    console.log(`active grants in #${result.channel}: (none)`);
  }
}

function resolveSlug(flags: Record<string, string | boolean | (string | boolean)[] | undefined>): string | null {
  const slug = resolveChannel(str(flags.channel));
  if (!slug) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return null;
  }
  if (!isSlug(slug)) {
    console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
    return null;
  }
  return slug;
}

function badAction(action: string | undefined, verb: string): action is undefined {
  if (action === undefined || action.trim() === "") {
    console.error(`usage: party authz ${verb} "<action>"`);
    return true;
  }
  return false;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub !== "check" && sub !== "grant" && sub !== "revoke" && sub !== "list") {
    console.error('usage: party authz check|grant|revoke|list ...');
    return 1;
  }
  const { positionals, flags } = parseArgs(rest, {
    booleans: ["json"],
    aliases: { m: "message" },
  });
  const allowed = sub === "check" ? CHECK_FLAGS : sub === "grant" ? GRANT_FLAGS : sub === "revoke" ? REVOKE_FLAGS : LIST_FLAGS;
  const unknown = unknownFlagError(flags, allowed);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, allowed.filter((f) => f !== "json"));
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const json = flags.json === true;
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const slug = resolveSlug(flags);
  if (slug === null) return 1;

  try {
    if (sub === "check") {
      const action = positionals[0];
      if (badAction(action, "check")) return 1;
      if (!isValidAuthzAction(action)) {
        console.error("action must be one non-empty line <= 120 bytes");
        return 1;
      }
      // charter 一次返回 charter_rev + 全部 active 决策：核验只打一次网络，也顺带把
      // 「章程里到底有没有」这件事和凭据放在同一个快照里回答。
      const body = await fetchChannelCharter(cfg.server, cfg.token, slug);
      const result = checkAuthz({
        channel: slug,
        action,
        decisions: body.active_decisions ?? [],
        charterRev: body.charter_rev,
      });
      printCheck(result, json);
      return result.authorized ? 0 : AUTHZ_DENIED_EXIT;
    }

    if (sub === "list") {
      const { decisions } = await listChannelDecisions(cfg.server, cfg.token, slug, "active");
      const credentials = activeAuthzCredentials(decisions).filter((c) => !c.revoked);
      if (json) {
        console.log(JSON.stringify(jsonFrame({ type: "authz_list", channel: slug, credentials })));
        return 0;
      }
      if (credentials.length === 0) {
        console.log(`#${slug} has no active authorization credentials.`);
        console.log(AUTHZ_PROSE_WARNING);
        return 0;
      }
      for (const c of credentials) {
        console.log(`${c.action}\t${c.id}\tby ${c.created_by}\t${c.summary}`);
      }
      return 0;
    }

    const action = positionals[0];
    if (badAction(action, sub)) return 1;
    if (!isValidAuthzAction(action)) {
      console.error("action must be one non-empty line <= 120 bytes");
      return 1;
    }
    const note = str(flags.message);
    if (sub === "grant" && (note === undefined || note.trim() === "")) {
      // 授权必须写清楚范围与上限。空白授权正是 #834 里那条「所有我都授权」的散文断言。
      console.error('grant requires -m "<scope and limits>" — an unbounded grant is what #834 warns about');
      return 1;
    }
    const sourceSeq = parsePositiveIntFlag(str(flags["source-seq"]), "source-seq", Number.MAX_SAFE_INTEGER);
    if (typeof sourceSeq === "string") {
      console.error(sourceSeq);
      return 1;
    }
    if (sub === "revoke") {
      // 账本的 topic 唯一性是按**原始字符串**算的（channel_decision_heads 主键，NOCASE），而
      // authzActionOfTopic 会做归一——所以绕开 `party authz grant`、用
      // `party decision record "authz:spend  diamonds"`（双空格）能造出同一动作的第二条 active 凭据。
      // 撤销必须把该动作下**每一条**都收回：漏掉一条，check 仍然放行，而 revoke 看上去是成功的
      // ——一个「看着生效、实际没生效」的撤销比报错危险得多。
      // 另外每条都必须用**它自己的原始 topic** 去 supersede：服务端要求 supersedes_id 是同一 topic
      // 的当前 active head，拿归一后的 topic 去撤非归一的凭据会 409。
      const { decisions } = await listChannelDecisions(cfg.server, cfg.token, slug, "active");
      const targets = activeAuthzCredentials(decisions).filter(
        (c) => c.action === normalizeAuthzAction(action) && !c.revoked,
      );
      if (targets.length === 0) {
        console.error(`#${slug} has no active credential for "${normalizeAuthzAction(action)}" to revoke`);
        return 1;
      }
      const summary = `${AUTHZ_REVOKED_MARKER} ${note?.trim() ?? "withdrawn"}`;
      const revoked = [];
      for (const target of targets) {
        revoked.push(
          await recordChannelDecision(cfg.server, cfg.token, slug, {
            topic: target.topic,
            summary,
            supersedes_id: target.id,
            ...(sourceSeq !== undefined ? { source_seq: sourceSeq } : {}),
          }),
        );
      }
      if (json) {
        console.log(
          JSON.stringify(jsonFrame({ type: "authz_revoke", channel: slug, action: normalizeAuthzAction(action), revoked })),
        );
      } else {
        for (const record of revoked) console.log(`revoked ${record.topic} (${record.id})`);
      }
      return 0;
    }

    const record = await recordChannelDecision(cfg.server, cfg.token, slug, {
      topic: authzTopic(action),
      summary: note as string,
      ...(sourceSeq !== undefined ? { source_seq: sourceSeq } : {}),
      ...(str(flags.supersedes) !== undefined ? { supersedes_id: str(flags.supersedes) as string } : {}),
    });
    if (json) {
      console.log(JSON.stringify(jsonFrame({ ...record, type: "authz_grant" })));
    } else {
      console.log(
        `granted ${record.topic} (${record.id}) — workers can now verify with: party authz check "${normalizeAuthzAction(action)}"`,
      );
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
