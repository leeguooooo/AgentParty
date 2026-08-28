// #962：party history 纯文本没有时间戳，排「这 13 条状态帧隔多久来一条」只能 --json 再手工换算 ts。
// 修法：每行带本地时区 HH:MM:SS（跨天补日期），连续「同 sender、内容完全相同」的帧折叠成
// `[3–15] ×13 sender: …`。--json 是给工具消费的：不折叠、不加前缀。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/commands/history";
import { collapseRuns, formatHistoryTs } from "../src/format";
import type { MsgFrame } from "@agentparty/shared";

let home: string;
let oldHome: string | undefined;
let oldTz: string | undefined;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];
let stderr: string[] = [];

// 时间戳按本地时区渲染，测试固定成上海（无夏令时），期望值才能写死。
const TZ = "Asia/Shanghai";

function localTs(year: number, month1: number, day: number, h: number, m: number, s: number): number {
  return new Date(year, month1 - 1, day, h, m, s, 0).getTime();
}

// 取「今天」当天的某个时刻（本地时区）。run() 里的「今天」取自 Date.now()，两边口径一致。
function todayAt(h: number, m: number, s: number): number {
  const d = new Date();
  return localTs(d.getFullYear(), d.getMonth() + 1, d.getDate(), h, m, s);
}

function ymd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SERVER = { name: "leo-server", kind: "agent", owner: "leo" } as const;
const NOTE = "serve supervisor 已挂上——等 @ 才唤醒";

function status(seq: number, ts: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    channel: "ludo",
    seq,
    ts,
    kind: "status",
    state: "waiting",
    note: NOTE,
    sender: SERVER,
    body: "",
    mentions: [],
    reply_to: null,
    status: { scope: [] },
    ...over,
  } as unknown as MsgFrame;
}

function message(
  seq: number,
  ts: number,
  body: string,
  sender: { name: string; kind: string } = { name: "alice", kind: "human" },
  over: Partial<MsgFrame> = {},
): MsgFrame {
  return {
    type: "msg",
    channel: "ludo",
    seq,
    ts,
    kind: "message",
    sender,
    body,
    mentions: [],
    reply_to: null,
    ...over,
  } as unknown as MsgFrame;
}

// issue 里的现场：seq 3..15 共 13 条同一 note 的 waiting 帧，2–12 分钟一条。
function flood(): MsgFrame[] {
  const frames: MsgFrame[] = [];
  let ts = todayAt(9, 0, 0);
  for (let seq = 3; seq <= 15; seq++) {
    frames.push(status(seq, ts));
    ts += (2 + (seq % 5) * 2) * 60_000;
  }
  return frames;
}

function serve(messages: MsgFrame[]): void {
  globalThis.fetch = (async () => Response.json({ messages })) as unknown as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-history-ts-"));
  oldHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
  oldTz = process.env.TZ;
  process.env.TZ = TZ;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: "https://ap.test", token: "ap_tok" }));
  stdout = [];
  stderr = [];
  console.log = (...args: unknown[]) => stdout.push(args.join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.join(" "));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = oldHome;
  if (oldTz === undefined) delete process.env.TZ;
  else process.env.TZ = oldTz;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
});

describe("formatHistoryTs 纯函数（#962）", () => {
  const now = localTs(2026, 8, 28, 15, 0, 0);

  test("与上一条同日、与今天同日 → 只有 HH:MM:SS，本地时区", () => {
    const ts = localTs(2026, 8, 28, 9, 5, 7);
    expect(formatHistoryTs(ts, ts - 60_000, now)).toBe("09:05:07");
    // 同一瞬间换个时区，小时数必须跟着变——证明用的是本地时区，不是 UTC。
    process.env.TZ = "UTC";
    expect(formatHistoryTs(ts, ts - 60_000, now)).toBe("01:05:07");
  });

  test("没有上一条（页首）→ 带日期，读者知道从哪天开始", () => {
    expect(formatHistoryTs(localTs(2026, 8, 28, 9, 5, 7), undefined, now)).toBe("2026-08-28 09:05:07");
  });

  test("与上一条不同日 → 带日期", () => {
    const prev = localTs(2026, 8, 27, 23, 59, 59);
    expect(formatHistoryTs(localTs(2026, 8, 28, 0, 0, 1), prev, now)).toBe("2026-08-28 00:00:01");
  });

  test("与上一条同日但不是今天 → 带日期（翻旧账时每行都得能定位到哪天）", () => {
    const prev = localTs(2026, 8, 20, 10, 0, 0);
    expect(formatHistoryTs(localTs(2026, 8, 20, 10, 3, 0), prev, now)).toBe("2026-08-20 10:03:00");
  });

  test("小时/分/秒补零到两位", () => {
    const ts = localTs(2026, 8, 28, 1, 2, 3);
    expect(formatHistoryTs(ts, ts, now)).toBe("01:02:03");
  });
});

