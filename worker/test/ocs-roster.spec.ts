import { env } from "cloudflare:test";
import { OCS_ROSTER_TTL_MS, type OcsRosterFrame, type ServerFrame } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { OcsRosterStore } from "../src/ocs-roster-store";
import { WsClient, api, seedToken, uniq } from "./helpers";

// #1113：CLI 把本机 ocs 会话经已有 WS 上报；DO 按身份挂着、断线即清，并在**服务端**按观看者裁剪：
// 上报者本人 + 频道 owner 看完整 cwd，其他成员只看 harness / 短地址 / 同项目 / 宿主类别。

const SECRET_CWD = "/Users/reporter/secret-project";

async function join(slug: string, token: string, extraHeaders: Record<string, string> = {}): Promise<WsClient> {
  const ws = await WsClient.open(slug, token, "header", extraHeaders);
  await ws.nextOfType("welcome");
  ws.send({ type: "hello", since: 0 });
  return ws;
}

async function drainUntilPong(ws: WsClient): Promise<ServerFrame[]> {
  ws.send({ type: "ping", nonce: 1 });
  const seen: ServerFrame[] = [];
  for (;;) {
    const frame = await ws.next();
    if (frame.type === "pong") return seen;
    seen.push(frame);
  }
}

async function setup() {
  const ownerAcct = `${uniq("owner")}@leeguoo.com`;
  const memberAcct = `${uniq("member")}@leeguoo.com`;
  const reporterAcct = `${uniq("rep")}@leeguoo.com`;
  const owner = await seedToken("human", uniq("owner"), { owner: ownerAcct });
  const slug = uniq("ch");
  const res = await api("/api/channels", owner.token, {
    method: "POST",
    body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
  for (const acct of [memberAcct, reporterAcct]) {
    await env.DB.prepare("INSERT INTO channel_members (channel_slug, account, added_by, added_at) VALUES (?, ?, ?, ?)")
      .bind(slug, acct, ownerAcct, Date.now())
      .run();
  }
  const member = await seedToken("human", uniq("member"), { owner: memberAcct });
  const reporter = await seedToken("agent", uniq("rep"), { owner: reporterAcct });
  return { slug, owner, member, reporter };
}

const report = {
  type: "ocs_roster",
  name: "impostor",
  sessions: [
    {
      addr: "codex-1a2b3c4d",
      harness: "codex",
      label: "fix the [31mlogin bug",
      cwd: SECRET_CWD,
      same_project: true,
      host_kind: "terminal",
      status: "busy",
      session_key: "thread-secret-key",
    },
    { addr: "evil\u0007addr", harness: "claude", same_project: false, host_kind: "process" },
    { addr: "pi-00ff00ff", harness: "vim", same_project: false, host_kind: "process" },
  ],
};

describe("local ocs sessions on presence (#1113)", () => {
  it("strips cwd/label/status server-side for non-owner members; owner gets the full view", async () => {
    const { slug, owner, member, reporter } = await setup();
    const ownerWs = await join(slug, owner.token);
    // 客户端注入 x-ap-moderator 必须被 worker 剥离，不能借此提权看 cwd。
    const memberWs = await join(slug, member.token, { "x-ap-moderator": "1" });
    const rep = await join(slug, reporter.token);
    await drainUntilPong(ownerWs);
    await drainUntilPong(memberWs);
    await drainUntilPong(rep);

    rep.send(report);
    const full = (await ownerWs.nextOfType("ocs_roster")) as OcsRosterFrame;
    expect(full.name).toBe(reporter.name);
    expect(full.full).toBe(true);
    expect(full.sessions).toEqual([
      {
        addr: "codex-1a2b3c4d",
        harness: "codex",
        same_project: true,
        host_kind: "terminal",
        cwd: SECRET_CWD,
        label: "fix the [31mlogin bug",
        status: "busy",
      },
    ]);
    expect(full.expires_at - full.ts).toBe(OCS_ROSTER_TTL_MS);

    const limited = (await memberWs.nextOfType("ocs_roster")) as OcsRosterFrame;
    expect(limited.full).toBe(false);
    expect(limited.sessions).toEqual([
      { addr: "codex-1a2b3c4d", harness: "codex", same_project: true, host_kind: "terminal" },
    ]);
    const wire = JSON.stringify(limited);
    expect(wire).not.toContain("secret-project");
    expect(wire).not.toContain("login");
    expect(JSON.stringify(full)).not.toContain("thread-secret-key");

    // agent 连接（包括上报者自己）不收扇出。
    expect((await drainUntilPong(rep)).filter((f) => f.type === "ocs_roster")).toEqual([]);

    // 晚到的非 owner 成员拿到的回放同样是裁剪视图。
    const lateMember = await join(slug, member.token);
    const snap = (await lateMember.nextOfType("ocs_roster")) as OcsRosterFrame;
    expect(snap.full).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("secret-project");

    // 上报连接断开 → 观看者收到空清除帧；之后晚到者什么都拿不到。
    rep.close();
    const cleared = (await memberWs.nextOfType("ocs_roster")) as OcsRosterFrame;
    expect(cleared).toMatchObject({ name: reporter.name, sessions: [] });
    const afterClose = await join(slug, owner.token);
    expect((await drainUntilPong(afterClose)).filter((f) => f.type === "ocs_roster")).toEqual([]);

    for (const ws of [ownerWs, memberWs, lateMember, afterClose]) ws.close();
  });

  it("rejects reports from human connections", async () => {
    const { slug, member } = await setup();
    const memberWs = await join(slug, member.token);
    await drainUntilPong(memberWs);
    memberWs.send(report);
    expect(await memberWs.nextOfType("error")).toMatchObject({ code: "bad_request" });
    memberWs.close();
  });
});

describe("OcsRosterStore (#1113)", () => {
  const s = { addr: "a", harness: "claude" as const, cwd: "/x", same_project: false, host_kind: "process" as const, session_key: "k" };

  it("expires reports after the TTL and only clears on the reporting connection's disconnect", () => {
    const store = new OcsRosterStore();
    store.apply("rep", "conn-new", [s], 1000, () => "bot");
    expect(store.frameFor("rep", false, 1000)?.sessions).toEqual([
      { addr: "a", harness: "claude", same_project: false, host_kind: "process", party_name: "bot" },
    ]);
    expect(store.disconnect("conn-old")).toEqual([]);
    expect(store.frameFor("rep", true, 1000)?.sessions[0]?.cwd).toBe("/x");
    expect(store.frameFor("rep", true, 1000 + OCS_ROSTER_TTL_MS)).toBeNull();
    expect(store.names(1000)).toEqual([]);

    store.apply("rep", "conn-new", [s], 1000, () => undefined);
    expect(store.disconnect("conn-new")).toEqual(["rep"]);
    expect(store.frameFor("rep", true, 1000)).toBeNull();
  });
});
