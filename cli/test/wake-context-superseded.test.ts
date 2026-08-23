// #834 第 4 项：唤醒上下文里的**背景消息**必须带上「已被取代」。
//
// #881 把 superseded 一路做通到了触发帧，但 issue 抱怨的那件事说的是「wake-context 会重放旧
// seq，携带已被后续消息推翻的旧前提」——被重放的正是 `recent[]`（触发帧只有一条）。recent[]
// 此前只落 seq/sender/kind/body/attachments/ts，标记整个丢掉：模型看到的背景里，一条已被推翻
// 的旧指令与仍然有效的指令长得一模一样。
//
// 而且 recent 是**收帧当时**的快照，supersede 只发生在「之后」——不接住服务端的
// message_update("supersede") 广播，缓冲里那条永远不会带上标记。两件事必须都做，缺一条这
// 条路径就仍然是通的。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MsgFrame } from "@agentparty/shared";
import {
  applySupersedeToRecent,
  createWakeContextDir,
  runServe,
  writeContextFile,
  type ServeOptions,
} from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const dirs: string[] = [];
let server: MockServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctxDir(): string {
  const d = createWakeContextDir();
  dirs.push(d);
  return d;
}

function frame(seq: number, body: string, superseded?: { by_seq: number; reason: "revision" | "reply_correction" }): MsgFrame {
  const base = msgFrame(seq, body) as unknown as MsgFrame;
  return superseded === undefined ? base : { ...base, superseded };
}

function contextOf(trigger: MsgFrame, recent: MsgFrame[]): Record<string, unknown> {
  const path = writeContextFile(ctxDir(), trigger, "dev", "alice", recent);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("#834 第 4 项：recent[] 里的旧前提必须自带 superseded", () => {
  // 反假绿：**触发帧刻意不带 superseded**。触发帧那条分支早就实现了，让它同时满足条件就会把
  // 被测的这道闸整个遮住——退回旧实现照样全绿。这里唯一能产生标记的来源只有 recent[]。
  test("触发帧未被取代，但背景里的旧指令被取代 → recent 条目与 notice 都要报出来", () => {
    const ctx = contextOf(frame(9, "@alice 现在处理这个"), [
      frame(3, "部署到 prod", { by_seq: 5, reason: "reply_correction" }),
      frame(5, "改口：先别部署"),
    ]);

    expect(ctx.superseded).toBeNull();
    expect(ctx.superseded_notice).toBeUndefined();

    const recent = ctx.recent as Array<Record<string, unknown>>;
    expect(recent.map((entry) => entry.seq)).toEqual([3, 5]);
    expect(recent[0]!.superseded).toEqual({ by_seq: 5, reason: "reply_correction" });
    expect(recent[1]!.superseded).toBeUndefined();

    expect(ctx.recent_superseded_seqs).toEqual([3]);
    expect(String(ctx.recent_superseded_notice)).toContain("seq 3");
    expect(String(ctx.recent_superseded_notice)).toContain("不得当作仍然有效的指令");
  });

  test("背景全是有效消息 → 不凭空插 notice（免得每次唤醒都喊狼来了）", () => {
    const ctx = contextOf(frame(9, "@alice 干活"), [frame(3, "早"), frame(5, "好")]);
    expect(ctx.recent_superseded_seqs).toBeUndefined();
    expect(ctx.recent_superseded_notice).toBeUndefined();
    for (const entry of ctx.recent as Array<Record<string, unknown>>) {
      expect(entry.superseded).toBeUndefined();
    }
  });

  test("触发帧与背景各自被取代时两条 notice 并存，互不遮蔽", () => {
    const ctx = contextOf(frame(9, "@alice 按老方案来", { by_seq: 11, reason: "revision" }), [
      frame(3, "部署到 prod", { by_seq: 5, reason: "reply_correction" }),
    ]);
    expect(ctx.superseded).toEqual({ by_seq: 11, reason: "revision" });
    expect(String(ctx.superseded_notice)).toContain("seq 11");
    expect(ctx.recent_superseded_seqs).toEqual([3]);
    expect(String(ctx.recent_superseded_notice)).toContain("seq 3");
  });
});

describe("#834 第 4 项：supersede 广播必须落到 serve 的 recent 缓冲", () => {
  // 这条是上面那条的**前置**：recent 存的是收帧当时的快照，标记只可能后到。没有这一步，
  // 上面新增的字段在真实 serve 里永远是空的（只有重连补拉的帧才自带标记）。
  test("message_update(supersede) 命中缓冲里的旧帧 → 之后落盘的上下文带标记", () => {
    const recent: MsgFrame[] = [frame(3, "部署到 prod"), frame(5, "改口：先别部署")];
    const authoritative = frame(3, "部署到 prod", { by_seq: 5, reason: "reply_correction" });

    expect(applySupersedeToRecent(recent, 3, authoritative)).toBe(true);
    expect(recent[0]!.superseded).toEqual({ by_seq: 5, reason: "reply_correction" });

    const ctx = contextOf(frame(9, "@alice 继续"), recent);
    expect(ctx.recent_superseded_seqs).toEqual([3]);
  });

  test("目标 seq 已被挤出缓冲 → 什么都不动，不凭空造一条", () => {
    const recent: MsgFrame[] = [frame(5, "改口：先别部署")];
    expect(applySupersedeToRecent(recent, 3, frame(3, "部署到 prod", { by_seq: 5, reason: "reply_correction" }))).toBe(false);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.superseded).toBeUndefined();
  });

  test("权威快照没带 superseded → 不当成取代（标记只认服务端下发的，不自己拼）", () => {
    const recent: MsgFrame[] = [frame(3, "部署到 prod")];
    expect(applySupersedeToRecent(recent, 3, frame(3, "部署到 prod"))).toBe(false);
    expect(recent[0]!.superseded).toBeUndefined();
  });

  test("不篡改缓冲里的其它字段，也不动别的条目", () => {
    const recent: MsgFrame[] = [frame(3, "部署到 prod"), frame(5, "改口")];
    applySupersedeToRecent(recent, 3, frame(3, "被服务端改写过的正文", { by_seq: 5, reason: "reply_correction" }));
    expect(recent[0]!.body).toBe("部署到 prod");
    expect(recent[0]!.seq).toBe(3);
    expect(recent[1]!.superseded).toBeUndefined();
  });
});

