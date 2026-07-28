// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// AgentTokens 只依赖 ../lib/api 的这几个运行时导出；类型导入会被擦除。
// 这里整体桩掉，让测试可以驱动 profile 规则的查看/编辑，而不真的打网络。
type ProfileFixture = {
  owner_account: string;
  handle: string;
  name: string;
  runner: string;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: string;
  rules: string | null;
  invitable_by: string;
  created_at: number;
  updated_at: number;
};
type AgentFixture = { name: string; owner: string; channel_scope: string; created_at: number; nickname?: string | null };

let profilesFixture: ProfileFixture[] = [];
let agentsFixture: AgentFixture[] = [];
let createdProfileOverride: ProfileFixture | null = null;
let listAgentsImpl = async () => agentsFixture;
let listProfilesImpl = async () => profilesFixture;
const createCalls: Array<{ token: string; body: Record<string, unknown> }> = [];
const nicknameCalls: Array<{ token: string; slug: string; name: string; nickname: string }> = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ConflictError: class ConflictError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createChannelAgent: async (_slug: string, name: string) => ({ name, token: "ap_created" }),
  createProjectAgentProfile: mock(async (token: string, body: Record<string, unknown>) => {
    createCalls.push({ token, body });
    // upsert：把新 rules 落回 fixture，模拟 worker 的 ON CONFLICT DO UPDATE
    const existing = profilesFixture.find((p) => p.handle === body.handle);
    if (existing) {
      existing.rules = (body.rules as string | undefined) ?? null;
      return existing;
    }
    const created = createdProfileOverride ?? profile({
      handle: String(body.handle),
      name: String(body.handle),
    });
    profilesFixture = [...profilesFixture, created];
    return created;
  }),
  inviteProjectAgent: async () => {},
  listChannelAgents: () => listAgentsImpl(),
  listProjectAgentProfiles: () => listProfilesImpl(),
  deleteChannelAgent: async () => {},
  rotateChannelAgent: async (_token: string, _slug: string, name: string) => ({
    name,
    token: "ap_rotated",
  }),
  setChannelAgentNickname: mock(async (token: string, slug: string, name: string, nickname: string) => {
    nicknameCalls.push({ token, slug, name, nickname });
    const agent = agentsFixture.find((entry) => entry.name === name);
    if (agent) agent.nickname = nickname;
    return { name, nickname };
  }),
}));

const { AgentTokens } = await import("./AgentTokens");
const { saveAgentToken, findSavedAgentToken } = await import("../lib/agentTokenVault");

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

function profile(overrides: Partial<ProfileFixture> = {}): ProfileFixture {
  return {
    owner_account: "acct-1",
    handle: "builder",
    name: "builder",
    runner: "codex",
    repo_url: "https://github.com/x/y",
    workdir: "/w",
    base_branch: "main",
    worktree_strategy: "branch",
    rules: "always run the tests",
    invitable_by: "owner",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

let renderer: ReactTestRenderer | null = null;
let windowEvents: TestEventTarget;
let documentEvents: TestEventTarget;
const insideTarget = {};

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

beforeEach(() => {
  profilesFixture = [];
  agentsFixture = [];
  createdProfileOverride = null;
  listAgentsImpl = async () => agentsFixture;
  listProfilesImpl = async () => profilesFixture;
  createCalls.length = 0;
  nicknameCalls.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage({ ap_locale: "en" }) });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://ap.test" } });
  windowEvents = new TestEventTarget();
  documentEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    },
  });
});

afterEach(async () => {
  if (renderer !== null) await act(async () => renderer?.unmount());
  renderer = null;
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "location");
});

function baseProps() {
  return {
    slug: "demo",
    token: "tok-1",
    accountKey: "acct-1",
    inviterName: "host",
    charter: null,
    onAuthFailed: () => {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderOpen(): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<LocaleProvider><AgentTokens {...baseProps()} /></LocaleProvider>, {
      createNodeMock(element) {
        if ((element.props as { className?: string }).className === "agenttokens") {
          return {
            contains: (target: unknown) => target === insideTarget,
            getBoundingClientRect: () => ({ bottom: 40, right: 700 }),
          };
        }
        return {};
      },
    });
  });
  renderer = r;
  // 打开面板 → 触发 refresh()，拉取 profiles
  await act(async () => {
    r.root.find((n) => n.props.className === "d-btn agenttokens-btn").props.onClick();
  });
  await act(async () => {}); // flush Promise.all
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

