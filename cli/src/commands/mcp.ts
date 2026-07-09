// party mcp — stdio MCP server exposing AgentParty as structured tools.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StatusState } from "@agentparty/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { loadCursor, loadRevCursor, resolveChannel, saveCursor, saveRevCursor } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth, resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, fetchMessages, fetchPresence, handleRestError, listChannels, postMessage, type Identity } from "../rest";
import { isName, isSlug } from "../validation";
import { buildContext } from "./status";
import { runWatch } from "./watch";

const HELP = `usage: party mcp

Run an AgentParty stdio MCP server.

Example:
  claude mcp add party -- party mcp

Tools:
  party_whoami
  party_channels
  party_send
  party_status
  party_who
  party_history
  party_digest
  party_watch_once
  party_wake_test`;

const StateSchema = z.enum(["working", "waiting", "blocked", "done"]);

function ok(data: Record<string, unknown>, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function normalizeChannel(channel: string | undefined, defaultChannel?: string): string {
  const resolved = resolveChannel(channel ?? defaultChannel);
  if (!resolved) throw new Error("no channel, pass channel or bind with: party init --channel C");
  if (!isSlug(resolved)) throw new Error("channel must match [a-z0-9][a-z0-9-]{0,63}");
  return resolved;
}

function normalizeMentions(mentions?: string[]): string[] {
  const values = mentions ?? [];
  const bad = values.find((mention) => !isName(mention));
  if (bad !== undefined) throw new Error(`invalid mention: ${bad}`);
  return values;
}

async function auth(): Promise<{ server: string; token: string; me?: Identity }> {
  const cfg = await resolveAuth();
  if (!cfg) throw new Error("no config, run: party login or party init --server URL --token T");
  return cfg;
}

let captureQueue: Promise<void> = Promise.resolve();

async function captureCommand(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let release!: () => void;
  const previous = captureQueue;
  captureQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldLog = console.log;
  const oldError = console.error;
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(" "));
  try {
    const code = await run();
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = oldLog;
    console.error = oldError;
    release();
  }
}

function capturedResult(name: string, captured: { code: number; stdout: string; stderr: string }): CallToolResult {
  const firstJson = captured.stdout
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((value): value is Record<string, unknown> => value !== null);
  const data = {
    type: name,
    exit_code: captured.code,
    stdout: captured.stdout,
    stderr: captured.stderr,
    ...(firstJson !== undefined ? { frame: firstJson } : {}),
  };
  return captured.code === 0 ? ok(data) : { ...fail(captured.stderr || captured.stdout || `${name} failed`), structuredContent: data };
}

