// codex stop-time review on #1036：`claude` 是我们交出去、还会自己再 spawn 一堆东西的外部进程，
// 本机凭据没有任何理由跟着它走。上游（party claude）已经在最早时机把 AGENTPARTY_TOKEN 摘出环境，
// 这里是纵深防御：上游哪天忘了摘，这一层也不漏。
import { describe, expect, test } from "bun:test";
import {
  claudeSpawnEnv,
  probeInstalledClaudePlugin,
  runClaudePluginUpdate,
  type PluginSpawn,
} from "../src/claude-plugin-sync";

describe("spawn claude 时摘掉凭据（纵深防御）", () => {
  test("claudeSpawnEnv 只删 AGENTPARTY_TOKEN，其余环境原样保留", () => {
    const env = claudeSpawnEnv({ AGENTPARTY_TOKEN: "ap_secret", PATH: "/usr/bin", HOME: "/h" });
    expect(env.AGENTPARTY_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/h");
  });

  test("plugin list / plugin update 两处 spawn 都拿不到 token", () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const spawn = ((_cmd: string, _args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      seen.push(opts.env);
      return { status: 0, stdout: "[]", stderr: "", error: undefined };
    }) as unknown as PluginSpawn;

    const before = process.env.AGENTPARTY_TOKEN;
    process.env.AGENTPARTY_TOKEN = "ap_secret";
    try {
      probeInstalledClaudePlugin(spawn);
      runClaudePluginUpdate(spawn);
    } finally {
      if (before === undefined) delete process.env.AGENTPARTY_TOKEN;
      else process.env.AGENTPARTY_TOKEN = before;
    }
    expect(seen).toHaveLength(2);
    for (const env of seen) expect(env?.AGENTPARTY_TOKEN).toBeUndefined();
  });
});
