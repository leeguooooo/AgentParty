// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { TaskRecord } from "@agentparty/shared";
import { LocaleProvider } from "../i18n/locale";

// Channel.tsx 会 import dompurify（经 markdown 链路）——测试环境里存桩掉。
mock.module("dompurify", () => ({
  default: { addHook: () => {}, sanitize: (value: string) => value },
}));

const { TaskLedgerPanel, isTaskLedgerStatusNote } = await import("./Channel");

// #204 P1②：判定哪些 system status 触发任务台账刷新（多客户端一致性）。
describe("isTaskLedgerStatusNote (#204 P1②)", () => {
  test("matches worker-broadcast task status notes", () => {
    expect(isTaskLedgerStatusNote("task #12 in_progress")).toBe(true);
    expect(isTaskLedgerStatusNote("task #3 blocked")).toBe(true);
    expect(isTaskLedgerStatusNote("task #1 done")).toBe(true);
  });
  test("ignores non-task and lookalike notes (no false refetch)", () => {
    expect(isTaskLedgerStatusNote("charter updated to rev 5")).toBe(false);
    expect(isTaskLedgerStatusNote("worker-a working on task #5")).toBe(false); // 必须以 task # 开头
    expect(isTaskLedgerStatusNote("task #x oops")).toBe(false); // 需数字 id
    expect(isTaskLedgerStatusNote("task #12")).toBe(false); // 需 state 段（后随空格）
  });
});

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

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    type: "task",
    id: 1,
    channel: "demo",
    title: "wire the task panel",
    desc: null,
    state: "backlog",
    assignee: null,
    created_by: "human-a",
    created_by_kind: "human",
    priority: 0,
    labels: [],
    parent_id: null,
    anchor_seqs: [],
    completion_artifact: null,
    workflow_id: null,
    scope: [],
    blocked_reason: null,
    external_ref: null,
    created_at: 0,
    updated_at: 0,
    completed_at: null,
    ...overrides,
  };
}

type PanelProps = Parameters<typeof TaskLedgerPanel>[0];

function baseProps(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    tasks: [task()],
    loading: false,
    error: null,
    canWrite: true,
    busyTaskId: null,
    actionError: null,
    creating: false,
    createError: null,
    onRefresh: () => {},
    onSetState: () => {},
    onAssign: () => {},
    onReview: () => {},
    onCreateTask: async () => true,
    ...overrides,
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

function render(locale: "en" | "zh", props: PanelProps): ReactTestRenderer {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_locale: locale }),
  });
  let r!: ReactTestRenderer;
  void act(() => {
    r = create(<LocaleProvider><TaskLedgerPanel {...props} /></LocaleProvider>);
  });
  renderer = r;
  return r;
}

function allText(r: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object" && "children" in (node as Record<string, unknown>)) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(r.toJSON());
  return out.join(" ");
}

function findByAria(r: ReactTestRenderer, label: string) {
  return r.root.find((n) => n.props["aria-label"] === label);
}

describe("TaskLedgerPanel i18n", () => {
  test("renders Chinese action + column labels when locale is zh", () => {
    const r = render("zh", baseProps());
    const text = allText(r);
    expect(text).toContain("认领"); // Claim
    expect(text).toContain("阻塞"); // Block
    expect(text).toContain("新建任务"); // New task
    expect(text).toContain("待办"); // backlog state label
    expect(text).not.toContain("Claim");
    expect(text).not.toContain("New task");
  });

  test("renders English labels when locale is en", () => {
    const r = render("en", baseProps());
    const text = allText(r);
    expect(text).toContain("Claim");
    expect(text).toContain("New task");
  });
});

describe("TaskLedgerPanel new-task entry", () => {
  test("opening the composer and submitting fires onCreateTask exactly once with the typed values", async () => {
    const calls: Array<{ title: string; desc: string }> = [];
    const onCreateTask = mock(async (input: { title: string; desc: string }) => {
      calls.push(input);
      return true;
    });
    const r = render("en", baseProps({ onCreateTask }));

    // open composer
    await act(async () => {
      findByAria(r, "New task").props.onClick();
    });
    // type a title
    await act(async () => {
      findByAria(r, "New task title").props.onChange({ currentTarget: { value: "ship it" } });
    });
    // submit the form
    await act(async () => {
      await r.root.find((n) => n.props.className === "task-new-form").props.onSubmit({ preventDefault() {} });
    });

    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([{ title: "ship it", desc: "" }]);
  });

  test("submitting with an empty title never calls onCreateTask", async () => {
    const onCreateTask = mock(async () => true);
    const r = render("en", baseProps({ onCreateTask }));

    await act(async () => {
      findByAria(r, "New task").props.onClick();
    });
    await act(async () => {
      await r.root.find((n) => n.props.className === "task-new-form").props.onSubmit({ preventDefault() {} });
    });

    expect(onCreateTask).toHaveBeenCalledTimes(0);
  });
});
