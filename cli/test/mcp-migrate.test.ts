// #1083：老用户的自动迁移——一频道一注册 → 一条 `party mcp --all-channels`。
// 用例重点是失败关闭：任何一步失败都不能让用户处在「旧的删了、新的没加上」的空档。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpRegistration } from "../src/mcp-registry";
import {
  maybeAutoMigrate,
  migrateMarkerPath,
  migrationDone,
  planMcpMigrate,
  runMcpMigrate,
  writeMigrateMarkerForTest,
  type MigrateDeps,
} from "../src/commands/mcp-migrate";

const NOW = 1_800_000_000_000;

function reg(over: Partial<McpRegistration> & { name: string }): McpRegistration {
  return {
    scope: "user",
    command: "party",
    args: ["mcp", "--channel", "dev", "--identity", over.name],
    env: { AGENTPARTY_CONFIG: `/cfg/${over.name}.json` },
    harness: "codex",
    codexHome: "/home/.codex",
    ...over,
  };
}

interface Trace {
  defaults: [string, string, string][];
  removed: string[];
  added: string[];
}

function deps(
  registrations: McpRegistration[],
  over: Partial<MigrateDeps> & { servers?: Record<string, string | null> } = {},
): { deps: MigrateDeps; trace: Trace } {
  const trace: Trace = { defaults: [], removed: [], added: [] };
  const servers = over.servers ?? {};
  const d: MigrateDeps = {
    home: "/home",
    registrations: () => registrations,
    readServer: (p) => (p in servers ? servers[p]! : "https://s1"),
    recordDefault: (server, channel, path) => void trace.defaults.push([server, channel, path]),
    remove: (r) => {
      trace.removed.push(r.name);
      return { ok: true, detail: "" };
    },
    addSingle: (h) => {
      trace.added.push(h);
      return { ok: true, detail: "" };
    },
    now: () => NOW,
    ...over,
  };
  return { deps: d, trace };
}

