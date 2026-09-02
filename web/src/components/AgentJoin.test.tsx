// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { clearApiBase, setApiBase } from "../lib/base";
// 版本闸跟随刚发布的 CLI（joinPack 从 cli/package.json 派生），断言引用常量而非写死数字，杜绝再漂移。
import { MIN_CLI_UNATTENDED } from "../lib/joinPack";
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";

const savedAgents: Array<{ name: string; token: string; command: string }> = [];
const VAULT_KEY = "ap_agent_token_vault:v1";

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ConflictError: class ConflictError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createChannelAgent: mock(async (_slug: string, name: string) => ({ name, token: "ap_created" })),
  // #1005 stepper 用到的两个：轮询后备（测试都直接注入 presence/messages，所以恒空）与换 token。
  rotateChannelAgent: mock(async (_token: string, _slug: string, name: string) => ({ name, token: "ap_rotated" })),
  fetchChannelPresence: mock(async () => []),
  fetchMessages: mock(async () => []),
}));

// 用真实 vault 覆盖持久化和复制路径，避免 mock.module 污染同一 Bun 进程里的
// agentTokenVault 单测。#642 仍通过受控的 execCommand 返回值覆盖成功/失败。
let copyResult = true;

const { AgentJoin, wakeableSessionCommand, wakeableCommandCarriesToken, recoverCommand, recoverHarness } = await import("./AgentJoin");

class TestEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

let renderer: ReactTestRenderer | null = null;
let windowEvents: TestEventTarget;
let storedLocale: string | null;
let storedVault: string | null;
let originalDocumentDescriptor: PropertyDescriptor | undefined;
let originalClipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  savedAgents.length = 0;
  storedLocale = null;
  storedVault = null;
  copyResult = true;
  windowEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://party.test" } });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => (key === "ap_locale" ? storedLocale : key === VAULT_KEY ? storedVault : null),
      setItem: (key: string, value: string) => {
        if (key === "ap_locale") storedLocale = value;
        if (key === VAULT_KEY) {
          storedVault = value;
          savedAgents.splice(0, savedAgents.length, ...JSON.parse(value));
        }
      },
    },
  });
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
  originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        value: "",
        setAttribute: () => {},
        style: {},
        select: () => {},
      }),
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
      execCommand: () => copyResult,
    },
  });
});

afterEach(() => {
  clearApiBase(); // #530：清掉测试里注入的 runtime apiBase，避免泄漏到后续用例/文件
  act(() => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "location");
  Reflect.deleteProperty(globalThis, "localStorage");
  if (originalClipboardDescriptor === undefined) {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
  } else {
    Object.defineProperty(globalThis.navigator, "clipboard", originalClipboardDescriptor);
  }
  if (originalDocumentDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
  }
});

function render(
  onActiveChange?: (open: boolean) => void,
  charter: React.ComponentProps<typeof AgentJoin>["charter"] = null,
  extra: Partial<React.ComponentProps<typeof AgentJoin>> = {},
): ReactTestRenderer {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <AgentJoin
          slug="demo"
          token="owner-token"
          namePrefix="leo"
          inviterName="host"
          charter={charter}
          accountKey="acct-1"
          onActiveChange={onActiveChange}
          {...extra}
        />
      </LocaleProvider>,
    );
  });
  return renderer as ReactTestRenderer;
}

function open(r: ReactTestRenderer) {
  act(() => r.root.find((node) => node.props.className === "d-btn d-btn--primary agent-join-btn").props.onClick());
}

describe("AgentJoin dismiss behavior", () => {
  // #992：粘贴稿只剩「一句话（分步引导）+ 一条命令」，那句话排在 party join 之前；
  // charter 不再快照进包（改由 party join 加入时拉取），所以管理员可控文本绝不出现在粘贴稿里。
  test("guide sentence precedes the party join command; moderator charter is not baked into the pack", async () => {
    const r = render(undefined, {
      charter: "MODERATOR CONTROLLED CHARTER",
      charter_rev: 1,
      updated_at: 1,
      updated_by: "moderator",
    });
    open(r);
    await act(async () => {
      await r.root
        .find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick)
        .props.onClick();
    });

    const command = savedAgents[0]!.command;
    expect(command).toContain("分步引导");
    expect(command).toContain("告诉你怎么修");
    // 管理员可控文本绝不进粘贴稿（连注释化快照都不放了）。
    expect(command).not.toContain("MODERATOR CONTROLLED CHARTER");
    // 那一句话排在 party join 命令之前。
    expect(command.indexOf("分步引导")).toBeLessThan(command.indexOf("party join "));
  });

  test("Escape closes the compose dialog, reports controlled state, and removes its listener", () => {
    const changes: boolean[] = [];
    const r = render((value) => changes.push(value));
    open(r);

    const dialog = r.root.find((node) => node.props.role === "dialog");
    expect(dialog.props["aria-modal"]).toBe("true");
    expect(windowEvents.count("keydown")).toBe(1);

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(changes).toEqual([true, false]);
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(windowEvents.count("keydown")).toBe(0);
  });

  test("scrim closes but clicking the card itself has no dismiss handler", () => {
    const r = render();
    open(r);
    const card = r.root.find((node) => node.props.className === "d-card agent-join-card");
    expect(card.props.onClick).toBeUndefined();

    act(() => r.root.find((node) => node.props.className === "agent-join-scrim").props.onClick());
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
  });

  test("Escape closes the completed dialog without undoing the saved agent token", async () => {
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
    expect(savedAgents.map(({ name, token }) => ({ name, token }))).toEqual([{ name: "leo-demo", token: "ap_created" }]);
    // #944：保存的命令就是新的两行接入包——token 走 AGENTPARTY_TOKEN 前缀，绝不进 argv（无 --token）。
    expect(savedAgents[0]?.command).toContain("party join --server");
    expect(savedAgents[0]?.command).toContain("AGENTPARTY_TOKEN='ap_created' party join");
    expect(savedAgents[0]?.command).not.toContain("--token");

    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(savedAgents.map(({ name, token }) => ({ name, token }))).toEqual([{ name: "leo-demo", token: "ap_created" }]);

    open(r);
    const input = r.root.find((node) => node.props.className === "t-mono agent-join-nameinput");
    expect(input.props.value).toBe("leo-demo");
  });

  // #992：粘贴稿 = 一句话 + 一条命令。行为约定不再进粘贴稿（`party join` 落成 rules 文件），
  // 逐轮待命/确认路由的长篇指引更早就收进了 `party join`（#944）。
  test("join pack is one guide sentence plus exactly one party join command — no prompt block", async () => {
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });

    const command = savedAgents[0]!.command;
    const lines = command.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeLessThanOrEqual(3);
    const executable = lines.filter((l) => !l.startsWith("#"));
    expect(executable).toHaveLength(1);
    expect(executable[0]).toMatch(/^AGENTPARTY_TOKEN='ap_created' party join --server \S+ --channel \S+ --as \S+( --mention \S+)? --yes$/);
    // 三行行为约定 / 长篇待命指引都不在粘贴稿里了。
    expect(command).not.toContain("Trellis");
    expect(command).not.toContain("交给子 agent");
    expect(command).not.toContain("re-anchor");
    expect(command).not.toContain("watch --once");
    expect(command).not.toContain("party init");
  });
});

