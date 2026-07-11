// #141 CLI 侧：party task create --external-ref <ref> 把外部引用键透传进请求体，
// 供 issue→task 同步脚本做幂等 create（对照 worker/test/task-external-ref.spec.ts）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-cli-extref-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("party task create --external-ref", () => {
  test("sends external_ref in the POST body", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const task = {
      type: "task",
      id: 9,
      channel: "dev",
      title: "sync issue #96",
      desc: null,
      state: "triage",
      assignee: null,
      created_by: "me",
      created_by_kind: "agent",
      priority: 0,
      labels: [],
      parent_id: null,
      anchor_seqs: [],
      external_ref: "gh:leeguooooo/agentparty#96",
      completion_artifact: null,
      workflow_id: null,
      created_at: 1,
      updated_at: 1,
    };
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "POST") {
          return Response.json(task, { status: 201 });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const r = await runCli(["task", "create", "sync issue #96", "--channel", "dev", "--external-ref", "gh:leeguooooo/agentparty#96"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("created #9");

    expect(seen).toContainEqual({
      method: "POST",
      path: "/api/channels/dev/tasks",
      body: { title: "sync issue #96", external_ref: "gh:leeguooooo/agentparty#96" },
    });
  });

  test("omits external_ref from the POST body when the flag is not passed", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const task = {
      type: "task",
      id: 10,
      channel: "dev",
      title: "plain task",
      desc: null,
      state: "triage",
      assignee: null,
      created_by: "me",
      created_by_kind: "agent",
      priority: 0,
      labels: [],
      parent_id: null,
      anchor_seqs: [],
      external_ref: null,
      completion_artifact: null,
      workflow_id: null,
      created_at: 1,
      updated_at: 1,
    };
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "GET" ? null : await req.json().catch(() => null);
        seen.push({ method: req.method, path: `${url.pathname}${url.search}`, body });
        if (url.pathname === "/api/channels/dev/tasks" && req.method === "POST") {
          return Response.json(task, { status: 201 });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const r = await runCli(["task", "create", "plain task", "--channel", "dev"]);
    expect(r.code).toBe(0);

    expect(seen).toContainEqual({
      method: "POST",
      path: "/api/channels/dev/tasks",
      body: { title: "plain task" },
    });
  });
});
