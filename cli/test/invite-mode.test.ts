// party invite --mode watch|participate（#186）：观看模式把接入包锚到 readonly token（发送禁用、只读围观），
// 参与模式锚到 agent token（全程参与，今日默认）。子进程级：真实 argv + mock REST，断言接入包内容。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let restServer: ReturnType<typeof Bun.serve> | null = null;
let minted: { name: string; role: string }[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-invite-"));
  minted = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  restServer?.stop(true);
  restServer = null;
});

function startRest(): string {
  let counter = 0;
  restServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/tokens" && req.method === "POST") {
        const body = (await req.json()) as { name: string; role: string };
        minted.push({ name: body.name, role: body.role });
        // token 明文按角色可辨认，方便断言接入包引用了哪一个
        const token = `ap_${body.role === "readonly" ? "readonly" : "agenttok"}${(counter++).toString().padStart(24 - (body.role === "readonly" ? 8 : 8), "0")}`;
        return Response.json({ token, name: body.name, role: body.role, owner: "x", channel_scope: body.name }, { status: 201 });
      }
      if (url.pathname === "/api/channels" && req.method === "POST") {
        return Response.json({ ok: true }, { status: 201 });
      }
      if (url.pathname.endsWith("/charter") && req.method === "GET") {
        return Response.json({ error: { code: "not_found", message: "no charter" } }, { status: 404 });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${restServer.port}`;
}

async function runInvite(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, "invite", ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home, ADMIN_SECRET: "sekret" },
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

/** 粘贴稿正文：介绍行之后、网页围观链接之前的非空行。 */
function packBodyLines(stdout: string): string[] {
  const lines = stdout.split("\n");
  const start = lines.findIndex((l) => l.includes("一句话 + 一条命令"));
  const end = lines.findIndex((l) => l.startsWith("网页只读围观"));
  if (start < 0 || end < 0 || end <= start) throw new Error(`pack body not found in:\n${stdout}`);
  return lines.slice(start + 1, end).filter((l) => l.trim() !== "");
}

// #992（epic #987）：接入包 = 一句话 + 一条命令。机械步骤早已全收进 `party join`，而 `party join`
// 自己就是分步引导（每步 check → 过/不过 → 不过给一条修法并停在那一步），粘贴稿里不再需要任何提示词。
// 2026-08-28 owner 一条链全踩了的教训：粘贴包每一步都兜不住——那就别再让粘贴包承担「教它怎么做」。
describe("party invite 接入包 = 一句话 + 一条命令（#992）", () => {
  test("正文至多 3 行：一句约定 + 一行 token 安全提示 + 唯一一条可执行命令 party join … --yes", async () => {
    const server = startRest();
    const r = await runInvite(["One Cmd", "--slug", "onecmd", "--server", server]);
    expect(r.code).toBe(0);
    const body = packBodyLines(r.stdout);
    expect(body.length).toBeLessThanOrEqual(3);
    const executable = body.filter((l) => !l.startsWith("#"));
    // 含且仅含一条 party join；它就是全部可执行内容。
    expect(executable).toHaveLength(1);
    expect(executable[0]).toMatch(/^AGENTPARTY_TOKEN='ap_agenttok\d*' party join --server \S+ --channel onecmd --as onecmd-guest --yes$/);
    expect(r.stdout.match(/party join /g)).toHaveLength(1);
    // 不再有 install 独立行、不再有 party init、不再有整段行为约定提示词。
    expect(r.stdout).not.toMatch(/^command -v party/m);
    expect(r.stdout).not.toContain("party init");
    expect(r.stdout).not.toContain("Trellis");
    expect(r.stdout).not.toContain("交给子 agent");
  });

  test("那一句话说清：跑这条命令会被分步引导，每一步不通停下来告诉你怎么修；没装 party 的兜底也在这句里", async () => {
    const server = startRest();
    const r = await runInvite(["One Cmd", "--slug", "onecmd", "--server", server]);
    const [guide, safety] = packBodyLines(r.stdout);
    expect(guide).toMatch(/^# 你被邀请加入 #onecmd/);
    expect(guide).toContain("分步引导");
    expect(guide).toContain("停下来");
    expect(guide).toContain("告诉你怎么修");
    expect(guide).toContain("curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh");
    // 安全提示一行：token 别进 argv、别贴公开的地方。
    expect(safety).toMatch(/^# token/);
    expect(safety).toContain("别改成命令行参数传");
    expect(safety).toContain("别把这段贴到公开的地方");
  });

  test("token 只走 AGENTPARTY_TOKEN 环境变量前缀（#676）：输出里除了那个前缀，token 明文不再出现第二次", async () => {
    const server = startRest();
    const r = await runInvite(["One Cmd", "--slug", "onecmd", "--server", server]);
    const tokens = [...r.stdout.matchAll(/ap_agenttok\d+/g)].map((m) => m[0]);
    expect(tokens).toHaveLength(1);
    expect(r.stdout).toContain(`AGENTPARTY_TOKEN='${tokens[0]}' party join`);
    expect(r.stdout).not.toContain(`--token ${tokens[0]}`);
  });
});

describe("party invite --mode", () => {
  test("watch mode anchors the join pack to a readonly token and disables sending", async () => {
    const server = startRest();
    const r = await runInvite(["Watch Room", "--slug", "watchroom", "--mode", "watch", "--server", server]);
    expect(r.code).toBe(0);
    // a readonly token was minted and it is the one the invitee inits with
    expect(minted.some((m) => m.role === "readonly")).toBe(true);
    // #676：token 走 AGENTPARTY_TOKEN 环境变量，不写进 argv——可拷贝命令里不得再有明文 `--token ap`
    expect(r.stdout).toMatch(/AGENTPARTY_TOKEN='ap_readonly\d*' party init --server .* --channel watchroom/);
    expect(r.stdout).not.toContain("--token ap_readonly");
    const watchGuardIndex = r.stdout.indexOf("AgentParty onboarding scope: join the existing channel #watchroom");
    expect(watchGuardIndex).toBeGreaterThan(-1);
    expect(watchGuardIndex).toBeLessThan(r.stdout.indexOf("party init "));
    // mode is stated in the pack
    expect(r.stdout).toContain("观看");
    // watch mode never tells the invitee to send a check-in (readonly can't send)
    expect(r.stdout).not.toMatch(/party send .*报到/);
    expect(r.stdout.toLowerCase()).toContain("watch");
  });

  test("participate mode (explicit) anchors to an agent token with a party join line", async () => {
    const server = startRest();
    const r = await runInvite(["Part Room", "--slug", "partroom", "--mode", "participate", "--server", server]);
    expect(r.code).toBe(0);
    expect(minted.some((m) => m.role === "agent")).toBe(true);
    // #944：接入包压成一行 party join（108 行里的机械步骤全收进它），token 走环境变量前缀不进 argv（#676）。
    expect(r.stdout).toMatch(/AGENTPARTY_TOKEN='ap_agenttok\d*' party join --server .* --channel partroom --as partroom-guest --yes$/m);
    expect(r.stdout).not.toContain("--token ap_agenttok");
    expect(r.stdout).not.toContain("party init --server");
    // #992：那一句话（分步引导）排在 party join 之前。
    const guideIndex = r.stdout.indexOf("分步引导");
    expect(guideIndex).toBeGreaterThan(-1);
    expect(guideIndex).toBeLessThan(r.stdout.indexOf("party join "));
    expect(r.stdout).toContain("参与");
    // 报到收进 party join——粘贴稿里不再单独出现 party send 报到行。
    expect(r.stdout).not.toMatch(/party send .*报到/);
  });

  test("default mode is participate", async () => {
    const server = startRest();
    const r = await runInvite(["Def Room", "--slug", "defroom", "--server", server]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/AGENTPARTY_TOKEN='ap_agenttok\d*' party join --server .* --channel defroom --as defroom-guest/);
    expect(r.stdout).not.toContain("--token ap_agenttok");
    expect(r.stdout).not.toContain("party init --server");
  });

  test("--harness codex 写进 party join --harness；非法值拒绝（占位符 codex|claude 贴进 shell 会变成管道）", async () => {
    const server = startRest();
    const r = await runInvite(["Harness Room", "--slug", "hroom", "--harness", "codex", "--server", server]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^AGENTPARTY_TOKEN='ap_agenttok\d*' party join --server \S+ --channel hroom --as hroom-guest --harness codex --yes$/m,
    );
    const bad = await runInvite(["Harness Room", "--slug", "hroom2", "--harness", "codex|claude", "--server", server]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--harness must be one of");
  });

  test("rejects an invalid --mode", async () => {
    const server = startRest();
    const r = await runInvite(["Bad", "--slug", "bad", "--mode", "lurk", "--server", server]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mode");
  });
});
