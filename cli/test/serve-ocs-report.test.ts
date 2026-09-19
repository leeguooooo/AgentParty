// #1113：真 runServe 在 welcome 后经 WS 上报本机 ocs 会话（仅替换 `ocs who` 这个进程边界）。
// 断言 mock 服务端收到的线上帧——删掉 serve 里 welcome 分支的 reportNow，这里就红。
// 没开 ocsReport（测试/嵌入缺省）时绝不上报。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, type OcsRosterClientFrame } from "@agentparty/shared";
import { runServe, type ServeOptions } from "../src/commands/serve";
import { startMockServer, welcomeFrame, type MockServer } from "./mock-server";

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

function start(): { frames: OcsRosterClientFrame[]; url: string } {
  const frames: OcsRosterClientFrame[] = [];
  server = startMockServer((frame, sock) => {
    if (frame.type === "ocs_roster") {
      frames.push(frame as unknown as OcsRosterClientFrame);
      return;
    }
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 300);
  });
  return { frames, url: server.url };
}

function options(url: string, extra: Partial<ServeOptions>): ServeOptions {
  const cwd = tmp("ap-ocs-");
  return {
    server: url,
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: () => undefined,
    lockDir: tmp("ap-lock-"),
    runnerCwd: cwd,
    post: async () => ({ seq: 1 }),
    ...extra,
  };
}

describe("serve ocs roster report（#1113）", () => {
  test("reports local ocs sessions over the websocket after welcome", async () => {
    const { frames, url } = start();
    const exec = async () => ({
      ok: true,
      stdout: JSON.stringify({ entries: [{ kind: "codex-task", target: "codex-1a2b3c4d", threadId: "t1", cwd: "/elsewhere", livePid: 5, tty: "ttys001" }] }),
    });
    expect(await runServe(options(url, { ocsReport: exec }))).toBe(EXIT_ARCHIVED);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0]!.sessions).toEqual([
      { addr: "codex-1a2b3c4d", harness: "codex", cwd: "/elsewhere", same_project: false, host_kind: "terminal", session_key: "t1" },
    ]);
  });

  test("does not report unless enabled", async () => {
    const { frames, url } = start();
    expect(await runServe(options(url, {}))).toBe(EXIT_ARCHIVED);
    expect(frames).toEqual([]);
  });
});
