// #908 端到端：真起进程、真 kill 宿主，钉住本次故障形态。
//
// 「测试全绿真机是坏的」在这条链上已经连续八次（#884/#898/#906…），所以这个文件不 mock
// 任何东西：真的 spawn 一个宿主，真的让宿主拉起 `party claude-channel`，真的 kill 宿主，
// 然后断言子进程自己没了、注册条目被回收。
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerClaudeSession, listClaudeSessions, CLAUDE_SESSION_REGISTRY_DIR_ENV } from "../src/claude-session-registry";

const PARENT_LIVENESS = join(import.meta.dir, "..", "src", "parent-liveness.ts");
const POLL_MS = 200;

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) {
    try { fn(); } catch { /* 尽力而为 */ }
  }
});

/**
 * 「这个 pid 还在跑吗」。
 *
 * `kill(pid, 0)` 对**僵尸**返回成功——进程已经死了、只是还没被父进程收尸。本用例里
 * host 正是测试进程的直接子进程，SIGKILL 之后到被回收之间必然有一段僵尸窗口，
 * 光看 `kill(pid,0)` 会把「已经死了」读成「还活着」，让 `waitFor("host is gone")`
 * 白等到超时。所以拿到信号后再用 ps 核一次状态，`Z` 一律当死。
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM＝进程在、只是不归我们管（这里不会发生，保守当活着）。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  const res = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  const stat = (res.stdout ?? "").trim();
  // ps 拿不到（超时/不可用/进程刚没）时不擅自判死：只有明确看到 Z 才算死。
  if (stat === "") return res.status === 0;
  return !stat.startsWith("Z");
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/** 从 ps 里找出命令行里带某个标记的进程 pid。 */
function findPids(marker: string, extra = ""): number[] {
  const res = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const out: number[] = [];
  for (const line of (res.stdout ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(line);
    if (m === null) continue;
    if (m[2]!.includes(marker) && m[2]!.includes(extra)) out.push(Number(m[1]));
  }
  return out;
}

/**
 * 收尾杀进程**必须先复核身份**：pid 一旦退出就可能被系统立刻复用，照着记下来的 pid 无脑
 * SIGKILL 会打到同一轮测试里别的进程头上（实测把同 shard 的 watch 用例打成了
 * 「parent process is gone」）。只杀命令行里仍然带着本用例唯一标记的那个。
 */
function killIfStillOurs(pid: number, marker: string): void {
  if (!findPids(marker).includes(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* 刚好没了 */ }
}

/**
 * 抹掉注释。不求语法级精确（那要上 AST），只要能挡住「注释里提到函数名就算接上了」这类假绿。
 * `[^:]` 是为了别把 `https://` 里的双斜杠当成行注释起点。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** 在去注释的基础上再抹掉字符串字面量——查「调用」时用，免得字符串里的同名文本混进来。 */
function stripCommentsAndStrings(source: string): string {
  return stripComments(source)
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
    .replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, '""')
    .replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, '""');
}

