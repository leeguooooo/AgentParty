import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PresenceEntry, Sender } from "@agentparty/shared";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { buildGroups, countLiveGroups, ownerKey, PresenceBar, type Item } from "./PresenceBar";

function item(over: Partial<Item> = {}): Item {
  return {
    name: "agent-a",
    kind: "agent",
    state: "working",
    note: null,
    ts: 1_000,
    lastSeen: 1_000,
    role: null,
    roleSource: null,
    residency: null,
    wakeKind: null,
    wakeVerifiedAt: null,
    context: null,
    lineage: null,
    workflow: null,
    owner: null,
    account: null,
    handle: null,
    displayName: null,
    avatarUrl: null,
    avatarThumb: null,
    display: "agent-a",
    responsibility: null,
    connectionCount: 1,
    clientVersion: null,
    ...over,
  };
}

describe("presence grouping by account", () => {
  test("ownerKey groups online and offline sessions of the same account together", () => {
    const online = item({ name: "sess-1", kind: "human", state: "working", owner: "alice@example.com", account: "alice@example.com" });
    // 离线会话：owner 出于隐私置空，但 account 仍保留，用来分组。
    const offline = item({ name: "3d2f1e8a-uuid", kind: "human", state: "offline", owner: null, account: "alice@example.com" });
    expect(ownerKey(online)).toBe(ownerKey(offline));
    expect(ownerKey(online)).toBe("account:alice@example.com");
  });

  test("items without an account fall back to per-session grouping", () => {
    const a = item({ name: "agent-a", account: null });
    const b = item({ name: "agent-b", account: null });
    expect(ownerKey(a)).not.toBe(ownerKey(b));
  });

  test("buildGroups folds one account's online + offline sessions into a single group, and counts participants (not sessions)", () => {
    const aliceOnline = item({
      name: "sess-1",
      kind: "human",
      state: "working",
      owner: "alice@example.com",
      account: "alice@example.com",
      display: "alice@example.com",
    });
    const aliceOffline = item({
      name: "3d2f1e8a-uuid",
      kind: "human",
      state: "offline",
      owner: null,
      account: "alice@example.com",
      display: "3d2f1e8a-uuid",
    });
    const bobOffline = item({
      name: "bot-1",
      kind: "agent",
      state: "offline",
      owner: null,
      account: "bob@example.com",
      display: "bob@example.com",
    });

    const groups = buildGroups([aliceOnline, aliceOffline, bobOffline]);

    // alice 的在线 + 离线会话应折叠为同一组（1 人 2 个会话），bob 单独一组。
    expect(groups).toHaveLength(2);
    const aliceGroup = groups.find((g) => g.key === "account:alice@example.com");
    expect(aliceGroup?.items).toHaveLength(2);

    // 顶部计数按人数：2 个账号，其中只有 alice 有非离线会话，所以 1/2。
    const { live, total } = countLiveGroups(groups);
    expect(total).toBe(2);
    expect(live).toBe(1);
  });

  test("an account with only offline sessions across multiple entries still counts as one non-live participant", () => {
    const offlineA = item({ name: "sess-x", kind: "human", state: "offline", owner: null, account: "carol@example.com" });
    const offlineB = item({ name: "sess-y", kind: "human", state: "offline", owner: null, account: "carol@example.com" });

    const groups = buildGroups([offlineA, offlineB]);
    expect(groups).toHaveLength(1);
    const { live, total } = countLiveGroups(groups);
    expect(total).toBe(1);
    expect(live).toBe(0);
  });
});

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function presenceEntry(clientVersion?: string): PresenceEntry {
  return {
    name: "agent-a",
    kind: "agent",
    state: "working",
    note: null,
    ts: Date.now(),
    ...(clientVersion === undefined ? {} : { client_version: clientVersion }),
  };
}

const participants: Sender[] = [{ name: "agent-a", kind: "agent" }];
let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_locale: "en", ap_presence_expanded: "1" }),
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      innerWidth: 1280,
      innerHeight: 800,
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "window");
});

function renderPresence(entry: PresenceEntry): ReactTestRenderer {
  let next!: ReactTestRenderer;
  void act(() => {
    next = create(
      createElement(
        LocaleProvider,
        null,
        createElement(PresenceBar, {
          presence: { "agent-a": entry },
          participants,
          status: "open",
        }),
      ),
    );
  });
  renderer = next;
  return next;
}

function nodesWithClass(r: ReactTestRenderer, className: string) {
  return r.root.findAll((node) => String(node.props.className ?? "").split(" ").includes(className));
}

describe("presence client version", () => {
  test("shows an agent CLI version in expanded details and the group tooltip, then removes it when collapsed", async () => {
    const r = renderPresence(presenceEntry("0.2.89"));

    const versions = nodesWithClass(r, "presence-client-version");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.children).toEqual(["cli v", "0.2.89"]);
    const group = nodesWithClass(r, "presence-group")[0];
    expect(group?.props.title).toContain("agent-a: cli v0.2.89");

    await act(async () => {
      r.root.findByProps({ "aria-label": "collapse" }).props.onClick();
    });

    expect(nodesWithClass(r, "presence-client-version")).toHaveLength(0);
  });

  test("does not render a version label for legacy presence entries", () => {
    const r = renderPresence(presenceEntry());

    expect(nodesWithClass(r, "presence-client-version")).toHaveLength(0);
  });
});
