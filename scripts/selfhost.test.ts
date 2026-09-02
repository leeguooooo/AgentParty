// 内网自部署脚本的预检（scripts/selfhost.sh）。
//
// 这条预检是整个脚本存在的首要理由：真机（AlmaLinux 9 + Node 16）实测的失败形态是
// **服务照常启动、端口照常 LISTEN、请求零字节零报错永远挂住**——workerd 通过回环调用
// supervisor 取绑定，而 supervisor 在旧 Node 上不工作且不报错。那个形态几乎不可能自己查出来。
//
// 所以这里钉的是：**旧 Node 必须被响亮地拒绝**，而不是让人撞上静默挂起。
// 预检本身只用 POSIX sh —— 它必须在「Node 太旧」的机器上照样能跑，不能反过来依赖 node/bun。
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve(import.meta.dir, "selfhost.sh");

/** 造一个假 repo：假 node（版本可控）+ 可选的 web 产物。 */
function sandbox(nodeVersion: string | null, withDist = true): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "agentparty-selfhost-"));
  mkdirSync(join(dir, "bin"), { recursive: true });
  if (nodeVersion !== null) {
    const fake = join(dir, "bin", "node");
    writeFileSync(fake, `#!/bin/sh\n[ "$1" = "-v" ] && { printf '%s\\n' "${nodeVersion}"; exit 0; }\nexit 0\n`);
    chmodSync(fake, 0o755);
  }
  if (withDist) {
    mkdirSync(join(dir, "web", "dist"), { recursive: true });
    writeFileSync(join(dir, "web", "dist", "index.html"), "<html></html>");
  }
  return { dir, env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir } };
}

/** 在假 repo 里跑预检：把脚本复制进去，让它把该 repo 当根。 */
function preflight(nodeVersion: string | null, withDist = true) {
  const { dir, env } = sandbox(nodeVersion, withDist);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  const copy = join(dir, "scripts", "selfhost.sh");
  writeFileSync(copy, require("node:fs").readFileSync(script, "utf8"));
  chmodSync(copy, 0o755);
  const r = spawnSync("sh", [copy, "preflight"], { env, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe("自部署预检（#selfhost）", () => {
  test("Node 16 必须被拒绝，并说清楚那个静默挂起的形态", () => {
    const r = preflight("v16.20.2");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Node 版本太低");
    // 不能只说「版本低」——要说清症状，否则人照样会去撞
    expect(r.out).toContain("零字节");
    expect(r.out).toContain("永远挂住");
    // 还要给出可照做的修法
    expect(r.out).toContain("nodejs.org/dist");
  });

  test("Node 18 / 20 同样拒绝（wrangler 的 engines 写死 >= 22）", () => {
    for (const v of ["v18.20.0", "v20.11.0", "v21.7.3"]) {
      expect(preflight(v).status).not.toBe(0);
    }
  });

  test("Node 22 / 24 放行", () => {
    for (const v of ["v22.0.0", "v22.14.0", "v24.1.0"]) {
      const r = preflight(v);
      expect(r.status).toBe(0);
      expect(r.out).toContain("预检通过");
    }
  });

  test("没有 node ⇒ 拒绝，且不是崩溃", () => {
    const r = preflight(null);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("找不到 node");
  });

  test("node -v 输出不可解析 ⇒ 拒绝（不能当成通过）", () => {
    const r = preflight("not-a-version");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("读不出 node 版本");
  });

  test("web 没构建 ⇒ 拒绝并给出构建命令（含旧 Node 的那条）", () => {
    const r = preflight("v22.14.0", false);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("web 还没构建");
    expect(r.out).toContain("bun --bun x vite build");
  });

  /**
   * 只看**可执行**的那部分：注释与报错文案里出现 `bun` / `pkill` 是正常的
   * （文案本来就要教人用 bun 构建、注释本来就要写「绝不 pkill」）。
   * 第一版断言直接扫全文，结果匹配到了注释——那种用例挡不住真问题，只会挡住自己。
   */
  const code = () => {
    const src = require("node:fs").readFileSync(script, "utf8") as string;
    return src
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
  };

  test("预检只用 POSIX sh：不许起 node/bun 来判断能不能用 node", () => {
    // 它必须在「Node 太旧」的机器上照样跑得起来。用 node 写版本比较＝鸡生蛋。
    const src = code();
    const preflightFn = src.slice(src.indexOf("preflight() {"), src.indexOf("wrangler_js() {"));
    expect(preflightFn).not.toMatch(/\bnode\s+-e\b/);
    expect(preflightFn).not.toMatch(/\bnode\s+-p\b/);
    // 唯一允许的 node 调用是取版本
    expect(preflightFn).toContain("node -v");
    // 不许 spawn bun（文案里提到 bun 是可以的，那只是给人看的建议）
    expect(preflightFn).not.toMatch(/^\s*bun\s/m);
  });

  test("stop 只杀自己的进程树，不许 pkill（同机可能有别人的 workerd）", () => {
    const src = code();
    expect(src).not.toMatch(/\bpkill\b/);
    expect(src).toContain("$PIDFILE");
  });
});
