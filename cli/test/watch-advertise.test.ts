// #440：watch（尤其 --once）attach 时必须向服务端上报「有 watch 唤醒层」（wake_kind=watch），
// 否则服务端 / `party wake test` 对它恒判 'no wake adapter'、presence 把挂着 watch 的 agent 判成
// 假在线 / not listening。对照 serve 的 advertiseServeWake（residency=supervised + wake.kind=serve）。
import { afterEach, describe, expect, test } from "bun:test";
import { advertiseWatchWake, runWatch, type WatchOptions } from "../src/commands/watch";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";
import type { ResolvedAuthDetailed } from "../src/oidc-cli";

let server: MockServer | null = null;
let api: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop();
  server = null;
  api?.stop(true);
  api = null;
});

function opts(over: Partial<WatchOptions> & { server: string }): WatchOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    timeoutSec: 3,
    follow: false,
    mentionsOnly: true,
    once: true,
    out: (l) => lines.push(l),
    backoffBaseMs: 20,
    lines,
    ...over,
  };
}

describe("watch attach 上报 wake_kind=watch (#440)", () => {
  test("--once：attach 时声明一次 watch 唤醒层，且先于处理 @", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      sock.send(msgFrame(1, "wake up", { mentions: ["me"] }));
    });

    const order: string[] = [];
    let advertiseCalls = 0;
    const o = opts({
      server: server.url,
      advertise: async () => {
        advertiseCalls++;
        order.push("advertise");
      },
      out: (l) => {
        if (l.includes("wake up")) order.push("mention");
      },
    });

    expect(await runWatch(o)).toBe(0);
    expect(advertiseCalls).toBe(1); // 只声明一次
    expect(order).toEqual(["advertise", "mention"]); // 声明先于处理 @
  });

  test("重连收到第二个 welcome 不重复声明（只做一次）", async () => {
    let hellos = 0;
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      hellos++;
      sock.send(welcomeFrame(0, "me"));
      if (hellos === 1) {
        // 首个连接：发个非匹配帧后由服务端关闭，触发客户端重连
        setTimeout(() => sock.close(), 20);
      } else {
        sock.send(msgFrame(1, "wake up", { mentions: ["me"] }));
      }
    });

    let advertiseCalls = 0;
    const o = opts({
      server: server.url,
      advertise: async () => {
        advertiseCalls++;
      },
    });

    expect(await runWatch(o)).toBe(0);
    expect(advertiseCalls).toBe(1); // 两次 welcome 也只声明一次
  });

  test("advertise 抛错不影响监听（best-effort）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      sock.send(msgFrame(1, "wake up", { mentions: ["me"] }));
    });

    const o = opts({
      server: server.url,
      advertise: async () => {
        throw new Error("network down");
      },
    });

    // 声明失败仍照常唤醒退出 0，打印 @
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("wake up"))).toBe(true);
  });

  test("advertise 永不返回也不阻塞后续 @", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      sock.send(msgFrame(1, "wake through stalled advertise", { mentions: ["me"] }));
    });

    const o = opts({
      server: server.url,
      advertise: () => new Promise<void>(() => {}),
    });

    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("wake through stalled advertise"))).toBe(true);
  });

  test("advertiseWatchWake 发 wake.kind=watch + residency=supervised，且不谎称已验证", async () => {
    let captured: Record<string, unknown> | null = null;
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/messages" && req.method === "POST") {
          captured = (await req.json()) as Record<string, unknown>;
          return Response.json({ seq: 1 });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const auth: ResolvedAuthDetailed = {
      server: `http://127.0.0.1:${api.port}`,
      token: "ap_tok",
      auth_source: "runtime_config",
      config: { kind: "workspace", path: null },
      account: { present: false, path: "" },
    };

    await advertiseWatchWake(auth, "dev");

    expect(captured).not.toBeNull();
    const body = captured as unknown as Record<string, unknown>;
    expect(body.kind).toBe("status");
    expect(body.state).toBe("waiting");
    expect(body.residency).toBe("supervised");
    expect(body.wake).toEqual({ kind: "watch" });
    // 自报=unverified：只声明存在 watch 唤醒层，绝不带 verified_at（真验证靠 agent_resumed）
    expect((body.wake as Record<string, unknown>).verified_at).toBeUndefined();
    expect(body.context).toBeDefined();
  });

  test("无鉴权（server/token 缺失）时静默跳过，不发请求", async () => {
    let hits = 0;
    api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        hits++;
        return Response.json({ seq: 1 });
      },
    });
    const auth: ResolvedAuthDetailed = {
      server: null,
      token: null,
      auth_source: "none",
      config: { kind: "none", path: null },
      account: { present: false, path: "" },
    };
    await advertiseWatchWake(auth, "dev");
    expect(hits).toBe(0);
  });
});