function findClass(r: ReactTestRenderer, className: string) {
  return r.root.find((n) => n.props.className === className);
}

function findClassToken(r: ReactTestRenderer, className: string) {
  return r.root.find((node) =>
    typeof node.props.className === "string"
    && node.props.className.split(/\s+/).includes(className)
  );
}

function findButton(r: ReactTestRenderer, text: string) {
  return r.root.find((node) =>
    node.type === "button"
    && node.children.some((child) => child === text)
  );
}

describe("AgentTokens project-agent rules view", () => {
  test("shows an existing profile's rules text", async () => {
    profilesFixture = [profile({ rules: "always run the tests" })];
    const r = await renderOpen();
    expect(allText(r)).toContain("always run the tests");
  });

  test("shows the empty-rules placeholder when a profile has no rules", async () => {
    profilesFixture = [profile({ rules: null })];
    const r = await renderOpen();
    expect(allText(r)).toContain("no rules set");
    expect(allText(r)).not.toContain("always run the tests");
  });
});

describe("AgentTokens functional workspaces", () => {
  test("loads channel and profile data when a controlled parent opens the manager", async () => {
    agentsFixture = [{ name: "controlled-agent", owner: "acct-1", channel_scope: "demo", created_at: 1 }];
    profilesFixture = [profile({ handle: "controlled-profile" })];
    await act(async () => {
      renderer = create(
        <LocaleProvider><AgentTokens {...baseProps()} active={true} /></LocaleProvider>,
      );
    });
    await act(async () => {});

    expect(allText(renderer!)).toContain("controlled-agent");
    expect(allText(renderer!)).toContain("controlled-profile");
  });

  test("opens the exact agent requested by an upgrade or directory action", async () => {
    agentsFixture = [
      { name: "alpha", owner: "acct-1", channel_scope: "demo", created_at: 1 },
      { name: "target-agent", owner: "acct-1", channel_scope: "demo", created_at: 2, nickname: "目标" },
    ];
    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <AgentTokens {...baseProps()} active={true} focusAgentName="target-agent" />
        </LocaleProvider>,
      );
    });
    await act(async () => {});

    const selectedRow = renderer!.root.find((node) =>
      typeof node.props.className === "string"
      && node.props.className.split(/\s+/).includes("agentmanager-list-item")
      && node.props["aria-pressed"] === true
    );
    expect(selectedRow.findAll((node) => node.children.some((child) => child === "target-agent"))).toHaveLength(1);
    expect(allText(renderer!)).toContain("目标");
  });

  test("ignores stale channel and profile refresh responses", async () => {
    agentsFixture = [{ name: "initial-agent", owner: "acct-1", channel_scope: "demo", created_at: 1 }];
    profilesFixture = [profile({ handle: "initial-profile" })];
    const r = await renderOpen();
    const firstAgents = deferred<AgentFixture[]>();
    const secondAgents = deferred<AgentFixture[]>();
    const firstProfiles = deferred<ProfileFixture[]>();
    const secondProfiles = deferred<ProfileFixture[]>();
    let agentCall = 0;
    let profileCall = 0;
    listAgentsImpl = () => (agentCall++ === 0 ? firstAgents.promise : secondAgents.promise);
    listProfilesImpl = () => (profileCall++ === 0 ? firstProfiles.promise : secondProfiles.promise);
    const channelPanel = r.root.find((node) => node.props.id === "agent-manager-panel-channel");
    const projectPanel = r.root.find((node) => node.props.id === "agent-manager-panel-projects");
    const channelRefresh = channelPanel.find((node) =>
      node.type === "button" && node.children.some((child) => child === "refresh")
    );
    const projectRefresh = projectPanel.find((node) =>
      node.type === "button" && node.children.some((child) => child === "refresh")
    );

    await act(async () => {
      channelRefresh.props.onClick();
      channelRefresh.props.onClick();
      projectRefresh.props.onClick();
      projectRefresh.props.onClick();
    });
    await act(async () => {
      secondAgents.resolve([{ name: "newest-agent", owner: "acct-1", channel_scope: "demo", created_at: 2 }]);
      secondProfiles.resolve([profile({ handle: "newest-profile" })]);
      await Promise.all([secondAgents.promise, secondProfiles.promise]);
    });
    await act(async () => {
      firstAgents.resolve([{ name: "stale-agent", owner: "acct-1", channel_scope: "demo", created_at: 3 }]);
      firstProfiles.resolve([profile({ handle: "stale-profile" })]);
      await Promise.all([firstAgents.promise, firstProfiles.promise]);
    });

    expect(allText(r)).toContain("newest-agent");
    expect(allText(r)).toContain("newest-profile");
    expect(allText(r)).not.toContain("stale-agent");
    expect(allText(r)).not.toContain("stale-profile");
  });

  test("filters channel identities without duplicating their management controls", async () => {
    agentsFixture = [
      { name: "build-bot", owner: "acct-1", channel_scope: "demo", created_at: 1, nickname: "构建" },
      { name: "release-bot", owner: "acct-1", channel_scope: "demo", created_at: 2, nickname: "发版" },
    ];
    const r = await renderOpen();
    const search = r.root.find((node) => node.props.placeholder === "Search by agent name or nickname");
    await act(async () => search.props.onChange({ target: { value: "release" } }));

    const rows = r.root.findAll((node) =>
      typeof node.props.className === "string"
      && node.props.className.split(/\s+/).includes("agentmanager-list-item")
    );
    expect(rows).toHaveLength(1);
    expect(allText(r)).toContain("release-bot");
    expect(allText(r)).not.toContain("build-bot");
  });

  test("keeps project creation behind an explicit workflow when profiles already exist", async () => {
    profilesFixture = [profile()];
    createdProfileOverride = profile({
      owner_account: "canonical-owner",
      handle: "reviewer",
      name: "reviewer",
    });
    const r = await renderOpen();
    expect(r.root.findAll((node) => node.props.className === "agentmanager-profile-form")).toHaveLength(0);

    await act(async () => findButton(r, "new project agent").props.onClick());
    const form = findClass(r, "agentmanager-profile-form");
    const handle = form.find((node) => node.props["aria-label"] === "handle");
    await act(async () => handle.props.onChange({ target: { value: "reviewer" } }));
    await act(async () => form.props.onSubmit({ preventDefault: () => {} }));
    await act(async () => {});

    expect(createCalls.at(-1)?.body.handle).toBe("reviewer");
    expect(r.root.findAll((node) => node.props.className === "agentmanager-profile-form")).toHaveLength(0);
    const selectedRow = r.root.find((node) =>
      typeof node.props.className === "string"
      && node.props.className.split(/\s+/).includes("agentmanager-list-item")
      && node.props["aria-pressed"] === true
    );
    expect(selectedRow.findAll((node) => node.children.some((child) => child === "reviewer"))).toHaveLength(1);
  });
});

