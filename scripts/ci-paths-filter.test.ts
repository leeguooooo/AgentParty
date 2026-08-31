// #247 phase 2 + 并行门禁：release.yml 把 full check 拆成并行 per-workspace job，
// 并保留 paths-filter 让纯 CLI 的 PR 只跑 check:cli（秒级）。
//
// workflow 是最容易配错、且配错会「漏测但显示绿」的地方。这里守几个不变量：
//   1. required 门禁 job 名字仍是 "full check"（分支保护映射的就是它，改名=required check 消失=误合）
//   2. 快路径只由 changes.cli_only 决定，且 cli_only 是 fail-safe 的（要求 non_cli == false）
//   3. 非 PR（tag/main push）永不走快路径
//   4. 5 个 workspace（cli/worker/web/shared/scripts）都有人跑，且非 cli 的靠 cli_only 跳过
//   5. 聚合门禁把 workspace job 的 failure 变成自己失败，skipped 才算通过（漏配不漏测）
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const yml = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");

// 整行匹配一条 needs 依赖项——避免前缀误命中：`- check-cli` 不能被 `- check-cli-types`
// 满足，否则删了必需依赖测试仍绿、发布门禁失守（#723 CodeRabbit）。
function hasDep(block: string, dep: string): boolean {
  return new RegExp(`^\\s*- ${dep}\\s*$`, "m").test(block);
}

