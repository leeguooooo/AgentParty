/**
 * Windows: verify who is serving ChatGPT Desktop's IPC pipe before a single byte is written.
 *
 * `\\.\pipe\codex-ipc` is a fixed name in the machine-wide pipe namespace. Whoever creates it
 * first is the server (pipe squatting), so the name proves nothing. On Unix the equivalent is
 * the uid + private-mode check on `ipc.sock`; here the checks run on **the handle that then
 * carries the frames**, so there is no window between the check and the use:
 *
 *   1. pipe owner SID == our user SID  (GetKernelObjectSecurity on our handle). The Unix uid
 *      check's twin, and the barrier against another account: setting an owner other than
 *      yourself needs SeRestorePrivilege. It does not depend on any process id.
 *   2. the pipe's server process (GetNamedPipeServerProcessId) runs as our user SID.
 *   3. that process carries the ChatGPT Desktop package identity (`OpenAI.Codex_2p2nqsd0c76g0`,
 *      GetPackageFamilyName — the kernel reads it from the process token) and its image lives
 *      inside that package's install directory (`…\WindowsApps\OpenAI.Codex_<ver>…\`, writable
 *      only by TrustedInstaller). Both: a command an agent runs under Desktop can inherit the
 *      package identity, but its image is outside the package.
 *
 * Why not Authenticode: Store packages are signed as a package, not per exe, and WinVerifyTrust
 * is slow; package identity + install directory say the same thing without admin rights.
 *
 * What this does not stop: a process already running as the same user can defeat any
 * user-mode check (it can inject into Desktop itself). Check 2/3 rely on a process id, which a
 * determined same-user process could recycle; check 1 does not.
 *
 * The handle is opened with SECURITY_IDENTIFICATION so a rogue server cannot impersonate us,
 * and only `\\.\pipe\…` is accepted (a `\\host\pipe\…` name would send credentials over SMB).
 *
 * Node/Bun's net.Socket does not expose the pipe HANDLE, so on Windows the transport itself
 * runs over this handle (PeekNamedPipe polling + ReadFile/WriteFile through bun:ffi). The handle
 * is switched to PIPE_NOWAIT: a server that stops reading must not block the event loop inside
 * WriteFile (timers would never fire), so writes take what fits and the rest is queued.
 */
import { dlopen } from "bun:ffi";
import { readdirSync } from "node:fs";

/** ChatGPT Desktop's Store package family (name + publisher hash). 2026-09-30, OpenAI.Codex 26.924. */
export const CODEX_DESKTOP_PACKAGE_FAMILY = "OpenAI.Codex_2p2nqsd0c76g0";

export interface WindowsPipeServerFacts {
  /** Owner SID of the pipe object we are connected to. */
  pipeOwnerSid: string | null;
  serverPid: number | null;
  serverUserSid: string | null;
  serverImagePath: string | null;
  serverPackageFamily: string | null;
  serverPackageInstallPath: string | null;
}

export interface WindowsPipeHandle {
  /** Identity of the server on THIS connection. */
  facts(): WindowsPipeServerFacts;
  /** Bytes ready to read; -1 once the pipe is broken or closed. */
  available(): number;
  read(maxBytes: number): Buffer;
  /** Never blocks: returns how many bytes the pipe took (0 when its buffer is full). Throws when broken. */
  write(data: Buffer): number;
  close(): void;
}

export interface WindowsPipeApi {
  currentUserSid(): string | null;
  /** null when the pipe cannot be opened. */
  open(path: string): WindowsPipeHandle | null;
  pipeExists(path: string): boolean;
}

export type VerifiedPipe =
  | { ok: true; handle: WindowsPipeHandle; facts: WindowsPipeServerFacts }
  | { ok: false; reason: string; facts?: WindowsPipeServerFacts };

const LOCAL_PIPE = /^\\\\\.\\pipe\\[^\\]/i;

function sameSid(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toUpperCase() === b.toUpperCase();
}

function insideDirectory(file: string, directory: string): boolean {
  const dir = directory.replace(/\\+$/, "").toLowerCase();
  return dir !== "" && file.toLowerCase().startsWith(`${dir}\\`);
}

