// #113：本地游标持久化三连击。三个独立缺陷共同击穿「@mention 恰好一次送达」。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceCursorPastOwnMessage,
  loadStuck,
  loadCursor,
  loadRevCursor,
  readState,
  saveCursor,
  saveRevCursor,
  saveStuck,
  statePath,
  workspaceId,
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

    test("后续自己发言会确认 pending wake，即使 cursor 前仍有空洞也只清 debt、不吞消息 (#508)", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 10 }, d);
      saveStuck("dev", { seq: 12, attempts: 2, source: "watch" }, d);

      advanceCursorPastOwnMessage("dev", 15, d);

      expect(loadCursor("dev", d)).toBe(10);
      expect(loadStuck("dev", d)).toBeNull();
    });

    test("早于 pending wake 的乱序自发消息不能误清 debt (#508)", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 10 }, d);
      saveStuck("dev", { seq: 12, attempts: 1, source: "watch" }, d);

      advanceCursorPastOwnMessage("dev", 11, d);

      expect(loadCursor("dev", d)).toBe(11);
      expect(loadStuck("dev", d)).toEqual({ seq: 12, attempts: 1, source: "watch" });
    });

    test("自己发言不能误清 serve 的 runner delivery debt (#508)", () => {
      const d = cwd();
      writeState({ channel: "dev", cursor: 10 }, d);
      saveStuck("dev", { seq: 12, attempts: 1 }, d);

      advanceCursorPastOwnMessage("dev", 15, d);

      expect(loadCursor("dev", d)).toBe(10);
      expect(loadStuck("dev", d)).toEqual({ seq: 12, attempts: 1 });
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

  describe("④ cursor RMW 必须跨进程保持单调 (#364)", () => {
    test("barrier-released writers cannot overwrite a larger cursor", async () => {
      const root = cwd();
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      const rounds = 40;
      mkdirSync(workspace);
      const isolatedStatePath = join(home, "state", workspaceId(workspace), "state.json");
      mkdirSync(join(isolatedStatePath, ".."), { recursive: true });
      writeFileSync(isolatedStatePath, JSON.stringify({ channel: "dev", cursor: 0 }) + "\n");
      try {
        const values = Array.from({ length: 32 }, (_, index) => index + 1);
        const children = values.map((value) => {
          const readyPrefix = join(root, `ready-${value}`);
          const donePrefix = join(root, `done-${value}`);
          const goPrefix = join(root, "go");
          return {
            readyPrefix,
            donePrefix,
            child: Bun.spawn(
              [
                process.execPath,
                join(import.meta.dir, "fixtures", "cursor-writer.ts"),
                workspace,
                "dev",
                String(value),
                readyPrefix,
                goPrefix,
                donePrefix,
                String(rounds),
              ],
              { env: { ...process.env, AGENTPARTY_HOME: home }, stdout: "pipe", stderr: "pipe" },
            ),
          };
        });

        const observed: number[] = [];
        for (let round = 1; round <= rounds; round++) {
          while (!children.every(({ readyPrefix }) => existsSync(`${readyPrefix}-${round}`))) await Bun.sleep(1);
          writeFileSync(join(root, `go-${round}`), "go\n");
          while (!children.every(({ donePrefix }) => existsSync(`${donePrefix}-${round}`))) await Bun.sleep(1);
          const state = JSON.parse(readFileSync(isolatedStatePath, "utf8")) as { cursors?: Record<string, { cursor: number }> };
          observed.push(state.cursors?.dev?.cursor ?? 0);
        }
        const exitCodes = await Promise.all(children.map(({ child }) => child.exited));
        expect(exitCodes.every((code) => code === 0)).toBeTrue();
        expect(observed).toEqual(Array.from({ length: rounds }, (_, index) => (index + 1) * 1_000 + Math.max(...values)));
        expect(() => JSON.parse(readFileSync(isolatedStatePath, "utf8"))).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
