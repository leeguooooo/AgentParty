// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { OcsRosterFrame } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { channelReducer, initialChannelState, type ChannelState } from "../state";
import { PresenceBar } from "./PresenceBar";
import { draftWithMention, visibleOcsGroups } from "./LocalOcsSessions";

// #1113：成员面板「本机可介入」。服务端已按观看者裁剪（非 owner 帧里没有 cwd），前端只负责：
// 按上报机器分组、给可复制的 ocs dm 命令、有 party 身份才给 @、过期/清除即隐藏。
//
// 变异自检（已手动做过，改回后全绿）：
//  · state.ts 的 ocs_roster 分支不处理空 sessions（不删分组）→ 「清除帧」用例红；
//  · OcsRow 去掉 canMention 条件（无身份也给 @）→ 「@ 仅在有身份时出现」红；
//  · visibleOcsGroups 不过滤 expires_at → 「过期隐藏」红。

let renderer: ReactTestRenderer | null = null;

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "en"]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  win.setInterval = globalThis.setInterval.bind(globalThis);
  win.clearInterval = globalThis.clearInterval.bind(globalThis);
  win.setTimeout = globalThis.setTimeout.bind(globalThis);
  win.clearTimeout = globalThis.clearTimeout.bind(globalThis);
  win.innerWidth = 1280;
  win.innerHeight = 800;
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
});

const FAR = Date.now() + 3_600_000;

function roster(over: Partial<OcsRosterFrame> = {}): OcsRosterFrame {
  return {
    type: "ocs_roster",
    name: "builder",
    sessions: [
      { addr: "codex-1a2b3c4d", harness: "codex", same_project: true, host_kind: "terminal", party_name: "helper" },
      { addr: "my session", harness: "claude", same_project: false, host_kind: "process" },
      // 有 party 身份但不在本频道 presence/participants 里：不能 @。
      { addr: "pi-ghost", harness: "pi", same_project: false, host_kind: "process", party_name: "ghost" },
    ],
    ts: 1,
    expires_at: FAR,
    full: false,
    ...over,
  };
}

function text(node: ReactTestRenderer): string {
  return JSON.stringify(node.toJSON());
}

function render(rosters: Record<string, OcsRosterFrame>, mentioned: string[] = []) {
  const now = Date.now();
  act(() => {
    renderer = create(createElement(LocaleProvider, null, createElement(PresenceBar, {
      presence: {
        builder: { name: "builder", kind: "agent", state: "online", ts: now, last_seen: now, live: true },
        helper: { name: "helper", kind: "agent", state: "online", ts: now, last_seen: now, live: true },
      },
      participants: [{ name: "builder", kind: "agent" }, { name: "helper", kind: "agent" }],
      status: "open",
      initialRosterOpen: true,
      ocsRosters: rosters,
      onMentionAgent: (n: string) => mentioned.push(n),
    } as never)));
  });
}

describe("LocalOcsSessions (#1113)", () => {
  test("groups by reporting machine with copyable ocs dm commands; @ only for sessions with a party identity", () => {
    const mentioned: string[] = [];
    render({ builder: roster() }, mentioned);
    const out = text(renderer!);
    expect(out).toContain("Local reachable");
    expect(out).toContain("on builder");
    expect(out).toContain('ocs dm codex-1a2b3c4d \\"…\\"');
    expect(out).toContain(`ocs dm 'my session' \\"…\\"`);
    expect(out).toContain("path visible only to the reporter and the channel owner");
    const mentions = renderer!.root.findAll((n) => n.type === "button" && String(n.props.className).includes("ocs-mention"));
    expect(mentions).toHaveLength(1);
    act(() => mentions[0]!.props.onClick());
    expect(mentioned).toEqual(["helper"]);
  });

  test("full view shows the cwd; expired or empty groups are hidden", () => {
    render({
      builder: roster({ full: true, sessions: [{ addr: "pi-1", harness: "pi", same_project: false, host_kind: "process", cwd: "/srv/app", label: "deploy" }] }),
      stale: roster({ name: "stale", expires_at: Date.now() - 1 }),
    });
    const out = text(renderer!);
    expect(out).toContain("/srv/app");
    expect(out).toContain("deploy");
    expect(out).not.toContain("on stale");
    expect(visibleOcsGroups({ a: roster({ sessions: [] }) }, Date.now())).toEqual([]);
  });

  test("reducer stores, clears on empty frame, drops on welcome and ignores malformed frames", () => {
    let s: ChannelState = channelReducer(initialChannelState, { type: "frame", frame: roster() } as never);
    expect(Object.keys(s.ocsRosters)).toEqual(["builder"]);
    const bad = channelReducer(s, { type: "frame", frame: { ...roster({ name: "x" }), sessions: [{ addr: "a", harness: "gpt" }] } } as never);
    expect(Object.keys(bad.ocsRosters)).toEqual(["builder"]);
    s = channelReducer(s, { type: "frame", frame: roster({ sessions: [] }) } as never);
    expect(s.ocsRosters).toEqual({});
    s = channelReducer(s, { type: "frame", frame: roster() } as never);
    s = channelReducer(s, {
      type: "frame",
      frame: { type: "welcome", channel: "c", self: "me", participants: [], last_seq: 0, presence: [] },
    } as never);
    expect(s.ocsRosters).toEqual({});
  });

  test("draftWithMention prepends once", () => {
    expect(draftWithMention("", "helper")).toBe("@helper ");
    expect(draftWithMention("hi", "helper")).toBe("@helper hi");
    expect(draftWithMention("@helper hi", "helper")).toBe("@helper hi");
  });
});
