import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as replyRun } from "../src/commands/reply";
import { writeConfig, writeState } from "../src/config";
import { startRestMock, type RestMock } from "./rest-mock";

let home: string;
let mock: RestMock | null = null;
let errors: string[];
const originalError = console.error;
const originalLog = console.log;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-reply-command-"));
  process.env.AGENTPARTY_HOME = home;
  errors = [];
  console.error = (...values: unknown[]) => errors.push(values.map(String).join(" "));
  console.log = () => {};
  mock = startRestMock((request) => {
    if (request.method === "POST" && request.path === "/api/channels/dev/messages") {
      return Response.json({ seq: 43 });
    }
    return undefined;
  });
  writeConfig({ server: mock.url, token: "ap_x" });
});

afterEach(() => {
  console.error = originalError;
  console.log = originalLog;
  delete process.env.AGENTPARTY_HOME;
  mock?.stop();
  mock = null;
  rmSync(home, { recursive: true, force: true });
});

describe("party reply command (#1076)", () => {
  test("uses the workspace-bound channel when --channel is omitted", async () => {
    writeState({ channel: "dev", cursor: 0 });

    expect(await replyRun(["42", "hello"])).toBe(0);

    expect(mock!.requests).toContainEqual(expect.objectContaining({
      method: "POST",
      path: "/api/channels/dev/messages",
      body: expect.objectContaining({ body: "hello", reply_to: 42 }),
    }));
  });

  test("without a binding, names --channel as the required fix", async () => {
    expect(await replyRun(["42", "hello"])).toBe(1);
    expect(errors.join("\n")).toContain("no channel, pass --channel C");
    expect(mock!.requests.some((request) => request.method === "POST")).toBe(false);
  });
});