describe("AgentJoin 无人值守值守预设 (#612)", () => {
  function pickUnattended(r: ReactTestRenderer) {
    act(() =>
      r.root
        .find((node) => node.props.name === "agent-join-mode" && node.props.value === "unattended")
        .props.onChange(),
    );
  }
  async function generate(r: ReactTestRenderer) {
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
  }
  // #749：unattended 的 runner 选择器（仅 unattended 模式渲染）。
  function pickRunner(r: ReactTestRenderer, value: string) {
    act(() =>
      r.root
        .find((node) => node.props.name === "agent-join-runner")
        .props.onChange({ target: { value } }),
    );
  }

  test("选无人值守 → 默认生成 serve --runner codex 的运维脚本（#749：不再写死 claude），vault 记 mode+runner", async () => {
    const r = render();
    open(r);
    pickUnattended(r);
    await generate(r);

    const saved = savedAgents[0]! as { command: string; mode?: string; runner?: string };
    expect(saved.mode).toBe("unattended");
    expect(saved.runner).toBe("codex");
    expect(saved.command).toContain("party serve --channel demo --runner codex");
    expect(saved.command).not.toContain("--runner claude");
    expect(saved.command).toContain(`need=${MIN_CLI_UNATTENDED}`);
    expect(saved.command).toContain("party init --server ");
    // 值守机脚本给人跑，不该出现交互包的 harness 步骤
    expect(saved.command).not.toContain("claude mcp add");
    expect(saved.command).not.toContain("party watch");
  });

  test("选无人值守 + 选 runner=claude → 脚本 --runner claude，vault 记 runner=claude（#749：picker 生效）", async () => {
    const r = render();
    open(r);
    pickUnattended(r);
    pickRunner(r, "claude");
    await generate(r);

    const saved = savedAgents[0]! as { command: string; runner?: string };
    expect(saved.runner).toBe("claude");
    expect(saved.command).toContain("party serve --channel demo --runner claude");
    expect(saved.command).not.toContain("--runner codex");
  });

  test("无人值守包的 charter 快照仍整体注释化（管理员可控文本不落成可执行行）", async () => {
    const r = render(undefined, {
      charter: "MODERATOR CONTROLLED CHARTER",
      charter_rev: 1,
      updated_at: 1,
      updated_by: "moderator",
    });
    open(r);
    pickUnattended(r);
    await generate(r);

    const command = savedAgents[0]!.command;
    expect(command).toContain("# MODERATOR CONTROLLED CHARTER");
    expect(command).not.toMatch(/^MODERATOR CONTROLLED CHARTER$/m);
  });

  test("默认仍是交互接入：不动选择器时产物是「一句话 + 一条 party join」接入包（#992）", async () => {
    const r = render();
    open(r);
    await generate(r);
    const saved = savedAgents[0]! as { command: string; mode?: string };
    expect(saved.mode).toBe("interactive");
    // 交互接入＝一条 party join … --yes（进入分步引导），不是 unattended 的 serve 运维脚本。
    expect(saved.command).toContain("party join --server");
    expect(saved.command).toMatch(/ --yes$/);
    expect(saved.command).not.toContain("--runner claude");
    expect(saved.command).not.toContain("party serve");
  });
});

