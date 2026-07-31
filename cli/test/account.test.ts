// party login/logout/whoami/agent add + 账号会话 bearer 优先与自动刷新
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountPath, readAccount, writeAccount, clearAccount } from "../src/account";
import { writeConfig, writeState } from "../src/config";
import {
  challengeFor,
  decodeJwtPayload,
  ensureFreshAccess,
  exchangeCode,
  loginFlow,
  makeVerifier,
  refreshTokens,
  resolveAuth,
  resolveAuthDetailed,
} from "../src/oidc-cli";
import { createHash } from "node:crypto";
import { startOidcMock, type OidcMock } from "./oidc-mock";

let home: string;
let mock: OidcMock | null = null;
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-acct-"));
  process.env.AGENTPARTY_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTPARTY_HOME;
  delete process.env.AGENTPARTY_CONFIG;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

describe("account storage", () => {
  test("write/read roundtrip + 0600", () => {
    expect(readAccount()).toBeNull();
    writeAccount({ server: "https://ap.example.com", refresh_token: "ref-x", email: "a@b.c" });
    expect(readAccount()).toEqual({
      server: "https://ap.example.com",
      refresh_token: "ref-x",
      email: "a@b.c",
    });
    expect(statSync(accountPath()).mode & 0o777).toBe(0o600);
  });

  test("clear returns whether a session existed", () => {
    expect(clearAccount()).toBe(false);
    writeAccount({ server: "s", refresh_token: "r" });
    expect(clearAccount()).toBe(true);
    expect(readAccount()).toBeNull();
  });
});