describe("AgentTokens agent nickname management (#165)", () => {
  test("owner can set a Chinese nickname from the agent management panel", async () => {
    agentsFixture = [{ name: "build-bot", owner: "acct-1", channel_scope: "demo", created_at: 1, nickname: null }];
    const r = await renderOpen();

    await act(async () => findClassToken(r, "agenttokens-edit-nickname").props.onClick());
    const input = findClass(r, "agenttokens-input agenttokens-nickname-input");
    await act(async () => input.props.onChange({ target: { value: "  构建小助手  " } }));
    await act(async () => findClass(r, "d-btn d-btn--primary agenttokens-save-nickname").props.onClick());

    expect(nicknameCalls).toEqual([{ token: "tok-1", slug: "demo", name: "build-bot", nickname: "构建小助手" }]);
    expect(allText(r)).toContain("构建小助手");
  });

  test("editing an existing nickname starts with the current value", async () => {
    agentsFixture = [{ name: "build-bot", owner: "acct-1", channel_scope: "demo", created_at: 1, nickname: "旧昵称" }];
    const r = await renderOpen();
    await act(async () => findClassToken(r, "agenttokens-edit-nickname").props.onClick());
    expect(findClass(r, "agenttokens-input agenttokens-nickname-input").props.value).toBe("旧昵称");
  });

  test("keeps the nickname action reachable when search changes the selected agent", async () => {
    agentsFixture = [
      { name: "alpha", owner: "acct-1", channel_scope: "demo", created_at: 1, nickname: null },
      { name: "beta", owner: "acct-1", channel_scope: "demo", created_at: 2, nickname: null },
    ];
    const r = await renderOpen();
    await act(async () => findClassToken(r, "agenttokens-edit-nickname").props.onClick());
    const search = r.root.find((node) => node.props.placeholder === "Search by agent name or nickname");
    await act(async () => search.props.onChange({ target: { value: "beta" } }));

    expect(findClassToken(r, "agenttokens-edit-nickname")).toBeDefined();
    expect(r.root.findAll((node) => node.props.className === "agenttokens-input agenttokens-nickname-input")).toHaveLength(0);
  });
});

