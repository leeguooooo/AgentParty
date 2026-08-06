// #825：party_who 报的状态可以比频道里已有的 status frame 还旧，而「对方到底在不在干活」是多 agent
// 协作里唯一能决定「我是等还是自己上」的信号。实测后果不是理论风险：频道里 working 帧已存在 152 秒，
// party_who 仍报 waiting，协作方据此判断「没人接活」，直接去改了对方仓库并推了分支——两边差点在同一个
// 文件的同一个常量上撞车。错的不是那个判断，是喂给它的信息。
//
// 成因：REST 路径发出的 status 帧，presence 行落在 LEGACY_SESSION_ID 上；而 aggregatePresenceRow 在
// 该 name 有任何活 WS 连接时，只从「活连接对应的行」里挑，非 live 行被整个丢弃。于是一个既挂着 serve
// （有活 WS）又用 REST 报状态的 agent，who 永远停在 WS 那行的旧状态上。
import { describe, expect, it } from "vitest";
import type { PresenceEntry } from "@agentparty/shared";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken } from "./helpers";

async function presenceOf(slug: string, token: string, name: string): Promise<PresenceEntry | undefined> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const { presence } = (await res.json()) as { presence: PresenceEntry[] };
  return presence.find((p) => p.name === name);
}

function postStatus(slug: string, token: string, state: string, note: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "status", state, note, mentions: [] }),
  });
}

describe("#825 party_who 必须反映最新一次状态变更", () => {
  it("挂着活 WS 的 agent 经 REST 报 working：who 报 working，而不是 WS 那行的旧 waiting", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    // 1) agent 挂上 serve 那样的活 WS 连接，并在这条连接上报 waiting（standby）。
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [], wake: { kind: "serve" } });
    await ws.nextOfType("sent");
    expect((await presenceOf(slug, agent.token, agent.name))?.state).toBe("waiting");

    try {
      // 2) runner 经 REST 报 working（serve 的 runner 就是这么发的）。
      expect((await postStatus(slug, agent.token, "working", "runner started for seq 472")).status).toBe(200);

      // 3) who 必须看到 working。修复前这里恒为 waiting——REST 那行落在 LEGACY_SESSION_ID 上被丢掉了。
      const entry = await presenceOf(slug, agent.token, agent.name);
      expect(entry?.state).toBe("working");
      expect(entry?.note).toBe("runner started for seq 472");
    } finally {
      ws.close();
    }
  });

  it("活连接自己的状态更新照常生效（没把「优先 live 行」的本意改坏）", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);

    try {
      ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [] });
      await ws.nextOfType("sent");
      expect((await presenceOf(slug, agent.token, agent.name))?.state).toBe("waiting");

      ws.send({ type: "send", kind: "status", state: "working", note: "on it", mentions: [] });
      await ws.nextOfType("sent");
      const entry = await presenceOf(slug, agent.token, agent.name);
      expect(entry?.state).toBe("working");
      expect(entry?.note).toBe("on it");
    } finally {
      ws.close();
    }
  });

  // #821：serve 熔断退出前会经 REST 发一条 blocked 通告，但那一刻它的 WS 还开着——正是上面这个
  // bug 会把它整个丢掉的时机。于是「serve 已经死了」这件事对本人和协作方都不可见，协作方只看到
  // 一个 waiting 的人不回话，进而可能直接接管他的活。这条 case 单独钉住。
  it("serve 熔断的 blocked 通告不被自己那条还活着的 WS 连接盖住", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    ws.send({ type: "send", kind: "status", state: "waiting", note: "standby", mentions: [], wake: { kind: "serve" } });
    await ws.nextOfType("sent");

    try {
      const note = "serve wake circuit breaker tripped: reason=consecutive_abandons; consecutive_abandons=3/3";
      expect(
        (
          await api(`/api/channels/${slug}/messages`, agent.token, {
            method: "POST",
            body: JSON.stringify({ kind: "status", state: "blocked", note, mentions: [], blocked_reason: note }),
          })
        ).status,
      ).toBe(200);

      const entry = await presenceOf(slug, agent.token, agent.name);
      expect(entry?.state).toBe("blocked");
      expect(entry?.status?.blocked_reason).toContain("circuit breaker tripped");
    } finally {
      ws.close();
    }
  });

  it("没有活连接时行为不变：REST 状态照常反映", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);

    expect((await postStatus(slug, agent.token, "working", "no ws at all")).status).toBe(200);
    const entry = await presenceOf(slug, agent.token, agent.name);
    expect(entry?.state).toBe("working");
    expect(entry?.note).toBe("no ws at all");
  });
});
