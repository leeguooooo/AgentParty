// #594：party ack——纯读场景的显式清账。只清 watch 源债；serve 债误清=静默丢 @（#198 红线）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runAck } from "../src/commands/ack";
import { loadCursor, loadStuck, saveCursor, saveStuck, saveWatchStuck } from "../src/config";

let home: string;
let cwd: string;
let originalCwd: string;
const oldEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-ack-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-ack-cwd-"));
  for (const key of ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_CHANNEL"]) {
    oldEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTPARTY_HOME = home;
  originalCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  // check:cli 不带 --isolate：cwd 是进程级状态，不还原会污染后续测试文件的游标路径解析。
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const watchDebt = (seq: number) => ({
  seq,
  wake_ts: 1,
  attempts: 1,
  source: "watch" as const,
});

describe("party ack（#594）", () => {
  test("watch 债被清账；再跑一次报无债", async () => {
    expect(saveWatchStuck("dev", watchDebt(19))).toBe(true);
    expect(await runAck(["--channel", "dev"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
    expect(await runAck(["--channel", "dev"])).toBe(0);
  });

  test("--seq 高于当前 debt 时拒绝清账", async () => {
    expect(saveWatchStuck("dev", watchDebt(19))).toBe(true);
    expect(await runAck(["--channel", "dev", "--seq", "20"])).toBe(1);
    expect(loadStuck("dev")).not.toBeNull();
    expect(await runAck(["--channel", "dev", "--seq", "19"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
  });

  test("--seq 可确认较早 wake，同时保留处理期间到达的较新 debt (#755)", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(20))).toBe(true);

    expect(await runAck(["--channel", "dev", "--seq", "19"])).toBe(0);
    expect(loadCursor("dev")).toBe(19);
    expect(loadStuck("dev")?.seq).toBe(20);

    expect(await runAck(["--channel", "dev", "--seq", "20"])).toBe(0);
    expect(loadCursor("dev")).toBe(20);
    expect(loadStuck("dev")).toBeNull();
  });

  test("精确 ack 会原子推进落后游标，避免清 debt 后再次作为普通新消息重放", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(19))).toBe(true);
    expect(await runAck(["--channel", "dev", "--seq", "19"])).toBe(0);
    expect(loadCursor("dev")).toBe(19);
    expect(loadStuck("dev")).toBeNull();
  });

  test("serve 源债绝不触碰", async () => {
    saveStuck("dev", { seq: 7, wake_ts: 1, attempts: 1, source: "serve" } as never);
    expect(await runAck(["--channel", "dev"])).toBe(1);
    expect(loadStuck("dev")).not.toBeNull();
  });
});

describe("party ack 批量排空（#668/#674）", () => {
  test("--through N：清 <=N 的 watch 债并把游标推进到 N", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(10))).toBe(true);
    expect(await runAck(["--channel", "dev", "--through", "10"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
    expect(loadCursor("dev")).toBe(10);
  });

  test("--before N：游标推进到 N-1，清严格早于 N 的债", async () => {
    saveCursor("dev", 3);
    expect(saveWatchStuck("dev", watchDebt(8))).toBe(true);
    expect(await runAck(["--channel", "dev", "--before", "20"])).toBe(0);
    expect(loadStuck("dev")).toBeNull();
    expect(loadCursor("dev")).toBe(19);
  });

  test("--through 低于债 seq 时保留债、只推游标", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(30))).toBe(true);
    expect(await runAck(["--channel", "dev", "--through", "20"])).toBe(0);
    // 债 seq=30 高于排空点 20，保留；游标推进到 20。
    expect(loadStuck("dev")).not.toBeNull();
    expect(loadCursor("dev")).toBe(20);
  });

  test("--all 拉频道 head 排空多条积压债（一条命令清完，不逐条 ack）", async () => {
    saveCursor("dev", 5);
    expect(saveWatchStuck("dev", watchDebt(12))).toBe(true);
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages") {
          return Response.json({ messages: [{ seq: 182, type: "msg", sender: { name: "x" }, mentions: [], body: "head" }] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const configDir = join(home, "state");
      // ack --all 走 resolveAuthDetailed → 读 AGENTPARTY_HOME/config.json
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${api.port}`, token: "ap_tok" }));
      expect(await runAck(["--channel", "dev", "--all"])).toBe(0);
      expect(loadStuck("dev")).toBeNull();
      expect(loadCursor("dev")).toBe(182);
    } finally {
      api.stop(true);
    }
  });

  test("--all / --seq 互斥", async () => {
    expect(await runAck(["--channel", "dev", "--all", "--seq", "5"])).toBe(1);
  });

  test("--through 遇 serve 源债：保留债、推游标、退出 0 并提示", async () => {
    saveCursor("dev", 2);
    saveStuck("dev", { seq: 9, wake_ts: 1, attempts: 1, source: "serve" } as never);
    expect(await runAck(["--channel", "dev", "--through", "50"])).toBe(0);
    expect(loadStuck("dev")).not.toBeNull();
    expect(loadCursor("dev")).toBe(50);
  });
});


// ── #958：`party ack --drain` ─────────────────────────────────────────────────
// 事故现场：游标 1910，1923…1935 共 9 条 @ 我；codex Stop hook 每轮只推进一条，第 9 条要等 8 轮。
// --drain 必须一次把 9 条正文全部打出来（最老在前、一条不漏），再把游标推到 1935。
describe("party ack --drain（#958）", () => {
  const MENTIONS = [1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930, 1935];
  const frame = (seq: number) => ({
    seq,
    type: "msg",
    sender: { name: "leo", kind: "human" },
    kind: "message",
    body: `BODY-${seq}`,
    mentions: ["codex1"],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1,
  });

  /** modern=true 时 next-mention 回整张表（新服务端），否则只回队首（老服务端）。 */
  function startApi(modern: boolean) {
    const requests: string[] = [];
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        requests.push(`${url.pathname}?${url.searchParams.toString()}`);
        if (url.pathname === "/api/channels/dev/next-mention") {
          const since = Number(url.searchParams.get("since"));
          const seqs = MENTIONS.filter((seq) => seq > since);
          if (seqs.length === 0) return Response.json({ seq: null, seqs: [], truncated: false });
          return Response.json(modern ? { seq: seqs[0], seqs, truncated: false } : { seq: seqs[0] });
        }
        if (url.pathname === "/api/channels/dev/messages") {
          const since = Number(url.searchParams.get("since"));
          const limit = Number(url.searchParams.get("limit"));
          // 与真实 /messages 同语义：> since，取 limit 条；夹在 @ 之间的无关消息也在频道里。
          const all = [...MENTIONS, 1931, 1932].sort((a, b) => a - b);
          return Response.json({ messages: all.filter((seq) => seq > since).slice(0, limit).map(frame) });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: `http://127.0.0.1:${api.port}`, token: "ap_tok" }));
    return { api, requests };
  }

  function captureStdout(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    return { lines, restore: () => (console.log = original) };
  }

  for (const modern of [true, false]) {
    test(`积压 9 条一次全部列出（最老在前、一条不漏）并把游标推到最后一条——${modern ? "新" : "老"}服务端`, async () => {
      saveCursor("dev", 1910);
      const { api, requests } = startApi(modern);
      const out = captureStdout();
      try {
        expect(await runAck(["--channel", "dev", "--drain"])).toBe(0);
      } finally {
        out.restore();
        api.stop(true);
      }
      const text = out.lines.join("\n");
      expect(text).toContain("#dev: 9 pending @ for you after seq=1910");
      // 9 条正文全在，且按 seq 升序出现。
      let last = -1;
      for (const seq of MENTIONS) {
        const at = text.indexOf(`BODY-${seq}`);
        expect(at).toBeGreaterThan(last);
        last = at;
      }
      // 夹在中间、没 @ 我的消息不混进来。
      expect(text).not.toContain("BODY-1931");
      expect(text).not.toContain("BODY-1932");
      expect(text).toContain("drained #dev: listed 9 @ (seq 1923…1935), cursor advanced to seq=1935");
      expect(loadCursor("dev")).toBe(1935);
      // 列表问的是「> 游标」，不是从 0 开始翻整个频道。
      expect(requests[0]).toBe("/api/channels/dev/next-mention?since=1910");
    });
  }

  test("排空之后再跑：没有待处理的 @，游标不动", async () => {
    saveCursor("dev", 1935);
    const { api } = startApi(true);
    const out = captureStdout();
    try {
      expect(await runAck(["--channel", "dev", "--drain"])).toBe(0);
    } finally {
      out.restore();
      api.stop(true);
    }
    expect(out.lines.join("\n")).toContain("no pending @ for you in #dev after seq=1935");
    expect(loadCursor("dev")).toBe(1935);
  });

  test("--drain 顺带清掉 ≤ 最后一条的 watch 债；serve 债只推游标不清", async () => {
    saveCursor("dev", 1910);
    expect(saveWatchStuck("dev", watchDebt(1924))).toBe(true);
    const { api } = startApi(true);
    const out = captureStdout();
    try {
      expect(await runAck(["--channel", "dev", "--drain"])).toBe(0);
    } finally {
      out.restore();
      api.stop(true);
    }
    expect(loadStuck("dev")).toBeNull();
    expect(loadCursor("dev")).toBe(1935);
  });

  test("--drain 与其它选择器互斥；--no-reply 不能配 --drain", async () => {
    expect(await runAck(["--channel", "dev", "--drain", "--all"])).toBe(1);
    expect(await runAck(["--channel", "dev", "--drain", "--seq", "5"])).toBe(1);
    expect(await runAck(["--channel", "dev", "--drain", "--no-reply"])).toBe(1);
  });
});
