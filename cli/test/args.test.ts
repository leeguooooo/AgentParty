import { describe, expect, test } from "bun:test";
import { isHelpArg, num, parseArgs, str } from "../src/args";

describe("parseArgs", () => {
  test("positionals and value flags", () => {
    const p = parseArgs(["dev", "hello", "--timeout", "30"]);
    expect(p.positionals).toEqual(["dev", "hello"]);
    expect(p.flags.timeout).toBe("30");
  });

  test("--key=value form", () => {
    const p = parseArgs(["--server=https://x.dev", "--limit=5"]);
    expect(p.flags.server).toBe("https://x.dev");
    expect(p.flags.limit).toBe("5");
  });

  test("boolean flags do not eat next token", () => {
    const p = parseArgs(["--follow", "dev", "--mentions-only"], {
      booleans: ["follow", "mentions-only"],
    });
    expect(p.flags.follow).toBe(true);
    expect(p.flags["mentions-only"]).toBe(true);
    expect(p.positionals).toEqual(["dev"]);
  });

  test("repeatable --mention", () => {
    const p = parseArgs(["--mention", "bob", "--mention", "alice"], {
      repeatable: ["mention"],
    });
    expect(p.flags.mention).toEqual(["bob", "alice"]);
  });

  test("single repeatable still array", () => {
    const p = parseArgs(["--mention", "bob"], { repeatable: ["mention"] });
    expect(p.flags.mention).toEqual(["bob"]);
  });

  test("bare - is a positional (stdin marker)", () => {
    const p = parseArgs(["-"]);
    expect(p.positionals).toEqual(["-"]);
  });

  test("short alias -m", () => {
    const p = parseArgs(["working", "-m", "one liner"], { aliases: { m: "note" } });
    expect(p.positionals).toEqual(["working"]);
    expect(p.flags.note).toBe("one liner");
  });

  test("short value flag does not eat next flag", () => {
    const p = parseArgs(["working", "-m", "--channel", "ops"], { aliases: { m: "note" } });
    expect(p.positionals).toEqual(["working"]);
    expect(p.flags.note).toBe(true);
    expect(p.flags.channel).toBe("ops");
  });

  test("-- terminates flags and records literal mode", () => {
    const p = parseArgs(["--channel", "dev", "--", "-"]);
    expect(p.flags.channel).toBe("dev");
    expect(p.positionals).toEqual(["-"]);
    expect(p.terminated).toBe(true);
    expect(p.terminatedAt).toBe(0);
  });

  test("-- after a positional records where termination happened", () => {
    const p = parseArgs(["-", "--"]);
    expect(p.positionals).toEqual(["-"]);
    expect(p.terminated).toBe(true);
    expect(p.terminatedAt).toBe(1);
  });

  test("flag value may be - (stdin)", () => {
    const p = parseArgs(["--body", "-"]);
    expect(p.flags.body).toBe("-");
    expect(p.terminated).toBe(false);
  });

  test("str/num helpers", () => {
    expect(str("x")).toBe("x");
    expect(str(true)).toBeUndefined();
    expect(num("42")).toBe(42);
    expect(num("abc")).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
  });
});

describe("isHelpArg respects the `--` terminator (#373)", () => {
  test("real --help/-h flag (before terminator) triggers help", () => {
    expect(isHelpArg(["--help"])).toBe(true);
    expect(isHelpArg(["-h"])).toBe(true);
    expect(isHelpArg(["send", "--help"])).toBe(true);
  });

  test("--help/-h after `--` is body, not help — send must NOT be swallowed", () => {
    expect(isHelpArg(["--", "见 --help 说明"])).toBe(false);
    expect(isHelpArg(["--", "--help"])).toBe(false);
    expect(isHelpArg(["--channel", "c", "--", "text with -h inside"])).toBe(false);
  });

  test("allowHelpPositional only when `help` is the sole pre-terminator token", () => {
    expect(isHelpArg(["help"], { allowHelpPositional: true })).toBe(true);
    expect(isHelpArg(["--", "help"], { allowHelpPositional: true })).toBe(false); // 正文里的 help
    expect(isHelpArg(["help", "extra"], { allowHelpPositional: true })).toBe(false);
  });
});
