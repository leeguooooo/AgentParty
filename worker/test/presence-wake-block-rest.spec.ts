import type { PresenceEntry, WakeBlock } from "@agentparty/shared";
import { WAKE_BLOCK_TTL_MS } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

// #926：本机唤醒自检直报。agent 在 MCP 启动时读本地盘断定「这台机器上我叫不醒」，把结论挂到
// 自己的 presence 上，好让**下一个 @ 它的人**当场看见。
//
// 与 activity 直报（#615）最关键的一处不同：**presence 无行时必须建行**。
// 「装了、看起来正常、其实叫不醒」的那批身份恰恰从没建立过 WS 连接——沿用 activity 的
// 「无行即丢」会让唯一能救人的那条信号，正好在最需要它的场景下被丢掉。

function block(over: Partial<WakeBlock> = {}): WakeBlock {
  return {
    reason: "codex_hook_disabled",
    detail: "codex 把 Stop hook 标成了 enabled=false，会静默跳过它",
    fix: "party wake check",
    ts: Date.now(),
    ...over,
  };
}

async function fetchPresence(slug: string, token: string): Promise<PresenceEntry[]> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { presence: PresenceEntry[] }).presence;
}

async function postWakeBlock(slug: string, token: string, name: string, wakeBlock: unknown): Promise<Response> {
  return api(`/api/channels/${slug}/presence/${encodeURIComponent(name)}/wake-block`, token, {
    method: "POST",
    body: JSON.stringify({ wake_block: wakeBlock }),
  });
}

describe("wake-block self-report (issue #926)", () => {
  it("attaches even when the identity has NEVER connected — that is the whole point", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    // 刻意不开 WS、不发 status：这台机器上的 codex 身份从没在频道里露过面。
    expect((await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name)).toBeUndefined();

    const res = await postWakeBlock(slug, agent.token, agent.name, block());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, attached: true });

    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry?.wake_block?.reason).toBe("codex_hook_disabled");
    expect(entry?.wake_block?.fix).toBe("party wake check");
    // 凭空建出来的那行必须是 offline —— 收到一条自报绝不能把它渲染成在线。
    expect(entry?.state).toBe("offline");
  });

  it("survives on an offline presence row (unlike activity, which is cleared when offline)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    ws.send({ type: "send", kind: "status", state: "waiting", note: "here", mentions: [] });
    await ws.nextOfType("sent");
    expect((await postWakeBlock(slug, agent.token, agent.name, block())).status).toBe(200);
    ws.close();

    // 断连后 presence 转 offline。拉取式唤醒的身份平时本来就是 offline——
    // 这一档恰恰是那时最该说的话，绝不能跟着 activity 一起被抹掉。
    await new Promise((r) => setTimeout(r, 50));
    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry?.wake_block?.reason).toBe("codex_hook_disabled");
  });

  it("null clears the verdict — the self-healing path when the user fixes it", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    expect((await postWakeBlock(slug, agent.token, agent.name, block())).status).toBe(200);
    expect(
      (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name)?.wake_block,
    ).toBeDefined();

    const res = await postWakeBlock(slug, agent.token, agent.name, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ cleared: true });
    expect(
      (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name)?.wake_block,
    ).toBeUndefined();
  });

  it("clearing for an identity that never appeared does not conjure a presence row", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const res = await postWakeBlock(slug, agent.token, agent.name, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ attached: false });
    expect((await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name)).toBeUndefined();
  });

  it("stops surfacing once the verdict is older than the TTL", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const stale = block({ ts: Date.now() - WAKE_BLOCK_TTL_MS - 60_000 });
    expect((await postWakeBlock(slug, agent.token, agent.name, stale)).status).toBe(200);
    expect(
      (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name)?.wake_block,
    ).toBeUndefined();
  });

  it("only an agent may report, and only for itself", async () => {
    const agent = await seedToken("agent");
    const other = await seedToken("agent", uniq("other"));
    const human = await seedToken("human");
    const slug = await createChannel(agent.token);

    expect((await postWakeBlock(slug, agent.token, other.name, block())).status).toBe(403);
    expect((await postWakeBlock(slug, human.token, human.name, block())).status).toBe(403);
  });

  it("rejects dirty payloads instead of storing an un-actionable warning", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    // 未知 reason / 缺 detail / 缺 fix / 未来时间戳 —— 每一条都会产出一句让人无从下手的空警报。
    expect((await postWakeBlock(slug, agent.token, agent.name, { ...block(), reason: "whatever" })).status).toBe(400);
    expect((await postWakeBlock(slug, agent.token, agent.name, { ...block(), detail: "" })).status).toBe(400);
    expect((await postWakeBlock(slug, agent.token, agent.name, { ...block(), fix: "" })).status).toBe(400);
    expect(
      (await postWakeBlock(slug, agent.token, agent.name, { ...block(), ts: Date.now() + 10 * 60_000 })).status,
    ).toBe(400);
    expect((await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name)).toBeUndefined();
  });

  it("strips terminal control sequences from the free text it will render", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    // detail/fix 会被直接拼进终端输出与网页；它来自远端 agent 自报，不给转义序列注入留门。
    const res = await postWakeBlock(slug, agent.token, agent.name, block({ detail: "a\u001b[2Jb" }));
    expect(res.status).toBe(200);
    const entry = (await fetchPresence(slug, agent.token)).find((e) => e.name === agent.name);
    expect(entry?.wake_block?.detail).not.toContain("\u001b");
    expect(entry?.wake_block?.detail).toContain("b");
  });
});
