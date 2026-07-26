// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PresenceEntry, Sender } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";
import { DivisionBoard, teamMemberOnlineNames, teamRoleBuckets, type DivisionBoardProps } from "./Channel";

// issue #169:「频道四个 agent 分工面板只有两个」——分工面板此前只渲染
// 已分配角色（roles）+ 自报角色（presence role_source==="self"）的成员，
// 已连接但从未声明角色的 agent 会被整条略过、从名单里消失，
// 而不是仍然作为「未分工」成员出现在列表里（roster 完整性问题，不是 owner 折叠问题）。

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

let renderer: ReactTestRenderer | null = null;
let originalActEnvironment: PropertyDescriptor | undefined;
let originalLocalStorage: PropertyDescriptor | undefined;

const noop = () => {};

function presenceEntry(overrides: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return {
    state: "working",
    note: null,
    ts: 1,
    kind: "agent",
    ...overrides,
  };
}

function baseProps(overrides: Partial<DivisionBoardProps> = {}): DivisionBoardProps {
  return {
    canModerate: false,
    slug: "demo",
    roles: [],
    roleDrafts: {},
    roleError: null,
    roleSaving: null,
    roleName: "",
    roleDraft: { role: "worker", responsibility: "" },
    identities: [],
    presence: {},
    participants: [],
    onRoleDraft: noop,
    onNewRoleName: noop,
    onNewRoleDraft: noop,
    onSaveRole: async () => true,
    onDeleteRole: noop,
    forceOpen: true,
    charterText: null,
    onSyncToCharter: noop,
    syncingCharter: false,
    canManageAgentRules: false,
    onOpenAgentRules: noop,
    ...overrides,
  };
}

