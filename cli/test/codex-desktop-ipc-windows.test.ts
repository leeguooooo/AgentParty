// Windows 命名管道服务端身份校验（#1132；ocs 侧 open-cross-session#37）。平台调用全部注入，任何系统上都能跑。
// 变异自检：把 codex-desktop-ipc-windows.ts 里 openVerifiedCodexPipe 的 `if (refusal !== null)` 改成
// `if (false)`，标了「变异」的用例必须红（抢注的管道收到了帧）。
import { describe, expect, test } from "bun:test";
import {
  CodexDesktopIpcClient,
  CodexDesktopIpcPipeRefusedError,
  CodexDesktopIpcUnknownOutcomeError,
  codexDesktopIpcAvailable,
  codexDesktopIpcSocketPath,
  codexDesktopIpcStatus,
} from "../src/codex-desktop-ipc";
import {
  CODEX_DESKTOP_PACKAGE_FAMILY,
  judgeCodexPipeServer,
  openVerifiedCodexPipe,
  sidToString,
  type WindowsPipeApi,
  type WindowsPipeHandle,
  type WindowsPipeServerFacts,
} from "../src/codex-desktop-ipc-windows";

const ME = "S-1-5-21-1111111111-222222222-333333333-1001";
const OTHER = "S-1-5-21-1111111111-222222222-333333333-1002";
const PIPE = "\\\\.\\pipe\\codex-ipc";
const INSTALL = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0";
const THREAD_A = "aaaaaaaa-1111-2222-3333-444444444444";
const THREAD_B = "bbbbbbbb-1111-2222-3333-444444444444";

/** 2026-09-30 在真机（OpenAI.Codex 26.924）上读到的形状。 */
const DESKTOP: WindowsPipeServerFacts = {
  pipeOwnerSid: ME,
  serverPid: 20312,
  serverUserSid: ME,
  serverImagePath: `${INSTALL}\\app\\ChatGPT.exe`,
  serverPackageFamily: CODEX_DESKTOP_PACKAGE_FAMILY,
  serverPackageInstallPath: INSTALL,
};
/** 同一用户起的脚本抢注了管道名。 */
const SQUATTER: WindowsPipeServerFacts = {
  pipeOwnerSid: ME,
  serverPid: 4242,
  serverUserSid: ME,
  serverImagePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  serverPackageFamily: null,
  serverPackageInstallPath: null,
};

/** 假管道：同时是个会应答的假 IPC 路由器，记下收到的每个字节。 */
class FakePipe implements WindowsPipeHandle {
  written: Buffer[] = [];
  closed = false;
  failWritesOf: string | null = null;
  private inbound: Buffer[] = [];

  constructor(private readonly serverFacts: WindowsPipeServerFacts) {}

  facts(): WindowsPipeServerFacts { return this.serverFacts; }
  available(): number { return this.closed ? -1 : (this.inbound[0]?.length ?? 0); }
  read(): Buffer { return this.inbound.shift()!; }
  close(): void { this.closed = true; }

  write(data: Buffer): void {
    const message = JSON.parse(data.subarray(4).toString("utf8")) as Record<string, unknown>;
    if (message.method === this.failWritesOf) throw new Error("pipe broke mid-write");
    this.written.push(data);
    if (message.type !== "request") return;
    const base = { type: "response", requestId: message.requestId, resultType: "success", method: message.method };
    if (message.method === "initialize") this.reply({ ...base, result: { clientId: "client-1" } });
    if (message.method === "thread-owner-discovery") this.reply({ ...base, handledByClientId: "renderer-1" });
    if (message.method === "thread-follower-start-turn") this.reply({ ...base, result: { result: { turn: { id: "turn-1" } } } });
  }

  methods(): unknown[] {
    return this.written.map((frame) => (JSON.parse(frame.subarray(4).toString("utf8")) as { method: unknown }).method);
  }

  private reply(value: unknown): void {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    // 拆成两段：帧边界不等于读边界。
    this.inbound.push(frame.subarray(0, 3), frame.subarray(3));
  }
}

/** 每次 open 依次交出一个管道实例（同一个名字下可以有不同服务端的实例）。 */
function fakeApi(servers: WindowsPipeServerFacts[], options: { selfSid?: string | null; exists?: boolean } = {}) {
  const pipes: FakePipe[] = [];
  const opened: string[] = [];
  const api: WindowsPipeApi = {
    currentUserSid: () => options.selfSid === undefined ? ME : options.selfSid,
    pipeExists: () => options.exists ?? true,
    open(path) {
      opened.push(path);
      const facts = servers[Math.min(pipes.length, servers.length - 1)];
      if (facts === undefined) return null;
      const pipe = new FakePipe(facts);
      pipes.push(pipe);
      return pipe;
    },
  };
  return { api, pipes, opened };
}

const bytesSent = (pipes: FakePipe[]) => pipes.reduce((sum, pipe) => sum + pipe.written.length, 0);

