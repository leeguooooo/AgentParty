// #197：serve 的唤醒上下文按 channel+seq 落盘，路径不含身份。
// 同机多个 agent serve 同一频道时（README/SKILL 推荐的拓扑），同一条消息 → 同一个文件，
// 后写的赢。runner 会读到**另一个 agent 的上下文**，其中 self 是别人的名字。
// 而 --runner claude|codex 把这个文件直接喂给模型，protocol_reminder 还叫模型「先读本文件」。
import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync } from "node:fs";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { writeContextFile } from "../src/commands/serve";
import { msgFrame } from "./mock-server";

function frame(seq: number): MsgFrame {
  return msgFrame(seq, "@both of you", { mentions: ["alice", "bob"] }) as unknown as MsgFrame;
}

describe("serve 唤醒上下文按身份隔离 (#197)", () => {
  test("同一频道、同一 seq、不同身份 → 不同文件，互不覆盖", () => {
    const a = writeContextFile(frame(272), "dev", "alice", []);
    const b = writeContextFile(frame(272), "dev", "bob", []);
    try {
      expect(a).not.toBe(b);
      // 两份上下文各自说自己是谁——这是 #197 的核心：模型不能被告知自己是另一个 agent
      expect(JSON.parse(readFileSync(a, "utf8")).self).toBe("alice");
      expect(JSON.parse(readFileSync(b, "utf8")).self).toBe("bob");
    } finally {
      unlinkSync(a);
      unlinkSync(b);
    }
  });

  test("身份里的路径分隔符/点号不得逃逸出 tmpdir", () => {
    const p = writeContextFile(frame(1), "dev", "../../etc/passwd", []);
    try {
      expect(p).not.toContain("..");
      expect(p).not.toContain("/etc/passwd");
      expect(JSON.parse(readFileSync(p, "utf8")).self).toBe("../../etc/passwd"); // 正文里仍是原名
    } finally {
      unlinkSync(p);
    }
  });

  test("同一身份、同一 seq 重复写 → 同一路径（幂等，不堆垃圾）", () => {
    const a = writeContextFile(frame(9), "dev", "alice", []);
    const b = writeContextFile(frame(9), "dev", "alice", []);
    try {
      expect(a).toBe(b);
    } finally {
      unlinkSync(a);
    }
  });
});
