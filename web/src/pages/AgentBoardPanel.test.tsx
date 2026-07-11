// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PresenceEntry, TaskRecord } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

const { AgentBoardPanel } = await import("./Channel");

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function presence(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return { name, kind: "agent", state: "waiting", note: null, ts: 0, ...over } as PresenceEntry;
}

function task(id: number, assignee: string | null, state: TaskRecord["state"]): TaskRecord {
  return {
    type: "task", id, channel: "c", title: `t${id}`, desc: null, state,
    assignee: assignee === null ? null : { name: assignee, kind: "agent" },
    created_by: "h", created_by_kind: "human", priority: 0, labels: [], parent_id: null,
    anchor_seqs: [], completion_artifact: null, workflow_id: null, scope: [], blocked_reason: null,
    external_ref: null, created_at: 0, updated_at: 0, completed_at: null,
  };
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "localStorage");
});

function render(locale: "en" | "zh", presenceList: PresenceEntry[], tasks: TaskRecord[]): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: locale }) });
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(<LocaleProvider><AgentBoardPanel presence={presenceList} tasks={tasks} /></LocaleProvider>);
  });
  renderer = r;
  return r;
}
function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) walk((node as { children: unknown }).children);
  };
  walk(r.toJSON());
  return out.join(" ");
}

describe("AgentBoardPanel (#187)", () => {
  test("groups tasks by assignee and derives busy/offline status from presence", () => {
    const p = [presence("alice", { state: "working", live: true }), presence("bob", { live: false })];
    const tasks = [
      task(1, "alice", "in_progress"), task(2, "alice", "in_progress"), task(3, "alice", "assigned"),
      task(4, "bob", "needs_review"),
      task(5, null, "in_progress"), // 无 assignee 不计入任何 agent
      task(6, "alice", "done"), // done 不计入在手
    ];
    const txt = allText(render("en", p, tasks));
    // alice：busy + 2 in progress + 1 queued
    expect(txt).toContain("alice");
    expect(txt).toContain("busy");
    expect(txt).toContain("2"); // in progress
    // bob：live=false → offline，且有 1 待审
    expect(txt).toContain("bob");
    expect(txt).toContain("offline");
    // 无 assignee 的 task5 不产生「未命名」agent 行
    expect(txt).not.toContain("t5");
  });

  test("empty when no agents and no assigned tasks", () => {
    const txt = allText(render("zh", [], []));
    expect(txt).toContain("还没有 agent");
  });

  test("offline agent with backlog still shows (from task assignee union)", () => {
    // 一个不在 presence 里但有任务的 agent 也要显示（离线但手里有活）
    const txt = allText(render("en", [], [task(1, "ghost", "assigned")]));
    expect(txt).toContain("ghost");
    expect(txt).toContain("offline");
  });
});