describe("AgentJoin 桌面一键接管 (#616 phase 4)", () => {
  function pickUnattended(r: ReactTestRenderer) {
    act(() =>
      r.root
        .find((node) => node.props.name === "agent-join-mode" && node.props.value === "unattended")
        .props.onChange(),
    );
  }
  function pickRunner(r: ReactTestRenderer, value: string) {
    act(() =>
      r.root
        .find((node) => node.props.name === "agent-join-runner")
        .props.onChange({ target: { value } }),
    );
  }
  async function generate(r: ReactTestRenderer) {
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
  }

  test("桌面环境 + 无人值守：选工作目录后调 dutyAdopt（带 workdir），token 走 IPC 而非 URL", async () => {
    localStorage.setItem("ap_locale", "en");
    setApiBase("https://agentparty.leeguoo.com");
    const adopts: unknown[] = [];
    const r = render(undefined, null, {
      desktopDetect: () => true,
      pickDirectory: async () => "/picked/dir",
      dutyAdapter: {
        dutyAdopt: async (input: unknown) => {
          adopts.push(input);
          return {
            label: "com.agentparty.duty.x.demo",
            instanceId: "x:demo",
            plistPath: "/p",
            logPath: "/l",
            loaded: true,
          };
        },
      },
    });
    open(r);
    pickUnattended(r);
    await generate(r);

    const adoptBtn = r.root.find(
      (node) => node.type === "button" && String(node.children[0] ?? "").includes("Choose a folder"),
    );
    await act(async () => {
      await adoptBtn.props.onClick();
    });
    expect(adopts).toEqual([
      {
        server: "https://agentparty.leeguoo.com",
        token: "ap_created",
        name: "leo-demo",
        channel: "demo",
        runner: "codex", // #749：默认 codex,不再写死 claude
        workdir: "/picked/dir",
      },
    ]);
    expect(JSON.stringify(renderer!.toJSON())).toContain("resident ✓");
  });

  test("桌面 + 无人值守 + 选 runner=claude：dutyAdopt 带 runner=claude（#749：picker 驱动接管）", async () => {
    localStorage.setItem("ap_locale", "en");
    setApiBase("https://agentparty.leeguoo.com");
    const adopts: Array<{ runner?: string }> = [];
    const r = render(undefined, null, {
      desktopDetect: () => true,
      pickDirectory: async () => "/picked/dir",
      dutyAdapter: {
        dutyAdopt: async (input: { runner?: string }) => {
          adopts.push(input);
          return {
            label: "com.agentparty.duty.x.demo",
            instanceId: "x:demo",
            plistPath: "/p",
            logPath: "/l",
            loaded: true,
          };
        },
      },
    });
    open(r);
    pickUnattended(r);
    pickRunner(r, "claude");
    await generate(r);
    const adoptBtn = r.root.find(
      (node) => node.type === "button" && String(node.children[0] ?? "").includes("Choose a folder"),
    );
    await act(async () => {
      await adoptBtn.props.onClick();
    });
    expect(adopts).toHaveLength(1);
    expect(adopts[0]!.runner).toBe("claude");
  });

  test("桌面 + 无人值守：取消选目录 → 不 adopt", async () => {
    localStorage.setItem("ap_locale", "en");
    setApiBase("https://agentparty.leeguoo.com");
    const adopts: unknown[] = [];
    const r = render(undefined, null, {
      desktopDetect: () => true,
      pickDirectory: async () => null,
      dutyAdapter: { dutyAdopt: async (input: unknown) => { adopts.push(input); return {} as never; } },
    });
    open(r);
    pickUnattended(r);
    await generate(r);
    const adoptBtn = r.root.find(
      (node) => node.type === "button" && String(node.children[0] ?? "").includes("Choose a folder"),
    );
    await act(async () => { await adoptBtn.props.onClick(); });
    expect(adopts).toEqual([]);
  });

  test("接管成功后重开生成新 agent：不残留上一次选的目录（#724 adoptDir 复位）", async () => {
    localStorage.setItem("ap_locale", "en");
    setApiBase("https://agentparty.leeguoo.com");
    const r = render(undefined, null, {
      desktopDetect: () => true,
      pickDirectory: async () => "/picked/dir",
      dutyAdapter: {
        dutyAdopt: async () => ({
          label: "com.agentparty.duty.x.demo",
          instanceId: "x:demo",
          plistPath: "/p",
          logPath: "/l",
          loaded: true,
        }),
      },
    });
    open(r);
    pickUnattended(r);
    await generate(r);
    const adoptBtn = r.root.find(
      (node) => node.type === "button" && String(node.children[0] ?? "").includes("Choose a folder"),
    );
    await act(async () => { await adoptBtn.props.onClick(); });
    expect(JSON.stringify(renderer!.toJSON())).toContain("/picked/dir");
    // 关掉重开，为下一个 agent 再生成无人值守命令——旧目录必须消失
    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    open(r);
    pickUnattended(r);
    await generate(r);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("/picked/dir");
  });

  test("web（非桌面）+ 无人值守：不渲染运行按钮，改引导装桌面版 + 手动命令", async () => {
    localStorage.setItem("ap_locale", "en");
    const r = render(undefined, null, { desktopDetect: () => false });
    open(r);
    pickUnattended(r);
    await generate(r);
    // 没有「选工作目录并运行」按钮
    expect(
      r.root.findAll((node) => node.type === "button" && String(node.children[0] ?? "").includes("Choose a folder")),
    ).toHaveLength(0);
    // 有「安装桌面版」入口
    const json = JSON.stringify(renderer!.toJSON());
    expect(json).toContain("Install the desktop app");
  });
});

