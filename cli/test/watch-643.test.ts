// #643：`watch --once` 的 pending-wake 重放（run() 内、runWatch 之前）过去绕过单实例锁——两个并发重挂
// 会各自重放同一条 @ → 重复唤醒。修复让重放路径也走同一把锁，并在每条返回路径（含 directed-未确认
// 落回正常路径）释放。这里断言的是**过程**：锁被别人占着时重放被拒、不产生重复唤醒；且成功重放后
// 锁被释放（同进程内连续两次重挂都能替补上）。
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../src/config";
import { workspaceId } from "../src/config";
import { EXIT_ALREADY_WATCHING, run } from "../src/commands/watch";
import { acquireInstanceLock, defaultInstanceLockDir, instanceLockTarget } from "../src/instance-lock";
import { msgFrame } from "./mock-server";

let home: string | null = null;
let apiServer: ReturnType<typeof Bun.serve> | null = null;
let previousHome: string | undefined;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];

function seedStuck(server: string): void {
  writeFileSync(join(home!, "config.json"), JSON.stringify({ server, token: "ap_tok" }));
  const dir = join(home!, "state", workspaceId(process.cwd()));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      channel: "dev",
      cursor: 10,
      cursors: {
        dev: {
          cursor: 10,
          stuck: { seq: 10, attempts: 0, last_error: "watch wake awaiting agent acknowledgement", source: "watch" },
        },
      },
    }),
  );
}

function stuckAttempts(): number {
  const dir = join(home!, "state", workspaceId(process.cwd()));
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).cursors.dev.stuck.attempts;
}

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  apiServer?.stop(true);
  apiServer = null;
  if (previousHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

function begin(): void {
  home = mkdtempSync(join(tmpdir(), "ap-watch-643-"));
  previousHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
  stdout = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = () => {};
}

describe("#643 watch --once pending-wake replay respects the instance lock", () => {
  test("锁被别人占着时重放被拒，不重放、不产生重复唤醒（欠账保留、attempts 不变）", async () => {
    begin();
    const server = "http://127.0.0.1:65500"; // 拒绝路径在任何 REST 调用之前返回，URL 无需可达
    seedStuck(server);
    // 模拟"已有一个 watcher 挂在这条频道上"：先在同一锁作用域抢下锁。
    const held = acquireInstanceLock("watch", instanceLockTarget(server, "ap_tok", "dev"), defaultInstanceLockDir());
    expect(held.ok).toBe(true);
    try {
      const code = await run(["dev", "--once", "--json"]);
      expect(code).toBe(EXIT_ALREADY_WATCHING);
      // 关键：没有把 pending wake 重放出去（否则就是重复唤醒）。
      expect(stdout.join("\n")).not.toContain("watch_replay");
      // 欠账未被消费：attempts 保持 0。
      expect(stuckAttempts()).toBe(0);
    } finally {
      held.release?.();
    }
  });

  test("#652 锁内权威重读发现 debt 已被另一进程清账 → 本次不重放、返回 0（TOCTOU）", async () => {
    begin();
    // 锁内重读为 null 时在任何 REST 调用之前 return 0，URL 无需可达。
    const server = "http://127.0.0.1:65500";
    seedStuck(server); // 写 config.json + on-disk stuck（attempts=0），下面用 spy 覆盖 loadStuck 的返回值
    // 复刻 TOCTOU 时序：两个并发 `watch --once` 都在锁前读到同一条 debt；先抢到锁的那个重放并清账后释放，
    // 本进程随后才拿到锁——锁前快照（第 1 次读）仍是非空，锁内权威重读（第 2 次读）已是 null。
    const debt = {
      seq: 10,
      attempts: 0,
      last_error: "watch wake awaiting agent acknowledgement",
      source: "watch" as const,
    };
    const spy = spyOn(config, "loadStuck");
    spy.mockReturnValueOnce(debt); // 锁前读：还看得到 debt，于是进入重放分支去抢锁
    spy.mockReturnValue(null); // 锁内权威重读：另一进程已清账
    try {
      const code = await run(["dev", "--once", "--json"]);
      // 锁内重读为 null → 不重放，正常退出。
      expect(code).toBe(0);
      // 关键回归：没有把已被处理的同一条 wake 再重放一遍（否则就是 TOCTOU 重复唤醒）。
      expect(stdout.join("\n")).not.toContain("watch_replay");
      expect(stdout.join("\n")).not.toContain("replay_attempt");
      // 证明确实发生了锁前 + 锁内两次读（锁内重读把决策基准换成了当前真值）。
      expect(spy).toHaveBeenCalledTimes(2);
      // 欠账未被本进程消费：on-disk attempts 未被 +1（saveWatchStuck 从未触发）。
      expect(stuckAttempts()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("成功重放后释放锁：同一进程内连续两次重挂都能替补（attempts 1 → 2）", async () => {
    begin();
    const pending = msgFrame(10, "@me pending wake", { mentions: ["me"] });
    apiServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages") return Response.json({ messages: [pending] });
        return new Response("not found", { status: 404 });
      },
    });
    const server = `http://127.0.0.1:${apiServer.port}`;
    seedStuck(server);

    const first = await run(["dev", "--once", "--json"]);
    expect(first).toBe(0);
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ seq: 10, watch_replay: true, replay_attempt: 1 });
    expect(stuckAttempts()).toBe(1);
    // 第一次重放必须已释放锁，否则第二次会把同 pid 的自己误判成"已有 watcher"。
    const lockFile = join(defaultInstanceLockDir(), `watch-${instanceLockTarget(server, "ap_tok", "dev")}.lock`);
    expect(existsSync(lockFile)).toBe(false);

    stdout = [];
    const second = await run(["dev", "--once", "--json"]);
    expect(second).toBe(0);
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ seq: 10, watch_replay: true, replay_attempt: 2 });
    expect(stuckAttempts()).toBe(2);
  });
});
