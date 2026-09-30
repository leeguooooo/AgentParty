// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { inboxReceiptCounts, inboxReceiptRows, inboxReceiptTone } from "./inboxReceipt";

const r = (target: string, state: string, by = target, ts = 1, extra: Record<string, unknown> = {}) => ({
  target,
  state,
  reported_by: { name: by, kind: "agent" },
  ts,
  ...extra,
});

describe("inboxReceipt view model (#1130)", () => {
  test("tone per state: no state maps to a success tone", () => {
    expect(inboxReceiptTone("held")).toBe("held");
    expect(inboxReceiptTone("delivered")).toBe("delivered");
    expect(inboxReceiptTone("unknown")).toBe("unknown");
    for (const state of ["expired", "refused", "dropped", "denied"] as const) {
      expect(inboxReceiptTone(state)).toBe("not_delivered");
    }
  });

  test("one row per target; the target's own report wins; a third-party reporter is named", () => {
    const rows = inboxReceiptRows([
      r("a", "expired", "relay", 9),
      r("a", "held", "a", 1, { reason: "parked" }),
      r("b", "refused", "relay", 3),
    ]);
    expect(rows.map((row) => [row.target, row.state, row.reportedBy, row.reason])).toEqual([
      ["a", "held", null, "parked"],
      ["b", "refused", "relay", null],
    ]);
  });

  test("counts skip settled targets and never count delivered / unknown as held or not delivered", () => {
    const rows = inboxReceiptRows(
      [r("a", "held"), r("b", "expired"), r("c", "delivered"), r("d", "unknown"), r("e", "denied")],
      new Set(["e"]),
    );
    expect(inboxReceiptCounts(rows)).toEqual({ held: 1, notDelivered: 1 });
    expect(rows.find((row) => row.target === "e")?.settled).toBe(true);
  });

  test("malformed input, `accepted` and unknown states yield no rows", () => {
    expect(inboxReceiptRows(undefined)).toEqual([]);
    expect(inboxReceiptRows({})).toEqual([]);
    expect(inboxReceiptRows([r("a", "accepted"), r("a", "later_state"), null, 3])).toEqual([]);
  });
});
