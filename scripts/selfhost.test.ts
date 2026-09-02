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

  // codex stop-time review：自托管脚本存在数据泄露与进程误杀风险。真机实测两条都成立：
  //   `ps -axww` 里明文躺着 ADMIN_SECRET（同机任何用户可读，而它能铸任意 token）；
  //   数据目录 0755、D1 库 0644，而 D1 里存着**所有 token**。
  describe("凭据与进程安全（codex review）", () => {
    const code = () => {
      const src = require("node:fs").readFileSync(script, "utf8") as string;
      return src.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    };

    test("secret 绝不进 argv —— 走 .dev.vars（0600），不走 --var", () => {
      const src = code();
      // `ps -axww` 是公共表面：同机任何用户都读得到
      expect(src).not.toMatch(/--var\s+"?ADMIN_SECRET/);
      expect(src).not.toMatch(/\$AGENTPARTY_ADMIN_SECRET"?\s*\\?\s*$/m);
      expect(src).toContain(".dev.vars");
      expect(src).toContain('chmod 600 "$vars"');
      expect(src).toContain("umask 077");
    });

    test("数据目录只给属主 —— 里面是 D1（所有 token）与频道全部内容", () => {
      const src = code();
      expect(src).toContain('chmod 700 "$DATA_DIR"');
      // 创建时就要收紧，不能先 0755 再补
      expect(src).toMatch(/umask 077; mkdir -p "\$DATA_DIR"/);
    });

    // 这条必须验**行为**：断言脚本里有 `ours()` 这几个字，挡不住「有定义但没调用」——
    // 第一版就是那样，变异（把判断改成 if false）照样全绿。
    test("pidfile 指向别人的进程 ⇒ 拒绝、且那个进程必须还活着", () => {
      const dir = mkdtempSync(join(tmpdir(), "agentparty-selfhost-stop-"));
      // 一个与我们无关的长命进程，模拟 pid 被系统复用后落到别人头上
      const victim = spawnSync("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
      const pid = (victim.stdout || "").trim();
      try {
        expect(pid).toMatch(/^[0-9]+$/);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "worker.pid"), pid);
        const r = spawnSync("sh", [script, "stop"], {
          env: { ...process.env, AGENTPARTY_SELFHOST_DATA: dir },
          encoding: "utf8",
        });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain("没有杀任何进程");
        // 最要紧的一条：那个无关进程必须还活着
        expect(spawnSync("kill", ["-0", pid]).status).toBe(0);
      } finally {
        if (/^[0-9]+$/.test(pid)) spawnSync("kill", [pid]);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("pidfile 里是个早已消失的 pid ⇒ 清掉即可，不报错也不杀人", () => {
      const dir = mkdtempSync(join(tmpdir(), "agentparty-selfhost-dead-"));
      try {
        writeFileSync(join(dir, "worker.pid"), "2147483646");
        const r = spawnSync("sh", [script, "stop"], {
          env: { ...process.env, AGENTPARTY_SELFHOST_DATA: dir },
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain("进程已不在");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("绝不 pkill（同机可能有别人的 workerd）", () => {
      expect(code()).not.toMatch(/\bpkill\b/);
    });

    test("两处创建数据目录都要收紧权限（少一处就等于漏一条路径）", () => {
      const src = code();
      expect(src.split('chmod 700 "$DATA_DIR"').length - 1).toBe(2);
      expect(src.split('umask 077; mkdir -p "$DATA_DIR"').length - 1).toBe(2);
    });

    test("pidfile 内容不是 pid ⇒ 拒绝并清掉，绝不拿它去 kill", () => {
      const src = code();
      expect(src).toMatch(/case "\$pid" in ''\|\*\[!0-9\]\*\)/);
    });
  });

  // 第三次栽在同一个坑上了：`$pid），` 里的全角括号会被 shell 吃进变量名，
  // 配上 `set -u` 就是 "unbound variable" —— 而且只有走到那条分支时才炸
  // （smoke 里有 4 处一直没被触发，等于埋着）。中文脚本里这是系统性风险，用守卫扫。
  test("变量后面紧跟非 ASCII 字符必须加花括号（否则 set -u 下会 unbound）", () => {
    const files = ["selfhost.sh", "selfhost-smoke.sh"];
    const offenders: string[] = [];
    for (const f of files) {
      const src = require("node:fs").readFileSync(resolve(import.meta.dir, f), "utf8") as string;
      src.split("\n").forEach((line, i) => {
        // $VAR 紧跟一个非 ASCII 字符（$ 后不是 { 也不是 (）
        if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
