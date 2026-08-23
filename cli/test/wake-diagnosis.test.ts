// #924 第 4 条：终结静默失败。
//
// 之前解析不出唯一身份时只往日志写一行，用户看到的是「被 @ 了但什么都没弹」。本文件钉的是：
// 诊断必须**说出结论、说出原因、给出一条可执行命令**——三样缺一，就还是把问题推给用户。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeState, writeWorkspaceConfigOnly, type Config } from "../src/config";
import { joinBindingsPath, writeJoinBinding } from "../src/join-binding";
import { codexStopHookStatus, diagnoseCodexWake, formatCodexWakeDiagnosis, shouldSurfaceCodexWakeDiagnosis } from "../src/wake-diagnosis";

const CHANNEL = "agentparty";
const SERVER = "https://agentparty.pwtk-dev.work";

let home: string;
let cwd: string;
let saved: Record<string, string | undefined>;

function agentConfig(name: string, token: string): Config {
  return {
    server: SERVER,
    token,
    identity: {
      name,
      email: null,
      kind: "agent",
      role: "member",
      owner: "lark:on_owner",
      channel_scope: CHANNEL,
      verified_at: 1_700_000_000_000,
    },
  };
}

function writeAgent(name: string): string {
  const dir = join(home, "agents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agentparty-${name}-${CHANNEL}.json`);
  writeFileSync(path, JSON.stringify(agentConfig(name, `tok-${name}`)));
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-924-diag-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-924-diag-cwd-"));
  saved = {
    AGENTPARTY_HOME: process.env.AGENTPARTY_HOME,
    AGENTPARTY_CONFIG: process.env.AGENTPARTY_CONFIG,
    AGENTPARTY_CHANNEL: process.env.AGENTPARTY_CHANNEL,
  };
  process.env.AGENTPARTY_HOME = home;
  delete process.env.AGENTPARTY_CONFIG;
  delete process.env.AGENTPARTY_CHANNEL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("diagnoseCodexWake", () => {
  test("有绑定 → 说出会唤醒谁、依据是什么", () => {
    const path = writeAgent("codex-new");
    writeState({ channel: CHANNEL, cursor: 0 }, cwd);
    writeJoinBinding(joinBindingsPath(home), {
      harness: "codex",
      server: SERVER,
      channel: CHANNEL,
      owner: "lark:on_owner",
      identity: "codex-new",
      config_path: path,
      cwd,
      created_at: 1,
    });
    const d = diagnoseCodexWake(cwd, { AGENTPARTY_HOME: home, CODEX_HOME: join(home, "codex") });
    expect(d.identity).toBe("codex-new");
    expect(d.source).toBe("join-binding");
    const text = formatCodexWakeDiagnosis(d).join("\n");
    expect(text).toContain("codex-new");
    expect(text).toContain(CHANNEL);
  });

  test("同频道多身份、没有绑定 → 说出叫不醒、为什么、以及一条可执行命令", () => {
    for (const name of ["codex-a", "codex-b", "codex-c"]) writeAgent(name);
    writeWorkspaceConfigOnly(agentConfig("codex-a", "tok-codex-a"), cwd);
    writeState({ channel: CHANNEL, cursor: 0 }, cwd);
    const d = diagnoseCodexWake(cwd, { AGENTPARTY_HOME: home, CODEX_HOME: join(home, "codex") });
    expect(d.identity).toBe(null);
    expect(d.reason).toBe("ambiguous");
    expect(d.fix).toContain("party ");
    const lines = formatCodexWakeDiagnosis(d);
    const text = lines.join("\n");
    expect(text).toContain("叫不醒");
    expect(text).toContain("为什么");
    expect(text).toContain("怎么修");
    // 「加个提示告诉用户该怎么办」不算修好，但连提示都不给更不行——命令必须是可执行的一条。
    expect(lines.some((line) => line.includes("party mcp identities"))).toBe(true);
  });

  test("没绑频道 → 也给一条命令，不留「无可奉告」的出口", () => {
    const d = diagnoseCodexWake(cwd, { AGENTPARTY_HOME: home, CODEX_HOME: join(home, "codex") });
    expect(d.channel).toBe(null);
    expect(formatCodexWakeDiagnosis(d).join("\n")).toContain("party init --channel");
  });

  test("hook 没装是另一条独立的断点，必须单独说出来", () => {
    const path = writeAgent("codex-new");
    writeState({ channel: CHANNEL, cursor: 0 }, cwd);
    writeJoinBinding(joinBindingsPath(home), {
      harness: "codex",
      server: SERVER,
      channel: CHANNEL,
      owner: "lark:on_owner",
      identity: "codex-new",
      config_path: path,
      cwd,
      created_at: 1,
    });
    const codexHome = join(home, "codex");
    const withoutHook = formatCodexWakeDiagnosis(
      diagnoseCodexWake(cwd, { AGENTPARTY_HOME: home, CODEX_HOME: codexHome }),
    ).join("\n");
    expect(withoutHook).toContain("party hook install --codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(HOOKS_JSON));
    const withHook = formatCodexWakeDiagnosis(
      diagnoseCodexWake(cwd, { AGENTPARTY_HOME: home, CODEX_HOME: codexHome }),
    ).join("\n");
    expect(withHook).not.toContain("party hook install --codex");
  });
});

// 真机验收时撞到的第二个静默断点（codex 0.149 的 hook 信任闸）。owner 那台机器上
// 我们的 stop hook 就是 `enabled = false`——装了、但 codex 会静默跳过它。
// 「装了」和「会跑」必须是两个不同的判定，否则诊断会自信地说好、而用户永远醒不过来。
const HOOKS_JSON = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "party hook codex-report" }] }],
    Stop: [
      { hooks: [{ type: "command", command: "/some/other/tool --stop" }] },
      { hooks: [{ type: "command", command: '"/Users/x/.local/bin/party" hook codex-stop' }] },
    ],
  },
};