export function createMcpServer(defaultChannel?: string): McpServer {
  const server = new McpServer({
    name: "agentparty",
    version: pkg.version,
  });

  server.registerTool(
    "party_whoami",
    {
      title: "Current AgentParty identity",
      description: "Return the identity and capability metadata for the current AgentParty config.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = await auth();
        const me = await fetchMe(cfg.server, cfg.token);
        return ok({ type: "me", server: cfg.server, identity: me });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_channels",
    {
      title: "List channels",
      description: "List channels visible to the current AgentParty identity.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = await auth();
        const channels = await listChannels(cfg.server, cfg.token);
        return ok({ type: "channels", channels });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_send",
    {
      title: "Send message",
      description: "Send a message to an AgentParty channel.",
      inputSchema: {
        channel: z.string().optional().describe("Channel slug. Defaults to the workspace-bound channel."),
        body: z.string().min(1),
        mentions: z.array(z.string()).optional(),
        reply_to: z.number().int().positive().nullable().optional(),
      },
    },
    async ({ channel, body, mentions, reply_to }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedMentions = normalizeMentions(mentions);
        const { seq } = await postMessage(cfg.server, cfg.token, resolved, {
          kind: "message",
          body,
          mentions: normalizedMentions,
          reply_to: reply_to ?? null,
        });
        saveCursor(resolved, seq);
        return ok({ type: "send", channel: resolved, seq });
      } catch (e) {
        const code = handleRestError(e);
        return fail(code === 1 && e instanceof Error ? e.message : `send failed with exit ${code}`);
      }
    },
  );

  server.registerTool(
    "party_status",
    {
      title: "Post status",
      description: "Post a structured AgentParty status frame.",
      inputSchema: {
        channel: z.string().optional(),
        state: StateSchema,
        note: z.string().optional(),
        mentions: z.array(z.string()).optional(),
        scope: z.array(z.string()).optional(),
        summary_seq: z.number().int().positive().optional(),
      },
    },
    async ({ channel, state, note, mentions, scope, summary_seq }) => {
      try {
        const authInfo = await resolveAuthDetailed();
        if (!authInfo.server || !authInfo.token) throw new Error("no config, run: party login or party init --server URL --token T");
        const resolved = normalizeChannel(channel, defaultChannel);
        const normalizedMentions = normalizeMentions(mentions);
        const { seq } = await postMessage(authInfo.server, authInfo.token, resolved, {
          kind: "status",
          state: state as StatusState,
          note: note ?? "",
          mentions: normalizedMentions,
          ...(scope && scope.length > 0 ? { scope } : {}),
          ...(summary_seq !== undefined ? { summary_seq } : {}),
          context: buildContext(authInfo),
        });
        saveCursor(resolved, seq);
        return ok({ type: "status", channel: resolved, seq, state });
      } catch (e) {
        const code = handleRestError(e);
        return fail(code === 1 && e instanceof Error ? e.message : `status failed with exit ${code}`);
      }
    },
  );

  server.registerTool(
    "party_who",
    {
      title: "Channel presence",
      description: "Return current presence/wakeability for a channel.",
      inputSchema: {
        channel: z.string().optional(),
      },
    },
    async ({ channel }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const presence = await fetchPresence(cfg.server, cfg.token, resolved);
        return ok({ type: "who", channel: resolved, presence });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_history",
    {
      title: "Channel history",
      description: "Fetch recent AgentParty channel messages.",
      inputSchema: {
        channel: z.string().optional(),
        since: z.number().int().min(0).optional(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ channel, since, limit }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const messages = await fetchMessages(cfg.server, cfg.token, resolved, since ?? 0, limit ?? 100);
        return ok({ type: "history", channel: resolved, messages });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_digest",
    {
      title: "Channel digest",
      description: "Run the existing AgentParty digest command and return its structured frame.",
      inputSchema: {
        channel: z.string().optional(),
        since: z.union([z.number().int().min(0), z.literal("last-seen")]).optional(),
        limit: z.number().int().positive().max(1000).optional(),
        for_name: z.string().optional(),
      },
    },
    async ({ channel, since, limit, for_name }) => {
      const resolved = channel ?? defaultChannel;
      const argv = [
        ...(resolved ? ["--channel", resolved] : []),
        ...(since !== undefined ? ["--since", String(since)] : []),
        ...(limit !== undefined ? ["--limit", String(limit)] : []),
        ...(for_name !== undefined ? ["--for", for_name] : []),
        "--json",
      ];
      const captured = await captureCommand(async () => (await import("./digest")).run(argv));
      return capturedResult("digest", captured);
    },
  );

  server.registerTool(
    "party_watch_once",
    {
      title: "Wait for one matching mention",
      description: "Wait until the next matching message arrives, then return the structured watch frame.",
      inputSchema: {
        channel: z.string().optional(),
        timeout_sec: z.number().int().positive().max(600).optional(),
        mentions_only: z.boolean().optional(),
      },
    },
    async ({ channel, timeout_sec, mentions_only }) => {
      try {
        const cfg = await auth();
        const resolved = normalizeChannel(channel, defaultChannel);
        const lines: string[] = [];
        const code = await runWatch({
          server: cfg.server,
          token: cfg.token,
          channel: resolved,
          since: loadCursor(resolved),
          sinceRev: loadRevCursor(resolved),
          timeoutSec: timeout_sec ?? 240,
          follow: false,
          once: true,
          mentionsOnly: mentions_only ?? true,
          json: true,
          onCursor: (c) => saveCursor(resolved, c),
          onRevCursor: (r) => saveRevCursor(resolved, r),
          out: (line) => lines.push(line),
        });
        const frames = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        const data = { type: "watch_once", channel: resolved, exit_code: code, frames };
        return code === 0 ? ok(data) : { ...fail(lines.join("\n") || `watch_once failed with exit ${code}`), structuredContent: data };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.registerTool(
    "party_wake_test",
    {
      title: "Wake test",
      description: "Run the existing wake contract test and return its structured frame.",
      inputSchema: {
        channel: z.string().optional(),
        target: z.string().describe("Agent name, with or without @ prefix."),
        timeout_sec: z.number().int().positive().max(600).optional(),
      },
    },
    async ({ channel, target, timeout_sec }) => {
      const normalizedTarget = target.startsWith("@") ? target : `@${target}`;
      const resolved = channel ?? defaultChannel;
      const argv = [
        "test",
        normalizedTarget,
        ...(resolved ? ["--channel", resolved] : []),
        ...(timeout_sec !== undefined ? ["--timeout", String(timeout_sec)] : []),
        "--json",
      ];
      const captured = await captureCommand(async () => (await import("./wake")).run(argv));
      return capturedResult("wake_test", captured);
    },
  );

  return server;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  let defaultChannel: string | undefined;
  if (argv.length === 2 && argv[0] === "--channel") {
    defaultChannel = argv[1];
    if (!isSlug(defaultChannel)) {
      console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
      return 1;
    }
  } else if (argv.length > 0) {
    console.error("usage: party mcp [--channel C]");
    return 1;
  }
  const server = createMcpServer(defaultChannel);
  await server.connect(new StdioServerTransport());
  return new Promise<number>((resolve) => {
    process.stdin.on("close", () => resolve(0));
    process.stdin.on("end", () => resolve(0));
  });
}
