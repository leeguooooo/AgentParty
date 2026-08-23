// #930：supersede 只对「下一次」唤醒生效——已在跑 / 已排队的那条 @ 永远拿不到标记。
//
// 服务端打标记的**唯一时机**（`markSupersededByReplyCorrection`）要求「该目标的 delivery 仍未结清」，
// 也就是这条 @ 要么正在 runner 手里跑、要么在队列里等着被交出去。而 serve 是串行消费者：一条 wake
// 跑几分钟，期间到达的 `message_update("supersede")` 全堆在 FrameQueue 里，主循环要等本轮跑完才轮到
// 它。#928 补的 `applySupersedeToRecent` 管的是**下一次**唤醒的背景缓冲，救不了这两种状态。
//
// 本文件钉住的是这个故障形态本身：
//   路线 B（已排队）——交给 runner 之前用缓冲区里的权威标记重写触发帧，无损修好；
//   路线 A（正在跑）——只通知不打断：sidecar 落盘 + 一条频道 status，绝不 abort、绝不改投递状态。
//
// 反假绿纪律：wire 上发出去的 msg 帧**一律不带** `superseded`，也不发 delivery 帧、不靠 recent[]。
// 于是标记的唯一可能来源就是被测的那道闸；把闸删掉，用例必须转红。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MsgFrame, type ServerFrame } from "@agentparty/shared";
import {
  applyPendingSupersedeToTrigger,
  findPendingSupersede,
  inflightSupersededNotice,
  runServe,
  writeSupersededSidecar,
  type ServeOptions,
} from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer, type MockSocket } from "./mock-server";

const dirs: string[] = [];
let server: MockServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

type Mark = { by_seq: number; reason: "revision" | "reply_correction" };

function supersedeFrame(targetSeq: number, mark: Mark): Record<string, unknown> {
  return {
    type: "message_update",
    target_seq: targetSeq,
    action: "supersede",
    actor: { name: "bob", kind: "agent" },
    ts: Date.now(),
    message: msgFrame(targetSeq, `旧指令 ${targetSeq}`, { superseded: mark }),
  };
}

function pendingSupersede(targetSeq: number, mark: Mark): ServerFrame {
  return supersedeFrame(targetSeq, mark) as unknown as ServerFrame;
}

function trigger(seq: number, superseded?: Mark): MsgFrame {
  const base = msgFrame(seq, `@me 干活 ${seq}`, { mentions: ["me"] }) as unknown as MsgFrame;
  return superseded === undefined ? base : { ...base, superseded };
}

describe("#930 缓冲区里的 supersede 必须能被交接点看见", () => {
  test("命中同一 seq → 返回服务端下发的权威标记", () => {
    const mark: Mark = { by_seq: 11, reason: "reply_correction" };
    expect(findPendingSupersede([pendingSupersede(9, mark)], 9)).toEqual(mark);
  });

  test("target_seq 不匹配 → 绝不外溢到别的排队项（反向用例）", () => {
    expect(findPendingSupersede([pendingSupersede(8, { by_seq: 11, reason: "reply_correction" })], 9)).toBeNull();
  });

  test("同一 seq 多条修订 → 取最后一条（后到的快照更权威）", () => {
    const first: Mark = { by_seq: 11, reason: "reply_correction" };
    const last: Mark = { by_seq: 13, reason: "revision" };
    expect(findPendingSupersede([pendingSupersede(9, first), pendingSupersede(9, last)], 9)).toEqual(last);
  });

  test("同为 message_update 但 action 不是 supersede → 不当成取代", () => {
    const edit = { ...supersedeFrame(9, { by_seq: 11, reason: "revision" }), action: "edit" } as unknown as ServerFrame;
    expect(findPendingSupersede([edit], 9)).toBeNull();
  });

  test("权威快照没带 superseded → 不自己拼标记", () => {
    const bare = {
      type: "message_update",
      target_seq: 9,
      action: "supersede",
      actor: { name: "bob", kind: "agent" },
      ts: Date.now(),
      message: msgFrame(9, "旧指令 9"),
    } as unknown as ServerFrame;
    expect(findPendingSupersede([bare], 9)).toBeNull();
  });

  test("非 message_update 的缓冲帧一律忽略", () => {
    expect(findPendingSupersede([msgFrame(9, "闲聊") as unknown as ServerFrame], 9)).toBeNull();
  });
});

