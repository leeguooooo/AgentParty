// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelRoleAssignment, PresenceEntry, PublicDirectedDelivery, Sender, TaskRecord } from "@agentparty/shared";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../../i18n/locale";
import { buildTeamBoard } from "../../lib/teamBoard";
import { TeamBoard } from "./TeamBoard";

const NOW = 1_700_000_000_000;
let renderer: ReactTestRenderer | null = null;
let actEnv: PropertyDescriptor | undefined;
let storage: PropertyDescriptor | undefined;

beforeEach(() => {
  actEnv = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "ap_locale" ? "zh" : null), setItem() {}, removeItem() {} },
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  if (actEnv) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnv);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  if (storage) Object.defineProperty(globalThis, "localStorage", storage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function presence(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return { type: "presence", name, kind: "agent", state: "waiting", ts: NOW - 1000, last_seen: NOW - 1000, live: true, ...over } as PresenceEntry;
}
function sender(name: string, kind: Sender["kind"] = "agent"): Sender {
  return { name, kind } as Sender;
}
function role(name: string, r: ChannelRoleAssignment["role"], over: Partial<ChannelRoleAssignment> = {}): ChannelRoleAssignment {
  return { name, role: r, responsibility: null, assigned_by: "leo", assigned_at: NOW - 5000, ...over };
}
function task(id: number, assignee: string, state: TaskRecord["state"], title = `task ${id}`): TaskRecord {
  return { id, title, state, assignee: { name: assignee, kind: "agent" }, created_at: NOW - 10_000, updated_at: NOW - 1000 } as TaskRecord;
}
function delivery(id: string, target: string, state: PublicDirectedDelivery["state"]): PublicDirectedDelivery {
  return { id, message_seq: 1, target_name: target, state, reply_seq: null, created_at: NOW - 2000, updated_at: NOW - 1000 };
}

function model() {
  return buildTeamBoard({
    presence: [
      presence("lead", { state: "working", current_task: 7, role: "host", role_source: "channel" }),
      presence("worker-a", { state: "waiting", context: { repo: "leeguooooo/AgentParty", branch: "feat/x" } }),
      presence("worker-b", { state: "waiting", role: "worker", role_source: "self" }),
      presence("old", { state: "offline", last_seen: NOW - 3_600_000 * 2 }),
    ],
    participants: [sender("lead"), sender("worker-a"), sender("worker-b"), sender("old")],
    roles: [role("lead", "host"), role("worker-a", "worker", { responsibility: "写前端", reports_to: "lead" }), role("ghost", "reviewer")],
    tasks: [task(7, "lead", "in_progress", "发版"), task(8, "worker-a", "assigned")],
    deliveries: [delivery("d1", "worker-b", "waiting_owner")],
    hostBoard: { hosts: [{ name: "lead", lease: "active", stale_reason: null }] } as never,
    now: NOW,
  });
}

function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") { out.push(node); return; }
    if (!node || typeof node !== "object") return;
    for (const child of (node as { children?: unknown[] }).children ?? []) walk(child);
  };
  walk(r.toJSON());
  return out.join(" ");
}

function render(props: Partial<Parameters<typeof TeamBoard>[0]> = {}) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <TeamBoard model={model()} now={NOW} canModerate={true} {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!;
}

describe("TeamBoard（#1060 PR B）", () => {
  test("泳道按 受阻→处理中→等待→离线 排列，每张卡带角色/主持/汇报/仓库", () => {
    const r = render();
    const lanes = r.root.findAll((n) => n.type === "section" && typeof n.props["data-lane"] === "string").map((n) => n.props["data-lane"]);
    expect(lanes).toEqual(["blocked", "working", "waiting", "offline"]);
    const cards = r.root.findAll((n) => n.type === "li" && typeof n.props["data-lane"] === "string").map((n) => `${n.props["data-name"]}:${n.props["data-lane"]}`);
    expect(cards).toEqual(["worker-b:blocked", "lead:working", "worker-a:waiting", "old:offline"]);
    const text = allText(r);
    expect(text).toMatch(/★\s+主持/);
    expect(text).toContain("#7 发版");
    expect(text).toContain("汇报给 lead");
    expect(text).toMatch(/leeguooooo\/AgentParty\s*@feat\/x/);
    expect(text).toContain("自报 · 待确认");
    expect(text).toContain("1 项等 owner");
    expect(text).not.toMatch(/\bsupervised\b|\bserve\b|\bresidency\b/);
  });

  test("无人认领的角色单独成条，可指派给在场 agent 并移除旧行", async () => {
    const onSaveRole = mock(async () => true);
    const onDeleteRole = mock(() => undefined);
    const r = render({ onSaveRole, onDeleteRole });
    const row = r.root.findByProps({ "data-role": "reviewer" });
    expect(allText(r)).toContain("原为 ghost");
    const select = row.findByType("select");
    await act(async () => { select.props.onChange({ target: { value: "worker-a" } }); await Promise.resolve(); });
    expect(onSaveRole).toHaveBeenCalledWith("worker-a", { role: "reviewer", responsibility: "", reportsTo: null });
    expect(onDeleteRole).toHaveBeenCalledWith("ghost");
  });

  test("版主点「改角色」出表单，保存时把 role/职责/汇报对象交给 onSaveRole", async () => {
    const onSaveRole = mock(async () => true);
    const r = render({ onSaveRole });
    const card = r.root.findByProps({ "data-name": "worker-a" });
    act(() => card.findByProps({ className: "d-btn team-card-editbtn" }).props.onClick());
    const form = card.findByType("form");
    const [roleSel, reportsSel] = form.findAllByType("select");
    act(() => roleSel!.props.onChange({ target: { value: "reviewer" } }));
    act(() => form.findByType("input").props.onChange({ target: { value: "看 PR" } }));
    act(() => reportsSel!.props.onChange({ target: { value: "" } }));
    await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
    expect(onSaveRole).toHaveBeenCalledWith("worker-a", { role: "reviewer", responsibility: "看 PR", reportsTo: null });
    expect(card.findAllByType("form")).toHaveLength(0);
  });

  test("非版主看不到改角色；接回只给离线 agent；点名字开详情", () => {
    const onOpenAgentDetail = mock(() => undefined);
    const onReconnect = mock(() => undefined);
    const r = render({ canModerate: false, onOpenAgentDetail, onReconnect });
    expect(r.root.findAllByProps({ className: "d-btn team-card-editbtn" })).toHaveLength(0);
    const reconnects = r.root.findAll((n) => n.type === "button" && String(n.props.className).includes("team-card-reconnect"));
    expect(reconnects).toHaveLength(1);
    act(() => reconnects[0]!.props.onClick());
    expect(onReconnect).toHaveBeenCalledWith("old");
    act(() => r.root.findByProps({ "data-name": "lead" }).findByProps({ className: "team-card-name" }).props.onClick());
    expect(onOpenAgentDetail).toHaveBeenCalledWith("lead");
  });

  test("空频道给一句人话提示", () => {
    const r = render({ model: buildTeamBoard({ presence: [], participants: [], roles: [], now: NOW }) });
    expect(allText(r)).toContain("还没有成员");
  });
});