/** 截出一个 job 的片段（到下一个顶层 job 为止）——别用全局 yml 断言，别的 job 会让断言假通过。 */
function jobSlice(name: string): string {
  const start = yml.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`job ${name} not found in release.yml`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("release.yml 并行门禁 + CI 拆分不变量 (#247 phase 2)", () => {
  test('required 门禁 job 名字仍是 "full check"（改名会让分支保护的 required check 消失）', () => {
    expect(yml).toContain("name: full check");
  });

  test("cli_only 是 fail-safe 的：要求 PR 事件 + cli 变更 + 没有任何非 cli 变更", () => {
    // 三个条件缺一不可，否则快路径可能在不该走时走
    expect(yml).toContain("github.event_name == 'pull_request'");
    expect(yml).toContain("steps.filter.outputs.cli == 'true'");
    expect(yml).toContain("steps.filter.outputs.non_cli == 'false'");
  });

  test("paths-filter 的 non_cli 匹配 cli/ 之外的一切（任何非 cli 文件都翻回全量）", () => {
    expect(yml).toContain("non_cli:");
    expect(yml).toContain("'!cli/**'");
  });

  test("cli + web/shared/scripts 各自 check:* 都在 workflow 里（漏配某个 = 漏测该 workspace）", () => {
    // cli 分片：bun test --shard + 独立 tsc（替代原 `bun run check:cli` 串行）。
    expect(yml).toContain("bun test --shard=${{ matrix.shard }}/6");
    expect(yml).toContain("bunx tsc --noEmit");
    // web/shared/scripts 走 matrix：bun run check:${{ matrix.ws }}
    expect(yml).toContain("bun run check:${{ matrix.ws }}");
    expect(yml).toContain("ws: [web, shared, scripts]");
  });

  test("worker 测试按文件分片并行（vitest --shard），且 typecheck 单跑不漏", () => {
    // worker 是唯一长杆，拆 6 片；每片跑 vitest 的一个分片，tsc 单独一 job。
    expect(yml).toContain("bunx vitest run --shard=${{ matrix.shard }}/6");
    expect(yml).toContain("shard: [1, 2, 3, 4, 5, 6]");
    // worker 的 tsc 仍在（放独立 check-worker-types job，不进分片）
    expect(yml).toMatch(/check-worker-types:[\s\S]*?bunx tsc --noEmit/);
    // worker vitest 前的 runtime 预检仍在
    expect(yml).toContain("bun run verify:test-runtime");
  });

  test("非 cli workspace 靠 cli_only 跳过；Plugin gate 在 CLI 快路径仍运行", () => {
    expect(yml).toContain("if: needs.changes.outputs.cli_only != 'true'");
    const pluginJob = yml.slice(yml.indexOf("  check-plugin:\n"), yml.indexOf("  check-worker:\n"));
    expect(pluginJob).toContain('claude: ["2.1.154", "2.1.232"]');
    expect(pluginJob).toContain("bun scripts/sync-agentparty-plugin.ts --check");
    expect(pluginJob).toContain("plugin validate --strict plugins/agentparty");
    expect(pluginJob).toContain("verify-agentparty-plugin-install.ts --claude-package-version ${{ matrix.claude }}");
    // 只禁**job 级** if:（缩进 4 空格）——那才是「被 cli_only 拦住」的形态。
    // step 级 if: 是另一回事（prior-green 跳过重复 check），下面单独钉住它只能是那一个条件。
    expect(pluginJob).not.toMatch(/^ {4}if:/m);
  });

  test("check-cli 分片无条件跑 + tsc 单列（cli 在快路径与全量下都要测）", () => {
    // 截到各自 job 片段验证，别用全局 yml（否则别的 job 的命令也能让断言通过，#723 评审）。
    const cliJob = yml.slice(yml.indexOf("  check-cli:\n"), yml.indexOf("  check-cli-types:\n"));
    const cliTypesJob = yml.slice(yml.indexOf("  check-cli-types:\n"), yml.indexOf("  check-rest:\n"));
    expect(cliJob).toContain("name: check cli (shard");
    expect(cliJob).toContain("bun test --shard=${{ matrix.shard }}/6");
    expect(cliJob).toContain("shard: [1, 2, 3, 4, 5, 6]");
    expect(cliJob).toContain("working-directory: cli");
    expect(cliTypesJob).toContain("name: check cli (types)");
    expect(cliTypesJob).toContain("bunx tsc --noEmit");
    // 无条件跑：cli 在 cli_only 快路径下也要测，故两个 job 都不带**job 级** if: 门。
    expect(cliJob).not.toMatch(/^ {4}if:/m);
    expect(cliTypesJob).not.toMatch(/^ {4}if:/m);
  });

  test('聚合 "full check" needs 全部 workspace job（含 worker 分片与 types + desktop），且 if: always()', () => {
    expect(yml).toMatch(/check:\s*\n\s*name: full check/);
    // 限定在 check job 片段内，且把 check-desktop 一并纳入断言（漏了 desktop 依赖也该红，#723 评审）。
    const fullCheckJob = yml.slice(yml.indexOf("  check:\n"), yml.indexOf("  build:\n"));
    // changes 必进 needs：它挂了会让所有 check-* skipped（记作通过）= 全跳过全绿漏测（#723 CodeRabbit）。
    for (const dep of ["changes", "check-cli", "check-cli-types", "check-rest", "check-plugin", "check-worker", "check-worker-types", "check-desktop", "version-contract"]) {
      expect(hasDep(fullCheckJob, dep)).toBe(true);
    }
    // check-cli-types 与 changes 不仅进 needs，还要进失败判定（env + for 循环），否则挂了聚合仍绿。
    expect(fullCheckJob).toContain("R_CLI_TYPES: ${{ needs.check-cli-types.result }}");
    expect(fullCheckJob).toContain("R_PLUGIN: ${{ needs.check-plugin.result }}");
    expect(fullCheckJob).toContain("R_CHANGES: ${{ needs.changes.result }}");
    expect(fullCheckJob).toMatch(/for r in[\s\S]*"\$R_CLI_TYPES"/);
    expect(fullCheckJob).toMatch(/for r in[\s\S]*"\$R_PLUGIN"/);
    expect(fullCheckJob).toMatch(/for r in[\s\S]*"\$R_CHANGES"/);
    expect(fullCheckJob).toContain("if: always()");
  });

  test("聚合门禁把 failure/cancelled 变成自己失败，只有 success|skipped 通过（漏配不漏测）", () => {
    expect(yml).toContain("success|skipped");
    expect(yml).toContain("required check job did not pass");
  });

  test("build/desktop 解耦门禁：各只等相关 check，publish 经 build+desktop 传递闭包仍覆盖全部 check（全绿才发布）", () => {
    const buildJob = yml.slice(yml.indexOf("  build:\n"), yml.indexOf("  desktop:\n"));
    const desktopJob = yml.slice(yml.indexOf("  desktop:\n"), yml.indexOf("  release:\n"));
    const releaseJob = yml.slice(yml.indexOf("  release:\n"));
    // build（CLI 交叉编译）等非 desktop 的 check + 版本契约，不被最慢的 macOS check-desktop 拖住。
    for (const dep of ["check-cli", "check-cli-types", "check-rest", "check-plugin", "check-worker", "check-worker-types", "version-contract"]) {
      expect(hasDep(buildJob, dep)).toBe(true);
    }
    expect(hasDep(buildJob, "check-desktop")).toBe(false);
    // 整行负向断言：build 不得回归依赖聚合 check（否则解耦悄悄失效，又被最慢那个拖住）。
    expect(buildJob).not.toMatch(/^\s+- check\s*$/m);
    // desktop 只等 macOS check-desktop + 版本契约。
    expect(hasDep(desktopJob, "check-desktop")).toBe(true);
    expect(hasDep(desktopJob, "version-contract")).toBe(true);
    // 同样禁 desktop 回归依赖聚合 check 或 build（否则又被非桌面检查拖慢）。
    expect(desktopJob).not.toMatch(/^\s+- check\s*$/m);
    expect(desktopJob).not.toMatch(/^\s+- build\s*$/m);
    // publish（release）仍 needs build + desktop —— 传递闭包 = 全部 check，"全绿才发布"不变。
    expect(hasDep(releaseJob, "build")).toBe(true);
    expect(hasDep(releaseJob, "desktop")).toBe(true);
  });

  // ── 发版时跳过「同一 commit 已在 main 跑绿」的重复 check ──────────────
  // 这里钉住的是这套跳过**不会变成「没跑测试也发版」**：证据必须是同 SHA 的 full check success，
  // 跳过只发生在步骤层（job 结论与 needs 图不变），且校验 tag 本身的 version-contract 从不跳过。
  test("prior-green 只认同 SHA 的 full check success，且 fail-safe 默认全跑", () => {
    const job = yml.slice(yml.indexOf("  prior-green:\n"), yml.indexOf("  # ── #9 pre-merge"));
    expect(job).toContain("head_sha=$GITHUB_SHA");
    expect(job).toContain('select(.name == "full check")');
    expect(job).toContain("*success*) skip=true");
    // 不能把本次运行自己当证据
    expect(job).toContain('[ "$run_id" = "$GITHUB_RUN_ID" ] && continue');
    // 只认 main 上的 push：PR 运行的 head_sha 就是 PR 头 commit，而 PR 上的 full check
    // 可能走 cli_only 快路径（worker/web/shared/scripts 全 skip 也算绿）。拿那种绿当
    // 「跑过完整门禁」的证据，等于没测就发版。
    expect(job).toContain('[ "$meta" = "push main" ] || continue');
    expect(job).toContain("head_branch");
    // 只在 tag 上才可能跳过；默认值必须是 false（任何异常都退回全跑）
    expect(job).toContain('if [ "${GITHUB_REF_TYPE:-}" = "tag" ]');
    expect(job).toMatch(/skip=false\n/);
    // 读 run id 不靠变量分词（非 bash 下会把整串当一个元素），并显式 shell: bash
    expect(job).toContain("while IFS= read -r run_id");
    expect(job).toContain("shell: bash");
  });

  test("跳过只发生在步骤层：check job 的结论与 needs 图不变，version-contract 从不跳过", () => {
    const COND = "if: ${{ needs.prior-green.outputs.skip != 'true' }}";
    for (const name of [
      "check-cli", "check-cli-types", "check-rest", "check-plugin",
      "check-worker", "check-worker-types", "check-desktop",
    ]) {
      const job = jobSlice(name);
      expect(job).toContain("needs: [changes, prior-green]");
      expect(job).toContain(COND);
      // 每一条 step 级 if: 都只能是这个条件——别的条件混进来会悄悄改变门禁语义
      for (const line of job.split("\n").filter((l) => /^ {8}if:/.test(l))) {
        expect(line.trim()).toBe(COND);
      }
    }
    // tag 自身的校验（版本一致、不比 latest 旧）是 main 那次跑不出来的新信息，绝不能跳
    const versionContract = jobSlice("version-contract");
    expect(versionContract).toContain("needs: changes");
    expect(versionContract).not.toContain("prior-green");
    // 发布链的门禁不受影响：build/desktop 不认识 prior-green
    expect(jobSlice("build")).not.toContain("prior-green");
    expect(jobSlice("desktop")).not.toContain("prior-green");
  });
});
