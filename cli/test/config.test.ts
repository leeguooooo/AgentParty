import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  bindWorkspaceConfigPointer,
  loadCursor,
  readConfig,
  readConfigWithSource,
  readState,
  resolveChannel,
  saveCursor,
  slugifyBasename,
  statePath,
  tokenFingerprint,
  workspaceId,
  writeConfig,
  writeState,
} from "../src/config";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-test-"));
  process.env.AGENTPARTY_HOME = home;
});

afterEach(() => {
  delete process.env.AGENTPARTY_HOME;
  delete process.env.AGENTPARTY_CONFIG;
  rmSync(home, { recursive: true, force: true });
});

describe("config", () => {
  test("read returns null when missing", () => {
    expect(readConfig()).toBeNull();
  });

  test("write/read roundtrip", () => {
    writeConfig({ server: "https://ap.example.com", token: "ap_x" });
    expect(readConfig()).toEqual({ server: "https://ap.example.com", token: "ap_x" });
  });

  test("readConfigWithSource reports workspace source and safe fingerprint", () => {
    const cwd = "/tmp/project-source";
    writeConfig({ server: "https://ap.example.com", token: "ap_secret_token" }, cwd);
    const resolved = readConfigWithSource(cwd);
    expect(resolved.config).toEqual({ server: "https://ap.example.com", token: "ap_secret_token" });
    expect(resolved.source).toMatchObject({
      kind: "workspace",
      path: join(home, "state", workspaceId(cwd), "config.json"),
      workspace_id: workspaceId(cwd),
      token_fingerprint: tokenFingerprint("ap_secret_token"),
    });
    expect(JSON.stringify(resolved.source)).not.toContain("ap_secret_token");
  });

  test("readConfigWithSource reports explicit global and none", () => {
    expect(readConfigWithSource("/tmp/missing").source).toMatchObject({ kind: "none", path: null });

    writeConfig({ server: "https://ap.example.com", token: "ap_global" }, "/tmp/has-global");
    const global = readConfigWithSource("/tmp/other");
    expect(global.source.kind).toBe("global");
    expect(global.source.path).toBe(join(home, "config.json"));

    process.env.AGENTPARTY_CONFIG = join(home, "explicit.json");
    writeConfig({ server: "https://ap.example.com", token: "ap_explicit" });
    const explicit = readConfigWithSource("/tmp/other");
    expect(explicit.source.kind).toBe("explicit");
    expect(explicit.source.path).toBe(join(home, "explicit.json"));
    expect(explicit.source.token_fingerprint).toBe(tokenFingerprint("ap_explicit"));
  });

  test("workspace configs isolate by cwd; global is the cross-dir fallback", () => {
    const a = "/tmp/proj-a";
    const b = "/tmp/proj-b";
    writeConfig({ server: "s", token: "ap_a" }, a);
    writeConfig({ server: "s", token: "ap_b" }, b);
    // 各目录读回自己的 token——同机多 session 不再互相覆盖串号
    expect(readConfig(a)).toEqual({ server: "s", token: "ap_a" });
    expect(readConfig(b)).toEqual({ server: "s", token: "ap_b" });
    // 无 workspace 配置的目录回退到全局（= 最近一次 init 的 ap_b），保「init 一次跨目录可用」
    expect(readConfig("/tmp/proj-c")).toEqual({ server: "s", token: "ap_b" });
  });

  test("AGENTPARTY_CONFIG pins config and cursor state for same-cwd agents", () => {
    const cwd = "/tmp/shared-worktree";
    const configA = join(home, "agent-a.json");
    const configB = join(home, "agent-b.json");

    process.env.AGENTPARTY_CONFIG = configA;
    writeConfig({ server: "s", token: "ap_a" }, cwd);
    writeState({ channel: "agentparty", cursor: 10 }, cwd);
    expect(readConfig(cwd)).toEqual({ server: "s", token: "ap_a" });
    expect(statePath(cwd)).toBe(join(home, "agent-a.json.state", "state.json"));
    expect(readState(cwd)).toEqual({ channel: "agentparty", cursor: 10 });

    process.env.AGENTPARTY_CONFIG = configB;
    writeConfig({ server: "s", token: "ap_b" }, cwd);
    writeState({ channel: "agentparty", cursor: 3 }, cwd);
    expect(readConfig(cwd)).toEqual({ server: "s", token: "ap_b" });
    expect(statePath(cwd)).toBe(join(home, "agent-b.json.state", "state.json"));
    expect(readState(cwd)).toEqual({ channel: "agentparty", cursor: 3 });

    process.env.AGENTPARTY_CONFIG = configA;
    expect(readConfig(cwd)).toEqual({ server: "s", token: "ap_a" });
    expect(readState(cwd)).toEqual({ channel: "agentparty", cursor: 10 });
  });
});