/** Pure decision: null = the server is ChatGPT Desktop running as us; otherwise why not. */
export function judgeCodexPipeServer(selfSid: string | null, facts: WindowsPipeServerFacts): string | null {
  if (selfSid === null) return "cannot read the current user's SID";
  if (!sameSid(facts.pipeOwnerSid, selfSid)) {
    return `pipe is owned by another user (${facts.pipeOwnerSid ?? "owner unreadable"})`;
  }
  if (facts.serverPid === null) return "cannot identify the pipe's server process";
  if (!sameSid(facts.serverUserSid, selfSid)) {
    return `pipe server process ${facts.serverPid} runs as another user (${facts.serverUserSid ?? "token unreadable"})`;
  }
  const image = facts.serverImagePath;
  if (image === null) return `cannot read the image path of pipe server process ${facts.serverPid}`;
  if (facts.serverPackageFamily?.toLowerCase() !== CODEX_DESKTOP_PACKAGE_FAMILY.toLowerCase()) {
    return `pipe server process ${facts.serverPid} is not ChatGPT Desktop (${image}` +
      `${facts.serverPackageFamily === null ? ", no package identity" : `, package ${facts.serverPackageFamily}`})`;
  }
  if (facts.serverPackageInstallPath === null || !insideDirectory(image, facts.serverPackageInstallPath)) {
    return `pipe server process ${facts.serverPid} runs outside the ChatGPT Desktop package (${image})`;
  }
  return null;
}

/**
 * Open the pipe and verify its server on that same handle. On any failure the handle is
 * closed and nothing has been written.
 */
export function openVerifiedCodexPipe(path: string, api: WindowsPipeApi = nativeWindowsPipeApi()): VerifiedPipe {
  if (!LOCAL_PIPE.test(path)) return { ok: false, reason: `not a local named pipe: ${path}` };
  if (!api.pipeExists(path)) return { ok: false, reason: `ChatGPT Desktop IPC pipe is missing: ${path}` };
  const handle = api.open(path);
  if (handle === null) return { ok: false, reason: `cannot open ChatGPT Desktop IPC pipe: ${path}` };
  let facts: WindowsPipeServerFacts;
  let refusal: string | null;
  try {
    facts = handle.facts();
    refusal = judgeCodexPipeServer(api.currentUserSid(), facts);
  } catch (error) {
    handle.close();
    return { ok: false, reason: `pipe server identity check failed: ${String(error)}` };
  }
  if (refusal !== null) {
    handle.close();
    return { ok: false, reason: `refusing ${path}: ${refusal}`, facts };
  }
  return { ok: true, handle, facts };
}

// ── native implementation (bun:ffi → kernel32 / advapi32; no admin rights needed) ──

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;
/** SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server may identify us, never act as us. */
const SQOS_IDENTIFICATION = 0x00100000 | 0x00010000;
const INVALID_HANDLE = 0xffffffffffffffffn;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER_CLASS = 1;
const OWNER_SECURITY_INFORMATION = 1;
/** x64 TOKEN_USER = { PSID (8), DWORD attributes (+pad, 8) }; the SID body follows it. */
const TOKEN_USER_SID_OFFSET = 16;
/** PIPE_READMODE_BYTE | PIPE_NOWAIT. */
const PIPE_NOWAIT_MODE = 0x00000001;
const BUSY_WAIT_MS = 250;
const WIDE_CHARS = 1024;

function loadLibraries() {
  const kernel32 = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    WaitNamedPipeW: { args: ["ptr", "u32"], returns: "i32" },
    GetNamedPipeServerProcessId: { args: ["u64", "ptr"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    QueryFullProcessImageNameW: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
    GetPackageFamilyName: { args: ["u64", "ptr", "ptr"], returns: "i32" },
    GetPackageFullName: { args: ["u64", "ptr", "ptr"], returns: "i32" },
    GetPackagePathByFullName: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    SetNamedPipeHandleState: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    PeekNamedPipe: { args: ["u64", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
  }).symbols;
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    GetKernelObjectSecurity: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  }).symbols;
  return { kernel32, advapi32 };
}

type Libraries = ReturnType<typeof loadLibraries>;

function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

function usableHandle(handle: bigint): boolean {
  return handle !== 0n && handle !== INVALID_HANDLE;
}

/** Binary SID → `S-1-5-21-…`; null when the bytes are not a plausible SID. */
export function sidToString(bytes: Buffer, offset: number): string | null {
  if (offset < 0 || offset + 8 > bytes.length || bytes[offset] !== 1) return null;
  const count = bytes[offset + 1]!;
  if (count > 15 || offset + 8 + 4 * count > bytes.length) return null;
  const parts = [`S-1-${bytes.readUIntBE(offset + 2, 6)}`];
  for (let index = 0; index < count; index += 1) parts.push(String(bytes.readUInt32LE(offset + 8 + 4 * index)));
  return parts.join("-");
}

