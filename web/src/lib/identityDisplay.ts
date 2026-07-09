import type { MsgFrame, PresenceEntry, Sender } from "@agentparty/shared";
import type { ChannelIdentity } from "./api";
import type { MentionCandidate } from "./mentions";

export interface IdentityDisplay {
  display: string;
  kind?: "agent" | "human";
  account?: string;
}

export type IdentityDisplayMap = Record<string, IdentityDisplay>;

function displayQuality(name: string, display: string): number {
  return display !== "" && display !== name ? 2 : 1;
}

function addIdentity(
  map: IdentityDisplayMap,
  name: string,
  input: { display?: string; kind?: "agent" | "human"; account?: string },
  force = false,
) {
  if (name === "" || name === "system") return;
  const prev = map[name];
  const kind = input.kind ?? prev?.kind;
  const account = input.account ?? prev?.account;
  const fallbackDisplay = kind === "human" && account ? account : name;
  const nextDisplay = input.display ?? fallbackDisplay;
  const prevDisplay = prev?.display;
  const display =
    !force &&
    prevDisplay !== undefined &&
    displayQuality(name, prevDisplay) > displayQuality(name, nextDisplay)
      ? prevDisplay
      : nextDisplay;
  map[name] = {
    display,
    ...(kind === undefined ? {} : { kind }),
    ...(account === undefined ? {} : { account }),
  };
}

function displayForIdentity(name: string, identities: IdentityDisplayMap | undefined): string {
  return identities?.[name]?.display ?? name;
}

// 显示优先级：人类 handle（可 @ 昵称）> owner（人类专属，email）> 常规 identity 回退。
// 消息头的 senderLabel 与引用预览块里"被引用者"的名字共用同一份逻辑，保证两处一致。
export function resolveSenderLabel(sender: Sender, identities: IdentityDisplayMap | undefined): string {
  return sender.handle
    ? sender.handle
    : sender.kind === "human" && sender.display_name
      ? sender.display_name
    : sender.kind === "human" && sender.owner
      ? sender.owner
      : displayForIdentity(sender.name, identities);
}

export function buildIdentityDisplay(input: {
  channelIdentities: ChannelIdentity[];
  mentionOptions: MentionCandidate[];
  messages: MsgFrame[];
  participants: Sender[];
  presence: Record<string, PresenceEntry>;
}): IdentityDisplayMap {
  const map: IdentityDisplayMap = {};

  // 显示优先级：人类 handle > SSO display name > owner/account（email）> 原始 name。
  // agent 恒无 handle，天然回退 name，不受影响。map 的 key 仍是原始 name/UUID，不受此优先级影响。
  for (const sender of input.participants) {
    addIdentity(map, sender.name, {
      kind: sender.kind,
      account: sender.owner,
      display: sender.kind === "human" ? sender.handle || sender.display_name || sender.owner || sender.name : sender.name,
    });
  }
  for (const entry of Object.values(input.presence)) {
    addIdentity(map, entry.name, {
      kind: entry.kind,
      account: entry.account,
      display: entry.kind === "human" ? entry.handle || entry.display_name || entry.account || entry.name : entry.name,
    });
  }
  for (const message of input.messages) {
    addIdentity(map, message.sender.name, {
      kind: message.sender.kind,
      account: message.sender.owner,
      display:
        message.sender.kind === "human"
          ? message.sender.handle || message.sender.display_name || message.sender.owner || message.sender.name
          : message.sender.name,
    });
  }
  for (const option of input.mentionOptions) {
    addIdentity(map, option.name, { kind: option.kind, account: option.account, display: option.display });
  }
  for (const identity of input.channelIdentities) addIdentity(map, identity.name, identity, true);

  return map;
}
