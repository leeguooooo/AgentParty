// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// #895：vault 的「复制接入包」对 #847 之前建的旧记录只能给全量档（两种 harness 的唤醒指引都在），
// 而全量档对 codex 身份是【错的操作指引】（#879：codex 不靠 watch --once 唤醒）。
// 这里守的是补救链路：详情面板有可见、可改、会写回的 harness 选择器，旧记录按名字启发式预选。
const copiedTexts: string[] = [];

type AgentFixture = { name: string; owner: string; channel_scope: string; created_at: number; nickname?: string | null };
let agentsFixture: AgentFixture[] = [];

mock.module("../lib/api", () => ({
  AuthError: class AuthError extends Error {},
  ConflictError: class ConflictError extends Error {},
  ForbiddenError: class ForbiddenError extends Error {},
  ValidationError: class ValidationError extends Error {},
  createChannelAgent: async (_slug: string, name: string) => ({ name, token: "ap_created" }),
  createProjectAgentProfile: async () => {
    throw new Error("unused in this test");
  },
  inviteProjectAgent: async () => {},
  listChannelAgents: async () => agentsFixture,
  listProjectAgentProfiles: async () => [],
  deleteChannelAgent: async () => {},
  rotateChannelAgent: async (_token: string, _slug: string, name: string) => ({ name, token: "ap_rotated" }),
  setChannelAgentNickname: async (_token: string, _slug: string, name: string, nickname: string) => ({ name, nickname }),
}));

const { AgentTokens } = await import("./AgentTokens");

const VAULT_KEY = "ap_agent_token_vault:v1";

// harness 分档的指纹行：每条都是接入包里真实的可执行命令/指引整行，不是随处可见的词，
// 这样删掉 builder 里对应分支或改错档位时断言必然变红（弱变异挡不住的那种）。
const CLAUDE_ONLY_MCP = "claude mcp add party-";
const CLAUDE_ONLY_WATCH = "party watch demo --mentions-only --once";
const CLAUDE_ONLY_PLUGIN = "claude plugin marketplace add leeguooooo/AgentParty || true";
const CODEX_ONLY_PLUGIN = "codex plugin marketplace add leeguooooo/AgentParty || true";
const CODEX_ONLY_HOOK = "party hook install --codex || true";

function vaultSeed(records: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    records.map((rec) => ({
      account: "acct-1",
      slug: "demo",
      token: "ap_tok",
      command: "# stale frozen text",
      savedAt: 0,
      ...rec,
    })),
  );
}

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
}

let renderer: ReactTestRenderer | null = null;
const insideTarget = {};
let originalClipboardDescriptor: PropertyDescriptor | undefined;

function installEnv(vaultJson: string) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage({ ap_locale: "en", [VAULT_KEY]: vaultJson }),
  });
}

beforeEach(() => {
  agentsFixture = [];
  copiedTexts.length = 0;
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copiedTexts.push(text);
      },
    },
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  installEnv(vaultSeed([]));
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "https://party.example" },
  });
  const windowEvents = new TestEventTarget();
  const documentEvents = new TestEventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      setTimeout: globalThis.setTimeout.bind(globalThis),
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
  if (originalClipboardDescriptor === undefined) {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
  } else {
    Object.defineProperty(globalThis.navigator, "clipboard", originalClipboardDescriptor);
  }
});

async function renderOpen(): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <LocaleProvider>
        <AgentTokens
          slug="demo"
          token="tok-1"
          accountKey="acct-1"
          inviterName="host"
          charter={null}
          onAuthFailed={() => {}}
        />
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
  renderer = r;
  await act(async () => {
    r.root.find((n) => n.props.className === "d-btn agenttokens-btn").props.onClick();
  });
  await act(async () => {});
  return r;
}

function harnessSelects(r: ReactTestRenderer) {
  return r.root.findAll((n) => n.type === "select" && n.props.id === "agenttokens-pack-harness-select");
}

async function copyPack(r: ReactTestRenderer): Promise<string> {
  const before = copiedTexts.length;
  // 按位置取（actions 里的第一个按钮就是「复制接入包」）——复制后按钮文案会变成 "copied"，
  // 靠文案找的话同一测试里连点两次就抓不到了。
  const actions = r.root.findAll((n) => n.props.className === "agenttokens-actions agenttokens-pack-actions");
  expect(actions.length).toBe(1);
  const buttons = actions[0]!.findAll((n) => n.type === "button");
  expect(buttons.length).toBe(2);
  await act(async () => {
    buttons[0]!.props.onClick();
  });
  expect(copiedTexts.length).toBe(before + 1);
  return copiedTexts[copiedTexts.length - 1]!;
}

function seedOne(rec: Record<string, unknown>, agentName: string) {
  installEnv(vaultSeed([{ name: agentName, ...rec }]));
  agentsFixture = [{ name: agentName, owner: "acct-1", channel_scope: "demo", created_at: 0 }];
}

