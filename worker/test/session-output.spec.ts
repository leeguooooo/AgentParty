import { SESSION_OUTPUT_RING_LINES, type ServerFrame, type SessionOutputFrame } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import { SESSION_OUTPUT_BUCKET_CAPACITY, SessionOutputRing } from "../src/session-output-ring";
import { WsClient, createChannel, seedToken } from "./helpers";

// #1103：runner live session 输出。agent 连接经已有 WS 上报 session_output；DO 用连接身份（不是帧里的字段）
// 标注发送者、再脱敏一遍、扇出给观看者（人类恒收，agent 需 hello.session_output="v1" 订阅），
// 并为晚到者保留有界环形缓冲；上报连接断开 → running session 标 disconnected。

const SECRET = "ap_" + "WorkerSideSecret99999";

async function join(slug: string, token: string, hello: Record<string, unknown> = {}): Promise<WsClient> {
  const ws = await WsClient.open(slug, token);
  await ws.nextOfType("welcome");
  ws.send({ type: "hello", since: 0, ...hello });
  return ws;
}

/** 读到 pong 为止，返回途中收到的所有帧（用 ping/pong 当屏障，证明「没收到」而不是「还没到」）。 */
async function drainUntilPong(ws: WsClient): Promise<ServerFrame[]> {
  ws.send({ type: "ping", nonce: 1 });
  const seen: ServerFrame[] = [];
  for (;;) {
    const frame = await ws.next();
    if (frame.type === "pong") return seen;
    seen.push(frame);
  }
}

function frame(sessionId: string, state: string, texts: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "session_output",
    session_id: sessionId,
    task_seq: 12,
    state,
    lines: texts.map((text) => ({ kind: "stdout", text, ts: 1 })),
    ...extra,
  };
}

describe("live session output (#1103)", () => {
  it("fans out to human viewers with the connection identity, redacted; agents do not receive it unless subscribed", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(human.token);
    const viewer = await join(slug, human.token);
    const runner = await join(slug, agent.token);
    const subscribedAgent = await join(slug, (await seedToken("agent")).token, { session_output: "v1" });
    await drainUntilPong(viewer);
    await drainUntilPong(runner);
    await drainUntilPong(subscribedAgent);

    runner.send(frame("run-a", "running", [`using ${SECRET}`, "compiling"], { name: "impostor" }));
    const got = (await viewer.nextOfType("session_output")) as SessionOutputFrame;
    expect(got.name).toBe(agent.name);
    expect(got.session_id).toBe("run-a");
    expect(got.task_seq).toBe(12);
    expect(got.state).toBe("running");
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect(got.lines.map((l) => l.text)).toEqual(["using [redacted]", "compiling"]);

    const sub = (await subscribedAgent.nextOfType("session_output")) as SessionOutputFrame;
    expect(sub.session_id).toBe("run-a");
    const runnerSaw = await drainUntilPong(runner);
    expect(runnerSaw.filter((f) => f.type === "session_output")).toEqual([]);

    viewer.close();
    runner.close();
    subscribedAgent.close();
  });

  it("late joiners get the ring-buffer snapshot including the final state", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(human.token);
    const runner = await join(slug, agent.token);
    await drainUntilPong(runner);
    runner.send(frame("run-b", "running", ["one"]));
    runner.send(frame("run-b", "running", ["two"]));
    runner.send(frame("run-b", "done", ["three"]));
    await drainUntilPong(runner);

    const late = await join(slug, human.token);
    const snap = (await late.nextOfType("session_output")) as SessionOutputFrame;
    expect(snap.replay).toBe(true);
    expect(snap.name).toBe(agent.name);
    expect(snap.state).toBe("done");
    expect(snap.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);

    // 终态之后迟到的同 session 帧不能改写最后一屏。
    runner.send(frame("run-b", "running", ["late"]));
    await drainUntilPong(runner);
    const after = await drainUntilPong(late);
    expect(after.filter((f) => f.type === "session_output")).toEqual([]);
    runner.close();
    late.close();
  });

  it("runner disconnect marks the running session disconnected for viewers", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(human.token);
    const viewer = await join(slug, human.token);
    const runner = await join(slug, agent.token);
    await drainUntilPong(viewer);
    await drainUntilPong(runner);
    runner.send(frame("run-c", "running", ["working"]));
    await viewer.nextOfType("session_output");
    runner.close();
    for (;;) {
      const next = (await viewer.nextOfType("session_output")) as SessionOutputFrame;
      if (next.state === "disconnected") {
        expect(next.session_id).toBe("run-c");
        break;
      }
    }
    viewer.close();
  });

  it("rejects session_output from human connections and silently drops malformed agent frames", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(human.token);
    const viewer = await join(slug, human.token);
    const runner = await join(slug, agent.token);
    await drainUntilPong(viewer);
    await drainUntilPong(runner);

    viewer.send(frame("run-d", "running", ["spoof"]));
    const err = await viewer.nextOfType("error");
    expect(err).toMatchObject({ code: "bad_request" });

    runner.send(frame("bad id!", "running", ["x"]));
    runner.send(frame("run-d", "disconnected", ["x"]));
    const runnerSaw = await drainUntilPong(runner);
    expect(runnerSaw.filter((f) => f.type === "error")).toEqual([]);
    const viewerSaw = await drainUntilPong(viewer);
    expect(viewerSaw.filter((f) => f.type === "session_output")).toEqual([]);
    viewer.close();
    runner.close();
  });
});

describe("SessionOutputRing bounds (#1103)", () => {
  it("rate-limits running frames per connection but never drops the terminal frame; ring keeps the last N lines", () => {
    const ring = new SessionOutputRing();
    const mk = (state: "running" | "done", n: number) => ({
      type: "session_output" as const,
      session_id: "r",
      task_seq: null,
      state,
      lines: Array.from({ length: n }, (_, i) => ({ kind: "stdout" as const, text: `l${i}`, ts: 1 })),
    });
    let accepted = 0;
    for (let i = 0; i < SESSION_OUTPUT_BUCKET_CAPACITY + 10; i++) {
      if (ring.apply("a", "c1", mk("running", 50), 1000) !== null) accepted++;
    }
    expect(accepted).toBe(SESSION_OUTPUT_BUCKET_CAPACITY);
    expect(ring.apply("a", "c1", mk("done", 1), 1000)?.state).toBe("done");
    const [snap] = ring.snapshot();
    expect(snap!.lines).toHaveLength(SESSION_OUTPUT_RING_LINES);
    expect(snap!.state).toBe("done");
  });
});
