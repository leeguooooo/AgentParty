// issue #180：serve 是本地 supervisor，消息照样广播给它——服务端只对 webhook 抑制，serve 得自我抑制。
// 收到自己的 paused presence 帧后，被 @ 也不跑 runner；消息仍进历史（游标照推进）。恢复后重新响应。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe, type ServeOptions } from "../src/commands/serve";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  server?.stop();
  server = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function opts(over: Partial<ServeOptions> & { server: string }): ServeOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: (line) => lines.push(line),
    lines,
    lockDir: mkdtempSync(join(tmpdir(), "ap-lock-")),
    ...over,
  };
}

function presenceFrame(name: string, paused: boolean, resumeAt?: number) {
  return { type: "presence", name, state: "waiting", note: null, ts: Date.now(), ...(paused ? { paused: true, ...(resumeAt !== undefined ? { resume_at: resumeAt } : {}) } : {}) };
}

describe("serve 暂停接待自我抑制（#180）", () => {
  test("收到自己的 paused presence 帧后，@我 不再唤醒 runner，但游标仍推进", async () => {
    let ran = 0;
    const cursors: number[] = [];
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(presenceFrame("me", true)), 20);
      setTimeout(() => sock.send(msgFrame(1, "@me wake up", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 80);
    });
    const o = opts({ server: server.url, onCursor: (c) => cursors.push(c), runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(0); // 暂停中：runner 一次都没跑
    expect(cursors).toContain(1); // 但消息被消费、游标推进（不留欠账）
    expect(o.lines.some((l) => l.includes("暂停"))).toBe(true);
  });

  test("welcome 快照里已是 paused（重连后）：@我 同样不唤醒", async () => {
    let ran = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      const welcome = welcomeFrame(0, "me") as Record<string, unknown>;
      welcome.presence = [presenceFrame("me", true, Date.now() + 3_600_000)];
      sock.send(welcome);
      setTimeout(() => sock.send(msgFrame(1, "@me wake up", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 70);
    });
    const o = opts({ server: server.url, runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(0);
    expect(o.lines.some((l) => l.includes("暂停"))).toBe(true);
  });

  test("恢复接待帧后，@我 重新唤醒 runner", async () => {
    let ran = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(presenceFrame("me", true)), 15);
      setTimeout(() => sock.send(msgFrame(1, "@me while paused", { mentions: ["me"] })), 30);
      setTimeout(() => sock.send(presenceFrame("me", false)), 45);
      setTimeout(() => sock.send(msgFrame(2, "@me after resume", { mentions: ["me"] })), 60);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 100);
    });
    const o = opts({ server: server.url, runCommand: async () => { ran++; } });
    await runServe(o);
    expect(ran).toBe(1); // 只跑了恢复后的那条
  });
});
