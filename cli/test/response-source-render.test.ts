// #817：隔离 runner 代答的消息在频道里和本人发的完全一样——同一个 name、同一个 role、正文无标记。
// 服务端其实有 response_source，只是渲染层不显示。问题恰恰在于这类回复读起来「像有全部上下文的
// 本人说的」：它不知道本人这一整天做了什么、哪些结论已经被推翻。协作方要判断「这句话背后有多少
// 上下文」，不该只能自己去解析 API 元数据。
import { describe, expect, test } from "bun:test";
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import { formatMsg, formatMsgHeader, msgHeader } from "../src/format";
import { classify, receptionNote } from "../src/commands/who";

const NOW = 1_700_000_000_000;

function msg(over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    channel: "welcome",
    seq: 430,
    ts: NOW,
    kind: "message",
    sender: { name: "leo-welcome-fable5", kind: "agent" },
    body: "我来认领这个任务，设计上我倾向 A 方案。",
    mentions: [],
    reply_to: null,
    ...over,
  } as unknown as MsgFrame;
}

const RUNNER_REPLY = msg({
  response_source: {
    kind: "reception_runner",
    runner: "claude",
    context: "isolated_channel_session",
    session: "started",
    trigger_seq: 426,
  },
} as never);

describe("party history 渲染 response_source", () => {
  test("代答消息带出 runner 和上下文边界，与本人发的一眼可分", () => {
    const line = formatMsg(RUNNER_REPLY);
    expect(line).toContain("reception_runner");
    expect(line).toContain("claude");
    expect(line).toContain("isolated");
    // 正文照常在，标记只是加在发送人后面，不遮内容。
    expect(line).toContain("我来认领这个任务");
  });

  test("本人发的消息不带任何标记（有就显示，没有就不显示，零成本）", () => {
    expect(formatMsg(msg())).not.toContain("reception_runner");
  });

  test("fresh_process（custom 命令）与 isolated 会话措辞不同", () => {
    const line = formatMsg(
      msg({
        response_source: {
          kind: "reception_runner",
          runner: "custom",
          context: "fresh_process",
          session: "unavailable",
          trigger_seq: 426,
        },
      } as never),
    );
    expect(line).toContain("fresh process");
    expect(line).not.toContain("isolated");
  });

  test("headers 视图也带标记：扫 header 时就得看见，而不是展开全文才发现", () => {
    expect(formatMsgHeader(RUNNER_REPLY, 20)).toContain("reception_runner");
    expect(msgHeader(RUNNER_REPLY, 20).response_source).toMatchObject({ runner: "claude", trigger_seq: 426 });
    expect(msgHeader(msg(), 20).response_source).toBeUndefined();
  });
});

describe("party who 显示当前接待模式", () => {
  function presence(context: Record<string, unknown>): PresenceEntry {
    return {
      name: "leo-welcome-fable5",
      kind: "agent",
      state: "waiting",
      note: null,
      ts: NOW,
      last_seen: NOW,
      live: true,
      status: { owner: "leo-welcome-fable5", state: "waiting", note: "", scope: [], ts: NOW, context },
    } as unknown as PresenceEntry;
  }

  test("挂着隔离 runner 的身份，@ 之前就能看出「答我的可能不是本人」", () => {
    const row = classify(
      presence({ reception_mode: "model", reception_runner: "claude", reception_context: "isolated_channel_session" }),
      NOW,
    );
    expect(row).toMatchObject({
      reception_mode: "model",
      reception_runner: "claude",
      reception_context: "isolated_channel_session",
    });
    expect(receptionNote(row!)).toBe(" · 🤖 reception model:claude isolated");
  });

  test("custom 命令接待标 fresh", () => {
    const row = classify(
      presence({ reception_mode: "custom", reception_runner: "custom", reception_context: "fresh_process" }),
      NOW,
    );
    expect(receptionNote(row!)).toBe(" · 🤖 reception custom:custom fresh");
  });

  test("没有接待 runner 的身份不带这条（不无中生有）", () => {
    const row = classify(presence({}), NOW);
    expect(row!.reception_mode).toBeUndefined();
    expect(receptionNote(row!)).toBe("");
  });
});