describe("AgentTokens project-agent rules edit", () => {
  test("editing rules re-posts the full profile (upsert) with the new rules, preserving other fields", async () => {
    profilesFixture = [profile({ rules: "old rules", repo_url: "https://github.com/x/y", base_branch: "dev" })];
    const r = await renderOpen();

    // 进入编辑
    await act(async () => {
      findClassToken(r, "agenttokens-edit-rules").props.onClick();
    });
    // textarea 预填旧值
    const textarea = r.root.find((n) => n.props["aria-label"] === "agent rules" && n.type === "textarea");
    expect(textarea.props.value).toBe("old rules");
    // 改写
    await act(async () => {
      textarea.props.onChange({ target: { value: "new rules text" } });
    });
    // 保存
    await act(async () => {
      findClassToken(r, "agenttokens-save-rules").props.onClick();
    });
    await act(async () => {});

    expect(createCalls).toHaveLength(1);
    const body = createCalls[0]!.body;
    expect(body.handle).toBe("builder");
    expect(body.rules).toBe("new rules text");
    // 关键：不能因为重新 POST 而丢掉其它字段（worker 缺字段会写成 null）
    expect(body.runner).toBe("codex");
    expect(body.repo_url).toBe("https://github.com/x/y");
    expect(body.base_branch).toBe("dev");
    expect(body.worktree_strategy).toBe("branch");
    expect(body.invitable_by).toBe("owner");
    // 保存成功后退出编辑态，展示新规则
    expect(allText(r)).toContain("new rules text");
  });

  test("cancel leaves the profile untouched and posts nothing", async () => {
    profilesFixture = [profile({ rules: "keep me" })];
    const r = await renderOpen();
    await act(async () => {
      findClassToken(r, "agenttokens-edit-rules").props.onClick();
    });
    await act(async () => {
      findClass(r, "d-btn agenttokens-cancel-rules").props.onClick();
    });
    expect(createCalls).toHaveLength(0);
    expect(allText(r)).toContain("keep me");
  });
});

