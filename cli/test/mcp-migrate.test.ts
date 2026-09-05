// #1083：老用户的自动迁移——一频道一注册 → 一条 `party mcp --all-channels`。
// 用例重点是失败关闭：任何一步失败都不能让用户处在「旧的删了、新的没加上」的空档。
// 注册表在夹具里是**可变的**：迁移的每一步都要读回验证，不信 harness CLI 的退出码
//（codex stop-time review on f5c7bfc：不带 scope 的 `claude mcp remove` 在别的目录里
// 找不到名字也返回 0，上一版把 26 条一条没删却全报了 ✓）。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpRegistration, RegistrationHarness } from "../src/mcp-registry";
import {
  isMachineWideSingle,
  maybeAutoMigrate,
  migrateMarkerPath,
  migrationDone,
  planMcpMigrate,
  runMcpMigrate,
  writeMigrateMarkerForTest,
  type MigrateDeps,
} from "../src/commands/mcp-migrate";

const NOW = 1_800_000_000_000;
const GLOBAL_CODEX = "/home/.codex";

function reg(over: Partial<McpRegistration> & { name: string }): McpRegistration {
  return {
    scope: "/home/.codex/config.toml",
    command: "party",
    args: ["mcp", "--channel", "dev", "--identity", over.name],
    env: { AGENTPARTY_CONFIG: `/cfg/${over.name}.json` },
    harness: "codex",
    codexHome: GLOBAL_CODEX,
    ...over,
  };
}

/** 已经加好的、覆盖整台机器的单条注册。 */
function single(harness: RegistrationHarness, over: Partial<McpRegistration> = {}): McpRegistration {
  return harness === "codex"
    ? reg({ name: "party", args: ["mcp", "--all-channels"], env: {}, ...over })
    : reg({ name: "party", args: ["mcp", "--all-channels"], env: {}, harness: "claude", scope: "user", codexHome: undefined, ...over });
}

interface Trace {
  defaults: [string, string, string][];
  removed: string[];
  added: RegistrationHarness[];
  /** 记录调用顺序：add / remove 交错的先后。 */
  order: string[];
}

interface Knobs extends Partial<MigrateDeps> {
  servers?: Record<string, string | null>;
  /** addSingle 是否真的把单注册放进注册表（缺省放进 user/global）。 */
  addLands?: "global" | "project" | "none";
  /** remove 返回 ok 但实际不删（模拟 scope 没对上的 `claude mcp remove`）。 */
  removeLies?: boolean;
}

