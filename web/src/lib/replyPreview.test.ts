import { describe, expect, test } from "bun:test";
import { summarizeReplyPreview } from "./replyPreview";

describe("summarizeReplyPreview", () => {
  test("collapses internal whitespace/newlines to single spaces", () => {
    expect(summarizeReplyPreview("hello\n\n  world\tagain")).toBe("hello world again");
  });

  test("trims leading/trailing whitespace", () => {
    expect(summarizeReplyPreview("   padded   ")).toBe("padded");
  });

  test("passes short bodies through unchanged", () => {
    const body = "a".repeat(96);
    expect(summarizeReplyPreview(body)).toBe(body);
  });

  test("truncates long bodies to 93 chars + ellipsis", () => {
    const body = "a".repeat(200);
    const out = summarizeReplyPreview(body);
    expect(out).toBe(`${"a".repeat(93)}...`);
    expect(out.length).toBe(96);
  });

  test("empty body stays empty", () => {
    expect(summarizeReplyPreview("")).toBe("");
  });
});