function processUserSid({ kernel32, advapi32 }: Libraries, process: bigint): string | null {
  const tokenOut = Buffer.alloc(8);
  if (advapi32.OpenProcessToken(process, TOKEN_QUERY, tokenOut) === 0) return null;
  const token = tokenOut.readBigUInt64LE(0);
  try {
    const info = Buffer.alloc(256);
    const length = Buffer.alloc(4);
    if (advapi32.GetTokenInformation(token, TOKEN_USER_CLASS, info, info.length, length) === 0) return null;
    return sidToString(info, TOKEN_USER_SID_OFFSET);
  } finally {
    kernel32.CloseHandle(token);
  }
}

/** Calls a `LONG fn(…, UINT32* length, PWSTR buffer)` appmodel API; null unless it succeeds. */
function appModelString(call: (length: Buffer, out: Buffer) => number): string | null {
  const out = Buffer.alloc(WIDE_CHARS * 2);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(WIDE_CHARS, 0);
  if (call(length, out) !== 0) return null;
  const text = out.toString("utf16le");
  const end = text.indexOf("\0");
  return end <= 0 ? null : text.slice(0, end);
}

function readFacts(libs: Libraries, pipe: bigint): WindowsPipeServerFacts {
  const { kernel32, advapi32 } = libs;
  const facts: WindowsPipeServerFacts = {
    pipeOwnerSid: null,
    serverPid: null,
    serverUserSid: null,
    serverImagePath: null,
    serverPackageFamily: null,
    serverPackageInstallPath: null,
  };
  // Self-relative SECURITY_DESCRIPTOR: owner SID sits at the offset stored in bytes 4..8.
  const descriptor = Buffer.alloc(1024);
  const needed = Buffer.alloc(4);
  if (advapi32.GetKernelObjectSecurity(pipe, OWNER_SECURITY_INFORMATION, descriptor, descriptor.length, needed) !== 0) {
    const ownerOffset = descriptor.readUInt32LE(4);
    if (ownerOffset !== 0) facts.pipeOwnerSid = sidToString(descriptor, ownerOffset);
  }
  const pidOut = Buffer.alloc(4);
  if (kernel32.GetNamedPipeServerProcessId(pipe, pidOut) === 0) return facts;
  const pid = pidOut.readUInt32LE(0);
  if (pid === 0) return facts;
  facts.serverPid = pid;
  const process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!usableHandle(process)) return facts;
  try {
    // One process handle for every query: all facts describe the same process object.
    facts.serverUserSid = processUserSid(libs, process);
    const image = Buffer.alloc(WIDE_CHARS * 2);
    const chars = Buffer.alloc(4);
    chars.writeUInt32LE(WIDE_CHARS, 0);
    if (kernel32.QueryFullProcessImageNameW(process, 0, image, chars) !== 0) {
      facts.serverImagePath = image.toString("utf16le", 0, chars.readUInt32LE(0) * 2);
    }
    facts.serverPackageFamily = appModelString((length, out) => kernel32.GetPackageFamilyName(process, length, out));
    const fullName = appModelString((length, out) => kernel32.GetPackageFullName(process, length, out));
    if (fullName !== null) {
      facts.serverPackageInstallPath = appModelString((length, out) =>
        kernel32.GetPackagePathByFullName(wide(fullName), length, out));
    }
  } finally {
    kernel32.CloseHandle(process);
  }
  return facts;
}

class NativePipeHandle implements WindowsPipeHandle {
  private closed = false;

  constructor(private readonly libs: Libraries, private readonly handle: bigint) {}

  facts(): WindowsPipeServerFacts {
    return readFacts(this.libs, this.handle);
  }

  available(): number {
    if (this.closed) return -1;
    const total = Buffer.alloc(4);
    if (this.libs.kernel32.PeekNamedPipe(this.handle, null, 0, null, total, null) === 0) return -1;
    return total.readUInt32LE(0);
  }

  read(maxBytes: number): Buffer {
    const buffer = Buffer.alloc(maxBytes);
    const got = Buffer.alloc(4);
    if (this.closed || this.libs.kernel32.ReadFile(this.handle, buffer, maxBytes, got, null) === 0) {
      throw new Error("ChatGPT Desktop IPC pipe read failed");
    }
    return buffer.subarray(0, got.readUInt32LE(0));
  }

