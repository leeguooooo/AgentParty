// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { ChannelStrings } from "../i18n/strings/Channel";
import { GuardSettingsPanel, type GuardSettingsPanelProps } from "./Channel";

// issue #182:「这里输入不了」+「一键设置无限模式」。
// 这里守两件事：
//  (1) 循环守卫启用时占位符是数值区间提示（1-10000），不再是误导人的「无限」——
//      「无限」占位符曾让人以为清空=无限，保存却报「必须是 1-10000」，即「输入不了」。
//  (2) 有一个一键按钮，点一下就把守卫置为无限/关闭（enabled=false）并落库。

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

const noop = () => {};

function baseProps(overrides: Partial<GuardSettingsPanelProps> = {}): GuardSettingsPanelProps {
  return {
    canModerate: true,
    loopEnabled: true,
    loopLimit: "",
    workflowEnabled: true,
    workflowLimit: "30",
    saving: null,
    error: null,
    onLoopEnabled: noop,
    onLoopLimit: noop,
    onWorkflowEnabled: noop,
    onWorkflowLimit: noop,
    onSaveLoop: noop,
    onSaveWorkflow: noop,
    onLoopUnlimited: noop,
    onWorkflowUnlimited: noop,
    ...overrides,
  };
}

function render(locale: "en" | "zh", props: GuardSettingsPanelProps) {
  localStorage.setItem("ap_locale", locale);
  act(() => {
    renderer = create(
      <LocaleProvider>
        <GuardSettingsPanel {...props} />
      </LocaleProvider>,
    );
  });
  return renderer!.root;
}

function inputs() {
  return renderer!.root.findAll((n) => n.props.className === "guard-limit-input");
}

function unlimitedButtons() {
  return renderer!.root.findAll((n) => n.type === "button" && n.props.className?.includes("guard-unlimited-btn"));
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = null;
  }
});

describe("GuardSettingsPanel input affordance (#182)", () => {
  test("loop input placeholder is a numeric range hint when enabled, not '无限'", () => {
    render("zh", baseProps({ loopEnabled: true }));
    const loop = inputs()[0]!;
    expect(loop.props.placeholder).toBe(ChannelStrings.zh["Channel.settings.loopRange"]);
    expect(loop.props.placeholder).not.toBe(ChannelStrings.zh["Channel.settings.unlimited"]);
  });

  test("loop input placeholder falls back to '无限' when the guard is off", () => {
    render("zh", baseProps({ loopEnabled: false }));
    const loop = inputs()[0]!;
    expect(loop.props.placeholder).toBe(ChannelStrings.zh["Channel.settings.unlimited"]);
  });

  test("workflow input placeholder is a numeric range hint when enabled", () => {
    render("zh", baseProps({ workflowEnabled: true }));
    const workflow = inputs()[1]!;
    expect(workflow.props.placeholder).toBe(ChannelStrings.zh["Channel.settings.workflowRange"]);
  });
});

describe("GuardSettingsPanel one-click unlimited (#182)", () => {
  test("renders a one-click unlimited button for the loop guard", () => {
    render("zh", baseProps());
    expect(unlimitedButtons().length).toBeGreaterThanOrEqual(1);
    expect(unlimitedButtons()[0]!.props.children).toBe(ChannelStrings.zh["Channel.settings.setUnlimited"]);
  });

  test("clicking the loop unlimited button fires onLoopUnlimited", () => {
    let called = 0;
    render("zh", baseProps({ onLoopUnlimited: () => { called += 1; } }));
    act(() => unlimitedButtons()[0]!.props.onClick());
    expect(called).toBe(1);
  });

  test("clicking the workflow unlimited button fires onWorkflowUnlimited", () => {
    let called = 0;
    render("zh", baseProps({ onWorkflowUnlimited: () => { called += 1; } }));
    act(() => unlimitedButtons()[1]!.props.onClick());
    expect(called).toBe(1);
  });

  test("unlimited button is disabled once the guard is already off (nothing to disable)", () => {
    render("zh", baseProps({ loopEnabled: false }));
    expect(unlimitedButtons()[0]!.props.disabled).toBe(true);
  });

  test("unlimited button is disabled for non-moderators", () => {
    render("zh", baseProps({ canModerate: false }));
    expect(unlimitedButtons()[0]!.props.disabled).toBe(true);
  });

  test("unlimited button is disabled while a save is in flight", () => {
    render("zh", baseProps({ saving: "loop" }));
    expect(unlimitedButtons()[0]!.props.disabled).toBe(true);
  });
});

describe("GuardSettingsPanel i18n (#182)", () => {
  const KEYS = [
    "Channel.settings.loopRange",
    "Channel.settings.workflowRange",
    "Channel.settings.setUnlimited",
    "Channel.settings.turnOff",
  ];

  test("every new key exists in both en and zh", () => {
    for (const key of KEYS) {
      expect(ChannelStrings.en[key], `en missing ${key}`).toBeTruthy();
      expect(ChannelStrings.zh[key], `zh missing ${key}`).toBeTruthy();
    }
  });

  test("action-label copy is real Chinese, not the English string", () => {
    for (const key of ["Channel.settings.setUnlimited", "Channel.settings.turnOff"]) {
      expect(ChannelStrings.zh[key], `zh copied en for ${key}`).not.toBe(ChannelStrings.en[key]);
    }
  });
});
