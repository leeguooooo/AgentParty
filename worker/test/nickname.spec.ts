// #165：agent 也能设「全局唯一昵称」（复用 #59 的 @别名命名空间），且可被 @中文昵称 唤醒。
// 昵称存 D1 agent_nicknames（按 token name，per-identity，非 per-account——agent 与 human 共享 account）。
// 唤醒的关键：DO 发送路径把正文里的 @昵称 解析成目标真实 name 写进 mentions_json，
// serve/watch/webhook 全按真实 ASCII name 命中，昵称是不可 @ 到的（除非被解析）。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateNicknameFormat } from "../src/nickname";
import { api, createChannel, seedToken, uniq, WsClient } from "./helpers";

async function setNickname(token: string, nickname: string): Promise<Response> {
  return api("/api/me/nickname", token, { method: "PUT", body: JSON.stringify({ nickname }) });
}
async function setHandle(token: string, handle: string): Promise<Response> {
  return api("/api/me/handle", token, { method: "PUT", body: JSON.stringify({ handle }) });
}

describe("validateNicknameFormat（#165）", () => {
  it("接受中文/unicode 昵称，原样保留", () => {
    expect(validateNicknameFormat("中文昵称")).toBe("中文昵称");
    expect(validateNicknameFormat("小助手")).toBe("小助手");
    expect(validateNicknameFormat("bot中文")).toBe("bot中文");
    expect(validateNicknameFormat("Evan")).toBe("Evan");
  });
  it("拒绝非法：含空白 / @ / 首字为 . / 超长 / 非串", () => {
    expect(validateNicknameFormat("中 文")).toBeNull();
    expect(validateNicknameFormat("foo@bar")).toBeNull();
    expect(validateNicknameFormat(".中文")).toBeNull();
    expect(validateNicknameFormat("字".repeat(65))).toBeNull();
    expect(validateNicknameFormat(123)).toBeNull();
  });
});

describe("agent 设昵称 + 全局唯一（#165）", () => {
  it("agent 设中文昵称成功，stamp 到 sender.handle", async () => {
    const agent = await seedToken("agent", uniq("a"));
    const setRes = await setNickname(agent.token, "小助手");
    expect(setRes.status).toBe(200);

    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "message", body: "hi", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const msg = await ws.nextOfType("msg");
    expect(msg.sender.handle).toBe("小助手");
    ws.close();
  });

  it("同一昵称不能被第二个 agent 占用（全局唯一）", async () => {
    const a1 = await seedToken("agent", uniq("a"));
    const a2 = await seedToken("agent", uniq("a"));
    expect((await setNickname(a1.token, "唯一名")).status).toBe(200);
    expect((await setNickname(a2.token, "唯一名")).status).toBe(409);
  });

  it("昵称不能撞人类 handle（共用 @ 命名空间）", async () => {
    const owner = uniq("acct");
    const human = await seedToken("human", uniq("h"), { owner });
    const agent = await seedToken("agent", uniq("a"));
    expect((await setHandle(human.token, "sharedname")).status).toBe(200);
    expect((await setNickname(agent.token, "sharedname")).status).toBe(409);
  });

  it("人类 handle 反向也不能撞已存在的 agent 昵称", async () => {
    const owner = uniq("acct");
    const human = await seedToken("human", uniq("h"), { owner });
    const agent = await seedToken("agent", uniq("a"));
    expect((await setNickname(agent.token, "reverse")).status).toBe(200);
    expect((await setHandle(human.token, "reverse")).status).toBe(409);
  });

  it("昵称不能撞已存在的 token 名", async () => {
    const victim = await seedToken("agent", uniq("takenname"));
    const agent = await seedToken("agent", uniq("a"));
    expect((await setNickname(agent.token, victim.name)).status).toBe(409);
  });

  it("非 agent（readonly）不能设昵称", async () => {
    const ro = await seedToken("readonly", uniq("ro"));
    expect((await setNickname(ro.token, "nope")).status).toBe(403);
  });
});

describe("@中文昵称 解析成真实 name 并唤醒（#165）", () => {
  it("正文 @昵称 → mentions_json 含目标真实 name", async () => {
    const target = await seedToken("agent", uniq("target"));
    expect((await setNickname(target.token, "程序员小明")).status).toBe(200);

    const sender = await seedToken("agent", uniq("sender"));
    const slug = await createChannel(sender.token);
    const ws = await WsClient.open(slug, sender.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "message", body: "@程序员小明 帮我看下", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const msg = await ws.nextOfType("msg");
    expect(msg.mentions).toContain(target.name);
    ws.close();
  });

  it("email 里的 @ 不产生 mention", async () => {
    const target = await seedToken("agent", uniq("target"));
    expect((await setNickname(target.token, "小红")).status).toBe(200);
    const sender = await seedToken("agent", uniq("sender"));
    const slug = await createChannel(sender.token);
    const ws = await WsClient.open(slug, sender.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "send", kind: "message", body: "mail me at foo@bar.com thanks", mentions: [], reply_to: null });
    await ws.nextOfType("sent");
    const msg = await ws.nextOfType("msg");
    expect(msg.mentions).toEqual([]);
    ws.close();
  });
});