describe("judgeCodexPipeServer（纯判定）", () => {
  test("真 Desktop：属主是自己、服务端同用户、带包身份、映像在包目录里 → 通过", () => {
    expect(judgeCodexPipeServer(ME, DESKTOP)).toBeNull();
    expect(judgeCodexPipeServer(ME.toLowerCase(), { ...DESKTOP, serverPackageFamily: CODEX_DESKTOP_PACKAGE_FAMILY.toUpperCase() })).toBeNull();
  });

  test("每一条偏离都拒绝，并说出原因", () => {
    const cases: Array<[Partial<WindowsPipeServerFacts>, string]> = [
      [{ pipeOwnerSid: OTHER }, "owned by another user"],
      [{ pipeOwnerSid: null }, "owner unreadable"],
      [{ serverPid: null }, "cannot identify the pipe's server process"],
      [{ serverUserSid: OTHER }, "runs as another user"],
      [{ serverUserSid: null }, "token unreadable"],
      [{ serverImagePath: null }, "cannot read the image path"],
      [{ serverPackageFamily: null }, "no package identity"],
      [{ serverPackageFamily: "Evil.Codex_2p2nqsd0c76g0" }, "is not ChatGPT Desktop"],
      // 继承了包身份、但映像在包目录之外（Desktop 底下 agent 跑的命令）。
      [{ serverImagePath: "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\x\\codex.exe" }, "outside the ChatGPT Desktop package"],
      // 目录名只是前缀相同。
      [{ serverImagePath: `${INSTALL}-evil\\app\\ChatGPT.exe` }, "outside the ChatGPT Desktop package"],
      [{ serverPackageInstallPath: null }, "outside the ChatGPT Desktop package"],
    ];
    for (const [change, expected] of cases) {
      expect(judgeCodexPipeServer(ME, { ...DESKTOP, ...change })).toContain(expected);
    }
    expect(judgeCodexPipeServer(null, DESKTOP)).toContain("current user's SID");
    expect(judgeCodexPipeServer(ME, SQUATTER)).toContain("powershell.exe");
  });

  test("sidToString 解析二进制 SID，垃圾字节返回 null", () => {
    const sid = Buffer.alloc(28);
    sid.set([1, 5, 0, 0, 0, 0, 0, 5]);
    [21, 1111111111, 222222222, 333333333, 1001].forEach((part, index) => sid.writeUInt32LE(part, 8 + 4 * index));
    expect(sidToString(sid, 0)).toBe(ME);
    expect(sidToString(Buffer.alloc(16), 0)).toBeNull();
    expect(sidToString(sid.subarray(0, 12), 0)).toBeNull();
  });
});

describe("openVerifiedCodexPipe", () => {
  test("变异：抢注的管道被关掉，返回原因和看到的身份", () => {
    const { api, pipes } = fakeApi([SQUATTER]);
    const result = openVerifiedCodexPipe(PIPE, api);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("refusing \\\\.\\pipe\\codex-ipc");
    expect(result.reason).toContain("is not ChatGPT Desktop");
    expect(result.facts?.serverPid).toBe(4242);
    expect(pipes[0]!.closed).toBe(true);
  });

  test("不是本机管道的名字（\\\\host\\pipe\\… 会把凭据送上 SMB）连开都不开", () => {
    for (const path of ["\\\\evil-host\\pipe\\codex-ipc", "C:\\temp\\codex-ipc", "\\\\.\\pipe\\", "codex-ipc"]) {
      const { api, opened } = fakeApi([DESKTOP]);
      const result = openVerifiedCodexPipe(path, api);
      expect(result.ok).toBe(false);
      expect(opened).toEqual([]);
    }
  });

  test("管道不存在 / 打不开 / 读身份时抛错 → 都是不可用", () => {
    const missing = fakeApi([DESKTOP], { exists: false });
    expect(openVerifiedCodexPipe(PIPE, missing.api)).toMatchObject({ ok: false, reason: expect.stringContaining("missing") });
    expect(missing.opened).toEqual([]);
    expect(openVerifiedCodexPipe(PIPE, fakeApi([]).api)).toMatchObject({ ok: false, reason: expect.stringContaining("cannot open") });
    const broken = new FakePipe(DESKTOP);
    broken.facts = () => { throw new Error("boom"); };
    const result = openVerifiedCodexPipe(PIPE, { currentUserSid: () => ME, pipeExists: () => true, open: () => broken });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("identity check failed") });
    expect(broken.closed).toBe(true);
  });
});

