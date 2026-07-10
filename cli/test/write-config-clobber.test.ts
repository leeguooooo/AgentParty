// #104：writeConfig 双写**无条件覆盖**全局 config.json。
//
// `party init` 覆盖全局是有意的（既有契约：「init 一次，跨目录可用」，config.test.ts:84）。
// 真正的伤害来自那些**只想刷新一下 identity 缓存**的路径：`party whoami`、`statusline`。
// 它们读到本目录的身份，然后把全局也一起换掉——用户只是跑了句 whoami，
// 所有靠全局回落的目录就改用了另一个身份，甚至打到另一台 server 上。
// statusline 更隐蔽：它在后台定时跑。
//
// 症状（我在 #agentparty 频道亲历）：`task not found`、`board` 显示 0 tasks、
// history 里出现一堆陌生对话。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  refreshConfigInPlace,
  workspaceConfigPath,
  workspaceId,
  statePath,
  slugifyBasename,
  loadCursor,
  saveCursor,
  writeConfig,
  type Config,
} from "../src/config";
import { startRestMock } from "./rest-mock";

let home = "";
const dirs: string[] = [];
const prevHome = process.env.AGENTPARTY_HOME;
const prevExplicit = process.env.AGENTPARTY_CONFIG;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-home-"));
  dirs.push(home);
  process.env.AGENTPARTY_HOME = home;
  delete process.env.AGENTPARTY_CONFIG;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = prevHome;
  if (prevExplicit !== undefined) process.env.AGENTPARTY_CONFIG = prevExplicit;
  else delete process.env.AGENTPARTY_CONFIG;
});

function ws(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-ws-"));
  dirs.push(d);
  return d;
}
function cfg(name: string, token = `ap_${name}`): Config {
  return {
    server: "https://a.example",
    token,
    identity: { name, email: null, kind: "agent", role: "agent", owner: null, channel_scope: null, verified_at: 1 },
  };
}

describe("刷新 identity 缓存不得动全局回落身份 (#104)", () => {
  test("whoami/statusline 式刷新：本目录有 workspace 身份时，只写 workspace，全局纹丝不动", () => {
    const fallbackDir = ws(); // 从没 init 过，永远读全局
    const dirB = ws();

    writeConfig(cfg("alice"), ws()); // 第一次 init：全局 = alice
    writeConfig(cfg("bob"), dirB); // 第二次 init：显式意图，全局 = bob（既有契约）
    writeConfig(cfg("alice"), ws()); // 再 init 回 alice，全局 = alice

    expect(readConfig(fallbackDir)?.identity?.name).toBe("alice");

    // 现在在 dirB 里跑 `party whoami`：它只想把 identity 缓存刷新一下
    refreshConfigInPlace({ ...cfg("bob"), token: "ap_bob_refreshed" }, dirB);

    // dirB 自己更新了
    expect(readConfig(dirB)?.token).toBe("ap_bob_refreshed");
    // 但全局回落身份绝不能因此从 alice 变成 bob
    expect(readConfig(fallbackDir)?.identity?.name).toBe("alice");
  });

  test("回落目录里刷新：不得凭空给它创建 workspace config（那会把回落身份钉死）", () => {
    const fallbackDir = ws();
    writeConfig(cfg("alice"), ws()); // 全局 = alice

    // 在回落目录跑 whoami：local 来自全局
    refreshConfigInPlace({ ...cfg("alice"), token: "ap_alice_refreshed" }, fallbackDir);

    // 全局被就地刷新（它就是读到的那个来源）
    expect(readConfig(fallbackDir)?.token).toBe("ap_alice_refreshed");
    // 但不该给这个目录新建 workspace config
    expect(existsSync(workspaceConfigPath(fallbackDir))).toBe(false);
  });

  test("AGENTPARTY_CONFIG 显式路径：只写那个文件，不碰全局", () => {
    const explicit = join(home, "explicit.json");
    writeConfig(cfg("alice"), ws()); // 全局 = alice

    process.env.AGENTPARTY_CONFIG = explicit;
    writeConfig(cfg("carol"), ws());
    refreshConfigInPlace({ ...cfg("carol"), token: "ap_carol_refreshed" }, ws());
    delete process.env.AGENTPARTY_CONFIG;

    expect(readConfig(ws())?.identity?.name).toBe("alice"); // 全局仍是 alice
  });

  test("既有契约不变：party init 仍然写全局（init 一次，跨目录可用）", () => {
    writeConfig(cfg("alice"), ws());
    expect(readConfig(ws())?.identity?.name).toBe("alice");
    writeConfig(cfg("bob"), ws());
    expect(readConfig(ws())?.identity?.name).toBe("bob"); // 显式 init 覆盖，这是有意的
  });
});

// M2 的洞：完全没有任何 config 时，刷新不该凭空造一个
describe("无来源时不刷新 (#104)", () => {
  test("没有任何 config：refreshConfigInPlace 不创建任何文件", () => {
    const d = ws();
    refreshConfigInPlace(cfg("ghost"), d);
    expect(existsSync(workspaceConfigPath(d))).toBe(false);
    expect(readConfig(d)).toBeNull();
  });
});