describe("#930 路线 B：交接点重写触发帧", () => {
  test("排队的那条被取代 → 交出去的帧带上标记，且不改动其它字段", () => {
    const mark: Mark = { by_seq: 11, reason: "reply_correction" };
    const out = applyPendingSupersedeToTrigger(trigger(9), [pendingSupersede(9, mark)]);
    expect(out.superseded).toEqual(mark);
    expect(out.seq).toBe(9);
    expect(out.body).toBe("@me 干活 9");
    expect(out.mentions).toEqual(["me"]);
  });

  test("缓冲区里没有命中的 supersede → 原样返回同一个对象（prepare 缓存按对象身份查）", () => {
    const frame = trigger(9);
    expect(applyPendingSupersedeToTrigger(frame, [pendingSupersede(8, { by_seq: 11, reason: "revision" })])).toBe(frame);
  });

  test("帧自己已带标记 → 不被缓冲区里的另一条覆盖", () => {
    const own: Mark = { by_seq: 11, reason: "revision" };
    const frame = trigger(9, own);
    expect(applyPendingSupersedeToTrigger(frame, [pendingSupersede(9, { by_seq: 13, reason: "reply_correction" })])).toBe(frame);
    expect(frame.superseded).toEqual(own);
  });
});

describe("#930 路线 A：sidecar 说的是「已取代」，不是「不存在」", () => {
  test("文案点名新旧两个 seq，并明确要求别按旧前提继续", () => {
    const notice = inflightSupersededNotice(7, { by_seq: 9, reason: "reply_correction" });
    expect(notice).toContain("seq 7");
    expect(notice).toContain("seq 9");
    expect(notice).toContain("已过期");
    expect(notice).toContain("不要静默丢弃");
  });

  test("sidecar 落在 wake-context 同目录、同 seq 前缀，内容自洽", () => {
    const dir = tmp("ap-sidecar-");
    const mark: Mark = { by_seq: 9, reason: "reply_correction" };
    const path = writeSupersededSidecar(dir, 7, "dev", "me", mark, 1_700_000_000_000);
    expect(path).toBe(join(dir, "7.superseded.json"));
    const body = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(body.seq).toBe(7);
    expect(body.channel).toBe("dev");
    expect(body.self).toBe("me");
    expect(body.superseded).toEqual(mark);
    expect(body.detected_at).toBe(1_700_000_000_000);
    expect(String(body.notice)).toContain("seq 9");
  });
});

