// #1020 后续：release.sh 打 tag 前先等 main 上这条发布提交的 full check 出结论。
//
// 为什么要有这一步：release.yml 的 prior-green 只在「同一 commit 已在 main 跑绿」时跳过重复
// check，但原来推 commit 与推 tag 只差 10 秒，而 main 的 full check 要 3 分半——证据在探针下
// 结论之后才存在，优化恒不生效（v0.2.227 实测：探针 09:48:41 判 false，证据 09:51:17 才到）。
//
// 这里把四条出路逐条钉住。gh 用桩，不打真网络。
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

setDefaultTimeout(30_000);

const RELEASE_SH = join(import.meta.dir, "..", "scripts", "release.sh");

/** 只把 wait_for_main_full_check 抠出来跑，并按场景桩掉 gh。 */
function runWait(input: {
  runId: string;
  conclusion: string;
  env?: Record<string, string>;
}): { code: number; out: string } {
  const script = `
    set -uo pipefail
    eval "$(awk '/^wait_for_main_full_check\\(\\) \\{/,/^\\}/' "${RELEASE_SH}")"
    gh() {
      case "$*" in
        *"/runs?head_sha="*) printf '%s\\n' '${input.runId}' ;;
        *"/jobs?per_page=100"*) printf '%s\\n' '${input.conclusion}' ;;
      esac
    }
    wait_for_main_full_check deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 9.9.9
  `;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, RELEASE_MAIN_CHECK_INTERVAL: "1", RELEASE_MAIN_CHECK_TIMEOUT: "4", ...input.env },
  });
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` };
}

describe("release.sh 打 tag 前等 main 的 full check", () => {
  test("main 已绿 ⇒ 继续打 tag（tag 那次才跳得掉重复 check）", () => {
    const { code, out } = runWait({ runId: "12345", conclusion: "success" });
    expect(code).toBe(0);
    expect(out).toContain("main full check 已绿");
  });

  test("main 红 ⇒ 不打 tag，并给出修好后补 tag 的命令", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      const { code, out } = runWait({ runId: "12345", conclusion });
      // 绝不发布一个门禁红的版本
      expect(code).toBe(1);
      expect(out).toContain("**不打 tag**");
      expect(out).toContain(`full check = ${conclusion}`);
      // 版本提交已经在 main，所以修法是补 tag，不是回滚
      expect(out).toContain("git tag v9.9.9");
    }
  });

  test("查不到证据 ⇒ 超时后照常打 tag（fail-open 不削弱任何检查）", () => {
    // run 查不到：tag 那次的 prior-green 同样找不到证据，会把 check 全跑一遍，
    // 验证强度与没有这个优化时完全相同，只是没省到时间。
    const { code, out } = runWait({ runId: "", conclusion: "" });
    expect(code).toBe(0);
    expect(out).toContain("超时");
    expect(out).toContain("tag 那次会自己把 check 跑一遍");
  });

  test("RELEASE_SKIP_MAIN_WAIT=1 ⇒ 直接放行", () => {
    const { code, out } = runWait({
      runId: "12345",
      conclusion: "failure",
      env: { RELEASE_SKIP_MAIN_WAIT: "1" },
    });
    expect(code).toBe(0);
    expect(out).toContain("跳过等待 main full check");
  });

  test("证据只认 main 上的 push 运行", () => {
    const source = Bun.file(RELEASE_SH);
    expect(source).toBeDefined();
    const text = require("node:fs").readFileSync(RELEASE_SH, "utf8") as string;
    const fn = text.slice(text.indexOf("wait_for_main_full_check() {"), text.indexOf("\n}\n", text.indexOf("wait_for_main_full_check() {")));
    expect(fn).toContain('.event == "push" and .head_branch == "main"');
    expect(fn).toContain("head_sha=${sha}");
    expect(fn).toContain('select(.name == "full check")');
  });
});
