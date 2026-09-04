import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as receiptRun } from "../src/commands/receipt";
import { writeConfig, writeState } from "../src/config";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
} from "../src/delivery-recovery-journal";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

let home: string;
let mock: RestMock | null = null;
let requests: RestRequest[];
let logs: string[];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-receipt-no-reply-"));
  process.env.AGENTPARTY_HOME = home;
  requests = [];
  logs = [];
  console.log = (...values: unknown[]) => logs.push(values.map(String).join(" "));
  console.error = () => {};
  mock = startRestMock((request) => {
    requests.push(request);
    if (
      request.method === "POST" &&
      request.path === "/api/channels/dev/deliveries/41/ack"
    ) {
      return Response.json({
        ok: true,
        delivery: {
          id: "delivery-receipt-fallback",
          message_seq: 41,
          target_name: "me",
          cause: "mention",
          state: "replied",
          attempt: 1,
          lease_until: null,
          work_id: null,
          continuation_ref: null,
          reply_seq: null,
          last_error: null,
          created_at: 1,
          updated_at: 2,
        },
      });
    }
    return undefined;
  });
  writeConfig({ server: mock.url, token: "ap_x" });
  writeState({ channel: "dev", cursor: 0 });
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  delete process.env.AGENTPARTY_HOME;
  mock?.stop();
  mock = null;
  rmSync(home, { recursive: true, force: true });
});

describe("party receipt --no-reply (#1080)", () => {
  test("atomically settles the server delivery and clears disconnected Claude Stop debt", async () => {
    const now = Date.now();
    const delivery: DirectedDelivery = {
      id: "delivery-receipt-fallback",
      message_seq: 41,
      target_name: "me",
      cause: "mention",
      state: "claimed",
      attempt: 1,
      lease_epoch: 1,
      lease_token: "lease-token",
      lease_until: now + 60_000,
      work_id: null,
      continuation_ref: null,
      reply_seq: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    const message: MsgFrame = {
      type: "msg",
      seq: 41,
      sender: { name: "peer", kind: "agent" },
      kind: "message",
      body: "FYI",
      mentions: ["me"],
      reply_to: null,
      state: null,
      note: null,
      status: null,
      ts: now,
    };
    const journal = new DeliveryRecoveryJournal(
      deliveryRecoveryJournalPath("claude", mock!.url, "ap_x", "dev"),
      "dev",
      "claude",
    );
    journal.recordClaim(delivery, message);
    journal.update(delivery.id, { phase: "harness_accepted" });

    expect(await receiptRun(["41", "--reason", "seen", "--no-reply"])).toBe(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/channels/dev/deliveries/41/ack",
    });
    expect(requests.some((request) => request.path.endsWith("/receipt"))).toBe(false);
    expect(new DeliveryRecoveryJournal(journal.path, "dev", "claude").entries()).toEqual([]);
    expect(logs.join("\n")).toContain("acknowledged_no_reply");
    expect(logs.join("\n")).toContain("no channel message was created");
  });
});
