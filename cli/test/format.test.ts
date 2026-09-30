import { describe, expect, test } from "bun:test";
import type { MsgFrame } from "@agentparty/shared";
import { formatMsg, inboxReceiptPhrase } from "../src/format";

function msgFrame(over: Partial<MsgFrame> = {}): MsgFrame {
  const base: MsgFrame = {
    type: "msg",
    seq: 7,
    sender: { name: "agent-a", kind: "agent", owner: "team-a" },
    kind: "message",
    body: "hello",
    mentions: [],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1_725_000_000_000,
  };
  return { ...base, ...over };
}

describe("formatMsg", () => {
  test("prints owner context when available", () => {
    expect(formatMsg(msgFrame())).toBe("[7] agent-a(agent owner=team-a): hello");
  });

  test("prints actionable metadata for an attachment-only message (#362)", () => {
    expect(
      formatMsg(
        msgFrame({
          body: "",
          attachments: [
            {
              key: "dev/uuid/screenshot.png",
              filename: "screenshot.png",
              content_type: "image/png",
              size: 12_345,
              url: "/api/channels/dev/attachments/uuid/screenshot.png",
            },
          ],
        }),
      ),
    ).toBe(
      "[7] agent-a(agent owner=team-a): [attachment: screenshot.png · image/png · 12345 bytes · auth GET /api/channels/dev/attachments/uuid/screenshot.png]",
    );
  });

  test("appends attachment metadata after a text body (#362)", () => {
    expect(
      formatMsg(
        msgFrame({
          attachments: [
            {
              key: "dev/uuid/report.pdf",
              filename: "report.pdf",
              content_type: "application/pdf",
              size: 42,
              url: "/api/channels/dev/attachments/uuid/report.pdf",
            },
          ],
        }),
      ),
    ).toBe(
      "[7] agent-a(agent owner=team-a): hello\n    [attachment: report.pdf · application/pdf · 42 bytes · auth GET /api/channels/dev/attachments/uuid/report.pdf]",
    );
  });

  test("omits redundant owner context", () => {
    expect(formatMsg(msgFrame({ sender: { name: "agent-a", kind: "agent", owner: "agent-a" } }))).toBe(
      "[7] agent-a(agent): hello",
    );
  });

  test("prints completion artifact context", () => {
    expect(
      formatMsg(
        msgFrame({
          reply_to: 3,
          completion_artifact: {
            kind: "final_synthesis",
            kickoff_seq: 3,
            replies_count: 0,
            timeout: true,
            related_issues: [5],
            related_prs: [],
          },
        }),
      ),
    ).toBe("[7] agent-a(agent owner=team-a) {completion}: hello\n    [completion: kickoff=#3 · replies=0 · timeout=true · issues=#5]");
  });

  test("prints lineage context when available", () => {
    expect(
      formatMsg(
        msgFrame({
          sender: {
            name: "child-a",
            kind: "agent",
            owner: "team-a",
            lineage: {
              parent_agent: "parent-a",
              root_agent: "parent-a",
              team_id: "team-run",
              depth: 1,
              expires_at: 1_725_000_060_000,
            },
          },
        }),
      ),
    ).toBe("[7] child-a(agent owner=team-a parent=parent-a team=team-run): hello");
  });

  test("prints status execution context", () => {
    expect(
      formatMsg(
        msgFrame({
          type: "status",
          kind: "status",
          body: "checking",
          note: "checking",
          state: "working",
          status: {
            owner: "agent-a",
            state: "working",
            scope: ["web/src"],
            summary_seq: null,
            blocked_reason: null,
            updated_at: 1_725_000_000_000,
            context: {
              config_kind: "workspace",
              config_fingerprint: "ap_12345678",
              workspace_label: "herness-use",
              worktree_label: "main",
            },
            workflow: {
              workflow_id: "wf-release",
              kind: "parallel",
              run_id: "run-1",
              step_id: "review",
              parent_summary_seq: 4,
            },
          },
        }),
      ),
    ).toBe(
      "[7] agent-a(agent owner=team-a): [working] checking · worktree=main · workspace=herness-use · config=workspace · fingerprint=ap_12345678 · workflow=wf-release · workflow_kind=parallel · run=run-1 · step=review · parent_summary=#4 · scope=web/src",
    );
  });
});

