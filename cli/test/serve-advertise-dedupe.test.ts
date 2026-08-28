// #959：serve 上线发的 waiting 状态帧要去重——本身份在频道里的上一条状态帧若一字不差，就不再发。
// 事故现场：一个反复拉起/回收的 codex 唤醒层 3 小时把同一句话刷了 28 遍，把频道烧到 loop guard。
import { describe, expect, test } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { advertiseServeWake, serveWakeNote, serveWakeAlreadyAdvertised } from "../src/commands/serve";
import type { ResolvedAuthDetailed } from "../src/oidc-cli";
import { msgFrame } from "./mock-server";

const SELF = "leo-server";
const NOTE = serveWakeNote("codex");

const auth: ResolvedAuthDetailed = {
  server: "https://party.example.com",
  token: "ap_tok",
  auth_source: "runtime_config",
  config: { present: true, kind: "workspace", path: "/tmp/x.json" } as never,
  account: { present: false, path: "/tmp/account.json" } as never,
};

function statusFrame(seq: number, sender: string, note: string, state = "waiting"): MsgFrame {
  return msgFrame(seq, "", { sender: { name: sender, kind: "agent" }, kind: "status", state, note }) as unknown as MsgFrame;
}

interface Harness {
  posted: unknown[];
  recentCalls: number;
  lines: string[];
  run: () => Promise<void>;
}

function harness(recent: () => Promise<MsgFrame[]>, self: string | null = SELF): Harness {
  const posted: unknown[] = [];
  const lines: string[] = [];
  let recentCalls = 0;
  const h: Harness = {
    posted,
    lines,
    get recentCalls() { return recentCalls; },
    run: () => advertiseServeWake(auth, "ludo", "codex", undefined, {
      self,
      out: (line) => lines.push(line),
      post: (async (_s: string, _t: string, _c: string, payload: unknown) => {
        posted.push(payload);
        return { seq: 99 };
      }) as never,
      recent: (async () => {
        recentCalls += 1;
        return recent();
      }) as never,
    }),
  };
  return h;
}

describe("serve 上线帧去重（#959）", () => {
  test("事故场景：本身份上一条状态帧与这次一字不差 ⇒ 不发，只留一行痕迹", async () => {
    const h = harness(async () => [
      statusFrame(28, SELF, NOTE),
      msgFrame(27, "hi") as unknown as MsgFrame,
      statusFrame(26, SELF, NOTE),
    ]);
    await h.run();
    expect(h.posted).toHaveLength(0);
    expect(h.recentCalls).toBe(1);
    expect(h.lines.join("\n")).toContain("不再重复发");
  });

  test("历史里从没发过 ⇒ 照发（首次上线必须让 presence 拿到 wake.kind=serve）", async () => {
    const h = harness(async () => [msgFrame(1, "hello") as unknown as MsgFrame]);
    await h.run();
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]).toMatchObject({ kind: "status", state: "waiting", note: NOTE, wake: { kind: "serve" } });
  });

  test("上一条状态帧是我的但正文不同（比如刚 done 完）⇒ 照发：这次上线是新信息", async () => {
    const h = harness(async () => [statusFrame(30, SELF, "任务已完成", "done"), statusFrame(29, SELF, NOTE)]);
    await h.run();
    expect(h.posted).toHaveLength(1);
  });

  test("一字不差的帧是别人发的 ⇒ 与我无关，照发", async () => {
    const h = harness(async () => [statusFrame(30, "someone-else", NOTE)]);
    await h.run();
    expect(h.posted).toHaveLength(1);
  });

  test("只看最新那条：我最新的状态帧不同，更早有一条相同的也不算", async () => {
    const h = harness(async () => [statusFrame(10, SELF, NOTE), statusFrame(12, SELF, "working on it", "working")]);
    await h.run();
    expect(h.posted).toHaveLength(1);
  });

  test("历史取不到（断网 / 旧服务端）⇒ 照发，行为与修复前一致", async () => {
    const h = harness(async () => { throw new Error("boom"); });
    await h.run();
    expect(h.posted).toHaveLength(1);
  });

  test("不知道自己是谁（welcome 还没给 self）⇒ 没法去重，照发且不查历史", async () => {
    const h = harness(async () => [statusFrame(28, SELF, NOTE)], null);
    await h.run();
    expect(h.posted).toHaveLength(1);
    expect(h.recentCalls).toBe(0);
  });

  test("判定函数本身：state 必须同为 waiting", async () => {
    const same = await serveWakeAlreadyAdvertised(auth, "ludo", NOTE, {
      self: SELF,
      recent: (async () => [statusFrame(5, SELF, NOTE, "blocked")]) as never,
    });
    expect(same).toBe(false);
  });
});
