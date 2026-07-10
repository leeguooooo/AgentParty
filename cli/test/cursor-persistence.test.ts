// #113：本地游标持久化三连击。三个独立缺陷共同击穿「@mention 恰好一次送达」。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceCursorPastOwnMessage,
  loadCursor,
  loadRevCursor,
  readState,
  saveCursor,
  saveRevCursor,
  statePath,
  writeState,
} from "../src/config";

const cwd = () => mkdtempSync(join(tmpdir(), "ap-cursor-"));

describe("cursor persistence (#113)", () => {
  describe("① send 不得吞掉发送前未消费的消息", () => {
    test("有空洞时，发自己的消息绝不推进游标", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 10 }, d);
      // 频道已经到 seq 14（11..14 是别人的消息，其中可能有 @我），我发的是 15
      advanceCursorPastOwnMessage("dev", 15, d);
      // 修复前：游标直接跳到 15，11..14 永久跳过——不打印、不唤醒、不补拉
      expect(loadCursor("dev", d)).toBe(10);
    });

    test("无空洞时（我已读到最新），推进一格以保住 statusline 的 unread=0", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 14 }, d);
      advanceCursorPastOwnMessage("dev", 15, d);
      expect(loadCursor("dev", d)).toBe(15);
    });

    test("乱序/重复调用不会让游标回退", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 14 }, d);
      advanceCursorPastOwnMessage("dev", 15, d);
      advanceCursorPastOwnMessage("dev", 15, d); // 重复
      advanceCursorPastOwnMessage("dev", 12, d); // 迟到的旧 seq
      expect(loadCursor("dev", d)).toBe(15);
    });
  });

  describe("② 游标必须按频道键，而不是只对绑定频道生效", () => {
    test("serve --profile 的多个频道各自保有游标", () => {
      const d = cwd();
      writeState({ channel: "alpha", cursor: 0 }, d);
      saveCursor("alpha", 100, d);
      saveCursor("beta", 200, d);
      saveCursor("gamma", 300, d);
      // 修复前：beta/gamma 的 saveCursor 被静默丢弃 → 每次重启 since=0 → 重放全部历史 @
      expect(loadCursor("alpha", d)).toBe(100);
      expect(loadCursor("beta", d)).toBe(200);
      expect(loadCursor("gamma", d)).toBe(300);
    });

    test("rev 游标同样按频道键", () => {
      const d = cwd();
      writeState({ channel: "alpha", cursor: 0 }, d);
      saveRevCursor("alpha", 7, d);
      saveRevCursor("beta", 9, d);
      expect(loadRevCursor("alpha", d)).toBe(7);
      expect(loadRevCursor("beta", d)).toBe(9);
      expect(loadRevCursor("unknown", d)).toBe(0);
    });

    test("升级兼容：只有旧格式顶层字段时，绑定频道的游标不丢", () => {
      const d = cwd();
      // 模拟旧版写下的 state（无 cursors 表）
      writeState({ channel: "dev", cursor: 42, rev_cursor: 8 }, d);
      expect(loadCursor("dev", d)).toBe(42);
      expect(loadRevCursor("dev", d)).toBe(8);
      expect(loadCursor("other", d)).toBe(0);
      // 写入后迁移到 cursors 表，且顶层仍镜像
      saveCursor("dev", 43, d);
      expect(readState(d)?.cursors?.dev?.cursor).toBe(43);
      expect(readState(d)?.cursor).toBe(43);
    });
  });

  describe("③ state.json 必须原子写", () => {
    test("截断的 state 不会让游标退回 0 之外——写入本身不留半个文件", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 5 }, d);
      // 直接模拟一次崩溃留下的截断文件
      writeFileSync(statePath(d), '{"channel":"dev","cur');
      expect(readState(d)).toBeNull();
      expect(loadCursor("dev", d)).toBe(0); // 损坏即重放，这正是要防的

      // 修复后：writeState 走 tmp+rename，中途崩溃不会产生上面这种半截文件。
      // 这里断言写完之后落盘的一定是完整可解析的 JSON。
      writeState({ channel: "dev", cursor: 5 }, d);
      saveCursor("dev", 6, d);
      const raw = readState(d);
      expect(raw).not.toBeNull();
      expect(raw?.cursors?.dev?.cursor).toBe(6);
    });

    test("并发写不会互相截断（同一目录连续多次写，每次都可解析）", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 0 }, d);
      for (let i = 1; i <= 50; i++) saveCursor("dev", i, d);
      expect(loadCursor("dev", d)).toBe(50);
      expect(readState(d)).not.toBeNull();
    });
  });
});
