import { env, runInDurableObject } from "cloudflare:test";
import { SESSION_OUTPUT_RING_LINES, type SessionOutputFrame } from "@agentparty/shared";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { SessionOutputRing, createSqlSessionOutputStore } from "../src/session-output-ring";
import { WsClient, createChannel, seedToken, uniq } from "./helpers";

// #1103 item 5：环形缓冲落 DO SQLite。DO 被驱逐（内存丢失）后，晚到者仍能回放最后一屏；
// 每 agent 有界 300 行；成员移除时连同存储一起清掉。

function clientFrame(sessionId: string, state: string, texts: string[]) {
  return {
    type: "session_output" as const,
    session_id: sessionId,
    task_seq: 3,
    state: state as "running",
    lines: texts.map((text, i) => ({ kind: "stdout" as const, text, ts: i + 1 })),
  };
}

describe("session output ring persistence (#1103)", () => {
  it("survives a fresh ring over the same storage, bounded to the ring size", async () => {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(uniq("persist")));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const ring = new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql));
      const total = SESSION_OUTPUT_RING_LINES + 40;
      for (let i = 0; i < total; i += 10) {
        const texts = Array.from({ length: 10 }, (_, j) => `line ${i + j}`);
        ring.apply("worker-a", "conn-1", clientFrame("run-1", "running", texts), 1_000 + i * 1_000);
      }
      ring.apply("worker-a", "conn-1", clientFrame("run-1", "done", ["bye"]), 1_000_000);

      // 「驱逐」：新 ring、同一份存储
      const revived = new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql));
      const [snap] = revived.snapshot();
      expect(snap).toBeDefined();
      expect(snap!.name).toBe("worker-a");
      expect(snap!.session_id).toBe("run-1");
      expect(snap!.state).toBe("done");
      expect(snap!.task_seq).toBe(3);
      expect(snap!.replay).toBe(true);
      expect(snap!.lines).toHaveLength(SESSION_OUTPUT_RING_LINES);
      expect(snap!.lines.at(-1)!.text).toBe("bye");
      expect(snap!.lines[0]!.text).toBe(`line ${total + 1 - SESSION_OUTPUT_RING_LINES}`);
      const stored = state.storage.sql
        .exec("SELECT COUNT(*) AS n FROM session_output_lines WHERE name = ?", "worker-a")
        .toArray()[0]!.n;
      expect(Number(stored)).toBe(SESSION_OUTPUT_RING_LINES);

      // 新 session 替换旧行
      revived.apply("worker-a", "conn-2", clientFrame("run-2", "running", ["fresh"]), 2_000_000);
      const again = new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql)).snapshot();
      expect(again[0]!.session_id).toBe("run-2");
      expect(again[0]!.lines.map((l) => l.text)).toEqual(["fresh"]);

      // 恢复出来的 running session，上报连接已不在 → disconnected（并落盘）
      const reloaded = new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql));
      expect(reloaded.snapshot(new Set(["other-conn"]))[0]!.state).toBe("disconnected");
      expect(new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql)).snapshot()[0]!.state).toBe("disconnected");

      // 成员移除：存储一起清
      reloaded.forget("worker-a");
      expect(new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql)).snapshot()).toEqual([]);
      const left = state.storage.sql.exec("SELECT COUNT(*) AS n FROM session_output_lines").toArray()[0]!.n;
      expect(Number(left)).toBe(0);
    });
  });

  it("a late viewer after DO memory loss still gets the replay from storage", async () => {
    const agent = await seedToken("agent");
    const human = await seedToken("human");
    const slug = await createChannel(human.token);
    const runner = await WsClient.open(slug, agent.token);
    await runner.nextOfType("welcome");
    runner.send({ type: "hello", since: 0 });
    runner.send(clientFrame("run-z", "running", ["persisted line"]));
    runner.send({ type: "ping", nonce: 1 });
    for (;;) if ((await runner.next()).type === "pong") break;

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      // 模拟驱逐：丢掉内存里的环，只留存储
      (instance as unknown as { sessionOutputRing: SessionOutputRing }).sessionOutputRing =
        new SessionOutputRing(createSqlSessionOutputStore(state.storage.sql));
    });

    const viewer = await WsClient.open(slug, human.token);
    await viewer.nextOfType("welcome");
    viewer.send({ type: "hello", since: 0 });
    const replay = (await viewer.nextOfType("session_output")) as SessionOutputFrame;
    expect(replay.replay).toBe(true);
    expect(replay.name).toBe(agent.name);
    expect(replay.state).toBe("running");
    expect(replay.lines.map((l) => l.text)).toEqual(["persisted line"]);
  });
});
