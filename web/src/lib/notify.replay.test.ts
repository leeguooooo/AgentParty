// #861 回归：8 月 6 日弹出 7 月 27 日的老 @。socket 重建时游标被重新播种成 0，
// 服务端把整段历史当 live 帧重放，客户端弹窗判据又不做任何新鲜度检查。
//
// 这个文件把 issue 里那条「可直接写成断言」的失败场景逐字复刻：真的 ChannelSocket
// （initialCursor: 0）+ 真的服务端补拉帧 + 真的 shouldNotify/shouldToast/nextMentionBadgeCount，
// 断言 seq 143 一次通知都不产生，而真正的 live 新帧照弹。
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { MsgFrame, ServerFrame } from "@agentparty/shared";
import { ChannelSocket } from "./ws";
import {
  MENTION_ALERT_MAX_AGE_MS,
  isFreshDelivery,
  nextMentionBadgeCount,
  shouldNotify,
  shouldToast,
} from "./notify";

// ── issue 里的真实数据 ───────────────────────────────────────────────
const SEQ_143_TS = 1785134587385; // 2026-07-27 15:43:07
const NOW = 1785999999999; // 2026-08-06，比 seq 143 晚 10 天
const SELF_HANDLE = "Evan";

function historyFrame(seq: number, over: Partial<MsgFrame> = {}): MsgFrame {
  return {
    type: "msg",
    seq,
    sender: { name: "lark-b8d1411d3513", kind: "human" },
    kind: "message",
    body: `m${seq}`,
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: SEQ_143_TS,
    ...over,
  } as MsgFrame;
}

const seq143 = (over: Partial<MsgFrame> = {}): MsgFrame =>
  historyFrame(143, { mentions: [SELF_HANDLE], body: "@Evan 接口报错验证失败…", ...over });

// ── 最小 WebSocket 桩 ────────────────────────────────────────────────
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string, public protocols?: string[]) {
    FakeSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  deliver(frame: ServerFrame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  hello(): { type: string; since: number; since_rev?: number } {
    const raw = this.sent.map((s) => JSON.parse(s) as { type: string });
    const h = raw.find((f) => f.type === "hello");
    if (h === undefined) throw new Error("no hello sent");
    return h as { type: string; since: number };
  }
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");

beforeEach(() => {
  FakeSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeSocket });
  Object.defineProperty(globalThis, "location", {
    configurable: true, writable: true,
    value: { protocol: "https:", host: "party.example", origin: "https://party.example" },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true, writable: true,
    value: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, location: globalThis.location },
  });
});
afterEach(() => {
  for (const [key, desc] of [["WebSocket", originalWebSocket], ["window", originalWindow], ["location", originalLocation]] as const) {
    if (desc === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, desc);
  }
});

/**
 * 驱动一条真实 ChannelSocket，把服务端投来的每一帧过一遍真实的三个提醒判据。
 * 返回 issue 场景下的通知/toast/角标计数。
 */
function driveSocket(opts: {
  initialCursor: number;
  frames: ServerFrame[];
  documentHidden: boolean;
  now: number;
}): { notified: number[]; toasted: number[]; badge: number; helloSince: number } {
  const notified: number[] = [];
  const toasted: number[] = [];
  let badge = 0;
  const sock = new ChannelSocket("seamail", "tok", {
    onFrame: (frame) => {
      if (frame.type !== "msg") return;
      if (shouldNotify(frame, SELF_HANDLE, opts.documentHidden, true, null, opts.now)) notified.push(frame.seq);
      if (shouldToast(frame, SELF_HANDLE, opts.documentHidden, true, null, opts.now)) toasted.push(frame.seq);
      badge = nextMentionBadgeCount(badge, frame, SELF_HANDLE, opts.documentHidden, null, opts.now);
    },
    onStatus: () => {},
    onFatal: () => {},
  }, { initialCursor: opts.initialCursor });
  sock.connect();
  const ws = FakeSocket.instances[FakeSocket.instances.length - 1]!;
  ws.open();
  ws.deliver({ type: "welcome", participants: [], last_rev_seq: 0 } as unknown as ServerFrame);
  const helloSince = ws.hello().since;
  for (const frame of opts.frames) ws.deliver(frame);
  sock.dispose();
  return { notified, toasted, badge, helloSince };
}