function deps(initial: McpRegistration[], knobs: Knobs = {}): { deps: MigrateDeps; trace: Trace; registry: McpRegistration[] } {
  const registry = [...initial];
  const trace: Trace = { defaults: [], removed: [], added: [], order: [] };
  const servers = knobs.servers ?? {};
  const { servers: _s, addLands, removeLies, ...over } = knobs;
  const d: MigrateDeps = {
    home: "/home",
    globalCodexHome: GLOBAL_CODEX,
    registrations: () => [...registry],
    readServer: (p) => (p in servers ? servers[p]! : "https://s1"),
    recordDefault: (server, channel, path) => void trace.defaults.push([server, channel, path]),
    remove: (r) => {
      trace.removed.push(r.name);
      trace.order.push(`remove:${r.name}`);
      if (removeLies !== true) {
        const i = registry.findIndex((x) => x.scope === r.scope && x.name === r.name && (x.harness ?? "claude") === (r.harness ?? "claude"));
        if (i !== -1) registry.splice(i, 1);
      }
      return { ok: true, detail: "" };
    },
    addSingle: (h) => {
      trace.added.push(h);
      trace.order.push(`add:${h}`);
      const lands = addLands ?? "global";
      if (lands === "global") registry.push(single(h));
      if (lands === "project") registry.push(single(h, h === "codex" ? { scope: "/proj/.codex/config.toml", codexHome: "/proj/.codex" } : { scope: "/proj" }));
      return { ok: true, detail: "" };
    },
    now: () => NOW,
    ...over,
  };
  return { deps: d, trace, registry };
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

  test("user/global 的 --all-channels 记进 alreadySingle；只在 local/project 的不算覆盖", () => {
    const { deps: d } = deps([single("codex"), reg({ name: "party-a" })]);
    expect([...planMcpMigrate(d).alreadySingle]).toEqual(["codex"]);

    const projectOnly = single("claude", { scope: "/some/project" });
    const { deps: d2 } = deps([projectOnly, reg({ name: "party-c", harness: "claude", scope: "/some/project", codexHome: undefined })]);
    const plan = planMcpMigrate(d2);
    expect(plan.alreadySingle.size).toBe(0);
    expect(plan.skipped[0]!.reason).toContain("local/project");
    expect(isMachineWideSingle(projectOnly, GLOBAL_CODEX)).toBe(false);
    expect(isMachineWideSingle(single("claude"), GLOBAL_CODEX)).toBe(true);
    expect(isMachineWideSingle(single("codex", { codexHome: "/proj/.codex" }), GLOBAL_CODEX)).toBe(false);
  });

  test("不是 party 的注册一概不碰", () => {
    const { deps: d } = deps([reg({ name: "figma", command: "npx", args: ["figma-mcp"] })]);
    const plan = planMcpMigrate(d);
    expect(plan.legacy).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});

describe("runMcpMigrate —— 先加后删、读回验证", () => {
  test("正常路径：每个 harness 先加单注册并读回确认，再记默认、再删旧；默认身份就是旧注册用的那份", () => {
    const { deps: d, trace, registry } = deps([
      reg({ name: "party-a" }),
      reg({ name: "party-c", harness: "claude", scope: "/proj/web", codexHome: undefined, args: ["mcp", "--channel", "web"] }),
    ]);
    const r = runMcpMigrate(planMcpMigrate(d), d, () => undefined);
    expect(r.code).toBe(0);
    expect(trace.added.sort()).toEqual(["claude", "codex"]);
    expect(trace.removed.sort()).toEqual(["party-a", "party-c"]);
    // 先加后删：每个 add 都排在所有 remove 前面
    const firstRemove = trace.order.findIndex((x) => x.startsWith("remove:"));
    expect(trace.order.slice(0, firstRemove).every((x) => x.startsWith("add:"))).toBe(true);
    expect(trace.defaults).toEqual([
      ["https://s1", "dev", "/cfg/party-a.json"],
      ["https://s1", "web", "/cfg/party-c.json"],
    ]);
    // 迁完注册表里只剩两条 user/global 的单注册
    expect(registry.map((x) => x.name)).toEqual(["party", "party"]);
    expect(r.moved).toHaveLength(2);
  });

  // 整个模块最重要的断言：单注册加不上 ⇒ 该 harness 的旧注册一条都不删，非零退出，印手工命令。
  test("单注册加不上 ⇒ 一条旧注册都不删、退出码非 0、印出手工加回的命令（含 --scope user）", () => {
    const { deps: d, trace } = deps(
      [reg({ name: "party-a" }), reg({ name: "party-c", harness: "claude", scope: "/proj", codexHome: undefined })],
      { addSingle: (h) => (h === "claude" ? { ok: false, detail: "claude: command not found" } : (trace.added.push(h), { ok: true, detail: "" })) },
    );
    // codex 那边 addSingle 被覆盖后不会把单注册放进注册表 ⇒ 读回也不在 ⇒ 同样按失败处理
    const lines: string[] = [];
    const r = runMcpMigrate(planMcpMigrate(d), d, (l) => lines.push(l));
    expect(r.code).toBe(1);
    expect(trace.removed).toEqual([]);
    expect(lines.join("\n")).toContain("claude mcp add --scope user party -- party mcp --all-channels");
    expect(lines.join("\n")).toContain("codex mcp add party -- party mcp --all-channels");
  });

  test("addSingle 返回 0 但读回只在 project scope ⇒ 按没加上处理，不删旧", () => {
    const { deps: d, trace } = deps([reg({ name: "party-a" })], { addLands: "project" });
    const r = runMcpMigrate(planMcpMigrate(d), d, () => undefined);
    expect(r.code).toBe(1);
    expect(r.addFailed[0]!.detail).toContain("不在 user/global scope");
    expect(trace.removed).toEqual([]);
  });

  test("remove 返回 0 但注册还在 ⇒ 记为删除失败，不算迁走", () => {
    const { deps: d } = deps([reg({ name: "party-a" })], { removeLies: true });
    const lines: string[] = [];
    const r = runMcpMigrate(planMcpMigrate(d), d, (l) => lines.push(l));
    expect(r.code).toBe(0); // 单注册加上了，用户没失联；只是旧的多留了一个进程
    expect(r.moved).toEqual([]);
    expect(r.failed[0]).toMatchObject({ step: "remove" });
    expect(r.failed[0]!.detail).toContain("还在");
    expect(lines.join("\n")).toContain("仍保留");
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
    expect(r.code).toBe(0);
  });

  test("已经有 user/global 的 --all-channels ⇒ 不重复加，直接删旧", () => {
    const { deps: d, trace } = deps([single("codex"), reg({ name: "party-a" })]);
    const r = runMcpMigrate(planMcpMigrate(d), d, () => undefined);
    expect(r.code).toBe(0);
    expect(trace.added).toEqual([]);
    expect(trace.removed).toEqual(["party-a"]);
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
    expect(trace.removed).toEqual(["party-a"]);
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
    const { deps: d } = deps([], { registrations: () => (reads += 1, [reg({ name: "party-a" })]) });
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