describe("codex hook 信任闸（装了 ≠ 会跑）", () => {
  let codexHome: string;
  beforeEach(() => {
    codexHome = join(home, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(HOOKS_JSON));
    writeState({ channel: CHANNEL, cursor: 0 }, cwd);
    // 身份解析得出 —— 让「该不该出声」只由 hook 状态决定。
    const bound = writeAgent("codex-bound");
    writeJoinBinding(joinBindingsPath(home), {
      harness: "codex", server: SERVER, channel: CHANNEL, owner: "lark:on_owner",
      identity: "codex-bound", config_path: bound, cwd, created_at: 1,
    });
  });

  const env = () => ({ AGENTPARTY_HOME: home, CODEX_HOME: codexHome });
  const trustKey = () => `${join(codexHome, "hooks.json")}:stop:1:0`;

  test("hooks.json 里没有我们的条目 → missing", () => {
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({ hooks: { Stop: [] } }));
    expect(codexStopHookStatus(env())).toBe("missing");
  });

  test("老版本 codex（config.toml 里根本没有信任表）→ ok，绝不喊狼来了", () => {
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.x]\ncommand = "y"\n');
    expect(codexStopHookStatus(env())).toBe("ok");
  });

  test("有信任表但没有我们那条 → needs-review（codex 会静默跳过未批准的 hook）", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      `[hooks.state."${join(codexHome, "hooks.json")}:stop:0:0"]\nenabled = true\n`,
    );
    expect(codexStopHookStatus(env())).toBe("needs-review");
  });

  test("我们那条被标成 enabled=false → disabled（owner 那台机器的真实状态）", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      `[hooks.state."${trustKey()}"]\ntrusted_hash = "sha256:deadbeef"\nenabled = false\n`,
    );
    expect(codexStopHookStatus(env())).toBe("disabled");
    const lines = formatCodexWakeDiagnosis(diagnoseCodexWake(cwd, env()));
    const text = lines.join("\n");
    expect(text).toContain("静默跳过");
    expect(text).toContain("怎么修");
  });

  // #926：who 只在「会不会跑」为否时才出声。此前判据用的是 hookInstalled（只排除 missing），
  // 于是信任闸没过的 disabled / needs-review 被当成正常 —— 而那正是 owner 那台的真实状态，
  // 也是最常见的断点。这条钉住「装了但不会跑时必须出声」。
  test("信任闸没过时 who 必须出声，不能因为「装了」就沉默", () => {
    const key = trustKey();
    for (const [state, expected] of [["false", "disabled"], ["missing", "needs-review"]] as const) {
      if (state === "false") {
        writeFileSync(join(codexHome, "config.toml"), `[hooks.state."${key}"]\ntrusted_hash = "sha256:deadbeef"\nenabled = false\n`);
      } else {
        // 信任表存在、但没有我们这条 ⇒ 还没被 review 过。
        // （config.toml 整个为空是另一回事：那表示这个 codex 版本没有信任闸，按设计判 ok。）
        writeFileSync(join(codexHome, "config.toml"), `[hooks.state."other.json:stop:0:0"]\ntrusted_hash = "sha256:beef"\nenabled = true\n`);
      }
      const d = diagnoseCodexWake(cwd, env());
      expect({ state, hook: d.hook }).toEqual({ state, hook: expected });
      // 身份必须是**解析得出**的：否则 `d.identity === null` 那一支单独就能让下面的断言成立，
      // 把被测的这道闸整个遮住（#884 那类「外层检查遮住内层闸」的假绿，本条正是这么踩出来的）。
      expect({ state, identity: d.identity }).toEqual({ state, identity: "codex-bound" });
      // 「装了」为真，但「会跑」为假 —— 判据必须跟后者走。
      expect({ state, installed: d.hookInstalled }).toEqual({ state, installed: true });
      expect({ state, surfaced: shouldSurfaceCodexWakeDiagnosis(d) }).toEqual({ state, surfaced: true });
    }
  });

  test("批准了 → ok", () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      `[hooks.state."${trustKey()}"]\ntrusted_hash = "sha256:deadbeef"\nenabled = true\n`,
    );
    expect(codexStopHookStatus(env())).toBe("ok");
  });
});