function render(props: DivisionBoardProps) {
  localStorage.setItem("ap_locale", "zh");
  act(() => {
    renderer = create(
      <LocaleProvider>
        <DivisionBoard {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function personNames(): string[] {
  return renderer!.root
    .findAll((n) => String(n.props.className ?? "").split(" ").includes("role-person-name"))
    .map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
}

function openUnassigned(): void {
  const toggle = renderer!.root.find((node) =>
    String(node.props.className ?? "").split(" ").includes("role-unassigned-toggle"),
  );
  act(() => toggle.props.onClick());
}

beforeEach(() => {
  originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
  if (originalActEnvironment === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  else Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", originalActEnvironment);
  if (originalLocalStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
});

describe("DivisionBoard roster completeness (#169)", () => {
  test("confirmed, pending, and unassigned counts share one roster projection", () => {
    const assigned = [{
      name: "confirmed",
      role: "host" as const,
      responsibility: "lead",
      assigned_by: "leo",
      assigned_at: 1,
      kind: "agent" as const,
    }];
    const presence = Object.fromEntries([
      ["confirmed", presenceEntry({ name: "confirmed", role: "host", role_source: "assigned" })],
      ...Array.from({ length: 3 }, (_, index) => {
        const name = `claim-${index}`;
        return [name, presenceEntry({ name, role: "worker", role_source: "self" })] as const;
      }),
      ...Array.from({ length: 10 }, (_, index) => {
        const name = `unassigned-${index}`;
        return [name, presenceEntry({ name })] as const;
      }),
    ]);

    const buckets = teamRoleBuckets(
      assigned,
      presence,
      [],
      [],
      ((key: string) => key) as Parameters<typeof teamRoleBuckets>[4],
    );

    expect(assigned).toHaveLength(1);
    expect(buckets.selfReported).toHaveLength(3);
    expect(buckets.unassigned).toHaveLength(10);
  });

  test("a participant-only member stays visible in the unassigned roster", () => {
    const participants: Sender[] = [{
      name: "participant-only",
      kind: "agent",
      owner: "human-owner",
      handle: "Participant Only",
    }];
    const buckets = teamRoleBuckets(
      [],
      {},
      [],
      participants,
      ((key: string) => key) as Parameters<typeof teamRoleBuckets>[4],
    );

    expect(buckets.unassigned).toEqual([expect.objectContaining({
      name: "participant-only",
      display: "Participant Only",
      kind: "agent",
      accountLabel: "human-owner",
      owner: "human-owner",
    })]);

    render(baseProps({ participants }));
    openUnassigned();
    expect(personNames()).toContain("Participant Only");
  });

  test("self-reported roles stay visible but do not count as confirmed assignments", () => {
    render(
      baseProps({
        identities: [{ name: "runtime-agent", kind: "agent", display: "Runtime Agent", account: "leo" }],
        presence: {
          "runtime-agent": presenceEntry({
            name: "runtime-agent",
            role: "worker",
            role_source: "self",
            note: "runtime claim",
          }),
        },
      }),
    );

    const count = renderer!.root.find((node) => node.props.className === "t-mono role-board-count");
    expect(JSON.stringify(count.props.children)).toContain("0");
    expect(JSON.stringify(renderer!.toJSON())).toContain("自报");
  });

  test("connected human members use the same authoritative online projection as agents", () => {
    const humanPresence = presenceEntry({ name: "human-owner", kind: "human", live: false });
    render(
      baseProps({
        roles: [{
          name: "human-owner",
          role: "host",
          responsibility: "approve",
          assigned_by: "human-owner",
          assigned_at: 1,
          kind: "human",
        }],
        presence: { "human-owner": humanPresence },
        onlineNames: teamMemberOnlineNames(
          [humanPresence],
          [{ name: "human-owner", kind: "human" }],
        ),
      }),
    );

    const dot = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-live-dot"),
    );
    expect(String(dot.props.className)).toContain("is-online");
    expect(dot.props.role).toBe("img");
    expect(dot.props["aria-label"]).toBe("在线");
  });

  test("role editing stays collapsed until requested and collapses only after a successful save (#504)", async () => {
    let savedName = "";
    render(
      baseProps({
        canModerate: true,
        roles: [
          {
            name: "leo-claude",
            role: "host",
            responsibility: "统筹交付",
            assigned_by: "leo",
            assigned_at: 1,
            kind: "agent",
            account: "lark:on_leo",
            display: "leo-claude",
          },
        ],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "lark:on_leo", live: true }) },
        onSaveRole: async (name) => {
          savedName = name;
          return true;
        },
      }),
    );
    let card = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-row--card"),
    );
    expect(card.findAllByType("select")).toHaveLength(0);
    expect(card.findAllByType("input")).toHaveLength(0);

    const edit = card.findByProps({ className: "d-btn role-edit-btn" });
    act(() => edit.props.onClick());
    card = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-row--card"),
    );
    expect(card.findAllByType("select")).toHaveLength(1);
    expect(card.findAllByType("input")).toHaveLength(1);
    const save = card.findAllByType("button").find((node) => String(node.props.children).includes("保存"));
    expect(save).toBeDefined();
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
    });

    card = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-row--card"),
    );
    expect(savedName).toBe("leo-claude");
    expect(card.findAllByType("select")).toHaveLength(0);
    expect(card.findByProps({ className: "d-btn role-edit-btn" })).toBeDefined();
    expect(personNames()).toContain("leo-claude");
  });

  test("a failed save keeps the editor open and cancel restores the server draft", async () => {
    const restored: Array<{ role: string; responsibility: string }> = [];
    const role = {
      name: "worker-a",
      role: "worker" as const,
      responsibility: "server value",
      assigned_by: "leo",
      assigned_at: 1,
      kind: "agent" as const,
      account: "leo",
      display: "worker-a",
    };
    render(
      baseProps({
        canModerate: true,
        roles: [role],
        roleDrafts: { "worker-a": { role: "reviewer", responsibility: "unsaved draft" } },
        presence: { "worker-a": presenceEntry({ name: "worker-a", live: true }) },
        onRoleDraft: (_name, draft) => { restored.push(draft); },
        onSaveRole: async () => false,
      }),
    );

    let card = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    act(() => card.findByProps({ className: "d-btn role-edit-btn" }).props.onClick());
    card = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    const save = card.findAllByType("button").find((node) => String(node.props.children).includes("保存"))!;
    await act(async () => {
      save.props.onClick();
      await Promise.resolve();
    });
    expect(card.findAllByType("select")).toHaveLength(1);

    const cancel = card.findAllByType("button").find((node) => String(node.props.children).includes("取消"))!;
    await act(async () => {
      cancel.props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    card = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    expect(card.findAllByType("select")).toHaveLength(0);
    expect(restored.at(-1)).toEqual({ role: "worker", responsibility: "server value" });
  });

  test("switching edit rows and closing Team discard every unsaved role draft", () => {
    const restored: Array<{ name: string; responsibility: string }> = [];
    const roles = [
      { name: "lead", role: "host" as const, responsibility: "lead server", assigned_by: "leo", assigned_at: 1, kind: "agent" as const },
      { name: "worker-a", role: "worker" as const, responsibility: "worker server", assigned_by: "leo", assigned_at: 1, kind: "agent" as const },
    ];
    render(baseProps({
      canModerate: true,
      roles,
      roleDrafts: {
        lead: { role: "host", responsibility: "dirty lead" },
        "worker-a": { role: "worker", responsibility: "dirty worker" },
      },
      presence: {
        lead: presenceEntry({ name: "lead", live: true }),
        "worker-a": presenceEntry({ name: "worker-a", live: true }),
      },
      onRoleDraft: (name, draft) => {
        restored.push({ name, responsibility: draft.responsibility });
      },
    }));

    let worker = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    act(() => worker.findByProps({ className: "d-btn role-edit-btn" }).props.onClick());
    const lead = renderer!.root.findByProps({ className: "role-row role-row--card role-row--host" });
    act(() => lead.findByProps({ className: "d-btn role-edit-btn" }).props.onClick());
    expect(restored.at(-1)).toEqual({ name: "worker-a", responsibility: "worker server" });

    act(() => renderer!.unmount());
    renderer = null;
    expect(restored.at(-1)).toEqual({ name: "lead", responsibility: "lead server" });
  });

  test("Escape cancels only the active role edit and every role control is disabled during a save", () => {
    const restored: Array<{ role: string; responsibility: string }> = [];
    const roles = [
      { name: "lead", role: "host" as const, responsibility: "lead", assigned_by: "leo", assigned_at: 1, kind: "agent" as const },
      { name: "worker-a", role: "worker" as const, responsibility: "ship", assigned_by: "leo", assigned_at: 1, kind: "agent" as const },
    ];
    const props = baseProps({
      canModerate: true,
      roles,
      presence: {
        lead: presenceEntry({ name: "lead", live: true }),
        "worker-a": presenceEntry({ name: "worker-a", live: true }),
      },
      onRoleDraft: (_name, draft) => { restored.push(draft); },
      onSetReportsTo: noop,
    });
    render(props);
    let workerCard = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    act(() => workerCard.findByProps({ className: "d-btn role-edit-btn" }).props.onClick());
    act(() => {
      renderer!.update(
        <LocaleProvider>
          <DivisionBoard {...props} roleSaving="worker-a" />
        </LocaleProvider>,
      );
    });
    workerCard = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    let prevented = false;
    let stopped = false;
    act(() => workerCard.props.onKeyDown({
      key: "Escape",
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    }));
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(restored).toHaveLength(0);
    expect(workerCard.findAllByType("select")).toHaveLength(1);

    act(() => {
      renderer!.update(
        <LocaleProvider>
          <DivisionBoard {...props} roleSaving={null} />
        </LocaleProvider>,
      );
    });
    workerCard = renderer!.root.findByProps({ className: "role-row role-row--card role-row--worker" });
    prevented = false;
    stopped = false;
    act(() => workerCard.props.onKeyDown({
      key: "Escape",
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    }));
    expect(prevented).toBe(true);
    expect(stopped).toBe(true);
    expect(restored.at(-1)).toEqual({ role: "worker", responsibility: "ship" });
    expect(workerCard.findAllByType("select")).toHaveLength(0);

    act(() => {
      renderer!.update(
        <LocaleProvider>
          <DivisionBoard {...props} roleSaving="lead" />
        </LocaleProvider>,
      );
    });
    const editButtons = renderer!.root.findAllByProps({ className: "d-btn role-edit-btn" });
    expect(editButtons.every((button) => button.props.disabled === true)).toBe(true);
    expect(renderer!.root.findByProps({ className: "role-name-input t-mono" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ className: "role-name-input t-mono" }).props["aria-label"]).toBe("成员名称");

    const orgToggle = renderer!.root.findByProps({ className: "d-btn role-org-toggle" });
    act(() => orgToggle.props.onClick());
    const reportSelectors = renderer!.root.findAllByProps({ className: "org-report-select" });
    expect(reportSelectors.length).toBeGreaterThan(0);
    expect(reportSelectors.every((select) => select.props.disabled === true)).toBe(true);
  });

  test("all 4 distinct agents render as rows even though only 2 have a declared role, and all share one owner", () => {
    const owner = "lark:on_22608d74bd2d7f39f6dc67d0da248fa5";
    render(
      baseProps({
        roles: [
          {
            name: "leo-claude",
            role: "host",
            responsibility: "desktop 集成验收",
            assigned_by: "leo",
            assigned_at: 1,
            kind: "agent",
            account: owner,
            display: "leo-claude",
          },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: owner, role: "host", role_source: "assigned" }),
          "LEO-MAIN": presenceEntry({ name: "LEO-MAIN", account: owner, role: "host", role_source: "self", note: "联合协调前台" }),
          // 已连接，但从未 self-report 过角色，也没有被 admin 分配角色——这才是 issue #169 复现的关键场景。
          Evan_Claude: presenceEntry({ name: "Evan_Claude", account: owner }),
          Evan_opencoder: presenceEntry({ name: "Evan_opencoder", account: owner }),
        },
      }),
    );
    openUnassigned();
    const names = personNames();
    expect(names).toContain("leo-claude");
    expect(names).toContain("LEO-MAIN");
    expect(names).toContain("Evan_Claude");
    expect(names).toContain("Evan_opencoder");
    expect(names.length).toBe(4);
  });

  test("agents across different owners without a role still all render (matches the real #169 report)", () => {
    render(
      baseProps({
        presence: {
          "LEO-MAIN": presenceEntry({ name: "LEO-MAIN", account: "lark:on_leo", role: "host", role_source: "self" }),
          "leo-claude": presenceEntry({ name: "leo-claude", account: "lark:on_leo", role: "host", role_source: "self" }),
          Evan_Claude: presenceEntry({ name: "Evan_Claude", account: "lark:on_evan" }),
          Evan_opencoder: presenceEntry({ name: "Evan_opencoder", account: "lark:on_evan" }),
        },
      }),
    );
    openUnassigned();
    expect(personNames().length).toBe(4);
  });

  test("unassigned rows are labeled distinctly instead of showing a stale role badge", () => {
    render(
      baseProps({
        presence: {
          Evan_Claude: presenceEntry({ name: "Evan_Claude", account: "lark:on_evan" }),
        },
      }),
    );
    const toggle = renderer!.root.findByProps({ className: "role-unassigned-toggle t-mono" });
    expect(toggle.findAllByType("span").some((node) => String(node.props.children).includes("未认领"))).toBe(true);
    expect(personNames()).not.toContain("Evan_Claude");
    openUnassigned();
    expect(personNames()).toContain("Evan_Claude");
    const chip = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-unassigned-chip"),
    );
    expect(chip.type).toBe("span");
  });

  test("only moderators can click an unassigned member to prefill the claim form", () => {
    let selected = "";
    render(
      baseProps({
        canModerate: true,
        presence: { Evan_Claude: presenceEntry({ name: "Evan_Claude", account: "lark:on_evan" }) },
        onNewRoleName: (name) => { selected = name; },
      }),
    );
    openUnassigned();
    const chip = renderer!.root.find((node) =>
      String(node.props.className ?? "").split(" ").includes("role-unassigned-chip"),
    );
    expect(chip.type).toBe("button");
    act(() => chip.props.onClick());
    expect(selected).toBe("Evan_Claude");
  });
});

