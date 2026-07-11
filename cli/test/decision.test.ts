// party decision（#284）命令层：ask 上传请求、respond 回应、mode 切模式。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, writeState } from "../src/config";
import { run as decisionRun } from "../src/commands/decision";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

let home: string;
let mock: RestMock | null = null;
let logs: string[];
let errs: string[];
const origLog = console.log;
const origErr = console.error;

function decisionHandler(request: RestRequest): Response | undefined {
  if (request.method === "POST" && request.path.endsWith("/messages")) {
    return Response.json({ seq: 7 });
  }
  if (request.method === "POST" && /\/messages\/\d+\/decision$/.test(request.path)) {
    const body = request.body as { action?: string; option?: number | string };
    const chosenIndex = body.action === "approve" ? 0 : body.action === "reject" ? 1 : typeof body.option === "number" ? body.option : 0;
    return Response.json({
      message: {
        type: "msg",
        seq: 7,
        sender: { name: "agent", kind: "agent" },
        kind: "message",
        body: "plan",
        mentions: [],
        reply_to: null,
        state: null,
        note: null,
        status: null,
        decision_resolution: { state: "resolved", chosen_index: chosenIndex, chosen_option: `opt${chosenIndex}` },
        ts: 1,
      },
      reply: {
        type: "msg",
        seq: 8,
        sender: { name: "leo", kind: "human" },
        kind: "message",
        body: `@agent decision #7 → opt${chosenIndex}`,
        mentions: ["agent"],
        reply_to: 7,
        state: null,
        note: null,
        status: null,
        decision_response: { request_seq: 7, chosen_index: chosenIndex, chosen_option: `opt${chosenIndex}` },
        ts: 2,
      },
    });
  }
  if (request.method === "PUT" && request.path.endsWith("/decision-mode")) {
    return Response.json({ mode: (request.body as { mode: string }).mode });
  }
  return undefined;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-decision-"));
  process.env.AGENTPARTY_HOME = home;
  logs = [];
  errs = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errs.push(a.map(String).join(" "));
  mock = startRestMock(decisionHandler);
  writeConfig({ server: mock.url, token: "ap_x" });
  writeState({ channel: "dev", cursor: 0 });
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  delete process.env.AGENTPARTY_HOME;
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

describe("party decision ask", () => {
  test("posts an approval request (no options) carrying decision_request", async () => {
    const code = await decisionRun(["ask", "approve this plan?"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => r.method === "POST" && r.path === "/api/channels/dev/messages");
    expect((req?.body as { decision_request?: unknown }).decision_request).toEqual({ kind: "approval", prompt: "approve this plan?" });
  });

  test("turns --option into a numbered choice request", async () => {
    const code = await decisionRun(["ask", "which path?", "--option", "ship", "--option", "wait"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => r.method === "POST" && r.path === "/api/channels/dev/messages");
    expect((req?.body as { decision_request?: unknown }).decision_request).toEqual({
      kind: "choice",
      prompt: "which path?",
      options: ["ship", "wait"],
    });
  });
});

describe("party decision respond", () => {
  test("maps approve to an action body", async () => {
    const code = await decisionRun(["respond", "7", "approve"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => /\/messages\/7\/decision$/.test(r.path));
    expect(req?.body).toEqual({ action: "approve" });
  });

  test("converts a 1-based positional index to a 0-based option", async () => {
    const code = await decisionRun(["respond", "7", "2"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => /\/messages\/7\/decision$/.test(r.path));
    expect(req?.body).toEqual({ option: 1 });
  });

  test("passes a reject reason", async () => {
    const code = await decisionRun(["respond", "7", "reject", "-m", "too risky"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => /\/messages\/7\/decision$/.test(r.path));
    expect(req?.body).toEqual({ action: "reject", reason: "too risky" });
  });
});

describe("party decision mode", () => {
  test("PUTs the channel decision mode", async () => {
    const code = await decisionRun(["mode", "unattended"]);
    expect(code).toBe(0);
    const req = mock!.requests.find((r) => r.method === "PUT" && r.path === "/api/channels/dev/decision-mode");
    expect(req?.body).toEqual({ mode: "unattended" });
    expect(logs.join("\n")).toContain("decision mode: unattended");
  });

  test("rejects an invalid mode before any request", async () => {
    const code = await decisionRun(["mode", "bogus"]);
    expect(code).toBe(1);
    expect(mock!.requests.some((r) => r.path.endsWith("/decision-mode"))).toBe(false);
  });
});
