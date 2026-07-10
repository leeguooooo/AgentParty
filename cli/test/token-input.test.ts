// #111：token 只能经 argv 注入。
//
// 实测（macOS，本机）：
//   ps -axww -o command  → 直接读到 `--token ap_SECRET…`，同机任意用户可见
//   ~/.zsh_history       → `party init --token <T>` 原样落盘，18k 行里躺着
//
// argv 是进程的公共表面。token 不该出现在那里。
// 补两条通道：`AGENTPARTY_TOKEN` 环境变量，与 `--token -`（从 stdin 读）。
// 仍然支持 `--token <T>`（不破坏现有脚本），但必须**响亮地**告诉用户它会泄漏。
import { describe, expect, test } from "bun:test";
import { resolveTokenInput } from "../src/commands/init";
import { spawnHandoffHint } from "../src/commands/spawn";

const noStdin = async () => "";

describe("token 输入通道 (#111)", () => {
  test("--token - 从 stdin 读，argv 里只留一个 '-'", async () => {
    const warns: string[] = [];
    const token = await resolveTokenInput(
      { flagToken: "-", envToken: undefined, prevToken: undefined },
      { readStdin: async () => "ap_from_stdin\n", warn: (w) => warns.push(w) },
    );
    expect(token).toBe("ap_from_stdin"); // 尾部换行要吃掉
    expect(warns).toEqual([]); // 没有泄漏，不该警告
  });

  test("AGENTPARTY_TOKEN 环境变量可用，且不警告", async () => {
    const warns: string[] = [];
    const token = await resolveTokenInput(
      { flagToken: undefined, envToken: "ap_from_env", prevToken: undefined },
      { readStdin: noStdin, warn: (w) => warns.push(w) },
    );
    expect(token).toBe("ap_from_env");
    expect(warns).toEqual([]);
  });

  test("--token <T> 仍然能用，但必须响亮警告它会进 ps 和 shell history", async () => {
    const warns: string[] = [];
    const token = await resolveTokenInput(
      { flagToken: "ap_on_argv", envToken: undefined, prevToken: undefined },
      { readStdin: noStdin, warn: (w) => warns.push(w) },
    );
    expect(token).toBe("ap_on_argv");
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("ps");
    expect(warns[0]).toContain("AGENTPARTY_TOKEN"); // 告诉他们更好的姿势
    expect(warns[0]).not.toContain("ap_on_argv"); // 警告本身绝不能回显 token
  });

  test("显式 --token 优先于 env（脚本可覆盖）", async () => {
    const token = await resolveTokenInput(
      { flagToken: "ap_argv", envToken: "ap_env", prevToken: undefined },
      { readStdin: noStdin, warn: () => {} },
    );
    expect(token).toBe("ap_argv");
  });

  test("env 优先于已存在的 config（显式意图压过缓存）", async () => {
    const token = await resolveTokenInput(
      { flagToken: undefined, envToken: "ap_env", prevToken: "ap_prev" },
      { readStdin: noStdin, warn: () => {} },
    );
    expect(token).toBe("ap_env");
  });

  test("三者都没有时回退到已有 config", async () => {
    const token = await resolveTokenInput(
      { flagToken: undefined, envToken: undefined, prevToken: "ap_prev" },
      { readStdin: noStdin, warn: () => {} },
    );
    expect(token).toBe("ap_prev");
  });

  test("--token - 但 stdin 是空的 → 明确失败，而不是拿到空 token", async () => {
    const token = await resolveTokenInput(
      { flagToken: "-", envToken: undefined, prevToken: "ap_prev" },
      { readStdin: async () => "   \n", warn: () => {} },
    );
    expect(token).toBeNull(); // 不得静默回落到 prev：用户明确说了要从 stdin 读
  });

  test("空字符串 env 视为未设置（`export AGENTPARTY_TOKEN=` 是常见误操作）", async () => {
    const token = await resolveTokenInput(
      { flagToken: undefined, envToken: "", prevToken: "ap_prev" },
      { readStdin: noStdin, warn: () => {} },
    );
    expect(token).toBe("ap_prev");
  });
});

// spawn.ts 打印新铸 token 时，绝不能教用户把它写进 argv
describe("spawn 的交接姿势 (#111)", () => {
  test("handoff 提示用 stdin 通道，不教 --token <T>", () => {
    const line = spawnHandoffHint("https://x.example", "ap_new_token", "dev");
    // 必须教安全姿势
    expect(line).toContain("--token -");
    // 绝不能教危险姿势：token 明文紧跟在 --token 后面进 argv
    expect(line).not.toContain("--token ap_new_token");
    // token 本身仍要给出来（否则没法交接），但要走 stdin
    expect(line).toContain("ap_new_token");
    expect(line).toContain("ps");
  });
});
