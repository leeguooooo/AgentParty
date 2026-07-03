// M3：invite 接入包 / webhook 子命令 / channel create --party
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRestMock, type RestMock, type RestRequest } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let mock: RestMock | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-cli-m3-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

async function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", indexPath, ...args], {
    env: { ...process.env, AGENTPARTY_HOME: home, ADMIN_SECRET: undefined, ...env },
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

function writeCfg(server: string) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ server, token: "ap_tok" }));
}

function reqsOf(m: RestMock, method: string, pathPrefix: string): RestRequest[] {
  return m.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix));
}

describe("party invite", () => {
  test("默认参数：slug 由标题推导，铸 guest+share，输出可粘贴接入包", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "Fix Login Bug", "--server", mock.url], {
      ADMIN_SECRET: "s3cret",
    });
    expect(r.code).toBe(0);

    // 请求序列：agent token → channel → readonly token
    const tokenReqs = reqsOf(mock, "POST", "/api/tokens");
    expect(tokenReqs.map((t) => t.body)).toEqual([
      { name: "fix-login-bug-guest", role: "agent" },
      { name: "fix-login-bug-share", role: "readonly" },
    ]);
    expect(tokenReqs[0]!.headers["x-admin-secret"]).toBe("s3cret");
    const chanReq = reqsOf(mock, "POST", "/api/channels")[0]!;
    expect(chanReq.body).toEqual({
      slug: "fix-login-bug",
      title: "Fix Login Bug",
      kind: "standing",
      mode: "normal",
    });
    // 建频道用刚铸的 guest token
    expect(chanReq.headers.authorization).toBe("Bearer ap_fix-login-bug-guest_secret");

    // 接入包内容可整段粘贴
    expect(r.stdout).toContain(
      `party init --server ${mock.url} --token ap_fix-login-bug-guest_secret --channel fix-login-bug`,
    );
    expect(r.stdout).toContain("party watch fix-login-bug --follow");
    expect(r.stdout).toContain(`${mock.url}/c/fix-login-bug?t=ap_fix-login-bug-share_secret`);
    // 输出快照（归一化随机端口）
    expect(r.stdout.replaceAll(mock.url, "https://party.example")).toMatchSnapshot();
  });

  test("--slug --temp --party --guest-name 组合", async () => {
    mock = startRestMock();
    const r = await runCli(
      [
        "invite",
        "修复登录",
        "--slug",
        "hotfix",
        "--temp",
        "--party",
        "--guest-name",
        "bob",
        "--server",
        mock.url,
      ],
      { ADMIN_SECRET: "s3cret" },
    );
    expect(r.code).toBe(0);
    const tokenReqs = reqsOf(mock, "POST", "/api/tokens");
    expect(tokenReqs.map((t) => t.body)).toEqual([
      { name: "bob", role: "agent" },
      { name: "hotfix-share", role: "readonly" },
    ]);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "hotfix",
      title: "修复登录",
      kind: "temp",
      mode: "party",
    });
    expect(r.stdout).toContain("(temp · party)");
    expect(r.stdout).toContain("--token ap_bob_secret --channel hotfix");
  });

  test("缺 ADMIN_SECRET 退出 1", async () => {
    mock = startRestMock();
    const r = await runCli(["invite", "t", "--server", mock.url]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ADMIN_SECRET");
    expect(mock.requests.length).toBe(0);
  });

  test("缺标题退出 1", async () => {
    const r = await runCli(["invite"], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party invite");
  });

  test("guest token 重名 409 → 报错提示 --guest-name", async () => {
    mock = startRestMock((req) => {
      if (
        req.method === "POST" &&
        req.path === "/api/tokens" &&
        (req.body as { role: string }).role === "agent"
      ) {
        return Response.json(
          { error: { code: "conflict", message: "token exists" } },
          { status: 409 },
        );
      }
      return undefined;
    });
    const r = await runCli(["invite", "demo", "--server", mock.url], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--guest-name");
  });

  test("share token 重名 409 → 撤销重铸，链接照常输出", async () => {
    let shareCreates = 0;
    mock = startRestMock((req) => {
      if (
        req.method === "POST" &&
        req.path === "/api/tokens" &&
        (req.body as { role: string }).role === "readonly"
      ) {
        shareCreates++;
        if (shareCreates === 1) {
          return Response.json(
            { error: { code: "conflict", message: "token exists" } },
            { status: 409 },
          );
        }
      }
      return undefined;
    });
    const r = await runCli(["invite", "demo", "--server", mock.url], { ADMIN_SECRET: "s" });
    expect(r.code).toBe(0);
    expect(shareCreates).toBe(2);
    expect(reqsOf(mock, "DELETE", "/api/tokens/demo-share").length).toBe(1);
    expect(r.stdout).toContain(`${mock.url}/c/demo?t=ap_demo-share_secret`);
  });
});

describe("party webhook", () => {
  test("add → list → remove 全流程", async () => {
    mock = startRestMock();
    writeCfg(mock.url);

    const add = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "hermes",
      "--url",
      "https://hooks.example/x",
      "--secret",
      "whs",
    ]);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("webhook hermes added to dev (filter: mentions)");
    const addReq = reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!;
    expect(addReq.body).toEqual({
      name: "hermes",
      url: "https://hooks.example/x",
      secret: "whs",
      filter: "mentions",
    });
    expect(addReq.headers.authorization).toBe("Bearer ap_tok");

    const list = await runCli(["webhook", "list", "dev"]);
    expect(list.code).toBe(0);
    expect(list.stdout.trim()).toBe("hermes\tmentions\thttps://hooks.example/x");

    const rm = await runCli(["webhook", "remove", "dev", "--name", "hermes"]);
    expect(rm.code).toBe(0);
    expect(rm.stdout).toContain("webhook hermes removed from dev");

    const list2 = await runCli(["webhook", "list", "dev"]);
    expect(list2.stdout.trim()).toBe("");
  });

  test("add --filter all", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "h",
      "--url",
      "https://x",
      "--secret",
      "s",
      "--filter",
      "all",
    ]);
    expect(r.code).toBe(0);
    expect((reqsOf(mock, "POST", "/api/channels/dev/webhooks")[0]!.body as { filter: string }).filter).toBe("all");
  });

  test("非法 filter 退出 1", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli([
      "webhook",
      "add",
      "dev",
      "--name",
      "h",
      "--url",
      "https://x",
      "--secret",
      "s",
      "--filter",
      "bogus",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party webhook add");
    expect(mock.requests.length).toBe(0);
  });

  test("缺必填参数退出 1", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["webhook", "add", "dev", "--name", "h"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: party webhook add");
  });

  test("无 config 退出 1", async () => {
    const r = await runCli(["webhook", "list", "dev"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no config");
  });
});

describe("party channel create mode", () => {
  test("--party 发送 mode=party", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "war-room", "--party", "--title", "作战室"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "war-room",
      title: "作战室",
      kind: "standing",
      mode: "party",
    });
  });

  test("默认 mode=normal", async () => {
    mock = startRestMock();
    writeCfg(mock.url);
    const r = await runCli(["channel", "create", "dev"]);
    expect(r.code).toBe(0);
    expect(reqsOf(mock, "POST", "/api/channels")[0]!.body).toEqual({
      slug: "dev",
      kind: "standing",
      mode: "normal",
    });
  });
});
