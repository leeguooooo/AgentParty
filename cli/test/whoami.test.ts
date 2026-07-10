// #140：party whoami 必须打印「生效 server」（命令实际落点），别只显示账号会话的 server。
// 子进程级冒烟：真实 argv 路由，验证 runtime_config 生效 server 与账号会话 server 不同的常态场景。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

// 账号会话所属 server（人类登录，server A）——本用例里它绝不该被当成生效落点。
const ACCOUNT_SERVER = "https://agentparty.account-side.example";

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-whoami-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

// server B：runtime config 指向的生效 server，命令真正打到这里。
function startEffectiveServer(): string {
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/me") {
        return Response.json({ name: "leo-claude", email: null, kind: "agent", role: "agent", owner: "lark:on_x" });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${restServer.port}`;
}

function seedConfigAndAccount(effectiveServer: string, accountServer: string): void {
  mkdirSync(home, { recursive: true });
  // runtime_config：带 token，resolveAuth 里优先，auth_source=runtime_config
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: effectiveServer, token: "ap_runtime_tok" }));
  // 并存的人类账号会话，指向另一个 server；access_token 未过期，即便被读到也不触发 refresh
  writeFileSync(
    join(home, "account.json"),
    JSON.stringify({
      server: accountServer,
      refresh_token: "rt_human",
      access_token: "at_human",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      email: "human@example.com",
    }),
  );
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("whoami 文本输出打印生效 server（命令实际落点），而不只是账号会话的 server（#140）", async () => {
  const effective = startEffectiveServer();
  seedConfigAndAccount(effective, ACCOUNT_SERVER);

  const r = await runCli(["whoami"]);
  expect(r.code).toBe(0);
  // 核心断言：生效 server 必须可见——修复前它一次都不打印，只露账号会话的 server A。
  expect(r.stdout).toContain(effective);
  // runtime 段（第一行的落点身份）与生效 server 关联，而非把 server A 呈现成落点。
  const runtimeLine = r.stdout.split("\n").find((l) => l.startsWith("runtime:")) ?? "";
  expect(runtimeLine).toContain(effective);
  expect(runtimeLine).not.toContain(ACCOUNT_SERVER);
});

test("account server 与生效 server 不同时，account 行显式标注「不是本次命令落点」（#140）", async () => {
  const effective = startEffectiveServer();
  seedConfigAndAccount(effective, ACCOUNT_SERVER);

  const r = await runCli(["whoami"]);
  expect(r.code).toBe(0);
  const accountLine = r.stdout.split("\n").find((l) => l.startsWith("account:")) ?? "";
  // account 行仍展示账号 server A，但必须带「不同 server / 未被本次命令使用」的显式提示。
  expect(accountLine).toContain(ACCOUNT_SERVER);
  expect(accountLine).toMatch(/different server|not used/i);
});

test("account server 与生效 server 相同时，不误报「不同 server」标注（#140）", async () => {
  const effective = startEffectiveServer();
  // 账号会话与 runtime 指向同一个 server
  seedConfigAndAccount(effective, effective);

  const r = await runCli(["whoami"]);
  expect(r.code).toBe(0);
  // 生效 server 依旧要打印
  expect(r.stdout).toContain(effective);
  const accountLine = r.stdout.split("\n").find((l) => l.startsWith("account:")) ?? "";
  // 同 server 时不该出现差异提示（否则等于恒定误报，agent 会无谓怀疑落点）
  expect(accountLine).not.toMatch(/different server|not used/i);
});

test("whoami --json 明确区分 effective_server 与 account_server（#140）", async () => {
  const effective = startEffectiveServer();
  seedConfigAndAccount(effective, ACCOUNT_SERVER);

  const r = await runCli(["whoami", "--json"]);
  expect(r.code).toBe(0);
  const frame = JSON.parse(r.stdout) as {
    type: string;
    logged_in: boolean;
    effective_server: string;
    account_server: string | null;
  };
  expect(frame.type).toBe("whoami");
  expect(frame.logged_in).toBe(true);
  // 生效落点 = server B；账号会话 = server A；两者机器可读地区分开，agent 免解析人话。
  expect(frame.effective_server).toBe(effective);
  expect(frame.account_server).toBe(ACCOUNT_SERVER);
  expect(frame.effective_server).not.toBe(frame.account_server);
});