describe("AgentTokens join-pack harness picker (#895)", () => {
  test("a record with a stored harness generates that harness's pack, name notwithstanding", async () => {
    // 名字里写着 claude，存的 harness 是 codex —— 存下来的事实必须压过名字启发式。
    seedOne({ harness: "codex" }, "team-claude-helper");
    const r = await renderOpen();

    expect(harnessSelects(r)[0]!.props.value).toBe("codex");
    // 选择器就挨着「复制接入包」按钮——档位必须在点它之前就看得见。
    expect(
      r.root.findAll((n) => n.props.className === "agenttokens-actions agenttokens-pack-actions")[0]!
        .findAll((n) => n.type === "button")[0]!.props.children,
    ).toBe("copy join pack");
    const pack = await copyPack(r);
    expect(pack).toContain(CODEX_ONLY_PLUGIN);
    expect(pack).toContain(CODEX_ONLY_HOOK);
    expect(pack).not.toContain(CLAUDE_ONLY_MCP);
    expect(pack).not.toContain(CLAUDE_ONLY_WATCH);
    expect(pack).not.toContain(CLAUDE_ONLY_PLUGIN);
  });

  test("a legacy record without harness pre-selects codex from the agent name and drops the Claude-only wake guidance", async () => {
    // owner 实拍的那个身份：lark-…-codex1，过去只能拿到含 watch --once 的全量档。
    seedOne({}, "lark-ad72b3f9749e-agentparty-codex1");
    const r = await renderOpen();

    const select = harnessSelects(r)[0]!;
    expect(select.props.value).toBe("codex");
    const pack = await copyPack(r);
    expect(pack).toContain(CODEX_ONLY_HOOK);
    expect(pack).not.toContain(CLAUDE_ONLY_WATCH);
    expect(pack).not.toContain(CLAUDE_ONLY_MCP);
  });

  test("a legacy record named *-claude* pre-selects claude", async () => {
    seedOne({}, "acme-claude-1");
    const r = await renderOpen();

    expect(harnessSelects(r)[0]!.props.value).toBe("claude");
    const pack = await copyPack(r);
    expect(pack).toContain(CLAUDE_ONLY_PLUGIN);
    expect(pack).toContain(CLAUDE_ONLY_WATCH);
    expect(pack).not.toContain(CODEX_ONLY_PLUGIN);
    expect(pack).not.toContain(CODEX_ONLY_HOOK);
  });

  test("a legacy record whose name says nothing keeps the full pack", async () => {
    seedOne({}, "helper-bot");
    const r = await renderOpen();

    expect(harnessSelects(r)[0]!.props.value).toBe("other");
    const pack = await copyPack(r);
    // 全量档＝两种 harness 的指引都在（这正是 #895 抱怨的产物，对「其它」harness 才是对的）。
    expect(pack).toContain(CLAUDE_ONLY_MCP);
    expect(pack).toContain(CLAUDE_ONLY_WATCH);
    // other 档必须与旧全量逐字节一致：两家的插件安装行都不属于它。
    expect(pack).not.toContain(CLAUDE_ONLY_PLUGIN);
    expect(pack).not.toContain(CODEX_ONLY_PLUGIN);
  });

  test("changing the picker changes the copied pack and is written back to the vault", async () => {
    seedOne({}, "helper-bot");
    const r = await renderOpen();

    const before = await copyPack(r);
    expect(before).toContain(CLAUDE_ONLY_WATCH);

    await act(async () => {
      harnessSelects(r)[0]!.props.onChange({ target: { value: "codex" } });
    });

    // 产物真的换档了。
    expect(harnessSelects(r)[0]!.props.value).toBe("codex");
    const after = await copyPack(r);
    expect(after).toContain(CODEX_ONLY_HOOK);
    expect(after).toContain(CODEX_ONLY_PLUGIN);
    expect(after).not.toContain(CLAUDE_ONLY_WATCH);
    expect(after).not.toContain(CLAUDE_ONLY_MCP);

    // 写回 vault：下次进来不用再选（且走 saveAgentToken，token/mode 等字段原样保留）。
    const stored = JSON.parse(localStorage.getItem(VAULT_KEY)!) as Array<Record<string, unknown>>;
    const record = stored.find((rec) => rec.name === "helper-bot")!;
    expect(record.harness).toBe("codex");
    expect(record.token).toBe("ap_tok");
  });

  test("re-opening the panel shows the persisted choice, not the name heuristic", async () => {
    seedOne({}, "acme-claude-1");
    const r = await renderOpen();
    await act(async () => {
      harnessSelects(r)[0]!.props.onChange({ target: { value: "codex" } });
    });
    await act(async () => renderer?.unmount());
    renderer = null;

    // 同一个 localStorage，重新挂载组件＝用户重新打开面板。
    const again = await renderOpen();
    expect(harnessSelects(again)[0]!.props.value).toBe("codex");
    const pack = await copyPack(again);
    expect(pack).toContain(CODEX_ONLY_HOOK);
    expect(pack).not.toContain(CLAUDE_ONLY_WATCH);
  });

  test("unattended records show no harness picker and keep their serve script", async () => {
    // #749/#612：unattended 走 runner，不走 harness；给它显示 harness 选择器就是误导。
    seedOne({ mode: "unattended", runner: "claude" }, "duty-codex-box");
    const r = await renderOpen();

    expect(harnessSelects(r).length).toBe(0);
    const pack = await copyPack(r);
    expect(pack).toContain("party serve --channel demo --runner claude");
    expect(pack).not.toContain(CODEX_ONLY_HOOK);
    expect(pack).not.toContain(CLAUDE_ONLY_WATCH);
  });
});