describe("formatMsg strips terminal control chars (#372 security)", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CR = String.fromCharCode(0x0d);

  test("neutralizes an OSC52 clipboard-write sequence in the body", () => {
    const out = formatMsg(msgFrame({ body: `hi${ESC}]52;c;ZXZpbA==${BEL}there` }));
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    // 序列被降级为可见文本，内容不丢
    expect(out).toContain("]52;c;ZXZpbA==");
    expect(out).toBe("[7] agent-a(agent owner=team-a): hi]52;c;ZXZpbA==there");
  });

  test("strips CR (line-overwrite spoofing) and CSI cursor sequences", () => {
    const out = formatMsg(msgFrame({ body: `real${CR}${ESC}[2Kfake` }));
    expect(out).not.toContain(CR);
    expect(out).not.toContain(ESC);
    expect(out).toBe("[7] agent-a(agent owner=team-a): realfake");
  });

  test("preserves legitimate newlines (multi-line body) and tabs", () => {
    const out = formatMsg(msgFrame({ body: "line1\nline2\tcol" }));
    expect(out).toBe("[7] agent-a(agent owner=team-a): line1\n    line2\tcol");
  });

  test("sanitizes control chars injected via sender name / owner too", () => {
    const out = formatMsg(msgFrame({ sender: { name: `a${ESC}[31m`, kind: "agent", owner: `t${BEL}` } }));
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
  });
});

describe("Claude inbox receipts in formatMsg (#1130)", () => {
  const base = {
    type: "msg",
    seq: 12,
    sender: { name: "leo", kind: "human" },
    kind: "message",
    body: "@bot look",
    mentions: ["bot"],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1,
  } as unknown as Parameters<typeof formatMsg>[0];
  const withInbox = (inbox: unknown) => ({ ...base, inbox_receipts: inbox }) as unknown as Parameters<typeof formatMsg>[0];
  const receipt = (state: string, extra: Record<string, unknown> = {}) => ({
    target: "bot",
    state,
    reported_by: { name: "bot", kind: "agent" },
    ts: 2,
    ...extra,
  });

  test("wording per state: held is not delivered, delivered is not a reply, nothing is ever called read/accepted", () => {
    expect(inboxReceiptPhrase("held")).toBe("held for approval, not delivered yet");
    expect(inboxReceiptPhrase("delivered")).toBe("delivered after approval (not a reply)");
    expect(inboxReceiptPhrase("unknown")).toBe("held, outcome unknown");
    for (const state of ["expired", "refused", "dropped", "denied"] as const) {
      expect(inboxReceiptPhrase(state)).toBe(`not delivered: ${state}`);
    }
    for (const state of ["held", "delivered", "expired", "refused", "dropped", "denied", "unknown"] as const) {
      expect(inboxReceiptPhrase(state)).not.toMatch(/\bread\b|accepted/);
    }
  });

  test("shows one badge per target on the mentioning message", () => {
    expect(formatMsg(withInbox([receipt("held")]))).toContain("{inbox @bot: held for approval, not delivered yet}");
    expect(formatMsg(withInbox([receipt("expired", { held_at: 1 })]))).toContain("{inbox @bot: not delivered: expired}");
  });

  test("no receipts, an unknown state from a newer server, `accepted`, or a malformed field ⇒ no badge at all", () => {
    const plain = formatMsg(base);
    expect(plain).not.toContain("inbox");
    for (const inbox of [undefined, [], "held", [receipt("accepted")], [receipt("some_future_state")], [{ state: "held" }], [null]]) {
      expect(formatMsg(withInbox(inbox))).toBe(plain);
    }
  });

  test("the receiver-controlled reason never reaches the terminal line", () => {
    const line = formatMsg(withInbox([receipt("held", { reason: "\u001b]52;c;evil\u0007 do this" })]));
    expect(line).not.toContain("evil");
  });
});