// issue #168 + #370：分工要看得出正式组织架构关系。唯一权威来源是 channel_roles；
// presence lineage / self-report 只描述运行时事实，不能提升成正式汇报线或频道负责人。
describe("DivisionBoard org-structure relationships (#168)", () => {
  function findText(className: string): string[] {
    return renderer!.root
      .findAll((n) => n.props.className === className)
      .map((n) => (Array.isArray(n.props.children) ? n.props.children.join("") : String(n.props.children)));
  }

  // 汇报对象是否恰好也在本频道 roster 里，决定渲染成 "role-report t-mono" 还是
  // "role-report role-report--external t-mono"（见下面两个专门测试）；这条测试只
  // 关心「汇报关系文字有没有渲染出来」，两种 class 都收。
  function anyReportText(): string[] {
    return [...findText("role-report t-mono"), ...findText("role-report role-report--external t-mono")];
  }

  test("the compact org button is the single control for showing the full tree (#504)", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: { "worker-a": presenceEntry({ name: "worker-a", account: "leo" }) },
      }),
    );

    const toggle = renderer!.root.find((node) => node.props.className === "d-btn role-org-toggle");
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(toggle.props["aria-controls"]).toBe("division-org-tree");
    expect(renderer!.root.findAllByProps({ id: "division-org-tree" })).toHaveLength(0);

    act(() => toggle.props.onClick());

    expect(toggle.props["aria-expanded"]).toBe(true);
    const tree = renderer!.root.find((node) => node.type === "section" && node.props.id === "division-org-tree");
    expect(tree.type).toBe("section");
    expect(tree.findAllByType("details")).toHaveLength(0);
  });

  test("runtime lineage is not promoted to a formal reports-to relationship", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "worker-a": presenceEntry({
            name: "worker-a",
            account: "leo",
            lineage: { parent_agent: "leo-claude", root_agent: "leo-claude", team_id: "t1", depth: 1, expires_at: null },
          }),
        },
      }),
    );
    expect(anyReportText()).toHaveLength(0);
  });

  test("a declared role shows its formal channel_roles reports_to relationship", () => {
    render(
      baseProps({
        roles: [
          { name: "lead", role: "host", responsibility: "leads", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "lead" },
          { name: "worker-a", role: "worker", responsibility: "ships x", reports_to: "lead", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          lead: presenceEntry({ name: "lead", account: "leo" }),
          "worker-a": presenceEntry({ name: "worker-a", account: "leo" }),
        },
      }),
    );
    expect(anyReportText().some((line) => line.includes("lead"))).toBe(true);
  });

  test("a role with no lineage shows no reporting badge", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: { "worker-a": presenceEntry({ name: "worker-a", account: "leo" }) },
      }),
    );
    expect(findText("role-report t-mono").length).toBe(0);
  });

  test("the host role is tagged as the channel lead", () => {
    render(
      baseProps({
        roles: [
          { name: "leo-claude", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "leo-claude" },
          { name: "worker-a", role: "worker", responsibility: "ships x", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }),
          "worker-a": presenceEntry({ name: "worker-a", account: "leo" }),
        },
      }),
    );
    const leadTags = renderer!.root.findAll((n) => n.props.className === "role-lead-tag t-mono");
    expect(leadTags.length).toBe(1);
  });

  test("a self-reported host is never tagged as the channel lead", () => {
    render(
      baseProps({
        presence: {
          "self-host": presenceEntry({
            name: "self-host",
            account: "leo",
            role: "host",
            role_source: "self",
          }),
        },
      }),
    );

    expect(renderer!.root.findAll((node) => node.props.className === "role-lead-tag t-mono")).toHaveLength(0);
    const toggle = renderer!.root.find((node) => node.props.className === "d-btn role-org-toggle");
    act(() => toggle.props.onClick());
    expect(renderer!.root.findAll((node) => node.props.className === "org-lead-tag t-mono")).toHaveLength(0);
  });

  test("flags when the reporting target isn't part of this channel's roster", () => {
    render(
      baseProps({
        roles: [
          { name: "worker-a", role: "worker", responsibility: "ships x", reports_to: "someone-not-in-channel", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: { "worker-a": presenceEntry({ name: "worker-a", account: "leo" }) },
      }),
    );
    const externalHints = renderer!.root.findAll((n) => n.props.className === "role-report role-report--external t-mono");
    expect(externalHints.length).toBe(1);
  });

  test("does not flag a reporting target that IS visible in this channel's roster", () => {
    render(
      baseProps({
        roles: [
          { name: "leo-claude", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "leo-claude" },
          { name: "worker-a", role: "worker", responsibility: "ships x", reports_to: "leo-claude", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "worker-a" },
        ],
        presence: {
          "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }),
          "worker-a": presenceEntry({ name: "worker-a", account: "leo" }),
        },
      }),
    );
    const externalHints = renderer!.root.findAll((n) => n.props.className === "role-report role-report--external t-mono");
    expect(externalHints.length).toBe(0);
  });

  test("reports-to editor is only available for confirmed assignments", () => {
    render(
      baseProps({
        canModerate: true,
        roles: [
          { name: "assigned-lead", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "assigned-lead" },
        ],
        presence: {
          "assigned-lead": presenceEntry({ name: "assigned-lead", account: "leo" }),
          "self-host": presenceEntry({ name: "self-host", account: "leo", role: "host", role_source: "self" }),
          "runtime-only": presenceEntry({ name: "runtime-only", account: "leo" }),
        },
        onSetReportsTo: noop,
      }),
    );

    const toggle = renderer!.root.find((node) => node.props.className === "d-btn role-org-toggle");
    act(() => toggle.props.onClick());
    const selects = renderer!.root.findAll((node) => node.props.className === "org-report-select");
    expect(selects).toHaveLength(1);
    expect(String(selects[0]!.props["aria-label"])).toContain("assigned-lead");
    const optionValues = selects[0]!.findAllByType("option").map((option) => option.props.value);
    expect(optionValues).not.toContain("self-host");
    expect(optionValues).not.toContain("runtime-only");
  });
});

