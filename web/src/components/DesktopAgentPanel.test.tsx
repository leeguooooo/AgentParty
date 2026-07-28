// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { DesktopSettingsStrings } from "../i18n/strings/DesktopSettings";
import type {
  DesktopAgentAdapter,
  DesktopAgentConfig,
  DesktopAgentStartInput,
  DesktopAgentStatus,
  DesktopDutyEntry,
} from "../lib/desktopAgent";
import { DesktopAgentPanel, type DesktopAgentScheduler } from "./DesktopAgentPanel";

const config: DesktopAgentConfig = {
  configId: "local-main",
  name: "Leo Codex",
  serverOrigin: "https://party.example.com",
  channel: "agentparty",
  kind: "project",
  role: "worker",
};
const stopped: DesktopAgentStatus = {
  state: "stopped",
  pid: null,
  configId: null,
  name: null,
  channel: null,
  runner: null,
  startedAt: null,
  exitCode: null,
  lastError: null,
  instanceId: null,
  workdir: null,
  repo: null,
};
const running: DesktopAgentStatus = {
  ...stopped,
  state: "running",
  pid: 42,
  configId: config.configId,
  name: config.name,
  channel: "agentparty",
  runner: "codex",
  instanceId: "local-main:agentparty",
};
const resident: DesktopDutyEntry = {
  label: "com.agentparty.duty.local-main.agentparty",
  instanceId: "local-main:agentparty",
  plistPath: "/p",
  logPath: "/l",
  loaded: true,
};

function adapter(overrides: Partial<DesktopAgentAdapter> = {}): DesktopAgentAdapter {
  return {
    listConfigs: async () => [config],
    status: async () => stopped,
    statusAll: async () => [],
    start: async () => running,
    stop: async () => stopped,
    stopInstance: async () => stopped,
    logs: async () => [],
    logsInstance: async () => [],
    dutyList: async () => [],
    dutyPersist: async () => resident,
    dutyUnpersist: async () => {},
    dutyRestart: async () => {},
    dutyAdopt: async () => resident,
    dutyLogRead: async () => "",
    ...overrides,
  };
}

const t = (key: string, vars?: Record<string, string | number>) => {
  const value = DesktopSettingsStrings.en[key] ?? key;
  return vars ? value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`)) : value;
};
const noPolling: DesktopAgentScheduler = { every: () => () => {} };
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

async function renderPanel(value: DesktopAgentAdapter, active = true) {
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <DesktopAgentPanel t={t} adapter={value} scheduler={noPolling} active={active} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function control(name: string) {
  return renderer!.root.find((node) => node.props.name === name);
}
function button(label: string) {
  return renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === label);
}

describe("DesktopAgentPanel launcher responsibilities", () => {
  test("shows only launch controls and points running/resident management to overview and logs", async () => {
    await renderPanel(adapter({
      statusAll: async () => [running],
      dutyList: async () => [resident],
    }));
    const output = JSON.stringify(renderer!.toJSON());
    expect(output).toContain("1 app agent(s) running · 1 resident");
    expect(output).not.toContain(resident.instanceId);
    expect(output).not.toContain(resident.logPath);
    expect(output).not.toContain("Show local agent logs");
  });

  test("starts the selected identity with channel, runner, workdir, and repo", async () => {
    const calls: DesktopAgentStartInput[] = [];
    await renderPanel(adapter({
      start: async (input) => {
        calls.push(input);
        return running;
      },
    }));
    await act(async () => {
      control("desktop-agent-channel").props.onChange({ target: { value: "ops" } });
      control("desktop-agent-workdir").props.onChange({ target: { value: "/srv/ops" } });
      control("desktop-agent-repo").props.onChange({ target: { value: "https://example.com/ops.git" } });
    });
    await act(async () => {
      await button("Start local agent").props.onClick();
    });
    expect(calls).toEqual([{
      configId: "local-main",
      channel: "ops",
      runner: "codex",
      workdir: "/srv/ops",
      repo: "https://example.com/ops.git",
    }]);
  });

  test("resident mode persists the configured agent instead of starting an app instance", async () => {
    const persists: DesktopAgentStartInput[] = [];
    let starts = 0;
    await renderPanel(adapter({
      dutyPersist: async (input) => {
        persists.push(input);
        return resident;
      },
      start: async () => {
        starts += 1;
        return running;
      },
    }));
    await act(async () => {
      control("desktop-agent-persist").props.onChange({ target: { checked: true } });
    });
    await act(async () => {
      await button("Start local agent").props.onClick();
    });
    expect(starts).toBe(0);
    expect(persists[0]).toMatchObject({ configId: "local-main", channel: "agentparty", runner: "codex" });
  });

  test("pauses native loading while inactive", async () => {
    let configReads = 0;
    await renderPanel(adapter({ listConfigs: async () => { configReads += 1; return [config]; } }), false);
    expect(configReads).toBe(0);
  });

  test("shows a retry action when native loading fails", async () => {
    await renderPanel(adapter({
      listConfigs: async () => { throw new Error("native unavailable"); },
      statusAll: async () => { throw new Error("native unavailable"); },
      status: async () => { throw new Error("native unavailable"); },
    }));
    expect(JSON.stringify(renderer!.toJSON())).toContain("native unavailable");
    expect(button("Retry loading").props.disabled).not.toBe(true);
  });
});
