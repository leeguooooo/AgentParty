// 命令层：send/agent add/whoami/logout 在账号会话下的行为
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAccount } from "../src/account";
import { tokenFingerprint, writeConfig, writeState } from "../src/config";
import { run as sendRun } from "../src/commands/send";
import { run as agentRun } from "../src/commands/agent";
import { run as whoamiRun } from "../src/commands/whoami";
import { run as logoutRun } from "../src/commands/logout";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
const nowSec = () => Math.floor(Date.now() / 1000);

// 捕获 console.log / console.error
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-acctcmd-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

function liveAccount(server: string) {
  writeAccount({
    server,
    refresh_token: "ref",
    access_token: "acc-live",
    expires_at: nowSec() + 3600,
  });
}

describe("send auth precedence", () => {
  test("config ap_ token wins over a live account session (workspace/agent identity)", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_agent_wins" });
    liveAccount(mock.url);
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    // init 写的 workspace token 优先——agent 以自己的身份发言，不被残留账号会话顶替
    expect(msgReq?.auth).toBe("Bearer ap_agent_wins");
    // 账号会话未被触碰，不刷新
    expect(mock.tokenCalls).toHaveLength(0);
  });

  test("uses account access_token when no workspace token is bound", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["yo", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    expect(msgReq?.auth).toBe("Bearer acc-live");
  });

  test("falls back to config ap_ token when logged out", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_fallback" });
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hi", "--channel", "dev"]);
    expect(code).toBe(0);
    const msgReq = mock.requests.find((r) => r.path === "/api/channels/dev/messages");
    expect(msgReq?.auth).toBe("Bearer ap_fallback");
  });

  test("warns on the send-to-channel footgun but still sends to the bound channel", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    writeState({ channel: "dev", cursor: 0 });

    // 想发到 ops，误用 `send ops "..."`：ops 被并进正文，实际发到绑定的 dev
    const code = await sendRun(["ops", "deploy done"]);
    expect(code).toBe(0);
    expect(errs.join("\n")).toContain("若想发到「ops」");
    expect(mock.requests.some((r) => r.path === "/api/channels/dev/messages")).toBe(true);
  });

  test("no footgun warning for a normal quoted message", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello everyone"]);
    expect(code).toBe(0);
    expect(errs.join("\n")).not.toContain("若想发到");
  });

  test("debug-auth prints safe runtime/config source without raw token", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_debug_secret" });
    writeState({ channel: "dev", cursor: 0 });

    const code = await sendRun(["hello", "--channel", "dev", "--debug-auth"]);
    expect(code).toBe(0);
    const stderr = errs.join("\n");
    expect(stderr).toContain("using runtime=fan@example.com (human/human)");
    expect(stderr).toContain("auth-source=runtime_config");
    expect(stderr).toContain(`token=${tokenFingerprint("ap_debug_secret")}`);
    expect(stderr).not.toContain("ap_debug_secret");
  });
});

describe("agent add", () => {
  test("requires login", async () => {
    mock = startOidcMock();
    writeConfig({ server: mock.url, token: "ap_x" });
    const code = await agentRun(["add", "botty"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("agent add requires a human login");
    expect(mock.requests.find((r) => r.path === "/api/agents")).toBeUndefined();
  });

  test("explains account capability failures separately from runtime token auth", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/agents")) {
        return Response.json({ error: { code: "forbidden", message: "forbidden" } }, { status: 403 });
      }
      return origFetch(input, init);
    }) as typeof fetch;
    try {
      liveAccount(mock.url);
      const code = await agentRun(["add", "botty"]);
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("current account cannot mint agents");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("stale account refresh failure tells operator to login again", async () => {
    mock = startOidcMock({ tokenResponse: () => ({ token_type: "Bearer" }) });
    writeAccount({
      server: mock.url,
      refresh_token: "ref-expired",
      access_token: "acc-expired",
      expires_at: nowSec() - 10,
    });

    const code = await agentRun(["add", "botty"]);
    expect(code).toBe(1);
    const stderr = errs.join("\n");
    expect(stderr).toContain("stored account session is expired or invalid");
    expect(stderr).toContain("party login");
    expect(stderr).not.toContain("token endpoint returned no access_token");
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.requests.find((r) => r.path === "/api/agents")).toBeUndefined();
  });

  test("mints agent via /api/agents with account bearer + channel_scope", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await agentRun(["add", "botty", "--channel-scope", "ops"]);
    expect(code).toBe(0);
    const req = mock.requests.find((r) => r.path === "/api/agents");
    expect(req?.method).toBe("POST");
    expect(req?.auth).toBe("Bearer acc-live");
    expect(req?.body).toEqual({ name: "botty", channel_scope: "ops" });
    // 明文 token 打印一次
    expect(logs.join("\n")).toContain("ap_botty_secret");
  });

  test("rejects invalid channel-scope before any request", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await agentRun(["add", "botty", "--channel-scope", "BAD_SLUG"]);
    expect(code).toBe(1);
    expect(mock.requests.find((r) => r.path === "/api/agents")).toBeUndefined();
  });
});

describe("whoami", () => {
  test("hits /api/me and prints identity", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun([]);
    expect(code).toBe(0);
    const stdout = logs.join("\n");
    expect(stdout).toContain("runtime: logged in as fan@example.com");
    expect(stdout).toContain("account:");
    expect(stdout).toContain("config:");
    expect(stdout).toContain("auth-source: account_session");
    expect(mock.requests.some((r) => r.path === "/api/me" && r.auth === "Bearer acc-live")).toBe(true);
  });

  test("prints identity as json", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun(["--json"]);
    expect(code).toBe(0);
    const frame = JSON.parse(logs[0]!);
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "whoami",
      logged_in: true,
      server: mock.url,
      name: "fan@example.com",
      email: "fan@example.com",
      kind: "human",
      role: "human",
      channel_scope: null,
      caps: {
        send: true,
        create_channel: true,
        mint_agents: true,
        scoped_to: null,
      },
      auth_source: "account_session",
      runtime: {
        name: "fan@example.com",
        email: "fan@example.com",
        kind: "human",
        role: "human",
        owner: null,
        channel_scope: null,
      },
      account: {
        present: true,
        server: mock.url,
      },
      config: {
        kind: "none",
        path: null,
      },
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("prints capabilities in text mode", async () => {
    mock = startOidcMock();
    liveAccount(mock.url);
    const code = await whoamiRun(["--caps"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("scope: none (all channels)");
    expect(logs.join("\n")).toContain("can: send=yes create-channel=yes mint-agents=yes");
  });

  test("prints not logged in when no auth", async () => {
    const code = await whoamiRun([]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("not logged in");
  });

  test("prints not logged in as json", async () => {
    const code = await whoamiRun(["--json"]);
    expect(code).toBe(0);
    const frame = JSON.parse(logs[0]!);
    expect(frame).toMatchObject({
      schema: "agentparty.v1",
      type: "whoami",
      logged_in: false,
      server: null,
      auth_source: "none",
      account: {
        present: false,
      },
      config: {
        kind: "none",
        path: null,
      },
    });
    expect(typeof frame.ts).toBe("number");
  });

  test("rejects unknown flags", async () => {
    const code = await whoamiRun(["--bogus"]);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("unknown option --bogus");
  });
});

describe("logout", () => {
  test("clears session", async () => {
    liveAccount("https://ap.example.com");
    expect(await logoutRun([])).toBe(0);
    expect(logs.join("\n")).toContain("logged out");
    // 二次登出提示未登录
    logs.length = 0;
    expect(await logoutRun([])).toBe(0);
    expect(logs.join("\n")).toContain("not logged in");
  });
});