describe("CodexDesktopIpcClient（win32，注入管道 API）", () => {
  test("真 Desktop：在校验过的那条连接上握手、探测 owner、发起 turn", async () => {
    const { api, pipes } = fakeApi([DESKTOP]);
    const client = new CodexDesktopIpcClient({ platform: "win32", windowsPipeApi: api, env: {} });
    try {
      await client.connect();
      expect(await client.discoverThreadOwner(THREAD_B)).toBe("renderer-1");
      const turn = await client.startDelegatedTurn({
        targetThreadId: THREAD_B, sourceThreadId: THREAD_A, prompt: "hi", clientUserMessageId: "m1",
      });
      expect(turn).toEqual({ turnId: "turn-1", ownerClientId: "renderer-1" });
      // 只开了一条连接：校验和发帧是同一个句柄。
      expect(pipes.length).toBe(1);
      expect(pipes[0]!.methods()).toEqual(["initialize", "thread-owner-discovery", "thread-owner-discovery", "thread-follower-start-turn"]);
    } finally {
      client.close();
    }
    expect(pipes[0]!.closed).toBe(true);
  });

  test("变异：抢注的管道 → connect 抛 PipeRefused，initialize 帧都没写出去", async () => {
    const { api, pipes } = fakeApi([SQUATTER]);
    const client = new CodexDesktopIpcClient({ platform: "win32", windowsPipeApi: api, env: {} });
    try {
      await expect(client.connect()).rejects.toBeInstanceOf(CodexDesktopIpcPipeRefusedError);
    } finally {
      client.close();
    }
    expect(bytesSent(pipes)).toBe(0);
    expect(pipes.every((pipe) => pipe.closed)).toBe(true);
  });

  test("变异：别的用户建的管道（属主 SID 不是自己）同样一个字节不发", async () => {
    const { api, pipes } = fakeApi([{ ...DESKTOP, pipeOwnerSid: OTHER, serverUserSid: OTHER }]);
    const client = new CodexDesktopIpcClient({ platform: "win32", windowsPipeApi: api, env: {} });
    await expect(client.connect()).rejects.toThrow("owned by another user");
    client.close();
    expect(bytesSent(pipes)).toBe(0);
  });

  test("AGENTPARTY_CODEX_IPC_PIPE 只换名字，不换信任规则", () => {
    const env = { AGENTPARTY_CODEX_IPC_PIPE: "\\\\.\\pipe\\my-test-pipe" };
    const squat = fakeApi([SQUATTER]);
    expect(codexDesktopIpcAvailable(env, { platform: "win32", windowsPipeApi: squat.api })).toBe(false);
    expect(squat.opened).toEqual(["\\\\.\\pipe\\my-test-pipe"]);
    const real = fakeApi([DESKTOP]);
    const status = codexDesktopIpcStatus(env, { platform: "win32", windowsPipeApi: real.api });
    expect(status).toMatchObject({ available: true, path: "\\\\.\\pipe\\my-test-pipe", server: { serverPid: 20312 } });
    // 探测连接不发帧，用完即关。
    expect(bytesSent(real.pipes)).toBe(0);
    expect(real.pipes[0]!.closed).toBe(true);
  });

  test("probe-then-connect：探测时是真 Desktop、发帧的连接拿到抢注者的实例 → 零字节", async () => {
    // 同名管道可以有多个实例，探测过关不代表下一条连接连到同一个服务端：每条连接自己校验。
    const { api, pipes } = fakeApi([DESKTOP, SQUATTER]);
    const deps = { platform: "win32" as const, windowsPipeApi: api };
    expect(codexDesktopIpcAvailable({}, deps)).toBe(true);
    const client = new CodexDesktopIpcClient({ ...deps, env: {} });
    await expect(client.connect()).rejects.toBeInstanceOf(CodexDesktopIpcPipeRefusedError);
    client.close();
    expect(pipes.length).toBe(2);
    expect(bytesSent(pipes)).toBe(0);
  });

  test("默认管道名是 \\\\.\\pipe\\codex-ipc；非 win32 不读 AGENTPARTY_CODEX_IPC_PIPE", () => {
    expect(codexDesktopIpcSocketPath({}, "win32")).toBe("\\\\.\\pipe\\codex-ipc");
    expect(codexDesktopIpcSocketPath({ AGENTPARTY_CODEX_IPC_PIPE: "\\\\.\\pipe\\x", CODEX_HOME: "/tmp/ch" }, "darwin")).toBe("/tmp/ch/ipc/ipc.sock");
  });

  test("不重放：start-turn 帧写到一半失败是 unknown-outcome，不是「没发」", async () => {
    const { api, pipes } = fakeApi([DESKTOP]);
    const client = new CodexDesktopIpcClient({ platform: "win32", windowsPipeApi: api, env: {} });
    try {
      await client.connect();
      pipes[0]!.failWritesOf = "thread-follower-start-turn";
      await expect(client.startDelegatedTurn({
        targetThreadId: THREAD_B, sourceThreadId: THREAD_A, prompt: "hi", clientUserMessageId: "m1",
      })).rejects.toBeInstanceOf(CodexDesktopIpcUnknownOutcomeError);
    } finally {
      client.close();
    }
  });
});
