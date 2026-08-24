import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #945 之后第二次踩：release.sh 实际总在临时 worktree 里跑（主仓工作树常年脏，
// 干净树检查过不去），而 worktree 是 detached HEAD。`git push origin main` 推的是
// **本地 main 引用**——它还停在 bump 之前，于是 git 打印 "Everything up-to-date"
// 并以 0 退出，脚本继续往下走，tag 推上去了、版本提交没进 main。线上 /api/version
// 与 tag 从此对不上，只能事后人工补推。这组用例把「按 SHA 推 + 推完核实」钉住。
const releaseScript = readFileSync(join(import.meta.dir, "release.sh"), "utf8");

describe("release.sh 推送目标", () => {
  test("不按分支名推 main——detached HEAD 下那是一条静默空推", () => {
    expect(releaseScript).not.toMatch(/^\s*git push origin main\s*$/m);
  });

  test("按 HEAD 推到 refs/heads/main", () => {
    expect(releaseScript).toContain('git push origin "HEAD:refs/heads/main"');
  });

  test("推完核实 origin/main 真的指向这条发布提交", () => {
    const verify = releaseScript.slice(releaseScript.indexOf('git push origin "HEAD:refs/heads/main"'));
    expect(verify).toContain("git fetch origin main --quiet");
    expect(verify).toMatch(/\[\[ "\$\(git rev-parse FETCH_HEAD\)" == "\$RELEASE_SHA" \]\]/);
  });

  test("tag 在 main 落地之后才打——main 没推成就不留悬空 tag", () => {
    const pushMainAt = releaseScript.indexOf('git push origin "HEAD:refs/heads/main"');
    const tagAt = releaseScript.indexOf('git tag "$TAG"');
    expect(pushMainAt).toBeGreaterThan(0);
    expect(tagAt).toBeGreaterThan(pushMainAt);
  });

  // 版本提交已在本地、没进 main 时，本地状态已经不可重跑（基线校验挡下 +
  // bump 无 diff 导致空提交）。所以恢复指引不能是一句「排查后重跑」。
  test("推送没落地时不给出「排查后重跑」这种走不通的指引", () => {
    const code = releaseScript
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toContain("排查后重跑");
    expect(code).toContain("abort_unpushed_release");
  });

  test("发版前把基线钉在 origin/main 上", () => {
    const preflight = releaseScript.slice(0, releaseScript.indexOf("同步 package 版本到"));
    expect(preflight).toContain("git fetch origin main --quiet");
    expect(preflight).toMatch(/BASE_SHA.*==.*REMOTE_MAIN_SHA|\$BASE_SHA" == "\$REMOTE_MAIN_SHA/);
  });
});