// ── issue 的核心失败场景 ────────────────────────────────────────────
test("#861: socket 以 initialCursor 0 重建、服务端回放含 seq 143 的历史 → 不弹通知/toast/角标", () => {
  // 已加载窗口 seq 141..190；服务端对 hello{since:0} 回放全量历史（带 replay 标记）
  const replayed: ServerFrame[] = [];
  for (let seq = 100; seq <= 190; seq++) {
    replayed.push(seq === 143 ? seq143({ replay: true }) : historyFrame(seq, { replay: true }));
  }
  const hidden = driveSocket({ initialCursor: 0, frames: replayed, documentHidden: true, now: NOW });
  expect(hidden.notified).toEqual([]);
  expect(hidden.badge).toBe(0);

  // 标签页聚焦时的页内 toast 走同一判据，同样不该弹
  const focused = driveSocket({ initialCursor: 0, frames: replayed, documentHidden: false, now: NOW });
  expect(focused.toasted).toEqual([]);
});

test("#861 兜底：服务端还没上线 replay 标记时，光凭帧自身 ts 也不弹 10 天前的老 @", () => {
  const legacyReplay = [seq143()]; // 没有 replay 字段，逐字节等同 live 帧
  const out = driveSocket({ initialCursor: 0, frames: legacyReplay, documentHidden: true, now: NOW });
  expect(out.notified).toEqual([]);
  expect(out.badge).toBe(0);
});

// ── 对照：真的新消息必须照常弹 ──────────────────────────────────────
test("对照：真正的 live 新帧仍然正常弹通知 / toast / 角标", () => {
  const liveMention = seq143({ seq: 241, ts: NOW - 1_000 }); // 无 replay、刚发出
  const hidden = driveSocket({ initialCursor: 190, frames: [liveMention], documentHidden: true, now: NOW });
  expect(hidden.notified).toEqual([241]);
  expect(hidden.badge).toBe(1);

  const focused = driveSocket({ initialCursor: 190, frames: [liveMention], documentHidden: false, now: NOW });
  expect(focused.toasted).toEqual([241]);
});

test("对照：短暂掉线后补投的 live 帧（阈值内）照弹——重连退避上限只有 30s，5 分钟窗口留足余量", () => {
  const nearlyFresh = seq143({ seq: 242, ts: NOW - (MENTION_ALERT_MAX_AGE_MS - 1_000) });
  const out = driveSocket({ initialCursor: 190, frames: [nearlyFresh], documentHidden: true, now: NOW });
  expect(out.notified).toEqual([242]);
});

// ── 游标不回退 ──────────────────────────────────────────────────────
test("#861: 重建 socket 时带着已见水位重连，hello.since 不是 0", () => {
  // 初始页停在 190、live 推进到 220 后重建 → hello.since 必须是 220
  const out = driveSocket({ initialCursor: 220, frames: [], documentHidden: true, now: NOW });
  expect(out.helloSince).toBe(220);
});

// 隔离第 A 层（服务端 replay 标记）：帧本身很新，只有 replay 标记能挡住它。
// 场景：断线 1 分钟后重连，服务端把断线窗口里那条 @ 补拉回来——它已经在 live 广播时被
// 处理过，补拉不该再打扰一次。
test("#861: 补拉帧即使 ts 很新也不弹——只靠新鲜度兜底是不够的", () => {
  const freshReplay = seq143({ seq: 191, ts: NOW - 60_000, replay: true });
  const hidden = driveSocket({ initialCursor: 0, frames: [freshReplay], documentHidden: true, now: NOW });
  expect(hidden.notified).toEqual([]);
  expect(hidden.badge).toBe(0);

  const focused = driveSocket({ initialCursor: 0, frames: [freshReplay], documentHidden: false, now: NOW });
  expect(focused.toasted).toEqual([]);

  // 同一条帧去掉 replay 标记就是 live 新消息，必须弹——证明上面的 false 来自标记本身，
  // 而不是判据被整体劣化。
  const asLive = seq143({ seq: 191, ts: NOW - 60_000 });
  expect(driveSocket({ initialCursor: 0, frames: [asLive], documentHidden: true, now: NOW }).notified).toEqual([191]);
});

// ── 新鲜度判据本身 ─────────────────────────────────────────────────
test("isFreshDelivery: replay 帧永不新鲜；ts 超阈值不新鲜；边界含等号；ts 缺失按新鲜（旧服务端）", () => {
  expect(isFreshDelivery(seq143({ replay: true, ts: NOW }), NOW)).toBe(false);
  expect(isFreshDelivery(seq143({ ts: NOW - MENTION_ALERT_MAX_AGE_MS }), NOW)).toBe(true);
  expect(isFreshDelivery(seq143({ ts: NOW - MENTION_ALERT_MAX_AGE_MS - 1 }), NOW)).toBe(false);
  expect(isFreshDelivery(seq143({ ts: SEQ_143_TS }), NOW)).toBe(false);
  expect(isFreshDelivery(seq143({ ts: undefined as unknown as number }), NOW)).toBe(true);
  // 服务端时钟略快于客户端（ts 在未来）不该被判旧
  expect(isFreshDelivery(seq143({ ts: NOW + 30_000 }), NOW)).toBe(true);
});