describe("AgentJoin 接入包 server 域名 (#530)", () => {
  // 桌面版(Tauri)里 location.origin 是 tauri://localhost，接入包若用它拼 `party join --server`
  // 会让 agent 报错/连不上。修复要求：apiBase() 非空(桌面注入了真后端)时用 apiBase()，
  // 只有同源 web(apiBase 为空)才回退 location.origin。
  // 本用例里 location.origin = https://party.test，代表「不该被用到的伪源」。
  test("apiBase() 非空时，party join --server 用注入的真实后端而非 location.origin", async () => {
    setApiBase("https://agentparty.leeguoo.com");
    const r = render();
    open(r);
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });

    const command = savedAgents[0]!.command;
    // 关键断言：--server 用的是 apiBase() 的真后端
    expect(command).toContain("party join --server https://agentparty.leeguoo.com ");
    // 绝不能回退到 location.origin(桌面端的伪源，此处以 https://party.test 代表)
    expect(command).not.toContain("party join --server https://party.test");
  });
});

describe("AgentJoin 复制反馈 (#642)", () => {
  async function generate(r: ReactTestRenderer) {
    await act(async () => {
      await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
    });
  }

  test("复制失败弹出错误横幅，不再静默（命令带只展示一次的 token）", async () => {
    copyResult = false;
    const r = render();
    open(r);
    await generate(r);
    await act(async () => {
      // #1005：stepper 里每步各有一个复制按钮（① 装 CLI / ② 接入命令），按 data-cmd 精确取带 token 的那条。
      await r.root
        .find((node) => node.props.className === "d-btn agent-join-copy" && node.props["data-cmd"] === "join")
        .props.onClick();
    });
    expect(r.root.findAll((node) => node.props.className === "banner banner--red agent-join-copyerr")).toHaveLength(1);
  });

  test("复制成功不显示错误横幅、按钮切到已复制", async () => {
    localStorage.setItem("ap_locale", "en");
    copyResult = true;
    const r = render();
    open(r);
    await generate(r);
    await act(async () => {
      // #1005：stepper 里每步各有一个复制按钮（① 装 CLI / ② 接入命令），按 data-cmd 精确取带 token 的那条。
      await r.root
        .find((node) => node.props.className === "d-btn agent-join-copy" && node.props["data-cmd"] === "join")
        .props.onClick();
    });
    expect(r.root.findAll((node) => node.props.className === "banner banner--red agent-join-copyerr")).toHaveLength(0);
    // #654 复审：不止「没有错误横幅」，还要确认按钮切到「已复制」文案——
    // 这样删掉 setCopied(ok) 会让本条挂掉（否则仅靠错误横幅缺席，删了也照样绿）。
    const copyBtn = r.root.find(
      (node) => node.props.className === "d-btn agent-join-copy" && node.props["data-cmd"] === "join",
    );
    expect(String(copyBtn.children[0] ?? "")).toBe("copied ✓");
  });
});

