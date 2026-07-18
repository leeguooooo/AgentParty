// #629：party board / channel role list / host board / squad list 都把服务端存的参与者可控自由文本
// 打到终端。这些字段必须先过 stripTerminalControls（同 #372 的消息路径），否则攻击者塞进
// OSC52 / CSI / 清屏序列，就能在受害者终端上劫持剪贴板、伪造或隐藏输出。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChannelSquad, TaskRecord } from "@agentparty/shared";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatTask } from "../src/commands/board";
import { run as hostRun } from "../src/commands/host";
import { run as channelRun } from "../src/commands/channel";
import { formatSquad } from "../src/commands/squad";

// 典型注入载荷：ESC[2J 清屏 + OSC 改标题栏 + OSC52 写剪贴板 + BEL；再塞 \n（伪造整行）+ \t（伪造列）。
// #652：stripTerminalControls 特意保留 \t\n（formatMsg 的多行结构靠它们），故单行 list/table 字段必须额外
// 折叠残留 TAB/换行，否则服务端可控文本能在受害者终端上多打一行或多分一列。折叠后 FORGED-ROW/FORGED-COL
// 应落在同一行、以单空格分隔。
const PAYLOAD = "\x1b[2J\x1b]0;pwned\x07\x1b]52;c;cHduZWQ=\x07\nFORGED-ROW\tFORGED-COL legit";

// 剥离干净 = 不残留任何 ESC(\x1b) / BEL(\x07) / CR(\x0d) / C1 等控制字节。可见文本 "legit" 应保留。
function expectNoControls(rendered: string): void {
  // eslint-disable-next-line no-control-regex
  expect(rendered).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  expect(rendered).toContain("legit");
}

// #652：单行渲染必须把字段里残留的 \t\n 折叠掉——断言没有裸换行（无伪造行）、TAB 数恰好等于可信列分隔符
// 数量（无伪造列），且被折叠的 FORGED-ROW/FORGED-COL 落在同一行以空格分隔。
function expectSingleLine(rendered: string, trustedTabs: number): void {
  expect(rendered).not.toContain("\n");
  expect((rendered.match(/\t/g) ?? []).length).toBe(trustedTabs);
  expect(rendered).toContain("FORGED-ROW FORGED-COL");
}

// #652：e2e 里逐个 console.log 元素都不该含裸换行——否则字段里的 \n 会把一行渲染拆成伪造的多行。
function expectNoForgedRows(lines: string[]): void {
  for (const line of lines) expect(line).not.toContain("\n");
}

function task(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    type: "task",
    id: 1,
    channel: "dev",
    title: "t",
    desc: null,
    state: "assigned",
    assignee: { name: "worker", kind: "agent" },
    created_by: "creator",
    created_by_kind: "agent",
    priority: 2,
    labels: [],
    parent_id: null,
    anchor_seqs: [],
    scope: [],
    blocked_reason: null,
    external_ref: null,
    completion_artifact: null,
    workflow_id: null,
    created_at: 0,
    updated_at: 0,
    completed_at: null,
    ...overrides,
  };
}

describe("#629 terminal control-sequence stripping", () => {
  test("board formatTask strips control sequences from the task title", () => {
    const rendered = formatTask(task({ id: 7, title: PAYLOAD }));
    expectNoControls(rendered);
    expect(rendered).toContain("#7");
    expectSingleLine(rendered, 0); // #652：board 行无可信 TAB，字段里的 \n/\t 全部折叠成空格
  });

  test("board formatTask strips control sequences from labels", () => {
    const rendered = formatTask(task({ id: 8, title: "clean", labels: [PAYLOAD] }));
    expectNoControls(rendered);
    expectSingleLine(rendered, 0); // #652：label 里的 \n/\t 不能伪造行/列
  });

  test("squad formatSquad strips control sequences from the squad title and members", () => {
    const squad: ChannelSquad = {
      type: "squad",
      channel: "dev",
      name: "team",
      title: PAYLOAD,
      description: null,
      leader: null,
      members: ["a", PAYLOAD],
      created_by: "creator",
      created_by_kind: "agent",
      created_at: 0,
      updated_at: 0,
    };
    const rendered = formatSquad(squad);
    expectNoControls(rendered);
    expect(rendered).toContain("@team");
    // #652：formatSquad 用 2 个可信 TAB 分列；title/members 里的 \n/\t 折叠后列数/行数不变。
    expectSingleLine(rendered, 2);
  });
});

// host board / channel role list 的渲染在 run() 内部（printBoard / role list 分支），不是纯函数，
// 用 host.test.ts 已有的模式：起本地 mock server + 写 config，跑 run() 后断言 stdout 已被剥离。
describe("#629 e2e: host board and channel role list strip control sequences", () => {
  let home: string;
  let oldHome: string | undefined;
  let restServer: ReturnType<typeof Bun.serve> | null = null;
  const originalLog = console.log;
  const originalError = console.error;
  let stdout: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ap-esc-"));
    oldHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    mkdirSync(home, { recursive: true });
    stdout = [];
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stdout.push(args.join(" "));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.AGENTPARTY_HOME;
    else process.env.AGENTPARTY_HOME = oldHome;
    console.log = originalLog;
    console.error = originalError;
    restServer?.stop(true);
    restServer = null;
  });

  function serve(handler: (url: URL) => Response): void {
    restServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler(new URL(req.url)) });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${restServer.port}`, token: "ap_tok" }),
    );
  }

  test("host board strips control sequences from blocked_reason and scope", async () => {
    serve((url) => {
      if (url.pathname.endsWith("/presence")) return Response.json({ presence: [] });
      if (url.pathname.endsWith("/tasks")) {
        return Response.json({
          tasks: [
            task({ id: 41, state: "blocked", assignee: null, blocked_reason: PAYLOAD }),
            task({ id: 42, state: "in_progress", scope: [PAYLOAD] }),
          ],
        });
      }
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ seq: 42 }] });
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    });
    const code = await hostRun(["board", "dev", "--since", "0"]);
    expect(code).toBe(0);
    const joined = stdout.join("\n");
    expect(joined).toContain("#41"); // blocker line present
    expect(joined).toContain("task #42"); // open-claim line present
    expectNoControls(joined);
    // #652：blocked_reason / scope 里的 \n 不能把一行渲染拆成伪造的多行。
    expectNoForgedRows(stdout);
  });

  test("channel role list strips control sequences from responsibility", async () => {
    serve((url) => {
      if (url.pathname.endsWith("/roles")) {
        return Response.json({
          roles: [
            {
              name: "worker",
              role: "worker",
              responsibility: PAYLOAD,
              assigned_by: "host",
              assigned_at: 0,
            },
          ],
        });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    });
    const code = await channelRun(["role", "list", "dev"]);
    expect(code).toBe(0);
    const joined = stdout.join("\n");
    expect(joined).toContain("worker");
    expectNoControls(joined);
    // #652：单条 role 只渲染一行，responsibility 里的 \n 不能伪造额外行，\t 不能伪造额外列。
    expect(stdout.length).toBe(1);
    expectNoForgedRows(stdout);
    expect((stdout[0].match(/\t/g) ?? []).length).toBe(4); // name\trole\tassigned_by\tISO\tresponsibility
  });
});
