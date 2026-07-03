import type { ChannelKind, ServerFrame, TokenRole } from "@agentparty/shared";
import { SELF, env } from "cloudflare:test";

export const ADMIN_HEADERS = { "x-admin-secret": "test-admin-secret" };

export function uniq(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 测试造 token 直接插 d1
export async function seedToken(role: TokenRole, name = uniq(`tok-${role}`)) {
  const token = `ap_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare("INSERT INTO tokens (hash, name, role, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), name, role, Date.now())
    .run();
  return { token, name };
}

export function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://ap.test${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function createChannel(token: string, kind: ChannelKind = "standing"): Promise<string> {
  const slug = uniq("ch");
  const res = await api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug, kind }),
  });
  if (res.status !== 201) throw new Error(`create channel failed: ${res.status}`);
  return slug;
}

export function postMessage(slug: string, token: string, body: string): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions: [], reply_to: null }),
  });
}

interface Waiter {
  resolve: (frame: ServerFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WsClient {
  private buf: ServerFrame[] = [];
  private waiters: Waiter[] = [];

  static async open(slug: string, token: string): Promise<WsClient> {
    const res = await SELF.fetch(`http://ap.test/api/channels/${slug}/ws`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    });
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`ws upgrade failed: ${res.status}`);
    }
    return new WsClient(res.webSocket);
  }

  private constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener("message", (event) => {
      this.push(JSON.parse(event.data as string) as ServerFrame);
    });
  }

  private push(frame: ServerFrame) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.buf.push(frame);
    }
  }

  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }

  raw(text: string) {
    this.ws.send(text);
  }

  next(timeoutMs = 3000): Promise<ServerFrame> {
    const buffered = this.buf.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error("timeout waiting for frame"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async nextOfType<T extends ServerFrame["type"]>(
    type: T,
    timeoutMs = 3000,
  ): Promise<Extract<ServerFrame, { type: T }>> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame.type === type) return frame as Extract<ServerFrame, { type: T }>;
    }
  }

  close() {
    this.ws.close();
  }
}