describe("collapseRuns 纯函数（#962）", () => {
  test("连续同 key 归一组，key 变了就断开，回到旧 key 也不合并回去", () => {
    const runs = collapseRuns(["a", "a", "b", "a", "a", "a"], (s) => s);
    expect(runs.map((r) => r.items.join(""))).toEqual(["aa", "b", "aaa"]);
  });

  test("空输入 → 空", () => {
    expect(collapseRuns([], (s: string) => s)).toEqual([]);
  });
});

describe("party history 纯文本时间戳（#962）", () => {
  test("每行以本地 HH:MM:SS 开头；页首那条带日期", async () => {
    serve([
      message(1, todayAt(9, 0, 0), "one"),
      message(2, todayAt(9, 0, 5), "two"),
      message(3, todayAt(9, 1, 0), "three"),
    ]);
    expect(await run(["ludo"])).toBe(0);
    expect(stdout).toEqual([
      `${ymd(todayAt(9, 0, 0))} 09:00:00 [1] alice(human): one`,
      "09:00:05 [2] alice(human): two",
      "09:01:00 [3] alice(human): three",
    ]);
  });

  test("跨天：与上一条不同日、或不是今天的行带日期", async () => {
    const yesterday = todayAt(23, 59, 0) - 86_400_000;
    serve([
      message(1, yesterday, "late"),
      message(2, todayAt(10, 0, 0), "morning"),
      message(3, todayAt(10, 0, 5), "still morning"),
    ]);
    expect(await run(["ludo"])).toBe(0);
    expect(stdout).toEqual([
      `${ymd(yesterday)} 23:59:00 [1] alice(human): late`,
      `${ymd(todayAt(10, 0, 0))} 10:00:00 [2] alice(human): morning`,
      "10:00:05 [3] alice(human): still morning",
    ]);
  });

  test("--no-ts 关掉前缀，行首回到 [seq]", async () => {
    serve([message(1, todayAt(9, 0, 0), "one"), message(2, todayAt(9, 0, 5), "two")]);
    expect(await run(["ludo", "--no-ts"])).toBe(0);
    expect(stdout).toEqual(["[1] alice(human): one", "[2] alice(human): two"]);
  });

  test("--headers 模式同样带时间戳", async () => {
    serve([message(1, todayAt(9, 0, 0), "one"), message(2, todayAt(9, 0, 5), "two")]);
    expect(await run(["ludo", "--headers"])).toBe(0);
    expect(stdout[0]).toMatch(/^\d{4}-\d{2}-\d{2} 09:00:00 \[1\] alice\(human\) 3ch: one$/);
    expect(stdout[1]).toBe("09:00:05 [2] alice(human) 3ch: two");
  });

  test("--seq N 单条展开也带时间戳", async () => {
    serve([message(7, todayAt(9, 0, 0), "one")]);
    expect(await run(["ludo", "--seq", "7"])).toBe(0);
    expect(stdout).toEqual([`${ymd(todayAt(9, 0, 0))} 09:00:00 [7] alice(human): one`]);
  });

  test("多行正文只在首行加时间戳，续行缩进不变", async () => {
    serve([message(1, todayAt(9, 0, 0), "line one\nline two")]);
    expect(await run(["ludo"])).toBe(0);
    expect(stdout).toEqual([`${ymd(todayAt(9, 0, 0))} 09:00:00 [1] alice(human): line one\n    line two`]);
  });

  test("--json 不加前缀：每行仍是一个可解析的帧，ts 原样", async () => {
    serve([message(1, todayAt(9, 0, 0), "one")]);
    expect(await run(["ludo", "--json"])).toBe(0);
    expect(stdout.length).toBe(1);
    const frame = JSON.parse(stdout[0]!) as { seq: number; ts: number };
    expect(frame.seq).toBe(1);
    expect(frame.ts).toBe(todayAt(9, 0, 0));
  });
});