describe("pkce + jwt helpers", () => {
  test("challenge = base64url(sha256(verifier))", () => {
    const v = makeVerifier();
    const expected = createHash("sha256").update(v).digest("base64url");
    expect(challengeFor(v)).toBe(expected);
    expect(v).not.toContain("=");
    expect(v).not.toContain("+");
  });

  test("decodeJwtPayload reads claims, tolerates junk", () => {
    const jwt = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ sub: "u1", email: "x@y.z" }),
    ).toString("base64url")}.sig`;
    expect(decodeJwtPayload(jwt)).toEqual({ sub: "u1", email: "x@y.z" });
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
  });
});

describe("token exchange + refresh", () => {
  test("exchangeCode posts authorization_code with verifier", async () => {
    mock = startOidcMock();
    const t = await exchangeCode(mock.url, "agentparty-cli", "the-code", "http://127.0.0.1:8976/callback", "verif");
    expect(t.access_token).toBe("acc-authcode");
    expect(t.refresh_token).toBe("ref-1");
    const params = mock.tokenCalls[0]!;
    expect(params).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      client_id: "agentparty-cli",
      code_verifier: "verif",
      redirect_uri: "http://127.0.0.1:8976/callback",
    });
  });

  test("refreshTokens posts refresh_token grant", async () => {
    mock = startOidcMock();
    const t = await refreshTokens(mock.url, "agentparty-cli", "ref-old");
    expect(t.access_token).toBe("acc-refreshed");
    expect(mock.tokenCalls[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "ref-old" });
  });
});

describe("ensureFreshAccess", () => {
  test("fresh token → no network", async () => {
    mock = startOidcMock();
    const sess = {
      server: mock.url,
      refresh_token: "ref",
      access_token: "still-good",
      expires_at: nowSec() + 3600,
    };
    const { token } = await ensureFreshAccess(sess);
    expect(token).toBe("still-good");
    expect(mock.tokenCalls).toHaveLength(0);
  });

  test("expired token → refresh + persist rotated refresh_token", async () => {
    mock = startOidcMock();
    writeAccount({
      server: mock.url,
      refresh_token: "ref-old",
      access_token: "expired",
      expires_at: nowSec() - 10,
    });
    const { token, session } = await ensureFreshAccess(readAccount()!);
    expect(token).toBe("acc-refreshed");
    expect(session.refresh_token).toBe("ref-2");
    // 落盘：下次读到刷新后的会话
    const persisted = readAccount()!;
    expect(persisted.access_token).toBe("acc-refreshed");
    expect(persisted.refresh_token).toBe("ref-2");
    expect(persisted.expires_at!).toBeGreaterThan(nowSec());
  });
});

describe("resolveAuth precedence", () => {
  test("config ap_ token wins over a stale account session (agent identity, no 401)", async () => {
    // 「让 agent 加入」：init 写了 workspace 的 agent token，即便本机残留一个（哪怕过期的）
    // 人类账号会话，也必须用 config.token 发言——否则 agent 变成以「人」的身份说话，
    // 且过期会话还会触发换取 access_token 从而 401。config.token 在就不该碰账号会话。
    writeConfig({ server: "https://ap.example.com", token: "ap_agent" });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "expired",
      expires_at: nowSec() - 10, // 过期：一旦被选中就得刷新，这里断言它压根不被选中
    });
    const auth = await resolveAuth();
    expect(auth).toEqual({ server: "https://ap.example.com", token: "ap_agent" });
  });

  test("detailed resolver exposes runtime config source without refreshing stale account", async () => {
    writeConfig({ server: "https://ap.example.com", token: "ap_agent_secret" });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "expired",
      expires_at: nowSec() - 10,
      email: "human@example.com",
    });
    const auth = await resolveAuthDetailed();
    expect(auth).toMatchObject({
      server: "https://ap.example.com",
      token: "ap_agent_secret",
      auth_source: "runtime_config",
      config: {
        kind: "workspace",
      },
      account: {
        present: true,
        server: "https://issuer.example.com",
        email: "human@example.com",
      },
    });
    expect(typeof auth.config.token_fingerprint).toBe("string");
    expect(auth.config.token_fingerprint!).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  test("falls back to config ap_ token when logged out", async () => {
    writeConfig({ server: "https://ap.example.com", token: "ap_only" });
    const auth = await resolveAuth();
    expect(auth).toEqual({ server: "https://ap.example.com", token: "ap_only" });
  });

  test("account-only (no config) uses account server", async () => {
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
    });
    const auth = await resolveAuth();
    expect(auth).toEqual({ server: "https://issuer.example.com", token: "acc-live" });
  });

  test("missing bound agent config fails closed instead of falling back to a human account (#518)", async () => {
    const missing = join(home, "agents", "missing-agent.json");
    writeState({ channel: "dev", cursor: 0, config_path: missing, bindings: { dev: missing } });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
      email: "human@example.com",
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const auth = await resolveAuthDetailed();
      expect(auth).toMatchObject({ server: "https://issuer.example.com", token: null, auth_source: "none" });
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("refusing human-account fallback");
    expect(errors.join("\n")).toContain(missing);
  });

  // #518 恢复：绑定的 agent config 丢了（常见于放 $TMPDIR 被系统清），但持久
  // ~/.agentparty/agents/ 里有一个 channel 唯一匹配的 agent config → 自动恢复它
  // （用它自己的 server+token），不再硬拒。绝不静默回退人类账号（#42 仍守住）。
  function writeAgentConfigFile(name: string, cfg: Record<string, unknown>) {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", name), JSON.stringify(cfg));
  }

  test("recovers a channel-unique persistent agent config instead of refusing (#518)", async () => {
    const missing = join(home, "agents", "orphan-bound.json");
    writeState({ channel: "dev", cursor: 0, config_path: missing, bindings: { dev: missing } });
    // 持久 agent config：与孤儿不同文件名，但 identity.channel_scope 唯一匹配 "dev"。
    // 注意其 server 与账号会话 server 不同——恢复必须用 agent 自己的 server。
    const durablePath = join(home, "agents", "durable-alice.json");
    writeAgentConfigFile("durable-alice.json", {
      server: "https://agent.example.com",
      token: "agent-tok",
      identity: { name: "alice", email: null, kind: "agent", role: "agent", owner: "o", channel_scope: "dev", verified_at: 1 },
    });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
      email: "human@example.com",
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const auth = await resolveAuthDetailed();
      // 恢复后 config 来源必须反映真实的持久文件（供 whoami/serve 决策），不是顶部探测的旧 source。
      expect(auth).toMatchObject({
        server: "https://agent.example.com",
        token: "agent-tok",
        auth_source: "runtime_config",
        config: { kind: "explicit", path: durablePath },
      });
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("alice");
    expect(errors.join("\n")).not.toContain("refusing human-account fallback");
  });

  test("strips terminal control chars from recovered identity before printing (#518)", async () => {
    const missing = join(home, "agents", "orphan-\x1b[31m\x07-bound.json");
    writeState({ channel: "dev", cursor: 0, config_path: missing, bindings: { dev: missing } });
    // 恶意/损坏 config：name 里塞 ANSI/OSC 控制序列，若原样打印会注入终端。
    // 剥离只去 ESC/BEL 等控制字节（OSC 载荷降级为可见文本），可读部分 "alice" 保留在前。
    writeAgentConfigFile("evil.json", {
      server: "https://agent.example.com",
      token: "agent-tok",
      identity: { name: "alice\x1b[31m\x1b]0;pwn\x07", email: null, kind: "agent", role: "agent", owner: "o", channel_scope: "dev", verified_at: 1 },
    });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
      email: "human@example.com",
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await resolveAuthDetailed();
    } finally {
      console.error = originalError;
    }
    const out = errors.join("\n");
    expect(errors.join("")).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/);
    expect(out).toContain("alice"); // 剥离控制字符后可读身份仍在
  });

  test("skips malformed persistent agent credentials and fails closed (#518)", async () => {
    const missing = join(home, "agents", "orphan-bound.json");
    writeState({ channel: "dev", cursor: 0, config_path: missing, bindings: { dev: missing } });
    writeAgentConfigFile("malformed.json", {
      server: "https://agent.example.com",
      token: { unexpected: "object" },
      identity: { name: ["alice"], channel_scope: "dev" },
    });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
      email: "human@example.com",
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const auth = await resolveAuthDetailed();
      expect(auth).toMatchObject({ token: null, auth_source: "none" });
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("refusing human-account fallback");
  });

  test("refuses (no wrong-identity pick) when multiple persistent configs match the channel (#518)", async () => {
    const missing = join(home, "agents", "orphan-bound.json");
    writeState({ channel: "dev", cursor: 0, config_path: missing, bindings: { dev: missing } });
    writeAgentConfigFile("a.json", {
      server: "https://a.example.com",
      token: "tok-a",
      identity: { name: "alice", email: null, kind: "agent", role: "agent", owner: "o", channel_scope: "dev", verified_at: 1 },
    });
    writeAgentConfigFile("b.json", {
      server: "https://b.example.com",
      token: "tok-b",
      identity: { name: "bob", email: null, kind: "agent", role: "agent", owner: "o", channel_scope: "dev", verified_at: 1 },
    });
    writeAccount({
      server: "https://issuer.example.com",
      refresh_token: "ref",
      access_token: "acc-live",
      expires_at: nowSec() + 3600,
      email: "human@example.com",
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const auth = await resolveAuthDetailed();
      expect(auth).toMatchObject({ token: null, auth_source: "none" });
    } finally {
      console.error = originalError;
    }
    expect(errors.join("\n")).toContain("refusing human-account fallback");
  });

  test("null when neither present", async () => {
    expect(await resolveAuth()).toBeNull();
  });
});

describe("loginFlow (loopback pkce)", () => {
  const ports = [45871, 45872, 45873];

  test("full flow: authorize → code → token → session", async () => {
    mock = startOidcMock();
    const sess = await loginFlow(mock.url, {
      ports,
      openUrl: async (url) => {
        // 模拟 IdP：解析 redirect_uri + state，带 code 回调
        const q = new URL(url).searchParams;
        expect(q.get("code_challenge_method")).toBe("S256");
        expect(q.get("client_id")).toBe("agentparty-cli");
        const redirect = q.get("redirect_uri")!;
        const state = q.get("state")!;
        await fetch(`${redirect}?code=auth-code-xyz&state=${encodeURIComponent(state)}`);
      },
    });
    expect(sess.email).toBe("fan@example.com");
    expect(sess.sub).toBe("user-123");
    expect(sess.refresh_token).toBe("ref-1");
    expect(sess.access_token).toBe("acc-authcode");
    expect(sess.expires_at!).toBeGreaterThan(nowSec());
    expect(mock.tokenCalls[0]).toMatchObject({ grant_type: "authorization_code", code: "auth-code-xyz" });
  });

  test("state mismatch is rejected (CSRF guard)", async () => {
    mock = startOidcMock();
    await expect(
      loginFlow(mock.url, {
        ports,
        openUrl: async (url) => {
          const redirect = new URL(url).searchParams.get("redirect_uri")!;
          await fetch(`${redirect}?code=x&state=WRONG`);
        },
      }),
    ).rejects.toThrow(/state mismatch/);
    // 状态不匹配不应换取 token
    expect(mock.tokenCalls).toHaveLength(0);
  });

  test("falls back to web client_id when cli_client_id absent", async () => {
    mock = startOidcMock({ cliClientId: null });
    await loginFlow(mock.url, {
      ports,
      openUrl: async (url) => {
        const q = new URL(url).searchParams;
        expect(q.get("client_id")).toBe("agentparty-web");
        const redirect = q.get("redirect_uri")!;
        const state = q.get("state")!;
        await fetch(`${redirect}?code=c&state=${encodeURIComponent(state)}`);
      },
    });
  });
});
