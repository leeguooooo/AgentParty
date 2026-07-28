// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { ResidentDutyLogsStrings } from "../i18n/strings/ResidentDutyLogs";
import type { DesktopAgentConfig, DesktopAgentStatus, DesktopDutyEntry } from "../lib/desktopAgent";
import { ResidentDutyLogs } from "./ResidentDutyLogs";

const duty: DesktopDutyEntry = {
  label: "com.agentparty.duty.cfg.ops",
  instanceId: "cfg:ops",
  plistPath: "/p",
  logPath: "/l",
  loaded: true,
};
const config: DesktopAgentConfig = {
  configId: "cfg",
  name: "ops-reviewer",
  serverOrigin: "https://party.example.com",
  channel: "ops",
  kind: "agent",
  role: "reviewer",
};
const instance: DesktopAgentStatus = {
  state: "running",
  pid: 1,
  configId: "app",
  name: "app-builder",
  channel: "build",
  runner: "codex",
  startedAt: null,
  exitCode: null,
  lastError: null,
  instanceId: "app:build",
  workdir: null,
  repo: null,
};
const t = (key: string) => ResidentDutyLogsStrings.en[key] ?? key;
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

async function renderLogs(
  overrides: Record<string, unknown> = {},
  createNodeMock?: (element: ReactElement) => unknown,
) {
  const adapter = {
    dutyList: async () => [duty],
    dutyLogRead: async () => "serve online\nWARN reconnecting\nERROR runner failed",
    listConfigs: async () => [config],
    statusAll: async () => [instance],
    logsInstance: async () => ["app ready"],
    ...overrides,
  };
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <ResidentDutyLogs t={t} adapter={adapter as never} />
      </LocaleProvider>,
      createNodeMock === undefined ? undefined : { createNodeMock },
    );
  });
  return renderer!.root;
}

function findButton(root: ReactTestInstance, text: string) {
  return root.findAllByType("button").find((node) =>
    node.children.map((child) => typeof child === "string" ? child : child.children.join("")).join("").includes(text),
  )!;
}

describe("unified local agent logs", () => {
  test("loads all app and resident logs with human-readable identity and channel labels", async () => {
    await renderLogs();
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("ops-reviewer");
    expect(output).toContain("#ops");
    expect(output).toContain("app-builder");
    expect(output).toContain("[ERROR] [ops-reviewer #ops] ERROR runner failed");
    expect(output).toContain("[INFO] [app-builder #build] app ready");
  });

  test("filters Error, Warn, and Info without losing the source identity", async () => {
    const root = await renderLogs();
    await act(async () => findButton(root, "Error").props.onClick());
    let output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("runner failed");
    expect(output).not.toContain("reconnecting");
    await act(async () => findButton(root, "Warn").props.onClick());
    output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("reconnecting");
    expect(output).not.toContain("runner failed");
  });

  test("selecting one Agent reloads only that source", async () => {
    let dutyReads = 0;
    let instanceReads = 0;
    const root = await renderLogs({
      dutyLogRead: async () => { dutyReads += 1; return "duty only"; },
      logsInstance: async () => { instanceReads += 1; return ["instance only"]; },
    });
    const select = root.findByType("select");
    await act(async () => {
      select.props.onChange({ currentTarget: { value: "duty:cfg:ops" } });
      await Promise.resolve();
    });
    expect(dutyReads).toBe(2);
    expect(instanceReads).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("duty only");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("instance only");
  });

  test("positions the combined log at the latest line", async () => {
    const logNode = { scrollTop: 0, scrollHeight: 720 };
    await renderLogs({}, (element) => element.type === "pre" ? logNode : {});
    expect(logNode.scrollTop).toBe(720);
  });

  test("shows source failures without crashing or hiding readable sources", async () => {
    await renderLogs({ dutyLogRead: async () => { throw new Error("log unavailable"); } });
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("Some agent logs could not be read");
    expect(output).toContain("app ready");
  });
});
