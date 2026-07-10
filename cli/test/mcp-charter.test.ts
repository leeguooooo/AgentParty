import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-mcp-charter-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

// #134/#136: the MCP接入路径 must be able to read the channel charter —
// both as an explicit tool AND as a machine-discoverable resource.
describe("mcp charter surface", () => {
  test("exposes party_charter tool and party://charter resource（#134/#136）", async () => {
    restServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/channels/dev/charter" && req.method === "GET") {
          return Response.json({
            charter: "Scope: reproduce the IM issue. Do not touch prod.",
            charter_rev: 7,
            updated_at: 123,
            updated_by: "host",
          });
        }
        if (url.pathname === "/api/me") {
          return Response.json({ name: "me", email: null, kind: "agent", role: "member", owner: null });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "mcp", "--channel", "dev"],
      env: { ...process.env, AGENTPARTY_HOME: home },
      stderr: "pipe",
    });
    const client = new Client({ name: "agentparty-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      // 1) party_charter tool exists and returns the charter body + rev.
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("party_charter");
      const charter = await client.callTool({ name: "party_charter", arguments: {} });
      expect(charter.isError).not.toBe(true);
      expect(charter.structuredContent).toMatchObject({
        type: "charter",
        channel: "dev",
        charter: "Scope: reproduce the IM issue. Do not touch prod.",
        charter_rev: 7,
      });

      // 2) charter is discoverable as an MCP resource (resources/list is non-empty).
      const resources = await client.listResources();
      const charterResource = resources.resources.find((r) => r.uri === "party://charter");
      expect(charterResource).toBeDefined();

      // 3) reading the resource returns the charter markdown.
      const read = await client.readResource({ uri: "party://charter" });
      expect(JSON.stringify(read.contents)).toContain("reproduce the IM issue");

      // 4) whoami nudges reading the charter first (first-screen context).
      const whoami = await client.callTool({ name: "party_whoami", arguments: {} });
      expect(JSON.stringify(whoami.structuredContent)).toContain("charter");
    } finally {
      await client.close();
    }
  }, 20000);
});
