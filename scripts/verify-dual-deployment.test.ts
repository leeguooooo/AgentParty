import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const workerDir = resolve(repoRoot, "worker");
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function metadataServer(metadata: { version: string; commit: string; deployed_at: string }) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/api/health" || url.searchParams.get("deployment_metadata") !== "1") {
        return new Response("not found", { status: 404 });
      }
      requests += 1;
      return Response.json({ ok: true, ...metadata });
    },
  });
  servers.push(server);
  return {
    base: `http://127.0.0.1:${server.port}`,
    requestCount: () => requests,
  };
}

describe("verify-dual-deployment", () => {
  test("accepts independent stable deployment timestamps", async () => {
    const version = JSON.parse(readFileSync(resolve(repoRoot, "desktop/package.json"), "utf8")).version;
    const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
    const prod = metadataServer({ version, commit, deployed_at: "2026-07-12T01:00:00.000Z" });
    const xdream = metadataServer({ version, commit, deployed_at: "2026-07-12T01:00:28.000Z" });

    const child = Bun.spawn(["node", "scripts/verify-dual-deployment.mjs"], {
      cwd: workerDir,
      env: {
        ...process.env,
        AGENTPARTY_PROD_SMOKE_BASE: prod.base,
        AGENTPARTY_XDREAM_SMOKE_BASE: xdream.base,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      prod: { version, commit, deployed_at: "2026-07-12T01:00:00.000Z" },
      xdream: { version, commit, deployed_at: "2026-07-12T01:00:28.000Z" },
    });
    expect(prod.requestCount()).toBe(3);
    expect(xdream.requestCount()).toBe(3);
  });
});
