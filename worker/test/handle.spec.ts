import { describe, it, expect } from "vitest";
import { validateHandleFormat, HANDLE_RE } from "../src/handle";

describe("validateHandleFormat", () => {
  it("接受合法 handle，大小写原样保留（GitHub 式：允许大写显示，唯一性另由 COLLATE NOCASE 判定）", () => {
    expect(validateHandleFormat("leo")).toBe("leo");
    expect(validateHandleFormat("a1._-b")).toBe("a1._-b");
    expect(validateHandleFormat("Evan")).toBe("Evan");
    expect(validateHandleFormat("a1._-Bc")).toBe("a1._-Bc");
  });
  it("拒绝非法：太短/太长/非法首字/非串", () => {
    expect(validateHandleFormat("a")).toBeNull();
    expect(validateHandleFormat("-abc")).toBeNull();
    expect(validateHandleFormat("a".repeat(33))).toBeNull();
    expect(validateHandleFormat(123)).toBeNull();
  });
});
