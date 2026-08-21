// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";

// #919：建频道失败时，前端把任何 403 都渲染成「需人类账号登录」，服务端的 code / message 被整个
// 丢弃。owner 实际撞的是频道配额，却被指去查登录状态。这里钉住三种语义不同的 403 渲染出三种
// 不同、且各自可执行的文案，防止再退回一句话包打天下。
// 桩的是 fetch 而不是 ../lib/api——mock.module 是进程级的，会污染同批跑的其它 spec；桩 fetch
// 还顺带覆盖了 rest 层解析 403 响应体这一环（真实故障就发生在那里）。
const { CreateChannel } = await import("./CreateChannel");

let renderer: ReactTestRenderer | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  globalThis.fetch = realFetch;
});

// 打开面板 → 填一个合法 slug → 提交 → 返回内联红字文案
async function submitAndReadError(body: string): Promise<string> {
  globalThis.fetch = (async () => new Response(body, { status: 403 })) as typeof fetch;
  await act(async () => {
    renderer = create(
      <LocaleProvider>
        <CreateChannel token="ap_tok" onCreated={() => {}} />
      </LocaleProvider>,
    );
  });
  const r = renderer!;
  await act(async () => {
    r.root.findByProps({ className: "d-pill chan-pill newchan-open" }).props.onClick();
  });
  await act(async () => {
    r.root.findByProps({ className: "t-mono newchan-input" }).props.onChange({ target: { value: "ludo" } });
  });
  await act(async () => {
    await r.root.findByProps({ className: "d-btn d-btn--primary" }).props.onClick();
  });
  const alert = r.root.findByProps({ role: "alert" });
  return alert.children.join("");
}

function body403(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

const QUOTA_MESSAGE =
  "account channel quota reached (max 20 channels per account) (free tier limit — upgrade to member for a higher quota (use the membership link in the Web or desktop header))";
const QUOTA = body403("quota_exceeded", QUOTA_MESSAGE);
const READONLY_MESSAGE = "readonly token cannot create channels";
const READONLY = body403("unauthorized", READONLY_MESSAGE);
const SCOPED_MESSAGE = "channel-scoped token can only create its own scope channel";
const SCOPED = body403("forbidden", SCOPED_MESSAGE);

describe("CreateChannel 403 rendering (#919)", () => {
  test("quota_exceeded says what the quota is, and nothing about signing in", async () => {
    const text = await submitAndReadError(QUOTA);
    // 服务端原文必须原样可见——那句英文才是排查时的决定性线索
    expect(text).toContain("max 20 channels per account");
    expect(text.toLowerCase()).toContain("quota");
    // 而且绝不能再把人往登录问题上带（默认 locale 是 en）
    expect(text.toLowerCase()).not.toContain("sign in");
    expect(text.toLowerCase()).not.toContain("log in");
    expect(text.toLowerCase()).not.toContain("human account");
  });

  test("readonly token gets a token-swap instruction, not a quota one", async () => {
    const text = await submitAndReadError(READONLY);
    expect(text).toContain(READONLY_MESSAGE);
    expect(text.toLowerCase()).toContain("read-only");
    expect(text.toLowerCase()).not.toContain("quota reached");
  });

  test("channel-scoped token is told it can only create its own scope", async () => {
    const text = await submitAndReadError(SCOPED);
    expect(text).toContain(SCOPED_MESSAGE);
    expect(text).toContain("scoped to a single channel");
    expect(text.toLowerCase()).not.toContain("read-only");
    expect(text.toLowerCase()).not.toContain("quota reached");
  });

  test("the three 403 codes never collapse onto one string", async () => {
    const quota = await submitAndReadError(QUOTA);
    const readonly = await submitAndReadError(READONLY);
    const scoped = await submitAndReadError(SCOPED);
    expect(new Set([quota, readonly, scoped]).size).toBe(3);
  });

  test("falls back to the local string only when the server gave nothing", async () => {
    const text = await submitAndReadError("not json at all");
    expect(text).toContain("gave no reason");
  });
});
