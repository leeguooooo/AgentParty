// #1083 最后一块：宿主重载 MCP 配置时不收旧 server，旧的自己发现被同参数的新兄弟顶替就退出。
// 真机现场：一个 codex 会话名下 39 个 party MCP、597 MB，最老 4 小时。
import { describe, expect, test } from "bun:test";
import {
  findYoungerTwin,
  parseEtime,
  parsePsLine,
  supersededPollMs,
  watchSuperseded,
  type ProcessRow,
} from "../src/mcp-superseded";

const row = (pid: number, ppid: number, ageSeconds: number, command: string): ProcessRow => ({ pid, ppid, ageSeconds, command });

describe("parseEtime", () => {
  test("四种形态都认；坏的返回 null 而不是猜", () => {
    expect(parseEtime("00:39")).toBe(39);
    expect(parseEtime("02:10:33")).toBe(2 * 3600 + 10 * 60 + 33);
    expect(parseEtime("1-04:00:58")).toBe(24 * 3600 + 4 * 3600 + 58);
    expect(parseEtime("12-00:00:01")).toBe(12 * 86400 + 1);
    expect(parseEtime("")).toBeNull();
    expect(parseEtime("abc")).toBeNull();
    expect(parseEtime("1:2:3:4")).toBeNull();
  });
});

describe("parsePsLine", () => {
  test("pid ppid etime command，命令保留全部参数", () => {
    const r = parsePsLine("  7977 45506 36:04 party mcp --all-channels");
    expect(r).toEqual({ pid: 7977, ppid: 45506, ageSeconds: 36 * 60 + 4, command: "party mcp --all-channels" });
  });
  test("etime 解析不出的行丢弃", () => {
    expect(parsePsLine("1 2 ??? party mcp")).toBeNull();
  });
});

describe("findYoungerTwin —— 只认同宿主 + 同命令行 + 更年轻", () => {
  const me = row(100, 1, 600, "party mcp --all-channels");

  test("有更年轻的同名兄弟 ⇒ 返回最年轻那个", () => {
    const rows = [me, row(101, 1, 300, "party mcp --all-channels"), row(102, 1, 30, "party mcp --all-channels")];
    expect(findYoungerTwin(100, rows)?.pid).toBe(102);
  });

  test("兄弟都比我老 ⇒ null（我就是最新的，留下）", () => {
    const rows = [me, row(90, 1, 900, "party mcp --all-channels")];
    expect(findYoungerTwin(100, rows)).toBeNull();
  });

  test("不同宿主的同名进程不算", () => {
    expect(findYoungerTwin(100, [me, row(101, 2, 30, "party mcp --all-channels")])).toBeNull();
  });

  test("同宿主但命令行不同（插件那条 / 不同 --channel）不算", () => {
    const rows = [
      me,
      row(101, 1, 30, "/x/bin/agentparty-runtime mcp --all-channels"),
      row(102, 1, 30, "party mcp --channel king"),
      row(103, 1, 30, "party mcp"),
    ];
    expect(findYoungerTwin(100, rows)).toBeNull();
  });

  test("自己那行不在表里 ⇒ undefined（判不出，绝不误退）", () => {
    expect(findYoungerTwin(100, [row(101, 1, 30, "party mcp --all-channels")])).toBeUndefined();
  });
});

describe("watchSuperseded", () => {
  test("发现被顶替 ⇒ 打一行、terminate 一次、停止轮询", () => {
    let tick: (() => void) | null = null;
    let stopped = 0;
    const logs: string[] = [];
    let terminated = 0;
    let rows: ProcessRow[] = [row(100, 1, 600, "party mcp --all-channels")];
    watchSuperseded({
      label: "party mcp",
      selfPid: 100,
      list: () => rows,
      log: (l) => logs.push(l),
      terminate: () => void (terminated += 1),
      schedule: (fn) => {
        tick = fn;
        return { stop: () => void (stopped += 1) };
      },
    });
    tick!();
    expect(terminated).toBe(0); // 还没兄弟
    rows = [...rows, row(101, 1, 5, "party mcp --all-channels")];
    tick!();
    tick!();
    expect(terminated).toBe(1);
    expect(stopped).toBe(1);
    expect(logs[0]).toContain("pid=101");
    expect(logs[0]).toContain("顶替");
  });

  test("ps 抽风（空表）⇒ 不退", () => {
    let tick: (() => void) | null = null;
    let terminated = 0;
    watchSuperseded({
      label: "x",
      selfPid: 100,
      list: () => [],
      log: () => undefined,
      terminate: () => void (terminated += 1),
      schedule: (fn) => {
        tick = fn;
        return { stop: () => undefined };
      },
    });
    tick!();
    expect(terminated).toBe(0);
  });
});

describe("supersededPollMs", () => {
  test("缺省 60s；env 覆盖但不低于 200ms", () => {
    expect(supersededPollMs({})).toBe(60_000);
    expect(supersededPollMs({ AGENTPARTY_SUPERSEDED_POLL_MS: "1000" })).toBe(1000);
    expect(supersededPollMs({ AGENTPARTY_SUPERSEDED_POLL_MS: "5" })).toBe(60_000);
    expect(supersededPollMs({ AGENTPARTY_SUPERSEDED_POLL_MS: "x" })).toBe(60_000);
  });
});
