import type { MsgFrame, PresenceEntry, Sender } from "@agentparty/shared";
import { assignIdentityDisambiguators } from "@agentparty/shared/identity";
import type { ChannelIdentity } from "./api";
import type { MentionCandidate } from "./mentions";

export interface IdentityDisplay {
  display: string;
  kind?: "agent" | "human";
  account?: string;
  // #858：同 owner 同角色的 agent 渲染出的显示名会完全一样；撞名时才带上这段技术区分码。
  disambiguator?: string;
}

export type IdentityDisplayMap = Record<string, IdentityDisplay>;

function isOpaqueAccount(value: string): boolean {
  return /^(?:(?:lark|oidc|apple|github):|oidc-)/i.test(value);
}

function generatedAgentRole(value: string): string | null {
  const match = value.match(/^(?:lark-)?[0-9a-f]{12,}-(.+)$/i);
  return match?.[1]?.trim() || null;
}

export interface IdentityPresentation {
  label: string;
  ownerLabel: string | null;
  technicalName: string;
  generated: boolean;
  kind?: "agent" | "human";
  // 仅撞名身份有值；渲染成 `owner · role·<code>`，不撞名的身份显示保持原样。
  disambiguator?: string;
}

export function formatIdentityPresentation(
  presentation: IdentityPresentation,
  ownedAgent: (owner: string, name: string) => string,
): string {
  return presentation.kind === "agent" && presentation.ownerLabel !== null
    ? ownedAgent(presentation.ownerLabel, presentation.label)
    : presentation.label;
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

// 撞名区分码查询（#858）：渲染点只需要「有没有」，不必重算 presentation。
export function disambiguatorForIdentity(
  name: string,
  identities: IdentityDisplayMap | undefined,
): string | null {
  return identities?.[name]?.disambiguator ?? null;
}

export function displayForIdentity(name: string, identities: IdentityDisplayMap | undefined): string {
  return identities?.[name]?.display ?? name;
}

export function resolveIdentityPresentation(
  name: string,
  identities: IdentityDisplayMap | undefined,
  hints: {
    kind?: "agent" | "human";
    owner?: string | null;
    display?: string | null;
  } = {},
): IdentityPresentation {
  const identity = identities?.[name];
  const kind = hints.kind ?? identity?.kind;
  const owner = hints.owner ?? identity?.account ?? null;
  const preferredDisplay = hints.display?.trim() || identity?.display?.trim() || name;
  const generatedRole = generatedAgentRole(name);
  const generatedDisplayRole = generatedAgentRole(preferredDisplay);
  const generated = kind === "agent" && generatedRole !== null;
  const readableAlias =
    preferredDisplay !== name &&
    generatedDisplayRole === null &&
    !isOpaqueAccount(preferredDisplay);
  const ownerLabel =
    kind === "agent"
      ? resolveAgentOwnerLabel({ kind: "agent", owner: owner ?? undefined }, identities)
      : null;

  return {
    label: generated && !readableAlias ? generatedRole : preferredDisplay,
    ownerLabel,
    technicalName: name,
    generated,
    ...(kind === undefined ? {} : { kind }),
    ...(identity?.disambiguator === undefined ? {} : { disambiguator: identity.disambiguator }),
  };
}

// 显示优先级：人类 display_name > handle（可 @ 昵称）> owner（email）> 常规 identity 回退。
// 消息头的 senderLabel 与引用预览块里"被引用者"的名字共用同一份逻辑，保证两处一致。
export function resolveSenderLabel(sender: Sender, identities: IdentityDisplayMap | undefined): string {
  const display =
    sender.kind === "human"
      ? sender.display_name || sender.handle || sender.owner
      : sender.handle;
  return resolveIdentityPresentation(sender.name, identities, {
    kind: sender.kind,
    owner: sender.owner,
    display,
  }).label;
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

  return withDisambiguators(map);
}

// #858：全量 map 构建完成后统一扫一遍撞名——按最终渲染出的 `ownerLabel · label` 分组，
// 同组多于一个技术 name 就给每个成员打一段组内唯一的区分码（规则在 shared/identity，与 #857 共用）。
function withDisambiguators(map: IdentityDisplayMap): IdentityDisplayMap {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(map)) {
    const presentation = resolveIdentityPresentation(name, map);
    const key = `${presentation.kind ?? "unknown"}\u0000${presentation.ownerLabel ?? ""}\u0000${presentation.label}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [name]);
    else bucket.push(name);
  }
  for (const names of groups.values()) {
    if (names.length < 2) continue;
    for (const [name, disambiguator] of assignIdentityDisambiguators(names)) {
      map[name] = { ...map[name]!, disambiguator };
    }
  }
  return map;
}
