import type { MsgFrame, PresenceEntry, Sender } from "@agentparty/shared";
import type { ChannelIdentity } from "./api";
import type { MentionCandidate } from "./mentions";

export interface IdentityDisplay {
  display: string;
  kind?: "agent" | "human";
  account?: string;
}

export type IdentityDisplayMap = Record<string, IdentityDisplay>;

function isOpaqueAccount(value: string): boolean {
  return /^(?:lark|oidc|apple|github):/i.test(value);
}

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

export function displayForIdentity(name: string, identities: IdentityDisplayMap | undefined): string {
  return identities?.[name]?.display ?? name;
}

// 显示优先级：人类 display_name > handle（可 @ 昵称）> owner（email）> 常规 identity 回退。
// 消息头的 senderLabel 与引用预览块里"被引用者"的名字共用同一份逻辑，保证两处一致。
export function resolveSenderLabel(sender: Sender, identities: IdentityDisplayMap | undefined): string {
  return sender.kind === "human" && sender.display_name
    ? sender.display_name
    : sender.handle
      ? sender.handle
      : sender.kind === "human" && sender.owner
        ? sender.owner
        : displayForIdentity(sender.name, identities);
}

export function resolveAgentOwnerLabel(
  sender: Pick<Sender, "kind" | "owner">,
  identities: IdentityDisplayMap | undefined,
): string | null {
  if (sender.kind !== "agent" || !sender.owner) return null;

  const owner = sender.owner;
  const human = Object.values(identities ?? {}).find(
    (identity) =>
      identity.kind === "human" &&
      identity.account === owner &&
      identity.display.trim() !== "" &&
      identity.display !== owner &&
      !isOpaqueAccount(identity.display),
  );
  if (human) return human.display;

  return isOpaqueAccount(owner) ? null : owner;
}

export function buildIdentityDisplay(input: {
  channelIdentities: ChannelIdentity[];
  mentionOptions: MentionCandidate[];
  messages: MsgFrame[];
  participants: Sender[];
  presence: Record<string, PresenceEntry>;
}): IdentityDisplayMap {
  const map: IdentityDisplayMap = {};

  // 人类显示优先级：SSO display name > account handle > owner/account（email）> 原始 name。
  // agent 仍是昵称 > 原始 name。map 的 key 始终是可路由 identity，不用展示名做 key。
  for (const sender of input.participants) {
    addIdentity(map, sender.name, {
      kind: sender.kind,
      account: sender.owner,
      display: (sender.kind === "human" ? sender.display_name || sender.handle || sender.owner : sender.handle) || sender.name,
    });
  }
  for (const entry of Object.values(input.presence)) {
    addIdentity(map, entry.name, {
      kind: entry.kind,
      account: entry.account,
      display: (entry.kind === "human" ? entry.display_name || entry.handle || entry.account : entry.handle) || entry.name,
    });
  }
  for (const message of input.messages) {
    addIdentity(map, message.sender.name, {
      kind: message.sender.kind,
      account: message.sender.owner,
      display:
        (message.sender.kind === "human"
          ? message.sender.display_name || message.sender.handle || message.sender.owner
          : message.sender.handle) ||
        message.sender.name,
    });
  }
  for (const option of input.mentionOptions) {
    addIdentity(map, option.name, {
      kind: option.kind === "squad" ? undefined : option.kind,
      account: option.account,
      display: option.display,
    });
  }
  for (const identity of input.channelIdentities) addIdentity(map, identity.name, identity, true);

  return map;
}
