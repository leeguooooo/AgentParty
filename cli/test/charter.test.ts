import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/commands/charter";

let home: string;
let oldHome: string | undefined;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-charter-"));
  oldHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = home;
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
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
});

describe("party charter command", () => {
  test("reads and writes with mocked REST", async () => {
    let charter = "initial charter";
    let rev = 3;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      expect(req.headers.get("authorization")).toBe("Bearer ap_tok");
      if (url.pathname === "/api/channels/dev/charter" && req.method === "GET") {
        return Response.json({ charter, charter_rev: rev, updated_at: 123, updated_by: "alice" });
      }
      if (url.pathname === "/api/channels/dev/charter" && req.method === "PUT") {
        const body = (await req.json()) as { charter: string };
        charter = body.charter;
        rev++;
        return Response.json({ charter, charter_rev: rev, updated_at: 456, updated_by: "me" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    expect(await run(["dev", "--json"])).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "{}").charter).toBe("initial charter");

    expect(await run(["set", "dev", "-m", "updated charter"])).toBe(0);
    expect(stdout.pop()).toContain("rev 4");
    expect(charter).toBe("updated charter");
    expect(stderr).toEqual([]);
  });

  test("#713：party charter get <slug> 与 set 对称，按 slug 读取而非把 get 当频道名", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(req.url);
      if (url.pathname === "/api/channels/dev/charter" && req.method === "GET") {
        return Response.json({ charter: "hello charter", charter_rev: 1, updated_at: 1, updated_by: "a" });
      }
      // 若把 "get" 误当频道名，会打到 /api/channels/get/charter → 这里 404 → 命令报「channel not found」
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    expect(await run(["get", "dev", "--json"])).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "{}").charter).toBe("hello charter");
    expect(stderr).toEqual([]);
  });
});