describe("#930 端到端：serve 真实帧循环", () => {
  // 路线 B。构造真实的「已排队」状态：第一条 @ 把串行循环卡住，其后到达的 msg 与 supersede 全堆在
  // FrameQueue 里，等第一条跑完才被消费——这正是服务端打标记的那个窗口。
  //
  // 因果性（不靠计时猜）：msg9 / msg10 / update10 是在同一次发送里按序进的 socket，TCP 有序，
  // 客户端 ws 收到即入队。断言 seq 10 带标记就证明 update10 在 seq 9 交接的那一刻**已经在缓冲区里**，
  // 于是同一时刻 seq 9 仍然干净这件事，就是货真价实的「不外溢」，而不是「还没到」。
  test("排队中的两条：被取代的那条带标记，另一条绝不被污染", async () => {
    const lockDir = tmp("ap-lock-");
    const mark: Mark = { by_seq: 12, reason: "reply_correction" };
    let sock: MockSocket | null = null;
    let beats = 0;
    let sent = false;
    let release: (() => void) | null = null;
    server = startMockServer((clientFrame, s) => {
      sock = s;
      if (clientFrame.type === "hello") {
        s.send(welcomeFrame(0, "me"));
        s.send(msgFrame(7, "@me 先做 A", { mentions: ["me"] }));
        return;
      }
      // 心跳只在 run() 期间发，且带 current_task——它证明第一条 @ 确实卡在 runner 手里。
      if (clientFrame.type !== "heartbeat") return;
      if ((clientFrame as unknown as { current_task: number | null }).current_task !== 7) return;
      beats += 1;
      if (!sent) {
        sent = true;
        s.send(msgFrame(9, "@me 顺手做 B", { mentions: ["me"] }));
        s.send(msgFrame(10, "@me 再做 C", { mentions: ["me"] }));
        s.send(supersedeFrame(10, mark));
        return;
      }
      // 再等几拍客户端自己的定时器：每一拍都意味着客户端事件循环转过一轮，
      // 上面三帧（回环、亚毫秒）早已被 ws 消息回调推进 FrameQueue。
      if (beats >= 6 && release !== null) {
        const go = release;
        release = null;
        go();
      }
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: MsgFrame[] = [];
    const options: ServeOptions = {
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      heartbeatIntervalMs: 10,
      out: () => {},
      post: (async () => ({ seq: 0 })) as unknown as ServeOptions["post"],
      runCommand: async (frame) => {
        seen.push(frame);
        if (frame.seq === 7) await gate;
        if (frame.seq === 10) sock?.send({ type: "error", code: "archived", message: "done" });
      },
    };
    await runServe(options);

    expect(seen.map((f) => f.seq)).toEqual([7, 9, 10]);
    // 卡住循环的那条自己没被取代——不许因为「有 supersede 广播」就无差别打标。
    expect(seen[0]!.superseded).toBeUndefined();
    // 反向用例：排在同一个缓冲区里、seq 不匹配的那条必须干净。
    expect(seen[1]!.superseded).toBeUndefined();
    // 被测的那道闸：交出去之前用服务端权威快照重写触发帧。
    expect(seen[2]!.superseded).toEqual(mark);
  });

  // 路线 A。第一条 @ 已经在 runner 手里，取代它的广播此刻才到——主循环被 run() 阻塞，
  // 只有心跳侧信道那一拍能看见它。断言 runner 的工作目录与频道里都能看到「已被 seq N 取代」。
  //
  // 因果性：update8（seq 不匹配）先进 socket、update7 后进；通告落在 by_seq=11 上就证明 update8
  // 当时已在缓冲区里却被正确忽略——反向用例不靠「可能还没到」蒙混过关。
  test("正在跑的那条被取代 → 频道一条通告 + 工作目录一份 sidecar，且不打断本轮", async () => {
    const lockDir = tmp("ap-lock-");
    const mark: Mark = { by_seq: 11, reason: "reply_correction" };
    let sock: MockSocket | null = null;
    let sent = false;
    let notify: ((note: string) => void) | null = null;
    server = startMockServer((clientFrame, s) => {
      sock = s;
      if (clientFrame.type === "hello") {
        s.send(welcomeFrame(0, "me"));
        s.send(msgFrame(7, "@me 先做 A", { mentions: ["me"] }));
        return;
      }
      if (clientFrame.type !== "heartbeat") return;
      if ((clientFrame as unknown as { current_task: number | null }).current_task !== 7) return;
      if (sent) return;
      sent = true;
      s.send(supersedeFrame(8, { by_seq: 999, reason: "revision" }));
      s.send(supersedeFrame(7, mark));
    });
    const notices: string[] = [];
    const notified = new Promise<string>((resolve) => { notify = resolve; });
    let sidecar: Record<string, unknown> | null = null;
    let sidecarPath = "";
    let finished = false;
    const options: ServeOptions = {
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      heartbeatIntervalMs: 10,
      out: () => {},
      post: (async (_server: string, _token: string, _channel: string, payload: { note?: string }) => {
        const note = payload.note ?? "";
        if (note.includes("superseded in flight")) {
          notices.push(note);
          notify?.(note);
          notify = null;
        }
        return { seq: 0 };
      }) as unknown as ServeOptions["post"],
      runCommand: async (frame, ctx) => {
        if (frame.seq !== 7) return;
        // 交接时缓冲区里还没有 supersede：路线 B 无从生效，唯一能产生通告的只有 in-flight 那道闸。
        expect(frame.superseded).toBeUndefined();
        // 有界等待：闸被拿掉时要给出干净的断言失败，而不是把整条用例挂到超时。
        await Promise.race([notified, new Promise((r) => setTimeout(r, 2_000))]);
        sidecarPath = join(ctx.contextDir, "7.superseded.json");
        // contextDir 在 serve 退出时整目录删除，只能在本轮内取证。
        if (existsSync(sidecarPath)) {
          sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
        }
        finished = true;
        sock?.send({ type: "error", code: "archived", message: "done" });
      },
    };
    await runServe(options);

    // 只通知、不打断：本轮照常跑到自己的结尾。
    expect(finished).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("seq 7");
    expect(notices[0]).toContain("seq 11");
    expect(notices[0]).not.toContain("999");
    expect(sidecarPath.endsWith(join("7.superseded.json"))).toBe(true);
    expect(sidecar).not.toBeNull();
    expect((sidecar as unknown as Record<string, unknown>).superseded).toEqual(mark);
    expect((sidecar as unknown as Record<string, unknown>).seq).toBe(7);
  });

  // 交接点已经贴上标记的那一轮，模型开箱就知道——不该再收一条重复通告刷频道。
  test("交接时已带标记 → 不再重复发 in-flight 通告", async () => {
    const lockDir = tmp("ap-lock-");
    const mark: Mark = { by_seq: 12, reason: "reply_correction" };
    let sock: MockSocket | null = null;
    let beats = 0;
    let sent = false;
    let release: (() => void) | null = null;
    server = startMockServer((clientFrame, s) => {
      sock = s;
      if (clientFrame.type === "hello") {
        s.send(welcomeFrame(0, "me"));
        s.send(msgFrame(7, "@me 先做 A", { mentions: ["me"] }));
        return;
      }
      if (clientFrame.type !== "heartbeat") return;
      const task = (clientFrame as unknown as { current_task: number | null }).current_task;
      if (task !== 7) return;
      beats += 1;
      if (!sent) {
        sent = true;
        s.send(msgFrame(10, "@me 再做 C", { mentions: ["me"] }));
        s.send(supersedeFrame(10, mark));
        return;
      }
      if (beats >= 6 && release !== null) {
        const go = release;
        release = null;
        go();
      }
    });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const notices: string[] = [];
    const seen: MsgFrame[] = [];
    const options: ServeOptions = {
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      heartbeatIntervalMs: 10,
      out: () => {},
      post: (async (_server: string, _token: string, _channel: string, payload: { note?: string }) => {
        if ((payload.note ?? "").includes("superseded in flight")) notices.push(payload.note ?? "");
        return { seq: 0 };
      }) as unknown as ServeOptions["post"],
      runCommand: async (frame) => {
        seen.push(frame);
        if (frame.seq === 7) await gate;
        if (frame.seq === 10) {
          // 让心跳多转几拍：若「已带标记就不再通告」的守卫没了，这里就会多出一条。
          await new Promise((r) => setTimeout(r, 60));
          sock?.send({ type: "error", code: "archived", message: "done" });
        }
      },
    };
    await runServe(options);

    expect(seen.map((f) => f.seq)).toEqual([7, 10]);
    expect(seen[1]!.superseded).toEqual(mark);
    expect(notices).toEqual([]);
  });
});
