import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import {
  createManagedFrontResultRoute,
  ManagedWorkerUndispatchedError,
  migrateLegacyProfileFrontLane,
  parseManagedFrontAction,
  WakeBlockedError,
} from "../src/commands/serve";
import { loadCursor, loadCursorForConfig, saveCursor } from "../src/config";
import { msgFrame } from "./mock-server";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "ap-finding-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// serve.test.ts 的同名局部 helper：固定六字段信封，缺省字段填 null。
function managedAction(
  action: "channel_reply" | "worker_dispatch" | "worker_feedback" | "owner_decision" | "blocked",
  fields: Partial<Record<"body" | "instruction" | "prompt" | "options" | "reason", unknown>>,
): string {
  return JSON.stringify({ action, body: null, instruction: null, prompt: null, options: null, reason: null, ...fields });
}

function directedDelivery(messageSeq: number, cause: DirectedDelivery["cause"] = "mention"): DirectedDelivery {
  return {
    id: `delivery-${messageSeq}`,
    message_seq: messageSeq,
    target_name: "front",
    cause,
    state: "claimed",
    attempt: 1,
    lease_until: Date.now() + 60_000,
    work_id: "work-1",
    continuation_ref: "continuation-1",
    reply_seq: null,
    last_error: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

describe("finding fixes — owner_decision options:null coercion (#2)", () => {
  test("owner_decision with options:null parses as an approval, same as options:[]", () => {
    // managedAction 默认把未填字段置 null，因此这里的 options 就是 null。
    expect(parseManagedFrontAction(managedAction("owner_decision", { prompt: "允许发布？" }))).toEqual({
      action: "owner_decision",
      prompt: "允许发布？",
    });
    // 与 options:[] 完全同义：都归一成不带 options 的 approval。
    expect(parseManagedFrontAction(managedAction("owner_decision", { prompt: "允许发布？", options: [] }))).toEqual({
      action: "owner_decision",
      prompt: "允许发布？",
    });
  });

  test("owner_decision still carries an explicit two-option choice and rejects a single option", () => {
    expect(parseManagedFrontAction(managedAction("owner_decision", { prompt: "选方案", options: ["A", "B"] }))).toEqual({
      action: "owner_decision",
      prompt: "选方案",
      options: ["A", "B"],
    });
    expect(() => parseManagedFrontAction(managedAction("owner_decision", { prompt: "缺一个", options: ["only"] })))
      .toThrow(/at least 2 options/);
  });
});

describe("finding fixes — owner_decision responder binding gate (createManagedFrontResultRoute)", () => {
  const owner = "fan@example.com";
  const frame = msgFrame(10, "ship it", {
    sender: { name: "leo", kind: "human", owner },
    mentions: ["front"],
  }) as unknown as MsgFrame;

  function route(binding?: () => boolean) {
    return createManagedFrontResultRoute({
      server: "http://agentparty.test",
      token: "ap_front",
      channel: "dev",
      frontName: "front",
      workerName: "worker",
      ownerAccount: owner,
      ownerDecisionBindingEnforced: binding,
    });
  }

  test("throws when the server does not enforce responder binding (false)", async () => {
    await expect(route(() => false)(frame, managedAction("owner_decision", { prompt: "允许发布？" }), null, directedDelivery(10)))
      .rejects.toThrow(/owner_decision responder binding/);
  });

  test("throws when binding enforcement is unknown (undefined)", async () => {
    await expect(route(undefined)(frame, managedAction("owner_decision", { prompt: "允许发布？" }), null, directedDelivery(10)))
      .rejects.toThrow(/owner_decision responder binding/);
  });

  test("emits the owner-bound decision when the server enforces binding (true)", async () => {
    await expect(route(() => true)(frame, managedAction("owner_decision", { prompt: "允许发布？" }), null, directedDelivery(10)))
      .resolves.toMatchObject({
        replyTo: 10,
        decisionRequest: { kind: "approval", prompt: "允许发布？" },
        expectedDecisionResponderOwner: owner,
      });
  });
});

describe("finding fixes — managed worker non-dispatch wake error type (#3)", () => {
  test("ManagedWorkerUndispatchedError is an exported non-retriable WakeBlockedError subclass", () => {
    const err = new ManagedWorkerUndispatchedError("worker got a non-dispatch wake");
    expect(err).toBeInstanceOf(WakeBlockedError);
    expect(err).toBeInstanceOf(ManagedWorkerUndispatchedError);
    expect(err.name).toBe("ManagedWorkerUndispatchedError");
    expect(err.retriable).toBe(false);
  });
});

describe("finding fixes — migrateLegacyProfileFrontLane is idempotent (#7/#10)", () => {
  test("seeds the front namespace cursor from legacy global state once, then no-ops", () => {
    const oldHome = process.env.AGENTPARTY_HOME;
    const oldConfig = process.env.AGENTPARTY_CONFIG;
    const home = tempDir("ap-migrate-home-");
    const legacyConfig = join(tempDir("ap-migrate-legacy-"), "legacy.json");
    const frontStateKey = join(tempDir("ap-migrate-front-"), "front-config.json");
    const frontRunnerWorkdir = tempDir("ap-migrate-runner-");
    const channel = "dev";
    process.env.AGENTPARTY_HOME = home;
    process.env.AGENTPARTY_CONFIG = legacyConfig;
    try {
      // 旧全局游标（升级前的自由文本 front）。
      saveCursor(channel, 42);
      expect(loadCursor(channel)).toBe(42);
      // 待清理的旧会话痕迹。
      const sessionFile = join(frontRunnerWorkdir, "wake-session.json");
      const continuationsDir = join(frontRunnerWorkdir, "continuations");
      writeFileSync(sessionFile, "{\"session\":\"stale\"}");
      mkdirSync(continuationsDir, { recursive: true });
      writeFileSync(join(continuationsDir, "c.json"), "{}");

      migrateLegacyProfileFrontLane(channel, frontStateKey, frontRunnerWorkdir);

      // 迁移落地：front 命名空间继承旧游标，marker 落盘，旧会话痕迹清空。
      expect(loadCursorForConfig(channel, frontStateKey)).toBe(42);
      expect(existsSync(join(frontRunnerWorkdir, ".front-lane-init"))).toBe(true);
      expect(existsSync(sessionFile)).toBe(false);
      expect(existsSync(continuationsDir)).toBe(false);

      // 第二次是纯 no-op：marker 已在，不再清理新写入的会话文件。
      writeFileSync(sessionFile, "{\"session\":\"fresh\"}");
      migrateLegacyProfileFrontLane(channel, frontStateKey, frontRunnerWorkdir);
      expect(existsSync(sessionFile)).toBe(true);
      expect(loadCursorForConfig(channel, frontStateKey)).toBe(42);
    } finally {
      if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = oldHome;
      if (oldConfig === undefined) delete process.env.AGENTPARTY_CONFIG;
      else process.env.AGENTPARTY_CONFIG = oldConfig;
    }
  });
});
