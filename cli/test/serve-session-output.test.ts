// #1103：serve 端到端（真 runServe + 真 builtin codex runner 的 runHarness，仅替换 runProcess 这个进程边界）
// 把 runner 的实时输出经 WS 以 session_output 帧上报。断言对象是 mock 服务端「收到的线上帧」，
// 不是 reporter 的内部状态——删掉 serve 里的 begin/end 或 runHarness 里的 onOutput 转发，这里都会红。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, type SessionOutputClientFrame } from "@agentparty/shared";
import { runServe, type RunnerProcess, type ServeOptions } from "../src/commands/serve";
import type { MessagePayload } from "../src/rest";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const dirs: string[] = [];
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

const SECRET = "ap_" + "LiveStreamSecret1234";

function start(): { frames: SessionOutputClientFrame[]; url: string } {
  const frames: SessionOutputClientFrame[] = [];
  server = startMockServer((frame, sock) => {
    if (frame.type === "session_output") {
      frames.push(frame as unknown as SessionOutputClientFrame);
      return;
    }
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send(msgFrame(1, "do the thing", { mentions: ["me"] })), 20);
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 400);
  });
  return { frames, url: server.url };
}

function options(url: string, runProcess: RunnerProcess): ServeOptions {
  const post = async (_s: string, _t: string, _c: string, _b: MessagePayload) => ({ seq: 50 });
  return {
    server: url,
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: () => undefined,
    lockDir: tmp("ap-lock-"),
    maxWakeAttempts: 1,
    wakeRetryDelayMs: 0,
    post,
    builtinRunner: { server: url, token: "ap_tok", channel: "dev", harness: "codex", workdir: tmp("ap-live-"), runProcess, post },
  };
}

describe("serve live session output（#1103）", () => {
  test("runner 输出实时上报：同一 session id、脱敏、最终正文、done 终态", async () => {
    const { frames, url } = start();
    const runProcess: RunnerProcess = async (args, o2) => {
      o2.onOutput?.("stderr", "exec: bun test\n");
      o2.onOutput?.("stdout", `token=${SECRET}\npartial`);
      await new Promise((r) => setTimeout(r, 30));
      o2.onOutput?.("stdout", " line\n");
      writeFileSync(args[args.indexOf("-o") + 1]!, "final answer\n");
      return { code: 0, stdout: "session id: 019f35d9-0000-7000-8000-000000000001\n", stderr: "" };
    };
    expect(await runServe(options(url, runProcess))).toBe(EXIT_ARCHIVED);

    expect(frames.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(frames.map((f) => f.session_id));
    expect(ids.size).toBe(1);
    expect(frames.every((f) => f.task_seq === 1)).toBe(true);
    expect(frames[0]!.state).toBe("running");
    expect(frames[0]!.lines[0]).toMatchObject({ kind: "system" });
    expect(frames.at(-1)!.state).toBe("done");

    const lines = frames.flatMap((f) => f.lines);
    const wire = JSON.stringify(frames);
    expect(wire).not.toContain(SECRET);
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(
      expect.arrayContaining(["stderr:exec: bun test", "stdout:partial line", "text:final answer"]),
    );
  });

  test("runner 失败：终态 blocked 且带原因，观看者不会看到空白", async () => {
    const { frames, url } = start();
    const runProcess: RunnerProcess = async (_args, o2) => {
      o2.onOutput?.("stderr", "fatal: something broke\n");
      return { code: 1, stdout: "", stderr: "fatal: something broke\n" };
    };
    expect(await runServe(options(url, runProcess))).toBe(EXIT_ARCHIVED);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const last = frames.at(-1)!;
    expect(last.state).toBe("blocked");
    expect(frames.flatMap((f) => f.lines).some((l) => l.text.includes("something broke"))).toBe(true);
  });
});