// issue #150：分工内容应该能一键同步进公告（charter）。这里测的是 DivisionBoard
// 把当前正式分工（只含 channel_roles）拼成 markdown 小节、合并进现有公告文本；
// presence 自报只能作为待确认 claim 展示，不能写成频道正式分工。
// 再把结果通过 onSyncToCharter 交给上层去落盘——按钮本身不发网络请求。
describe("DivisionBoard sync-to-charter (#150)", () => {
  test("syncs only confirmed agent roles and drops self-reports plus stale unresolved owner roles", () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter",
        roles: [
          { name: "lark:on_owner", role: "host", responsibility: "大脑", assigned_by: "leo", assigned_at: 1 },
          { name: "ai-girl", role: "worker", responsibility: "服务中台", assigned_by: "leo", assigned_at: 1, kind: "agent", display: "ai-girl" },
        ],
        presence: {
          "ai-girl-host-codex": presenceEntry({ name: "ai-girl-host-codex", role: "host", role_source: "self", note: "大脑大脑" }),
          "ai-girl": presenceEntry({ name: "ai-girl" }),
        },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    const btn = renderer!.root.find((n) => n.props.className === "d-btn role-sync-charter-btn");
    act(() => btn.props.onClick());
    expect(synced).not.toContain("ai-girl-host-codex");
    expect(synced).toContain("**ai-girl**（未归属 agent）— worker");
    expect(synced).not.toContain("lark:on_owner");
  });

  test("moderator sees a sync button that merges declared roles into the existing charter text", () => {
    let synced: string | null = null;
    render(
      baseProps({
        canModerate: true,
        charterText: "# Team charter\n\nBe kind to each other.",
        roles: [
          { name: "leo-claude", role: "host", responsibility: "统筹", assigned_by: "leo", assigned_at: 1, kind: "agent", account: "leo", display: "leo-claude" },
        ],
        presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
        onSyncToCharter: (text: string) => { synced = text; },
      }),
    );
    const btn = renderer!.root.find((n) => n.props.className === "d-btn role-sync-charter-btn");
    act(() => btn.props.onClick());
    expect(synced).not.toBeNull();
    expect(synced as unknown as string).toContain("leo-claude");
    expect(synced as unknown as string).toContain("Be kind to each other.");
  });

  test("mounting and refreshing roles stay read-only until the moderator clicks sync", () => {
    const synced: string[] = [];
    const hostRole = {
      name: "leo-claude", role: "host" as const, responsibility: "统筹", assigned_by: "leo",
      assigned_at: 1, kind: "agent" as const, account: "leo", display: "leo-claude",
    };
    const props = baseProps({
      canModerate: true,
      charterText: "# Team charter\n\nBe kind.",
      roles: [hostRole],
      presence: { "leo-claude": presenceEntry({ name: "leo-claude", account: "leo" }) },
      onSyncToCharter: (text: string) => { synced.push(text); },
    });
    render(props);
    expect(synced).toEqual([]);

    act(() => {
      renderer!.update(
        <LocaleProvider>
          <DivisionBoard
            {...props}
            roles={[{ ...hostRole, responsibility: "统筹与验收" }]}
          />
        </LocaleProvider>,
      );
    });
    expect(synced).toEqual([]);

    const btn = renderer!.root.find((node) => node.props.className === "d-btn role-sync-charter-btn");
    act(() => btn.props.onClick());
    expect(synced).toHaveLength(1);
    expect(synced[0]).toContain("统筹与验收");
  });

  test("non-moderators do not see the sync-to-charter button", () => {
    render(baseProps({ canModerate: false }));
    const btn = renderer!.root.findAll((n) => n.props.className === "d-btn role-sync-charter-btn");
    expect(btn.length).toBe(0);
  });
});

// issue #171：分工面板应该能跳到「查看/编辑每个 agent 自己的规则」（已用
// AgentTokens 面板实现，见 commit 7f7e8e1）——这里只测入口按钮的存在性/门禁和
// 点击转发，不重复造 AgentTokens 的规则编辑逻辑。
describe("DivisionBoard agent-rules entry point (#171)", () => {
  test("shows a link to the agent rules editor when the viewer can manage agent profiles", () => {
    let opened = false;
    render(baseProps({ canManageAgentRules: true, onOpenAgentRules: () => { opened = true; } }));
    const btn = renderer!.root.find((n) => n.props.className === "d-btn role-open-rules-btn");
    act(() => btn.props.onClick());
    expect(opened).toBe(true);
  });

  test("hides the link when the viewer cannot manage agent profiles", () => {
    render(baseProps({ canManageAgentRules: false }));
    const btn = renderer!.root.findAll((n) => n.props.className === "d-btn role-open-rules-btn");
    expect(btn.length).toBe(0);
  });
});
