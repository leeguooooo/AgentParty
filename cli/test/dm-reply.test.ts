import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { dmCandidateChannels, normalizeDmTarget, runWithDeps, type DmDeps } from "../src/commands/dm";
import { replyToSendArgs } from "../src/commands/reply";

let logs: string[];
let errs: string[];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  logs = [];
  errs = [];
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function presence(name: string, handle?: string): PresenceEntry {
  return {
    type: "presence",
    name,
    kind: "agent",
    state: "waiting",
    note: null,
    ts: Date.now(),
    ...(handle === undefined ? {} : { handle }),
  } as PresenceEntry;
}

function deps(overrides: Partial<DmDeps> = {}): { value: DmDeps; sent: string[][] } {
  const sent: string[][] = [];
  return {
    sent,
    value: {
      resolveAuth: async () => ({ server: "https://party.example", token: "token" }),
      listChannels: async () => [
        { slug: "alpha", title: null, archived_at: null } as never,
        { slug: "beta", title: null, archived_at: null } as never,
      ],
      fetchPresence: async (_server, _token, slug) => slug === "alpha" ? [presence("bob")] : [],
      runSend: async (argv) => { sent.push(argv); return 0; },
      ...overrides,
    },
  };
}

describe("party dm (#1075)", () => {
  test("normalizes one mention address and rejects invalid/reserved targets", () => {
    expect(normalizeDmTarget("@bob")).toBe("bob");
    expect(normalizeDmTarget("bad name")).toBeNull();
    expect(normalizeDmTarget("system")).toBeNull();
  });

  test("matches presence name or handle and sorts channel candidates", () => {
    expect(dmCandidateChannels("leo", [
      { slug: "z", presence: [presence("session", "Leo")] },
      { slug: "a", presence: [presence("leo")] },
    ])).toEqual(["a", "z"]);
  });

  test("unique common channel delegates to send with an authoritative mention", async () => {
    const fixture = deps();
    expect(await runWithDeps(["bob", "hello", "--notify-when-idle"], fixture.value)).toBe(0);
    expect(fixture.sent).toEqual([["--channel", "alpha", "--mention", "bob", "hello", "--notify-when-idle"]]);
    expect(errs.join("\n")).toContain("dm @bob -> #alpha (only common channel)");
  });

  test("explicit --channel skips all discovery", async () => {
    let listed = false;
    const fixture = deps({ listChannels: async () => { listed = true; return []; } });
    expect(await runWithDeps(["bob", "hello", "--channel", "chosen"], fixture.value)).toBe(0);
    expect(listed).toBe(false);
    expect(fixture.sent[0]).toEqual(["--mention", "bob", "hello", "--channel", "chosen"]);
  });

  test("multiple common channels refuses with deterministic candidates", async () => {
    const fixture = deps({ fetchPresence: async () => [presence("bob")] });
    expect(await runWithDeps(["bob", "hello"], fixture.value)).toBe(1);
    expect(fixture.sent).toEqual([]);
    expect(errs.join("\n")).toContain("#alpha, #beta");
    expect(errs.join("\n")).toContain("--channel <channel>");
  });

  test("no common channel prints executable invitation next steps", async () => {
    const fixture = deps({ fetchPresence: async () => [] });
    expect(await runWithDeps(["ghost", "hello"], fixture.value)).toBe(1);
    expect(errs.join("\n")).toContain("party channel join-link alpha");
    expect(errs.join("\n")).toContain("party channel invite-agent <owner>/<handle> alpha");
  });

  test("partial presence failure fails closed instead of guessing unique", async () => {
    const fixture = deps({
      fetchPresence: async (_server, _token, slug) => {
        if (slug === "beta") throw new Error("offline");
        return [presence("bob")];
      },
    });
    expect(await runWithDeps(["bob", "hello"], fixture.value)).toBe(1);
    expect(fixture.sent).toEqual([]);
    expect(errs.join("\n")).toContain("cannot safely choose");
  });
});

describe("party reply (#1076)", () => {
  test("turns a safe seq into send --reply-to and preserves the rest byte-for-byte", () => {
    expect(replyToSendArgs(["42", "hello", "--channel", "dev"])).toEqual([
      "--reply-to", "42", "hello", "--channel", "dev",
    ]);
  });

  test("rejects missing, invalid, list, and unsafe-integer seqs", () => {
    expect(replyToSendArgs([])).toBeNull();
    expect(replyToSendArgs(["zero", "hello"])).toBeNull();
    expect(replyToSendArgs(["1,2", "hello"])).toBeNull();
    expect(replyToSendArgs(["9007199254740993", "hello"])).toBeNull();
    expect(replyToSendArgs(["42", "hello", "--reply-to", "7"])).toBeNull();
  });
});