describe("#834 第 4 项：serve 主循环必须接住 supersede 广播（端到端）", () => {
  // 上面两组都在函数级：把 message_update 那块处理整个从 runServe 的帧循环里删掉，它们照样全绿。
  // 这条走真实的 runServe 循环，唯一能让 ctx.recent[0] 带上标记的路径就是那块处理。
  test("旧指令进缓冲 → 服务端广播取代 → 下一次唤醒拿到的 recent 已带标记", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "ap-lock-"));
    dirs.push(lockDir);
    const superseded = { by_seq: 5, reason: "reply_correction" as const };
    server = startMockServer((clientFrame, sock) => {
      if (clientFrame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(3, "部署到 prod")), 20);
      setTimeout(() => sock.send(msgFrame(5, "改口：先别部署")), 40);
      setTimeout(() => sock.send({
        type: "message_update",
        target_seq: 3,
        action: "supersede",
        actor: { name: "bob", kind: "agent" },
        ts: Date.now(),
        message: msgFrame(3, "部署到 prod", { superseded }),
      }), 60);
      setTimeout(() => sock.send(msgFrame(9, "@me 继续", { mentions: ["me"] })), 80);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 160);
    });
    let seen: MsgFrame[] | null = null;
    const options: ServeOptions = {
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      lockDir,
      out: () => {},
      runCommand: async (_frame, ctx) => { seen = ctx.recent.slice(); },
    };
    await runServe(options);
    const recent: MsgFrame[] | null = seen;
    expect(recent).not.toBeNull();
    expect(recent!.map((entry) => entry.seq)).toEqual([3, 5]);
    expect(recent![0]!.superseded).toEqual(superseded);
    expect(recent![1]!.superseded).toBeUndefined();
  });
});