describe("#908 宿主死亡 ⇒ 子进程退场（端到端）", () => {
  test("宿主 pid 被 kill 后，挂了存活探测的子进程自行退出", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-orphan-e2e-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    // 唯一标记必须落在**命令行**上（ps 看得到的只有 command，看不到环境变量），否则
    // 「ps 里已经没有它了」这条断言会永远空转成真。这里把它当探针脚本的位置参数传下去。
    const marker = `e2e-orphan-${String(process.pid)}-${String(Date.now())}`;
    const probeScript = join(dir, "probe.ts");
    // 子进程用**探针**而不是真的 `party claude-channel`：announce 在没有可解析身份时会立刻
    // 正常退出（本机有 65 份配置所以它活着，CI 里一份都没有所以它秒退），拿它当被试会让
    // 「宿主活着时子进程不该退」这条前置断言在 CI 上必然失败——那是环境差异，不是产品缺陷。
    // 探针直接调用被测的那段逻辑，于是这条用例只依赖「真进程 + 真 kill + 真存活探测」。
    // `claude-channel` / `mcp` 确实接上了这段逻辑，由下面那条接线守卫负责钉住。
    writeFileSync(
      probeScript,
      `import { watchParentLiveness } from ${JSON.stringify(PARENT_LIVENESS)};\n` +
      `watchParentLiveness({ label: "e2e-probe" });\n` +
      `setInterval(() => {}, 1000);\n`,
      "utf8",
    );
    const hostScript = join(dir, "host.ts");
    writeFileSync(
      hostScript,
      // 宿主：拉起探针子进程后就一直活着，等着被我们 kill。子进程 stdio 全部丢弃，
      // 这样「宿主死了 ⇒ 子进程退出」只可能来自父进程存活探测，不可能是 stdin EOF 的功劳。
      `import { spawn } from "node:child_process";\n` +
      `const child = spawn(process.execPath, ["run", ${JSON.stringify(probeScript)}, ${JSON.stringify(marker)}], {\n` +
      `  stdio: "ignore",\n` +
      `});\n` +
      `console.log("child " + String(child.pid));\n` +
      `setInterval(() => {}, 1000);\n`,
      "utf8",
    );

    let hostOut = "";
    const host: ChildProcess = spawn(process.execPath, ["run", hostScript], {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        // 端到端要在秒级内看到结果，不能等默认的 30s。
        AGENTPARTY_PARENT_LIVENESS_POLL_MS: String(POLL_MS),
      },
    });
    host.stdout?.on("data", (chunk: Buffer) => { hostOut += chunk.toString(); });
    const hostPid = host.pid!;
    cleanup.push(() => killIfStillOurs(hostPid, hostScript));

    await waitFor("host reports its child pid", () => /child \d+/.test(hostOut));
    const childPid = Number(/child (\d+)/.exec(hostOut)![1]);
    cleanup.push(() => killIfStillOurs(childPid, marker));
    // 必须先在 ps 里看到它（证明标记确实落在命令行上，后面那条「ps 里没有了」才有意义）。
    await waitFor("probe child is visible in ps", () => findPids(marker).includes(childPid));

    // 前置断言：宿主活着的时候，子进程绝不能自己退——否则这条闸门是「恒杀」，
    // 后面那条断言就毫无意义了（#884 的教训：守卫自己会假阴性）。
    await Bun.sleep(POLL_MS * 5);
    expect(alive(childPid)).toBe(true);

    // 故障形态本身：宿主会话被 kill（-9，不给它任何清理机会，就像真的崩了）。
    process.kill(hostPid, "SIGKILL");
    await waitFor("host is gone", () => !alive(hostPid));

    await waitFor("orphaned child exits by itself", () => !alive(childPid), 30_000);
    expect(alive(childPid)).toBe(false);
    // ps 里也不该再有它。
    expect(findPids(marker)).toEqual([]);
  }, 60_000);

  // 上面那条端到端只证明「存活探测本身管用」。它用探针当被试，所以**不会**发现
  // 「`claude-channel` / `mcp` 根本没调用它」这种接线漏掉的情况——那正是 #908 的故障本体。
  // 这条守卫补上那一半：两个命令必须真的调用 watchParentLiveness。
  // 用标识符边界匹配而不是子串：#871 的守卫曾因 `superseded` 是 `superseded_by` 的子串而
  // 假阴性，删掉真正的校验依然全绿。
  test("claude-channel 与 mcp 都真的接上了宿主存活探测（接线守卫）", () => {
    for (const rel of ["commands/claude-channel.ts", "commands/mcp.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", "src", rel), "utf8");
      // 注释和字符串里出现同名文本不算数——本文件上方的说明文字就提到了这个函数名。
      // 「断言被说明文案独自满足」正是 #864 那类假绿的成因，守卫自己更不能犯。
      const code = stripCommentsAndStrings(source);
      expect({ rel, calls: /(?<![\w$])watchParentLiveness\s*\(/.test(code) }).toEqual({ rel, calls: true });
      // import 的来源是字符串字面量，所以这一查只能去注释、不能去字符串。
      const decls = stripComments(source);
      // import 必须锚定到**真实的 import 语句**且来源正确：只查标识符出现过的话，
      // 调用本身就能满足它，这条断言等于空转（删掉 import 换个同名本地函数也照样绿）。
      const imported = new RegExp(
        String.raw`import\s*\{[^}]*(?<![\w$])watchParentLiveness(?![\w$])[^}]*\}\s*from\s*["']\.\.?/[^"']*parent-liveness["']`,
      ).test(decls);
      expect({ rel, imported }).toEqual({ rel, imported: true });
    }
  });

  test("宿主 pid 已死的注册条目会被回收", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-orphan-reg-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const registry = join(dir, "claude-sessions");
    mkdirSync(registry, { mode: 0o700 });
    const env = { ...process.env, [CLAUDE_SESSION_REGISTRY_DIR_ENV]: registry };

    // 一条活行（本进程）+ 一条死行（一个刚退出的真实进程的 pid）。
    // spawnSync 返回时这个进程已经退出且被收尸，它的 pid 就是一个确证已死的 pid。
    const dead = spawnSync("sh", ["-c", "exit 0"]);
    const deadPid = dead.pid!;
    expect(deadPid).toBeGreaterThan(1);
    expect(alive(deadPid)).toBe(false);

    expect(registerClaudeSession({
      session_id: "11111111-1111-4111-8111-111111111111",
      pid: process.pid,
      display_name: "alive-one",
      channel: "e2e-orphan",
      server: "https://example.test",
      cwd: process.cwd(),
    }, env)).toBe(true);
    expect(registerClaudeSession({
      session_id: "22222222-2222-4222-8222-222222222222",
      pid: deadPid,
      display_name: "dead-one",
      channel: "e2e-orphan",
      server: "https://example.test",
      cwd: process.cwd(),
    }, env)).toBe(true);
    expect(readdirSync(registry).filter((f) => f.endsWith(".json"))).toHaveLength(2);

    const live = listClaudeSessions(env);
    expect(live.map((e) => e.display_name)).toEqual(["alive-one"]);
    // 回收是**落盘**的，不只是过滤掉：死条目继续留在盘上会一直污染 #906 的选择逻辑。
    expect(readdirSync(registry).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });
});