describe("AgentTokens dismiss behavior", () => {
  test("exposes the manager as a shared modal dialog and keeps panel clicks inside", async () => {
    const r = await renderOpen();
    const dialog = r.root.find((node) => node.props.role === "dialog");
    expect(dialog.props["aria-modal"]).toBe("true");
    let stopped = false;
    act(() => findClass(r, "settings-panel settings-panel--agent-center agentmanager-dialog").props.onClick({
      stopPropagation: () => { stopped = true; },
    }));
    expect(stopped).toBe(true);
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(1);
  });

  test("Escape and backdrop clicks close, clear drafts, and clean up listeners", async () => {
    profilesFixture = [profile()];
    const r = await renderOpen();
    act(() => findButton(r, "Project agents").props.onClick());
    act(() => findButton(r, "new project agent").props.onClick());
    const handleInput = r.root.find((node) => node.props["aria-label"] === "handle");
    act(() => handleInput.props.onChange({ target: { value: "temporary" } }));

    expect(windowEvents.count("keydown")).toBe(1);
    expect(documentEvents.count("pointerdown")).toBe(0);
    act(() => windowEvents.emit("keydown", { key: "Escape" }));
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
    expect(windowEvents.count("keydown")).toBe(0);
    expect(documentEvents.count("pointerdown")).toBe(0);

    act(() => r.root.find((node) => node.props.className === "d-btn agenttokens-btn").props.onClick());
    expect(findButton(r, "Channel identities").props["aria-selected"]).toBe(true);
    act(() => findButton(r, "new project agent").props.onClick());
    expect(r.root.find((node) => node.props["aria-label"] === "handle").props.value).toBe("");
    act(() => findButton(r, "cancel").props.onClick());
    expect(allText(r)).toContain("always run the tests");

    act(() => findClass(r, "settings-overlay").props.onClick());
    expect(r.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
  });

  test("controlled dismiss requests onActiveChange without mutating the active prop", async () => {
    const changes: boolean[] = [];
    await act(async () => {
      renderer = create(
        <LocaleProvider>
          <AgentTokens {...baseProps()} active={true} onActiveChange={(open) => changes.push(open)} />
        </LocaleProvider>,
        {
          createNodeMock(element) {
            if ((element.props as { className?: string }).className === "agenttokens") {
              return {
                contains: (target: unknown) => target === insideTarget,
                getBoundingClientRect: () => ({ bottom: 40, right: 700 }),
              };
            }
            return {};
          },
        },
      );
    });
    act(() => findClass(renderer!, "settings-overlay").props.onClick());
    expect(changes).toEqual([false]);
    expect(renderer!.root.findAll((node) => node.props.role === "dialog")).toHaveLength(1);
  });
});

describe("AgentTokens 转为常驻", () => {
  const nodeMock = {
    createNodeMock(element: { props: unknown }) {
      return (element.props as { className?: string }).className === "agenttokens"
        ? { contains: () => false, getBoundingClientRect: () => ({ bottom: 40, right: 700 }) }
        : {};
    },
  };

  async function renderResident(extra: Record<string, unknown>): Promise<ReactTestRenderer> {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<LocaleProvider><AgentTokens {...baseProps()} {...extra} /></LocaleProvider>, nodeMock);
    });
    renderer = r;
    await act(async () => { r.root.find((n) => n.props.className === "d-btn agenttokens-btn").props.onClick(); });
    await act(async () => {});
    return r;
  }

  test("选目录后用本地 vault token 调 dutyAdopt（带 workdir，不 rotate）", async () => {
    agentsFixture = [{ name: "planner", owner: "acct-1", channel_scope: "demo", created_at: 0 }];
    saveAgentToken({ account: "acct-1", slug: "demo", name: "planner", token: "ap_saved", command: "x", savedAt: 1 });
    let confirmCalled = false;
    (globalThis as unknown as { window: { confirm: () => boolean } }).window.confirm = () => { confirmCalled = true; return true; };
    const adopted: Array<Record<string, unknown>> = [];
    const r = await renderResident({
      canMakeResident: true,
      pickDirectory: async () => "/picked/dir",
      dutyAdapter: { dutyAdopt: async (input: Record<string, unknown>) => { adopted.push(input); return {}; } },
    });
    await act(async () => {
      findClass(r, "d-btn agenttokens-resident").props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(confirmCalled).toBe(false); // 本地有 token → 不 rotate、不动线上
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ name: "planner", channel: "demo", token: "ap_saved", workdir: "/picked/dir" });
  });

  test("取消选目录 → 不 adopt", async () => {
    agentsFixture = [{ name: "planner", owner: "acct-1", channel_scope: "demo", created_at: 0 }];
    saveAgentToken({ account: "acct-1", slug: "demo", name: "planner", token: "ap_saved", command: "x", savedAt: 1 });
    const adopted: unknown[] = [];
    const r = await renderResident({
      canMakeResident: true,
      pickDirectory: async () => null,
      dutyAdapter: { dutyAdopt: async () => { adopted.push(1); return {}; } },
    });
    await act(async () => {
      findClass(r, "d-btn agenttokens-resident").props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(adopted).toHaveLength(0);
  });

  test("连点两次只 adopt 一次（ref 同步锁，#721 评审）", async () => {
    agentsFixture = [{ name: "planner", owner: "acct-1", channel_scope: "demo", created_at: 0 }];
    saveAgentToken({ account: "acct-1", slug: "demo", name: "planner", token: "ap_saved", command: "x", savedAt: 1 });
    const adopted: unknown[] = [];
    // 可控目录选择 Promise：双击发生在它 pending 期间，释放后再确定性 flush 后续链路（不靠固定计时）。
    let resolveDir!: (value: string) => void;
    const dirPromise = new Promise<string>((resolve) => { resolveDir = resolve; });
    const r = await renderResident({
      canMakeResident: true,
      pickDirectory: () => dirPromise,
      dutyAdapter: { dutyAdopt: async () => { adopted.push(1); return {}; } },
    });
    await act(async () => {
      const btn = findClass(r, "d-btn agenttokens-resident");
      btn.props.onClick(); // 第一次：同步上锁 ref，随后 await pickDirectory（pending）
      btn.props.onClick(); // 第二次：ref 非空 → 立即返回，不并发
    });
    await act(async () => {
      resolveDir("/picked/dir");
      await dirPromise;
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(adopted).toHaveLength(1);
  });

  test("非 mac 桌面（canMakeResident=false）→ 不渲染转常驻按钮", async () => {
    agentsFixture = [{ name: "planner", owner: "acct-1", channel_scope: "demo", created_at: 0 }];
    const r = await renderResident({ canMakeResident: false });
    expect(r.root.findAll((n) => n.props.className === "d-btn agenttokens-resident")).toHaveLength(0);
  });
});
