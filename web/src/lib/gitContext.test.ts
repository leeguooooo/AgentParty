import { describe, expect, test } from "bun:test";
import { gitContextChip } from "./gitContext";

// #853：chip 文案拼接。
describe("gitContextChip", () => {
  test("repo + branch + worktree", () => {
    expect(gitContextChip({ repo: "a/b", branch: "main", worktree_label: "b:main" })).toBe("a/b ⎇ main · b:main");
  });
  test("repo + branch without worktree", () => {
    expect(gitContextChip({ repo: "a/b", branch: "main" })).toBe("a/b ⎇ main");
  });
  test("repo only / branch only", () => {
    expect(gitContextChip({ repo: "a/b" })).toBe("a/b");
    expect(gitContextChip({ branch: "main" })).toBe("⎇ main");
  });
  test("null without repo and branch", () => {
    expect(gitContextChip({ worktree_label: "b:main" })).toBeNull();
    expect(gitContextChip(undefined)).toBeNull();
    expect(gitContextChip(null)).toBeNull();
  });
});
