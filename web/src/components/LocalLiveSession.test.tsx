// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopSettingsStrings } from "../i18n/strings/DesktopSettings";
import { LocalAgentsOverviewStrings } from "../i18n/strings/LocalAgentsOverview";
import type { DesktopAgentAdapter, DesktopAgentStatus, DesktopDutyEntry } from "../lib/desktopAgent";
import { parseLocalLiveOutput, readLocalLiveOutput, type LocalLiveTarget } from "../lib/localLiveOutput";
import type { LiveSession } from "../state";
import { LocalAgentsOverview, localLiveTarget } from "./LocalAgentsOverview";

// #1103 item 1：桌面本机 Agent 面板的 live 入口——读本机 tap 快照、只读渲染、按实例/常驻正确定位。

const merged: Record<string, string> = { ...DesktopSettingsStrings.en, ...LocalAgentsOverviewStrings.en };
const t = (key: string, vars?: Record<string, string | number>) => {
  const raw = merged[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : raw;
};
const SECRET = "ap_" + "DesktopTapSecret1234";

function inst(over: Partial<DesktopAgentStatus> = {}): DesktopAgentStatus {
  return {
    state: "running", pid: 1, configId: "cfg", name: "planner", channel: "ops", runner: "claude",
    startedAt: null, exitCode: null, lastError: null, instanceId: "cfg:ops", workdir: null, repo: null, ...over,
  };
}
function duty(over: Partial<DesktopDutyEntry> = {}): DesktopDutyEntry {
  return { label: "com.agentparty.duty.abc", instanceId: "cfg2:dev", plistPath: "/p", logPath: "/log", loaded: true, ...over };
}
function adapter(over: Partial<DesktopAgentAdapter> = {}): DesktopAgentAdapter {
  return {
    listConfigs: async () => [],
    status: async () => inst({ state: "stopped", instanceId: null }),
    statusAll: async () => [],
    start: async () => inst(),
    stop: async () => inst({ state: "stopped" }),
    stopInstance: async () => inst({ state: "stopped" }),
    logs: async () => [],
    logsInstance: async () => [],
    dutyList: async () => [],
    dutyPersist: async () => { throw new Error("na"); },
    dutyUnpersist: async () => {},
    dutyRestart: async () => {},
    dutyAdopt: async () => { throw new Error("na"); },
    dutyLogRead: async () => "",
    ...over,
  };
}

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => "en", setItem: () => {}, removeItem: () => {} },
  });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
});

async function render(a: DesktopAgentAdapter): Promise<ReactTestInstance> {
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <LocalAgentsOverview t={t} adapter={a} scheduler={{ every: () => () => {} }} />
      </LocaleProvider>,
      { createNodeMock: () => ({ focus: () => {}, querySelectorAll: () => [], contains: () => true, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }) },
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return renderer!.root;
}

const liveButtons = (root: ReactTestInstance) =>
  root.findAll((n) => n.type === "button" && String(n.props.className ?? "").includes("local-agents-open-live"));

test("parseLocalLiveOutput 校验形状并重新脱敏/去控制字符", () => {
  const session = parseLocalLiveOutput({
    v: 1,
    session_id: "run-1",
    task_seq: 4,
    state: "running",
    updated_at: 5,
    lines: [
      { kind: "stdout", text: `key ${SECRET}[31m red`, ts: 1 },
      { kind: "bogus", text: "x", ts: 1 },
      { kind: "text", text: "   ", ts: 1 },
    ],
  }, "cfg:ops");
  expect(session?.lines).toEqual([{ kind: "stdout", text: "key [redacted] red", ts: 1 }]);
  expect(parseLocalLiveOutput({ session_id: "r", state: "weird", task_seq: null, lines: [] }, "x")).toBeNull();
  expect(parseLocalLiveOutput([], "x")).toBeNull();
  expect(parseLocalLiveOutput({ session_id: "r", state: "done", task_seq: null, lines: [] }, "x")).toBeNull();
  expect(parseLocalLiveOutput({ session_id: "r", state: "done", task_seq: null, lines: [], updated_at: Number.NaN }, "x")).toBeNull();
});

test("readLocalLiveOutput 调只读命令并把 null 当「还没有输出」", async () => {
  const calls: Array<[string, unknown]> = [];
  const invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    return null as T;
  };
  expect(await readLocalLiveOutput(invoke, { kind: "duty", id: "lbl" }, "n")).toBeNull();
  expect(calls).toEqual([["desktop_agent_live_output", { kind: "duty", id: "lbl" }]]);
});

test("localLiveTarget：实例按 instanceId、常驻按 launchd label", () => {
  expect(localLiveTarget({ kind: "instance", instanceId: "cfg:ops" })).toEqual({ kind: "instance", id: "cfg:ops" });
  expect(localLiveTarget({ kind: "duty", instanceId: "cfg2:dev", duty: duty() })).toEqual({ kind: "duty", id: "com.agentparty.duty.abc" });
  expect(localLiveTarget({ kind: "instance", instanceId: null })).toBeNull();
});

test("面板每行有 live 入口，打开后只读显示本机 runner 输出（无输入框）", async () => {
  const reads: LocalLiveTarget[] = [];
  const session: LiveSession = {
    name: "cfg:ops", session_id: "run-1", task_seq: 7, state: "running", updated_at: 1,
    lines: [{ kind: "tool", text: "▸ Bash", ts: 1 }, { kind: "text", text: "working on it", ts: 2 }],
  };
  const root = await render(adapter({
    statusAll: async () => [inst()],
    dutyList: async () => [duty()],
    liveOutput: async (target) => {
      reads.push(target);
      return session;
    },
  }));
  const buttons = liveButtons(root);
  expect(buttons.length).toBe(2);
  await act(async () => buttons[0]!.props.onClick());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(reads.length).toBeGreaterThanOrEqual(1);
  expect(["instance", "duty"]).toContain(reads[0]!.kind);
  const text = JSON.stringify(renderer!.toJSON());
  expect(text).toContain("working on it");
  expect(text).toContain("▸ Bash");
  expect(root.findAll((n) => n.type === "input" || n.type === "textarea").filter((n) => String(n.props.type) !== "search")).toHaveLength(0);
});

test("旧壳没有 liveOutput 时不显示入口", async () => {
  const root = await render(adapter({ statusAll: async () => [inst()] }));
  expect(liveButtons(root)).toHaveLength(0);
});
