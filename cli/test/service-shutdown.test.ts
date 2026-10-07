// 托管服务关停（410 agentparty_shut_down）是终局：常驻命令打印一次说明后以 EXIT_SERVICE_SHUT_DOWN 退出，
// 不进任何退避/重连循环；一次性命令照常报错并映射到同一个退出码。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_SERVICE_SHUT_DOWN } from "@agentparty/shared";
import { handleRestError, listChannels, RestError } from "../src/rest";
import {
  exitOnServiceShutdown,
  resetServiceShutdownForTest,
  SERVICE_SHUT_DOWN_CODE,
  serviceShutdownMessage,
} from "../src/service-shutdown";

const MESSAGE =
  "Agent Party shut down on 2026-10-31. Move to open-cross-session: https://github.com/leeguooooo/open-cross-session — remove the local install: https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md";
const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let server: ReturnType<typeof Bun.serve>;
let requests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return Response.json({ error: SERVICE_SHUT_DOWN_CODE, message: MESSAGE }, { status: 410 });
    },
  });
});
afterAll(() => server.stop(true));

let home: string;
beforeEach(() => {
  resetServiceShutdownForTest();
  requests = 0;
  home = mkdtempSync(join(tmpdir(), "ap-shutdown-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${server.port}`, token: "ap_tok" }));
});
afterEach(() => {
  resetServiceShutdownForTest();
  rmSync(home, { recursive: true, force: true });
});

describe("serviceShutdownMessage", () => {
  test("only a 410 carrying error=agentparty_shut_down counts; output is sanitized", () => {
    expect(serviceShutdownMessage(410, { error: SERVICE_SHUT_DOWN_CODE, message: MESSAGE })).toBe(MESSAGE);
    expect(serviceShutdownMessage(410, { error: SERVICE_SHUT_DOWN_CODE, message: "bye\u001b[2J" })).toBe("bye");
    expect(serviceShutdownMessage(410, { error: "gone" })).toBeNull();
    expect(serviceShutdownMessage(404, { error: SERVICE_SHUT_DOWN_CODE })).toBeNull();
    expect(serviceShutdownMessage(410, null)).toBeNull();
  });
});

describe("in-process", () => {
  test("one-shot (default): REST throws RestError(agentparty_shut_down) and handleRestError maps it to the shutdown exit code", async () => {
    const exits: number[] = [];
    resetServiceShutdownForTest({ exit: ((code: number) => { exits.push(code); throw new Error("exit"); }) as (c: number) => never });
    let caught: unknown;
    try {
      await listChannels(`http://127.0.0.1:${server.port}`, "ap_tok");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RestError);
    expect((caught as RestError).code).toBe(SERVICE_SHUT_DOWN_CODE);
    expect((caught as RestError).message).toBe(MESSAGE);
    expect(exits).toEqual([]);
    expect(handleRestError(caught)).toBe(EXIT_SERVICE_SHUT_DOWN);
  });

  test("resident mode: the first shutdown response prints once and exits with the shutdown code", async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    resetServiceShutdownForTest({
      exit: ((code: number) => { exits.push(code); throw new Error("exit"); }) as (c: number) => never,
      log: (line) => logs.push(line),
    });
    exitOnServiceShutdown();
    for (let i = 0; i < 2; i++) {
      await listChannels(`http://127.0.0.1:${server.port}`, "ap_tok").catch(() => {});
    }
    expect(exits).toEqual([EXIT_SERVICE_SHUT_DOWN, EXIT_SERVICE_SHUT_DOWN]);
    expect(logs).toEqual([`party: ${MESSAGE}`]);
  });
});

async function runCli(args: string[], timeoutMs = 30_000): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home, AGENTPARTY_NO_AUTO_UPGRADE: "1", AGENTPARTY_NO_DEPRECATION_NOTICE: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

const occurrences = (text: string) => text.split("Agent Party shut down on 2026-10-31").length - 1;

describe("subprocess: long-running commands stop instead of retrying", () => {
  test("party serve (with its restart supervisor) exits 20 after one attempt", async () => {
    const r = await runCli(["serve", "dev", "--on-mention", "true"]);
    expect(r.code).toBe(EXIT_SERVICE_SHUT_DOWN);
    expect(occurrences(r.stderr + r.stdout)).toBe(1);
    expect(r.stdout + r.stderr).not.toContain("event=restart");
  }, 40_000);

  test("party watch --follow exits 20 instead of reconnecting", async () => {
    const r = await runCli(["watch", "dev", "--follow"]);
    expect(r.code).toBe(EXIT_SERVICE_SHUT_DOWN);
    expect(occurrences(r.stderr)).toBe(1);
  }, 40_000);

  test("codex auto-wake supervisor exits 20", async () => {
    const r = await runCli(["hook", "codex-autowake", "--supervise", "--channel", "dev"]);
    // stderr 一起比：Linux CI 上曾以 1 退出，没有输出就无从查起。
    expect({ code: r.code, stderr: r.stderr }).toMatchObject({ code: EXIT_SERVICE_SHUT_DOWN });
    expect(occurrences(r.stderr)).toBe(1);
  }, 40_000);

  test("party mcp exits 20 on the first tool call that hits the shut-down service", async () => {
    const proc = Bun.spawn(["bun", "run", indexPath, "mcp", "--channel", "dev"], {
      env: { ...process.env, AGENTPARTY_HOME: home, AGENTPARTY_NO_AUTO_UPGRADE: "1", AGENTPARTY_NO_DEPRECATION_NOTICE: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "party_whoami", arguments: {} } });
    await proc.stdin.flush();
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30_000);
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    expect(code).toBe(EXIT_SERVICE_SHUT_DOWN);
    expect(occurrences(stderr)).toBe(1);
  }, 40_000);

  test("one-shot party send reports the message and exits 20", async () => {
    const r = await runCli(["send", "hi", "--channel", "dev"]);
    expect(r.code).toBe(EXIT_SERVICE_SHUT_DOWN);
    expect(r.stderr).toContain(`error: ${SERVICE_SHUT_DOWN_CODE} ${MESSAGE}`);
  }, 40_000);
});