describe("planMcpMigrate —— 只收「一频道一注册」的形状", () => {
  test("有 --channel + AGENTPARTY_CONFIG 且 config 读得出 server ⇒ 进 legacy", () => {
    const { deps: d } = deps([reg({ name: "party-a" }), reg({ name: "party-b", args: ["mcp", "--channel", "ops"] })]);
    const plan = planMcpMigrate(d);
    expect(plan.legacy.map((l) => [l.reg.name, l.channel])).toEqual([["party-a", "dev"], ["party-b", "ops"]]);
    expect(plan.skipped).toHaveLength(0);
  });

  test("裸 `party mcp`（没 --channel）不动——它靠 cwd 绑定工作，不是本次要收的", () => {
    const { deps: d } = deps([reg({ name: "party", args: ["mcp"] })]);
    const plan = planMcpMigrate(d);
    expect(plan.legacy).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain("--channel");
  });

  test("没 AGENTPARTY_CONFIG 的不动——不知道它用哪份身份，删了就丢身份", () => {
    const { deps: d } = deps([reg({ name: "party-x", env: {} })]);
    const plan = planMcpMigrate(d);
    expect(plan.legacy).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain("AGENTPARTY_CONFIG");
  });

  test("config 读不出（TMPDIR 被清）⇒ 跳过并指向 prune，不在这里删", () => {
    const { deps: d } = deps([reg({ name: "party-dead" })], { servers: { "/cfg/party-dead.json": null } });
    const plan = planMcpMigrate(d);
    expect(plan.legacy).toHaveLength(0);
    expect(plan.skipped[0]!.reason).toContain("prune");
  });

  test("已有 --all-channels 的 harness 记进 alreadySingle，且那条不算 legacy", () => {
    const { deps: d } = deps([reg({ name: "party", args: ["mcp", "--all-channels"], env: {} }), reg({ name: "party-a" })]);
    const plan = planMcpMigrate(d);
    expect([...plan.alreadySingle]).toEqual(["codex"]);
    expect(plan.legacy.map((l) => l.reg.name)).toEqual(["party-a"]);
  });

  test("不是 party 的注册一概不碰", () => {
    const { deps: d } = deps([reg({ name: "figma", command: "npx", args: ["figma-mcp"] })]);
    const plan = planMcpMigrate(d);
    expect(plan.legacy).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});

describe("runMcpMigrate —— 顺序与失败关闭", () => {
  test("正常路径：先记默认、再删旧、最后每个 harness 加一条；默认身份就是旧注册用的那份", () => {
    const { deps: d, trace } = deps([
      reg({ name: "party-a" }),
      reg({ name: "party-c", harness: "claude", codexHome: undefined, args: ["mcp", "--channel", "web"] }),
    ]);
    const lines: string[] = [];
    const r = runMcpMigrate(planMcpMigrate(d), d, (l) => lines.push(l));
    expect(r.code).toBe(0);
    expect(trace.defaults).toEqual([
      ["https://s1", "dev", "/cfg/party-a.json"],
      ["https://s1", "web", "/cfg/party-c.json"],
    ]);
    expect(trace.removed).toEqual(["party-a", "party-c"]);
    expect(trace.added.sort()).toEqual(["claude", "codex"]);
    expect(r.moved).toHaveLength(2);
  });

  test("记默认失败 ⇒ 那条不删（否则频道从「能用」变「歧义」）", () => {
    const { deps: d, trace } = deps([reg({ name: "party-a" })], {
      recordDefault: () => {
        throw new Error("disk full");
      },
    });
    const r = runMcpMigrate(planMcpMigrate(d), d, () => undefined);
    expect(trace.removed).toEqual([]);
    expect(r.failed[0]).toMatchObject({ step: "default" });
    expect(trace.added).toEqual([]); // 一条都没迁成，就不加新的
    expect(r.code).toBe(0);
  });

  test("已经有 --all-channels 的 harness 不重复加", () => {
    const { deps: d, trace } = deps([reg({ name: "party", args: ["mcp", "--all-channels"], env: {} }), reg({ name: "party-a" })]);
    const r = runMcpMigrate(planMcpMigrate(d), d, () => undefined);
    expect(r.code).toBe(0);
    expect(trace.removed).toEqual(["party-a"]);
    expect(trace.added).toEqual([]);
  });

  // 这条是整个模块最重要的断言：旧的删了、新的没加上 ⇒ 所有 agent 一起静默失联。必须非零退出、
  // 必须把手工命令印出来。
  test("新注册加不上 ⇒ 退出码非 0，并印出手工加回的命令", () => {
    const { deps: d } = deps([reg({ name: "party-a" })], {
      addSingle: () => ({ ok: false, detail: "codex: command not found" }),
    });
    const lines: string[] = [];
    const r = runMcpMigrate(planMcpMigrate(d), d, (l) => lines.push(l));
    expect(r.code).toBe(1);
    expect(r.addFailed[0]!.harness).toBe("codex");
    expect(lines.join("\n")).toContain("codex mcp add party -- party mcp --all-channels");
  });
});

describe("maybeAutoMigrate —— 一次性、失败限频、进程内路径不触发", () => {
  function home(): string {
    return mkdtempSync(join(tmpdir(), "ap-migrate-"));
  }

  test("有旧注册 ⇒ 迁移并写 done 标记；再调一次不再动", () => {
    const h = home();
    const { deps: d, trace } = deps([reg({ name: "party-a" })]);
    const errs: string[] = [];
    const first = maybeAutoMigrate("who", { deps: d, agentpartyHome: h, errlog: (l) => errs.push(l) });
    expect(first.ran).toBe(true);
    expect(trace.removed).toEqual(["party-a"]);
    expect(JSON.parse(readFileSync(migrateMarkerPath(h), "utf8")).status).toBe("done");
    expect(errs.join("\n")).toContain("下次新开的会话生效");
    expect(migrationDone(h)).toBe(true);

    const second = maybeAutoMigrate("who", { deps: d, agentpartyHome: h });
    expect(second.ran).toBe(false);
    expect(trace.removed).toEqual(["party-a"]); // 没再删
    rmSync(h, { recursive: true, force: true });
  });

  test("没有旧注册 ⇒ 写 nothing 标记，之后连注册表都不再读", () => {
    const h = home();
    let reads = 0;
    const { deps: d } = deps([], { registrations: () => (reads += 1, []) });
    expect(maybeAutoMigrate("who", { deps: d, agentpartyHome: h }).ran).toBe(false);
    expect(reads).toBe(1);
    maybeAutoMigrate("who", { deps: d, agentpartyHome: h });
    expect(reads).toBe(1);
    rmSync(h, { recursive: true, force: true });
  });

  test("mcp / hook / serve 这些进程内入口绝不触发", () => {
    const h = home();
    let reads = 0;
    const { deps: d } = deps([reg({ name: "party-a" })], { registrations: () => (reads += 1, [reg({ name: "party-a" })]) });
    for (const cmd of ["mcp", "hook", "serve", "daemon", "watch"]) {
      expect(maybeAutoMigrate(cmd, { deps: d, agentpartyHome: h }).ran).toBe(false);
    }
    expect(reads).toBe(0);
    rmSync(h, { recursive: true, force: true });
  });

  test("失败后 24h 内不再自动重试，过了再试", () => {
    const h = home();
    writeMigrateMarkerForTest(h, { status: "failed", at: NOW - 60_000 });
    const { deps: d, trace } = deps([reg({ name: "party-a" })]);
    expect(maybeAutoMigrate("who", { deps: d, agentpartyHome: h }).ran).toBe(false);
    expect(trace.removed).toEqual([]);

    writeMigrateMarkerForTest(h, { status: "failed", at: NOW - 25 * 60 * 60 * 1000 });
    expect(maybeAutoMigrate("who", { deps: d, agentpartyHome: h }).ran).toBe(true);
    rmSync(h, { recursive: true, force: true });
  });

  test("读注册表炸了（harness 没装 / 文件坏）⇒ 安静返回，不写标记，下次再看", () => {
    const h = home();
    const { deps: d } = deps([], {
      registrations: () => {
        throw new Error("boom");
      },
    });
    expect(maybeAutoMigrate("who", { deps: d, agentpartyHome: h }).ran).toBe(false);
    expect(migrationDone(h)).toBe(false);
    rmSync(h, { recursive: true, force: true });
  });
});

// owner 那台机器的真实情况：#bug-7744 与 #welcome 各有两条旧注册、两份不同身份。迁移时按顺序
// 写默认等于最后一条赢——那是替人选身份。这种频道不设默认，让 --all-channels 失败关闭并列候选。
describe("同一频道多份不同身份的旧注册 ⇒ 不设默认", () => {
  test("两份不同身份：都删、都不记默认、给一条提示；单身份的频道照常记", () => {
    const { deps: d, trace } = deps([
      reg({ name: "party-a1", args: ["mcp", "--channel", "dup"], env: { AGENTPARTY_CONFIG: "/cfg/a1.json" } }),
      reg({ name: "party-a2", args: ["mcp", "--channel", "dup"], env: { AGENTPARTY_CONFIG: "/cfg/a2.json" } }),
      reg({ name: "party-solo", args: ["mcp", "--channel", "solo"] }),
    ]);
    const lines: string[] = [];
    const r = runMcpMigrate(planMcpMigrate(d), d, (l) => lines.push(l));
    expect(r.code).toBe(0);
    expect(trace.removed.sort()).toEqual(["party-a1", "party-a2", "party-solo"]);
    expect(trace.defaults).toEqual([["https://s1", "solo", "/cfg/party-solo.json"]]);
    expect(lines.filter((l) => l.includes("不设默认"))).toHaveLength(1);
  });

  test("两条旧注册指向**同一份**身份（重复注册）⇒ 不算多身份，照常记默认", () => {
    const { deps: d, trace } = deps([
      reg({ name: "party-x", args: ["mcp", "--channel", "dup"], env: { AGENTPARTY_CONFIG: "/cfg/same.json" } }),
      reg({ name: "party-y", args: ["mcp", "--channel", "dup"], env: { AGENTPARTY_CONFIG: "/cfg/same.json" } }),
    ]);
    runMcpMigrate(planMcpMigrate(d), d, () => undefined);
    expect(trace.defaults.map((x) => x[1])).toEqual(["dup", "dup"]);
  });
});