describe("party history 连续相同帧折叠（#962）", () => {
  test("13 条同 sender 同内容的状态帧折成一行：[3–15] ×13，首尾时间戳", async () => {
    const frames = flood();
    serve(frames);
    expect(await run(["ludo"])).toBe(0);
    expect(stdout.length).toBe(1);
    const line = stdout[0]!;
    const first = formatHistoryTs(frames[0]!.ts, undefined, Date.now());
    const last = formatHistoryTs(frames[12]!.ts, frames[0]!.ts, Date.now());
    expect(line).toBe(`${first}–${last} [3–15] ×13 leo-server(agent owner=leo): [waiting] ${NOTE}`);
  });

  test("中间夹一条不同的帧 → 断开成三段，seq 范围各自正确", async () => {
    const frames = flood();
    // seq 8 换一句 note：同 sender、同 kind，只有正文不同，也必须断开。
    frames[5] = status(8, frames[5]!.ts, { note: "换了一句话" } as never);
    serve(frames);
    expect(await run(["ludo", "--no-ts"])).toBe(0);
    expect(stdout).toEqual([
      `[3–7] ×5 leo-server(agent owner=leo): [waiting] ${NOTE}`,
      "[8] leo-server(agent owner=leo): [waiting] 换了一句话",
      `[9–15] ×7 leo-server(agent owner=leo): [waiting] ${NOTE}`,
    ]);
  });

  test("正文相同但 sender 不同 → 不折叠", async () => {
    serve([
      message(1, todayAt(9, 0, 0), "ok"),
      message(2, todayAt(9, 0, 1), "ok", { name: "bob", kind: "agent" }),
      message(3, todayAt(9, 0, 2), "ok"),
    ]);
    expect(await run(["ludo", "--no-ts"])).toBe(0);
    expect(stdout).toEqual(["[1] alice(human): ok", "[2] bob(agent): ok", "[3] alice(human): ok"]);
  });

  test("正文相同但 reply_to / mentions 不同 → 不折叠（--headers 会显示它们，折了就冒充）", async () => {
    serve([
      message(1, todayAt(9, 0, 0), "收到"),
      message(2, todayAt(9, 0, 1), "收到", undefined, { reply_to: 1 }),
      message(3, todayAt(9, 0, 2), "收到", undefined, { reply_to: 1 }),
      message(4, todayAt(9, 0, 3), "收到", undefined, { reply_to: 1, mentions: ["bob"] }),
    ]);
    expect(await run(["ludo", "--no-ts", "--headers"])).toBe(0);
    expect(stdout).toEqual([
      "[1] alice(human) 2ch: 收到",
      "[2–3] ×2 alice(human) ↩#1 2ch: 收到",
      "[4] alice(human) @bob ↩#1 2ch: 收到",
    ]);
  });

  test("只有两条也折叠（×2），单条不加 ×1", async () => {
    serve([message(1, todayAt(9, 0, 0), "ok"), message(2, todayAt(9, 0, 1), "ok"), message(3, todayAt(9, 0, 2), "other")]);
    expect(await run(["ludo", "--no-ts"])).toBe(0);
    expect(stdout).toEqual(["[1–2] ×2 alice(human): ok", "[3] alice(human): other"]);
  });

  test("折叠后下一行的时间戳以折叠段最后一条为「上一条」", async () => {
    const yesterday = todayAt(23, 0, 0) - 86_400_000;
    serve([
      message(1, yesterday, "ok"),
      message(2, yesterday + 60_000, "ok"),
      message(3, todayAt(0, 30, 0), "other"),
      message(4, todayAt(0, 31, 0), "more"),
    ]);
    expect(await run(["ludo"])).toBe(0);
    expect(stdout).toEqual([
      `${ymd(yesterday)} 23:00:00–${ymd(yesterday)} 23:01:00 [1–2] ×2 alice(human): ok`,
      `${ymd(todayAt(0, 30, 0))} 00:30:00 [3] alice(human): other`,
      "00:31:00 [4] alice(human): more",
    ]);
  });

  test("--no-collapse 展开：13 行，每行带自己的时间戳和 seq", async () => {
    const frames = flood();
    serve(frames);
    expect(await run(["ludo", "--no-collapse"])).toBe(0);
    expect(stdout.length).toBe(13);
    for (let i = 0; i < 13; i++) {
      const prev = i === 0 ? undefined : frames[i - 1]!.ts;
      expect(stdout[i]).toBe(
        `${formatHistoryTs(frames[i]!.ts, prev, Date.now())} [${i + 3}] leo-server(agent owner=leo): [waiting] ${NOTE}`,
      );
    }
    expect(stdout.join("\n")).not.toContain("×");
  });

  test("--headers 模式也折叠，行形如 [3–15] ×13 + header 摘要", async () => {
    serve(flood());
    expect(await run(["ludo", "--headers", "--no-ts"])).toBe(0);
    expect(stdout).toEqual([`[3–15] ×13 leo-server(agent) [waiting] ${NOTE.length}ch: ${NOTE}`]);
  });

  test("--json 不折叠：13 条原样 13 行，seq 逐一对应", async () => {
    serve(flood());
    expect(await run(["ludo", "--json"])).toBe(0);
    expect(stdout.length).toBe(13);
    const seqs = stdout.map((line) => (JSON.parse(line) as { seq: number }).seq);
    expect(seqs).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(stdout.join("\n")).not.toContain("×");
  });

  test("--headers --json 同样不折叠", async () => {
    serve(flood());
    expect(await run(["ludo", "--headers", "--json"])).toBe(0);
    expect(stdout.length).toBe(13);
    expect((JSON.parse(stdout[12]!) as { seq: number }).seq).toBe(15);
  });
});