describe("workspace id", () => {
  test("slugify basename", () => {
    expect(slugifyBasename("My_Dir 2")).toBe("my-dir-2");
    expect(slugifyBasename("herness-use")).toBe("herness-use");
    expect(slugifyBasename("中文目录")).toBe("workspace");
  });

  test("id = <basename-slug>-<sha256(cwd) first 16 hex>", () => {
    const cwd = "/Users/leo/github.com/My Project";
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    expect(workspaceId(cwd)).toBe(`my-project-${hash}`);
  });

  test("state path lives under AGENTPARTY_HOME/state/<id>/state.json", () => {
    const cwd = "/tmp/abc";
    expect(statePath(cwd)).toBe(join(home, "state", workspaceId(cwd), "state.json"));
  });
});

describe("workspace state", () => {
  const cwd = "/tmp/project-x";

  test("state roundtrip + cursor helpers", () => {
    expect(readState(cwd)).toBeNull();
    writeState({ channel: "dev", cursor: 7 }, cwd);
    expect(readState(cwd)).toEqual({ channel: "dev", cursor: 7 });
    expect(loadCursor("dev", cwd)).toBe(7);
    expect(loadCursor("other", cwd)).toBe(0);
  });

  test("saveCursor only advances bound channel monotonically", () => {
    writeState({ channel: "dev", cursor: 5 }, cwd);
    saveCursor("dev", 9, cwd);
    expect(loadCursor("dev", cwd)).toBe(9);
    saveCursor("dev", 3, cwd);
    expect(loadCursor("dev", cwd)).toBe(9);
    saveCursor("other", 42, cwd);
    expect(readState(cwd)).toEqual({ channel: "dev", cursor: 9 });
  });

  test("resolveChannel prefers explicit over bound", () => {
    writeState({ channel: "dev", cursor: 0 }, cwd);
    expect(resolveChannel(undefined, cwd)).toBe("dev");
    expect(resolveChannel("ops", cwd)).toBe("ops");
    expect(resolveChannel(undefined, "/tmp/unbound")).toBeNull();
  });

  test("breadcrumb recovers the agent config after AGENTPARTY_CONFIG is lost (issue #42)", () => {
    const cfgPath = join(home, "agent-cfg.json");
    // 建立轮：有 env，写隔离 config + cwd 面包屑
    process.env.AGENTPARTY_CONFIG = cfgPath;
    writeConfig({ server: "https://agentparty.leeguoo.com", token: "ap_AGENT" }, cwd);
    bindWorkspaceConfigPointer(cfgPath, "dev", cwd);
    // 回复轮：env 蒸发（模拟 Claude 新 Bash）——workspace/global 都空，靠面包屑找回 agent token
    delete process.env.AGENTPARTY_CONFIG;
    const r = readConfigWithSource(cwd);
    expect(r.config?.token).toBe("ap_AGENT");
    expect(r.source.kind).toBe("explicit");
    expect(r.source.path).toBe(cfgPath);
  });

  test("breadcrumb pointing to a deleted config yields no config (not a stale one)", () => {
    bindWorkspaceConfigPointer(join(home, "gone.json"), "dev", cwd);
    delete process.env.AGENTPARTY_CONFIG;
    expect(readConfigWithSource(cwd).config).toBeNull();
  });
});