// M3 的洞：光有 refreshConfigInPlace、没接进 whoami / statusline，等于没修。
// 这几条驱动**真实命令**，断言全局回落身份没被动过。
describe("whoami / statusline 接线 (#104)", () => {
  test("在 workspace 身份是 bob 的目录跑 whoami，全局回落身份仍是 alice", async () => {
    const mock = startRestMock((req) => {
      if (req.path === "/api/me") {
        return Response.json({ name: "bob", kind: "agent", role: "agent", email: null, owner: null });
      }
      return undefined;
    });
    const cwdBefore = process.cwd();
    try {
      const fallbackDir = ws();
      const dirB = ws();
      const withServer = (name: string): Config => ({ ...cfg(name), server: mock.url });

      writeConfig(withServer("alice"), ws()); // 全局 = alice
      expect(readConfig(fallbackDir)?.identity?.name).toBe("alice");

      // dirB 只写 workspace（模拟它自己 init 过 bob，但之后 alice 又 init 过一次）
      writeConfig(withServer("bob"), dirB);
      writeConfig(withServer("alice"), ws()); // 全局回到 alice
      expect(readConfig(fallbackDir)?.identity?.name).toBe("alice");

      process.chdir(dirB);
      const { run: whoami } = await import("../src/commands/whoami");
      await whoami(["--json"]);

      process.chdir(cwdBefore);
      // whoami 只刷新了 dirB 的 workspace config；全局绝不能被换成 bob
      expect(readConfig(fallbackDir)?.identity?.name).toBe("alice");
    } finally {
      process.chdir(cwdBefore);
      mock.stop();
    }
  });
});

// 上面那条接线测试第一次跑是红的，红的原因不是接线错了，而是这个：
//
// 造一对指向同一真实目录的路径：一条经 symlink、一条是 realpath。
// 不依赖「/tmp 恰好是 symlink」（macOS 成立、Linux CI 不成立 —— 第一版就是这样在 CI 挂的）。
function symlinkedDir(): { via: string; real: string } {
  const real = ws(); // 真实目录
  const link = mkdtempSync(join(tmpdir(), "ap-lnk-")) + "-link";
  dirs.push(link);
  symlinkSync(real, link); // link → real
  return { via: join(link), real: realpathSync(real) };
}

describe("workspaceId 必须先 realpath (#104 的另一半)", () => {
  test("同一目录经 symlink 路径访问，得到同一个 workspaceId", () => {
    const { via, real } = symlinkedDir();
    expect(realpathSync(via)).toBe(real); // 两条路径指向同一真实目录
    expect(via).not.toBe(real); // 但字符串不同
    expect(workspaceId(via)).toBe(workspaceId(real));
  });

  test("cd 进 symlink 路径后，仍能读到自己的 workspace config，而不是静默回落全局", () => {
    const fallbackDir = ws();
    const { via } = symlinkedDir();
    writeConfig(cfg("alice"), ws()); // 全局 = alice
    writeConfig(cfg("bob"), via); // 经 symlink 写 workspace = bob
    writeConfig(cfg("alice"), ws()); // 全局回到 alice

    // 用 realpath 形式访问同一个目录：必须仍读到 bob，不能回落到全局的 alice
    expect(readConfig(realpathSync(via))?.identity?.name).toBe("bob");
    expect(readConfig(fallbackDir)?.identity?.name).toBe("alice");
  });
});

// leo-claude 在频道 seq 530 指出的合并顺序炸弹：realpath 改变 workspaceId →
// 已有 workspace 的游标被当成陌生 workspace 从 0 开始 → serve/watch 重放整个积压。
// serve 有 #193 的 skip-backlog 兜底，**但 watch --once 没有**：游标归 0 后
// 每次唤醒只消费一条，要烧掉几百次唤醒才追得上。
// 与其靠兜底，不如从根上拆掉：一次性把旧 workspaceId 的状态搬过来，游标根本不重置。
describe("realpath 后不得丢掉旧 workspaceId 的游标 (#104 迁移)", () => {
  test("旧路径哈希下的 state 会被一次性迁移到 realpath 哈希下", () => {
    const { via: d, real } = symlinkedDir(); // d 经 symlink，real 是真实路径
    expect(d).not.toBe(real);

    // 造一份「realpath 修复之前」写下的 state：目录名是 symlink 路径的哈希
    const legacyId = `${slugifyBasename(basename(d))}-${createHash("sha256").update(d).digest("hex").slice(0, 16)}`;
    const legacyDir = join(home, "state", legacyId);
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "state.json"), JSON.stringify({ channel: "dev", cursor: 512 }));

    // 修复之后：statePath 用 realpath 哈希，目录名不同
    expect(statePath(d)).not.toContain(legacyId);

    // 但游标必须还在 512，不能归 0（否则 watch --once 要烧 512 次唤醒才追上）
    expect(loadCursor("dev", d)).toBe(512);
  });

  test("迁移是幂等的：新目录已存在时不覆盖它（顺序很重要，先有新的再出现旧的）", () => {
    const d = ws();
    // 先让当前 workspace 有一个更新的游标（这一步内部就会跑一次迁移，此时没有 legacy）
    saveCursor("dev", 999, d);
    expect(loadCursor("dev", d)).toBe(999);

    // 之后才出现一个旧哈希目录（比如用户从旧版本的另一台机器同步过来）
    const legacyId = `${slugifyBasename(basename(d))}-${createHash("sha256").update(d).digest("hex").slice(0, 16)}`;
    mkdirSync(join(home, "state", legacyId), { recursive: true });
    writeFileSync(join(home, "state", legacyId, "state.json"), JSON.stringify({ channel: "dev", cursor: 111 }));

    // 绝不能被旧的 111 覆盖回去——那会让游标倒退，重放已处理过的 mention
    expect(loadCursor("dev", d)).toBe(999);
  });
});