  write(data: Buffer): number {
    const wrote = Buffer.alloc(4);
    if (this.closed || this.libs.kernel32.WriteFile(this.handle, data, data.length, wrote, null) === 0) {
      throw new Error("ChatGPT Desktop IPC pipe write failed");
    }
    return wrote.readUInt32LE(0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.libs.kernel32.CloseHandle(this.handle);
  }
}

let cachedApi: WindowsPipeApi | null = null;

export function nativeWindowsPipeApi(): WindowsPipeApi {
  if (cachedApi !== null) return cachedApi;
  let libs: Libraries | null = null;
  const load = (): Libraries => (libs ??= loadLibraries());
  const open = (path: string): bigint =>
    load().kernel32.CreateFileW(wide(path), GENERIC_READ_WRITE, 0, null, OPEN_EXISTING, SQOS_IDENTIFICATION, 0n);
  cachedApi = {
    currentUserSid() {
      // The SID of this process never changes; nothing about the pipe or its server is cached.
      const loaded = load();
      return processUserSid(loaded, loaded.kernel32.GetCurrentProcess());
    },
    open(path) {
      let handle = open(path);
      if (!usableHandle(handle)) {
        // Every instance busy: wait for one to free up, once. Returns at once if the name is gone.
        load().kernel32.WaitNamedPipeW(wide(path), BUSY_WAIT_MS);
        handle = open(path);
      }
      if (!usableHandle(handle)) return null;
      const mode = Buffer.alloc(4);
      mode.writeUInt32LE(PIPE_NOWAIT_MODE, 0);
      if (load().kernel32.SetNamedPipeHandleState(handle, mode, null, null) === 0) {
        // A handle that could block the event loop is not used at all.
        load().kernel32.CloseHandle(handle);
        return null;
      }
      return new NativePipeHandle(load(), handle);
    },
    pipeExists(path) {
      const name = path.replace(/^\\\\\.\\pipe\\/i, "").toLowerCase();
      try {
        return readdirSync("\\\\.\\pipe\\").some((pipe) => pipe.toLowerCase() === name);
      } catch {
        return false;
      }
    },
  };
  return cachedApi;
}

// ── transport over the verified handle ──

const POLL_MIN_MS = 2;
const POLL_MAX_MS = 50;
const READ_CHUNK_BYTES = 1024 * 1024;
const READS_PER_TICK = 16;

/**
 * Duplex stream over a verified pipe handle. Nothing here blocks: incoming bytes are polled
 * (2ms right after traffic, backing off to 50ms when the pipe is quiet) and outgoing bytes the
 * pipe cannot take yet wait in a queue, in order. A write that fails later closes the stream,
 * exactly like a socket error after `socket.write()` returned.
 */
export class WindowsPipeStream {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = POLL_MIN_MS;
  private done = false;
  private outgoing: Buffer[] = [];

  constructor(
    private readonly handle: WindowsPipeHandle,
    private readonly onData: (chunk: Buffer) => void,
    private readonly onClose: (error: Error) => void,
  ) {
    this.schedule();
  }

  write(data: Buffer): void {
    if (this.done) throw new Error("ChatGPT Desktop IPC closed");
    this.outgoing.push(data);
    this.delay = POLL_MIN_MS;
    try {
      this.flush();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }

  /** Hands queued bytes to the pipe until it stops taking them. */
  private flush(): void {
    while (this.outgoing.length > 0) {
      const head = this.outgoing[0]!;
      const took = this.handle.write(head);
      if (took >= head.length) {
        this.outgoing.shift();
        continue;
      }
      if (took > 0) this.outgoing[0] = head.subarray(took);
      return;
    }
  }

  private fail(error: unknown): void {
    if (this.done) return;
    this.destroy();
    this.onClose(error instanceof Error ? error : new Error(String(error)));
  }

  destroy(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.outgoing = [];
    this.handle.close();
  }

  private schedule(): void {
    if (this.done) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), this.delay);
  }

  private pump(): void {
    this.timer = null;
    if (this.done) return;
    try {
      if (this.outgoing.length > 0) {
        this.flush();
        // Still backed up: keep polling fast so the rest leaves as soon as the server reads.
        if (this.outgoing.length > 0) this.delay = POLL_MIN_MS;
      }
      for (let reads = 0; reads < READS_PER_TICK && !this.done; reads += 1) {
        const ready = this.handle.available();
        if (ready < 0) throw new Error("ChatGPT Desktop IPC closed");
        if (ready === 0) {
          if (reads === 0 && this.outgoing.length === 0) this.delay = Math.min(POLL_MAX_MS, Math.ceil(this.delay * 1.5));
          break;
        }
        this.delay = POLL_MIN_MS;
        this.onData(this.handle.read(Math.min(ready, READ_CHUNK_BYTES)));
      }
    } catch (error) {
      this.fail(error);
      return;
    }
    this.schedule();
  }
}