// #1005：弹窗从「复制一整段」改成四步引导。这一组钉的是**每步只在服务端真的发生了才打勾**——
// 判据全部来自注入的 presence / 历史（与 party who 同源），不是本地猜。
describe("AgentJoin 分步引导 (#1005)", () => {
  const NOW = 1_800_000_000_000;

  function stepper(extra: Partial<React.ComponentProps<typeof AgentJoin>> = {}) {
    const props = { presence: [] as PresenceEntry[], messages: [] as MsgFrame[], now: () => NOW, liveNoteDelayMs: 0, ...extra };
    const r = render(undefined, null, props);
    open(r);
    return {
      r,
      async generate() {
        await act(async () => {
          await r.root.find((node) => node.props.className === "d-btn d-btn--primary" && node.props.onClick).props.onClick();
        });
      },
      rerender(next: Partial<React.ComponentProps<typeof AgentJoin>>) {
        act(() => {
          r.update(
            <LocaleProvider>
              <AgentJoin
                slug="demo"
                token="owner-token"
                namePrefix="leo"
                inviterName="host"
                charter={null}
                accountKey="acct-1"
                active
                {...props}
                {...next}
              />
            </LocaleProvider>,
          );
        });
      },
    };
  }

  /** 从 ② 的命令里读出这次铸出来的身份名（`--as <name>`）。 */
  function agentName(r: ReactTestRenderer): string {
    const cmd = String(r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children);
    return /--as (\S+)/.exec(cmd)?.[1] ?? "";
  }

  function statusOf(r: ReactTestRenderer, step: number): string {
    return String(r.root.find((n) => n.props["data-step"] === step).props["data-status"]);
  }

  function presenceOf(name: string, over: Record<string, unknown> = {}): PresenceEntry {
    return {
      name,
      kind: "agent",
      state: "online",
      note: null,
      ts: NOW,
      last_seen: NOW,
      live: true,
      wake: { kind: "serve" },
      ...over,
    } as unknown as PresenceEntry;
  }

  function msgOf(over: Record<string, unknown>): MsgFrame {
    return {
      type: "msg",
      channel: "demo",
      kind: "message",
      sender: { name: "someone", kind: "agent" },
      body: "hi",
      mentions: [],
      reply_to: null,
      ts: NOW,
      ...over,
    } as unknown as MsgFrame;
  }

  // #1040：四步门控卡片改成「命令区 + 三盏灯」。灯的 data-step 沿用 2/3/4，判据一字不差；
  // 「装 party」不再是一步，变成命令区里的开关（见下面的用例）。
  test("刚生成命令：报到灯在等，后两盏未亮（没报到就不许打勾）", async () => {
    const s = stepper();
    await s.generate();
    expect([statusOf(s.r, 2), statusOf(s.r, 3), statusOf(s.r, 4)]).toEqual(["active", "pending", "pending"]);
    // 命令不再门控：接入命令与起会话命令一开始就都给出来
    expect(s.r.root.findAll((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "session")).toHaveLength(1);
  });

  test("频道里出现它的报到消息 ⇒ ②（连同①）打勾并展开③", async () => {
    const s = stepper();
    await s.generate();
    const name = agentName(s.r);
    s.rerender({ messages: [msgOf({ seq: 88, sender: { name, kind: "agent" } })] });
    expect([statusOf(s.r, 2), statusOf(s.r, 3)]).toEqual(["done", "active"]);
    // 摘要要带真实 seq，不是「命令复制过了」。
    const done = s.r.root.findAll((n) => n.props.className === "agent-join-step-status agent-join-step-status--done t-mono");
    expect(done.some((n) => String(n.children.join("")).includes("88"))).toBe(true);
  });

  test("presence 显示 live + 有唤醒层 ⇒ ③ 打勾并展开④；只有蛰伏档（wake=none）时 ③ 仍在做", async () => {
    const s = stepper();
    await s.generate();
    const name = agentName(s.r);
    const checkedIn = [msgOf({ seq: 88, sender: { name, kind: "agent" } })];
    // 裸 claude 蛰伏档：在线但没有唤醒层——绝不能打勾（#979 那条虚报就是这么来的）。
    s.rerender({ messages: checkedIn, presence: [presenceOf(name, { wake: { kind: "none" } })] });
    expect([statusOf(s.r, 3), statusOf(s.r, 4)]).toEqual(["active", "pending"]);
    s.rerender({ messages: checkedIn, presence: [presenceOf(name)] });
    expect([statusOf(s.r, 3), statusOf(s.r, 4)]).toEqual(["done", "active"]);
  });

  test("④ 从这里发测试 @ 后收到回帖 ⇒ 四步全勾并显示完成句", async () => {
    const sent: Array<{ body: string; mention: string }> = [];
    const s = stepper({ sendMessage: (body: string, mention: string) => (sent.push({ body, mention }), true) });
    await s.generate();
    const name = agentName(s.r);
    const base = [msgOf({ seq: 88, sender: { name, kind: "agent" } })];
    s.rerender({ messages: base, presence: [presenceOf(name)] });
    await act(async () => {
      await s.r.root.find((n) => n.props.className === "d-btn d-btn--primary agent-join-probe-btn").props.onClick();
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mention).toBe(name);
    const probeSeq = 101;
    s.rerender({
      messages: [
        ...base,
        msgOf({ seq: probeSeq, sender: { name: "leo", kind: "human" }, body: sent[0]!.body }),
        msgOf({ seq: 102, sender: { name, kind: "agent" }, reply_to: probeSeq, ts: NOW + 2000 }),
      ],
      presence: [presenceOf(name)],
    });
    expect([statusOf(s.r, 3), statusOf(s.r, 4)]).toEqual(["done", "done"]);
    expect(s.r.root.findAll((n) => n.props.className === "banner banner--green agent-join-complete")).toHaveLength(1);
  });

  test("④ 超时按 presence 分层定位：投出去了但没人在听 ⇒ 说「没人在听」并指回第 3 步", async () => {
    // 组件的 now 由 tickMs 定时器推进；测试把 tick 调到 1ms，rerender 换掉 nowFn 后真等一格。
    const sent: string[] = [];
    const s = stepper({
      sendMessage: (body: string) => (sent.push(body), true),
      verifyTimeoutMs: 1_000,
      tickMs: 1,
      now: () => NOW,
    });
    await s.generate();
    const name = agentName(s.r);
    const base = [msgOf({ seq: 88, sender: { name, kind: "agent" } })];
    s.rerender({ messages: base, presence: [presenceOf(name)] });
    await act(async () => {
      await s.r.root.find((n) => n.props.className === "d-btn d-btn--primary agent-join-probe-btn").props.onClick();
    });
    // 探针进了历史（服务端接受）、但该身份 deaf，且时钟越过超时窗口。
    s.rerender({
      // 探针正文按当前语言渲染，别写死——用 sendMessage 真的收到的那条，才判得出「已投递」。
      messages: [...base, msgOf({ seq: 101, sender: { name: "leo", kind: "human" }, body: sent[0]! })],
      presence: [presenceOf(name, { listening: "deaf" })],
      now: () => NOW + 5_000,
      tickMs: 1,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const texts = s.r.root
      .findAll((n) => typeof n.props.className === "string" && /agent-join-step-(wait|status)/.test(String(n.props.className)))
      .map((n) => String(n.children.join("")));
    expect(texts.some((line) => line.includes("没人在听") || line.includes("nothing is listening"))).toBe(true);
  });

  test("关掉再打开：② 不再显示明文 token，给「生成新 token」入口；点了就换成新命令", async () => {
    const s = stepper();
    await s.generate();
    const before = String(
      s.r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
    expect(before).toContain("ap_created");
    // 关掉弹窗（token 只出现一次），再从「继续接入」回到 stepper。
    act(() => s.r.root.find((n) => n.props.className === "agent-join-close t-mono").props.onClick());
    act(() => s.r.root.find((n) => n.props.className === "d-btn agent-join-resume").props.onClick());
    // token 只出现一次：回到 stepper 时 ② 换成「重新生成」面板，整棵树里不再有明文 token。
    expect(s.r.root.findAll((n) => n.props.className === "agent-join-regen")).toHaveLength(1);
    expect(JSON.stringify(s.r.toJSON())).not.toContain("ap_created");
    await act(async () => {
      await s.r.root.find((n) => n.props.className === "d-btn agent-join-regen-btn").props.onClick();
    });
    const rotated = String(
      s.r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
    expect(rotated).toContain("ap_rotated");
  });

  // owner 实测（#1005 上线后）：① 已经单列「装 party」，② 的粘贴稿里又带一句
  // 「没有 party 命令就先装 curl … | sh」——同一条命令在同一个弹窗里出现两遍。
  test("② 只给那一条 party join，不再重复 ① 的安装命令、也不夹引导句", async () => {
    const s = stepper();
    await s.generate();
    const join = String(
      s.r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
    expect(join.split("\n")).toHaveLength(1);
    expect(join.startsWith("AGENTPARTY_TOKEN=")).toBe(true);
    expect(join).toContain("party join");
    expect(join).not.toContain("install.sh");
    expect(join).not.toContain("#");
    // #1040：安装命令不再单列一步，变成「那台机器还没装」开关——勾上才并进同一条命令，一次复制。
    expect(s.r.root.findAll((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "install")).toHaveLength(0);
    const toggle = s.r.root.find((n) => n.props.type === "checkbox" && typeof n.props.onChange === "function");
    act(() => toggle.props.onChange({ target: { checked: true } }));
    const joined = String(
      s.r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
    expect(joined.startsWith("curl -fsSL")).toBe(true);
    expect(joined).toContain("install.sh | sh && AGENTPARTY_TOKEN=");
  });

  // codex stop-time review on 3d65e20：无人值守脚本自带「版本闸 + 缺了才装」，① 再给一条
  // curl 就是同一个弹窗两条安装命令；另外 ② 带着明文 token，必须显眼地警告别贴到公开地方。
  test("无人值守：① 不再给安装命令（脚本自带），弹窗里安装命令只出现在 ② 那一段", async () => {
    const s = stepper();
    act(() => {
      const radios = s.r.root.findAll((n) => n.props.type === "radio" && typeof n.props.onChange === "function");
      const unattended = radios.find((n) => String(n.props.value) === "unattended");
      unattended?.props.onChange({ target: { value: "unattended" } });
    });
    await s.generate();
    expect(s.r.root.findAll((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "install")).toHaveLength(0);
    const join = String(
      s.r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
    // 值守脚本自带版本闸/安装，那是它自己的一部分，不算重复。
    expect(join).toContain("party serve");
  });

  // 安全行移出复制内容后不能丢；而且 interactive 与 unattended 的命令**都**带明文 token，
  // 警告只挂在其中一支就是漏（codex stop-time review 连着抓了两轮）。
  test.each([
    ["interactive", false],
    ["unattended", true],
  ] as const)("② 带明文 token 的两种模式都要警告别贴到公开地方（%s）", async (_label: string, useUnattended: boolean) => {
    const s = stepper();
    if (useUnattended) {
      act(() => {
        const radios = s.r.root.findAll((n) => n.props.type === "radio" && typeof n.props.onChange === "function");
        radios.find((n) => String(n.props.value) === "unattended")?.props.onChange({ target: { value: "unattended" } });
      });
    }
    await s.generate();
    const safety = s.r.root.findAll((n) => String(n.props.className ?? "").includes("agent-join-tokensafety"));
    expect(safety).toHaveLength(1);
    const text = String(safety[0]!.children.join(""));
    expect(/公开|public/i.test(text)).toBe(true);
    expect(/argv|ps|history/i.test(text)).toBe(true);
    // 必须排在可复制命令**之前**：无人值守是一段长脚本，警告放后面会被推出视野。
    const json = JSON.stringify(s.r.toJSON());
    expect(json.indexOf("agent-join-tokensafety")).toBeLessThan(json.indexOf('"data-cmd":"join"'));
    // 而且要看得见、听得见：黄底 banner + 有 role/label 让读屏播报，不是 12px 暗色小字。
    const banner = s.r.root.find((n) => String(n.props.className ?? "").includes("agent-join-tokenbanner"));
    expect(String(banner.props.className)).toContain("banner--yellow");
    // 播报走 live region：区域先空着落地，文字晚一拍填入（stepper() 注入 0 延迟，等一个 tick 即可）。
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const live = s.r.root.find((n) => String(n.props.className ?? "").includes("agent-join-sr-only"));
    expect(["status", "alert"]).toContain(live.props.role);
    expect(String(live.children.join(""))).toContain(text.slice(0, 12));
    // 「只出现这一次」并进同一条 banner，不再单独挂在命令之后。
    expect(banner.findAll((n) => String(n.props.className ?? "").includes("agent-join-warn"))).toHaveLength(1);
    expect(json.indexOf("agent-join-warn")).toBeLessThan(json.indexOf('"data-cmd":"join"'));
  });

  // live region 的可靠性判据：弹窗还没开、token 还没铸出来时它就得在 DOM 里；
  // 内容随后由 effect 填入，才算「已存在区域的内容变化」（codex review 第七轮）。
  test("播报区先以空内容落地、文字晚一拍才填——区域与文字同批插入读屏不念", async () => {
    // 延迟设成一个够长的值：generate 之后立刻看，区域已在、但还没有文字。
    const s = stepper({ liveNoteDelayMs: 10_000 });
    await s.generate();
    const atMount = s.r.root.find((n) => String(n.props.className ?? "").includes("agent-join-sr-only"));
    expect(["status", "alert"]).toContain(atMount.props.role);
    expect(String(atMount.children.join(""))).toBe("");
    // 换成 0 延迟重挂一次，确认文字确实会填进去。
    const fast = stepper({ liveNoteDelayMs: 0 });
    await fast.generate();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const filled = fast.r.root.find((n) => String(n.props.className ?? "").includes("agent-join-sr-only"));
    expect(String(filled.children.join("")).length).toBeGreaterThan(0);
  });

  // overlay 是 aria-modal="true"：VoiceOver 只念弹窗子树里的东西，挂在弹窗外的 live region
  // 完全不播报（codex review 第八轮）。所以播报区必须是 dialog 的后代。
  test("播报区在 dialog 子树内（aria-modal 下弹窗外的 live region 不会被念）", async () => {
    const s = stepper();
    await s.generate();
    const overlay = s.r.root.find((n) => String(n.props.className ?? "") === "agent-join-overlay");
    expect(overlay.props["aria-modal"]).toBe("true");
    const live = overlay.findAll((n) => String(n.props.className ?? "").includes("agent-join-sr-only"));
    expect(live).toHaveLength(1);
    expect(["status", "alert"]).toContain(live[0]!.props.role);
  });

  test("recover 不带 token ⇒ 不渲染那条安全警告（没有明文可泄露）", () => {
    const r = render(undefined, null, { recoverName: "aaa", presence: [], messages: [], now: () => NOW });
    expect(r.root.findAll((n) => String(n.props.className ?? "").includes("agent-join-tokensafety"))).toHaveLength(0);
  });

  test("标题两种句式都完整：接入是「让 X 加入」，重连是「把 X 重新接上」", async () => {
    const s = stepper();
    await s.generate();
    const title = s.r.root.find((n) => n.props.className === "d-title agent-join-title");
    const text = title.children.map((c) => (typeof c === "string" ? c : String((c as { children?: unknown[] }).children?.[0] ?? ""))).join("");
    expect(text).toContain("add");
    expect(text).toContain("guided setup");
    const r2 = render(undefined, null, { recoverName: "aaa", presence: [], messages: [], now: () => NOW });
    const t2 = r2.root.find((n) => n.props.className === "d-title agent-join-title");
    const text2 = t2.children.map((c) => (typeof c === "string" ? c : String((c as { children?: unknown[] }).children?.[0] ?? ""))).join("");
    expect(text2).toContain("reconnect");
    expect(text2).toContain("guided setup");
  });

  test("恢复入口：recoverName 直接进 stepper，② 给的是 party recover，不铸新身份", () => {
    // recover 是挂载即进 stepper（成员详情点「重新接上」），不走「＋ 让 agent 加入」那条铸造路径。
    const r = render(undefined, null, { recoverName: "aaa", presence: [], messages: [], now: () => NOW });
    const cmd = String(
      r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
    expect(cmd).toContain("party recover demo");
    expect(cmd).not.toContain("party join");
    expect(cmd).not.toContain("AGENTPARTY_TOKEN");
  });

  // #1009：「接入凭证」面板的「接入引导 / 重新接上」经频道页转过来的一次会话——同一个 stepper。
  function joinCmd(r: ReactTestRenderer): string {
    return String(
      r.root.find((n) => n.props.className === "agent-join-cmd" && n.props["data-cmd"] === "join").props.children[0].props.children,
    );
  }

  test("guideSession 打开：② 就是面板给的那条命令（含 token），并渲染 token 安全警告", () => {
    const r = render(undefined, null, {
      guideSession: {
        name: "helper-bot",
        command: "AGENTPARTY_TOKEN='ap_x' party join --server https://party.example --channel demo --as helper-bot --yes",
        mode: "interactive",
        harness: "codex",
        runner: "codex",
        recover: false,
        token: "ap_x",
      },
      presence: [],
      messages: [],
      now: () => NOW,
    });
    expect(joinCmd(r)).toBe(
      "AGENTPARTY_TOKEN='ap_x' party join --server https://party.example --channel demo --as helper-bot --yes",
    );
    expect(r.root.findAll((n) => String(n.props.className ?? "").includes("agent-join-tokensafety"))).toHaveLength(1);
  });

  test("guideSession 的 recover 形态：默认「接着上次的对话」，切到「先诊断」才是 party recover；不含 token、不渲染安全警告", () => {
    const r = render(undefined, null, {
      guideSession: {
        name: "helper-bot",
        command: "party recover demo",
        mode: "interactive",
        harness: "codex",
        runner: "codex",
        recover: true,
        token: null,
      },
      presence: [],
      messages: [],
      now: () => NOW,
    });
    // codex 身份、presence 没记上次会话 ⇒ 接最近一次 thread
    expect(joinCmd(r)).toBe("party bridge codex demo --resume-last");
    expect(joinCmd(r)).not.toContain("AGENTPARTY_TOKEN");
    expect(r.root.findAll((n) => String(n.props.className ?? "").includes("agent-join-tokensafety"))).toHaveLength(0);
    act(() => {
      r.root.find((n) => n.props.type === "radio" && String(n.props.value) === "diagnose").props.onChange();
    });
    expect(joinCmd(r)).toBe("party recover demo");
  });

  // #1040：owner 要的就是这个——「用户一般想直接 resume 一个对话」。presence.agent_session 记了
  // 上次会话 id 时，重连命令精确到 --resume <id>，harness 也以那次会话为准（名字猜错也不怕）。
  test("recover + presence 记了上次 claude 会话 ⇒ 默认命令精确 --resume <session_id>", () => {
    const r = render(undefined, null, {
      recoverName: "aaa",
      presence: [
        {
          name: "aaa",
          kind: "agent",
          state: "offline",
          note: null,
          ts: NOW - 60_000,
          last_seen: NOW - 60_000,
          agent_session: { harness: "claude", session_id: "8aff5437-4afc-4be7-997c-a8c64584927d", updated_at: NOW - 60_000, cwd: "/work/demo" },
        } as unknown as PresenceEntry,
      ],
      messages: [],
      now: () => NOW,
    });
    expect(joinCmd(r)).toBe("party claude demo -- --resume 8aff5437-4afc-4be7-997c-a8c64584927d");
    const on = r.root.find((n) => String(n.props.className ?? "").includes("agent-join-plan-option--on"));
    expect(on.props["data-plan"]).toBe("resume");
    const toggle = r.root.find((n) => n.props.type === "checkbox" && typeof n.props.onChange === "function");
    act(() => toggle.props.onChange({ target: { checked: true } }));
    expect(joinCmd(r)).toBe(
      "curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh && party claude demo -- --resume 8aff5437-4afc-4be7-997c-a8c64584927d",
    );
  });

  test("recover 身份猜不出 harness（other）且无上次会话 ⇒ 没有「接着上次」这一档，默认先诊断", () => {
    const r = render(undefined, null, { recoverName: "aaa", presence: [], messages: [], now: () => NOW });
    const plans = r.root.findAll((n) => typeof n.props["data-plan"] === "string").map((n) => n.props["data-plan"]);
    expect(plans).toEqual(["diagnose", "fresh"]);
    expect(joinCmd(r)).toBe("party recover demo");
  });
});

describe("recoverCommand（#1040 重连三档）", () => {
  const claudeResume = { harness: "claude" as const, sessionId: "sid-1", cwd: null };
  test("resume：claude 有 sid 精确 --resume，没有用 --continue；codex 有 thread 用 --resume，没有 --resume-last", () => {
    expect(recoverCommand("resume", "ludo", "claude", claudeResume)).toBe("party claude ludo -- --resume sid-1");
    expect(recoverCommand("resume", "ludo", "claude", null)).toBe("party claude ludo -- --continue");
    expect(recoverCommand("resume", "ludo", "codex", { harness: "codex", sessionId: "t-1", cwd: null })).toBe("party bridge codex ludo --resume t-1");
    expect(recoverCommand("resume", "ludo", "codex", null)).toBe("party bridge codex ludo --resume-last");
  });
  test("claude 的 resume 带 token 走环境变量前缀；codex 绝不加", () => {
    expect(recoverCommand("resume", "ludo", "claude", claudeResume, "ap_x")).toBe("AGENTPARTY_TOKEN='ap_x' party claude ludo -- --resume sid-1");
    expect(recoverCommand("resume", "ludo", "codex", null, "ap_x")).toBe("party bridge codex ludo --resume-last");
  });
  test("fresh 与第③步同一条；diagnose 恒为 party recover", () => {
    expect(recoverCommand("fresh", "ludo", "claude", claudeResume)).toBe("party claude ludo");
    expect(recoverCommand("diagnose", "ludo", "claude", claudeResume)).toBe("party recover ludo");
  });
  test("presence 的 codex-sdk 会话按 codex 处理；harness 以上次会话为准", () => {
    expect(recoverHarness("other", { harness: "codex-sdk", sessionId: "t", cwd: null })).toBe("codex");
    expect(recoverHarness("codex", { harness: "claude", sessionId: "s", cwd: null })).toBe("claude");
    expect(recoverHarness("other", null)).toBe("other");
  });
});

// #1029：owner「唤醒会话应该是带 token 的」。重连引导要解决的正是「本地 token 被撤销」，
// 不带凭据的 `party claude <chan>` 在这个场景下必然失败。
describe("第③步的唤醒命令带 token（#1029）", () => {
  test("有明文 token ⇒ claude 那条带 AGENTPARTY_TOKEN 前缀（走环境变量，不进 argv flag）", () => {
    const cmd = wakeableSessionCommand("ludo", "claude", "ap_secret-123");
    expect(cmd).toBe("AGENTPARTY_TOKEN='ap_secret-123' party claude ludo");
    expect(cmd).not.toContain("--token");
    expect(wakeableCommandCarriesToken("claude", "ap_secret-123")).toBe(true);
  });

  test("没有 token ⇒ 与今天一字不差", () => {
    expect(wakeableSessionCommand("ludo", "claude")).toBe("party claude ludo");
    expect(wakeableSessionCommand("ludo", "claude", null)).toBe("party claude ludo");
    expect(wakeableCommandCarriesToken("claude", null)).toBe(false);
  });

  test("serve 不认这个环境变量 ⇒ 绝不给它加前缀（否则是一条骗人的命令）", () => {
    expect(wakeableSessionCommand("ludo", "codex", "ap_secret")).toBe("party serve ludo --runner codex");
    expect(wakeableSessionCommand("ludo", "other", "ap_secret")).toBe("party serve ludo");
    expect(wakeableCommandCarriesToken("codex", "ap_secret")).toBe(false);
  });

  test("含 shell 元字符的 token 一律不拼进命令", () => {
    for (const bad of ["a'b", "a b", "a;rm -rf /", "$(id)"]) {
      expect(wakeableSessionCommand("ludo", "claude", bad)).toBe("party claude ludo");
      expect(wakeableCommandCarriesToken("claude", bad)).toBe(false);
    }
  });
});

// #1028 端到端：owner 截图里第 ② 步打了 ✓，依据是「已报到（4637 分钟前）」。
// 纯函数用例挡不住这个——判据读的是 session.baseline，只更新 baselineRef 的修复完全不生效
// （CodeRabbit on #1031 指出、变异自检实测确认）。所以这条用例必须真渲染弹窗。
