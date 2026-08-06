// #818：`--reply-to A` 只清 A。真实协作里一条回复常常同时答掉对方连发的 2-3 条 @，其余的 debt
// 不清、原样重放——收到的人还得先辨认「这是新消息还是重放」。`--reply-to 396,398` 让一次回复
// 一次清准；首个 seq 仍是唯一的线程锚点，其余只标记已处理。
import { describe, expect, test } from "bun:test";
import { MAX_ALSO_RESOLVES } from "@agentparty/shared";
import { parseReplyToList } from "../src/commands/send";

describe("parseReplyToList", () => {
  test("单个 seq：与旧行为完全一致，没有额外要清的", () => {
    expect(parseReplyToList("396")).toEqual({ replyTo: 396, alsoResolves: [] });
  });

  test("未提供 → 不是回复", () => {
    expect(parseReplyToList(undefined)).toEqual({ replyTo: null, alsoResolves: [] });
  });

  test("多个 seq：第一个是线程锚点，其余进 alsoResolves", () => {
    expect(parseReplyToList("396,398")).toEqual({ replyTo: 396, alsoResolves: [398] });
    expect(parseReplyToList("396,398,401")).toEqual({ replyTo: 396, alsoResolves: [398, 401] });
  });

  test("容忍空格，重复项去重（重复不该悄悄多算一条）", () => {
    expect(parseReplyToList(" 396 , 398 , 396 ")).toEqual({ replyTo: 396, alsoResolves: [398] });
  });

  test("非法输入给出点破语义的报错，而不是静默丢掉后半段", () => {
    expect(typeof parseReplyToList("396,")).toBe("string");
    expect(typeof parseReplyToList("396,abc")).toBe("string");
    expect(typeof parseReplyToList("0")).toBe("string");
    expect(typeof parseReplyToList("-3")).toBe("string");
    expect(String(parseReplyToList("396,abc"))).toContain("comma-separated");
  });

  test("超上限拒绝：一条消息不该清空整个接待债务", () => {
    const tooMany = Array.from({ length: MAX_ALSO_RESOLVES + 2 }, (_, i) => i + 1).join(",");
    expect(typeof parseReplyToList(tooMany)).toBe("string");
    const atLimit = Array.from({ length: MAX_ALSO_RESOLVES + 1 }, (_, i) => i + 1).join(",");
    expect(typeof parseReplyToList(atLimit)).toBe("object");
  });
});
