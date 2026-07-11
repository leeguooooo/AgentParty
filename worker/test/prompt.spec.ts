// #284 频道内交互式提问：消息带 prompt {question, options[]}，服务端校验 + 落库 + 回帧带出。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken } from "./helpers";

interface MsgLike {
  seq: number;
  body: string;
  kind: string;
  prompt?: { question: string; options: string[] };
}

async function messages(slug: string, token: string): Promise<MsgLike[]> {
  const res = await api(`/api/channels/${slug}/messages?since=0&limit=1000`, token);
  return ((await res.json()) as { messages: MsgLike[] }).messages;
}

function send(slug: string, token: string, body: string, prompt?: unknown): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: null, ...(prompt === undefined ? {} : { prompt }) }),
  });
}

describe("message prompt (#284)", () => {
  it("round-trips a prompt: question + options come back on the frame", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const res = await send(slug, token, "选择执行方案", { question: "选择执行方案", options: ["方案A", "方案B", "方案A"] });
    expect(res.status).toBe(200);
    const msg = (await messages(slug, token)).find((m) => m.body === "选择执行方案")!;
    expect(msg.prompt).toBeDefined();
    expect(msg.prompt!.question).toBe("选择执行方案");
    // 重复选项去重
    expect(msg.prompt!.options).toEqual(["方案A", "方案B"]);
  });

  it("a normal message has no prompt", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    await send(slug, token, "hi");
    const msg = (await messages(slug, token)).find((m) => m.body === "hi")!;
    expect(msg.prompt).toBeUndefined();
  });

  it("rejects an invalid prompt (empty options) with 400, does not persist", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const bad = await send(slug, token, "bad prompt", { question: "q", options: [] });
    expect(bad.status).toBe(400);
    expect((await messages(slug, token)).some((m) => m.body === "bad prompt")).toBe(false);
  });

  it("rejects a prompt whose question is missing", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const bad = await send(slug, token, "no q", { options: ["A"] });
    expect(bad.status).toBe(400);
  });
});
