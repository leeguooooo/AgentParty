// 自升级支持（issue #45）：已在跑的 serve 是内存里的旧二进制，但 process.execPath 指向的磁盘文件
// 会被 install.sh 换成新版。这里网络-free 地读磁盘二进制版本、比对、在唤醒间隙 re-exec 新版。
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

export const RUNNING_VERSION = pkg.version;
export const OWNER_REPO = "leeguooooo/agentparty";
export const INSTALL_LINE = `curl -fsSL https://raw.githubusercontent.com/${OWNER_REPO}/main/install.sh | sh`;

// semver 比较：a>b→1, a<b→-1, ==→0。只认 X.Y.Z 数字段，非法段当 0。
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 磁盘上 party 二进制的版本：对编译版（bun --compile），process.execPath 就是 party 二进制本身，
// install.sh 覆盖它后，spawn 它 --version 读到的是【新】版本，而当前进程仍是旧的内存镜像。
// 注入点 readVersion 供测试；默认真跑 execPath --version。dev（bun run src/index.ts）下 execPath
// 是 bun，读不到 party 版本 → 返回 null（不误判、不 re-exec）。
export interface UpgradeDeps {
  runningVersion?: string;
  execPath?: string;
  readInstalledVersion?: (execPath: string) => string | null;
  reexec?: (execPath: string, argv: string[]) => void;
  fetch?: typeof fetch;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  extractPartyBinary?: (archivePath: string, outDir: string, platform: NodeJS.Platform) => Promise<string>;
  installBinary?: (sourcePath: string, targetPath: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  mirror?: string;
}

export interface CliUpgradeNotice {
  running_version: string;
  /** 磁盘已经安装、只需 re-exec 的版本。服务器发布版提示里没有这个字段。 */
  installed_version?: string;
  /** 可下载安装的版本；磁盘更新和服务器发布更新两种来源都统一暴露。 */
  available_version: string;
  auto_upgrade: boolean;
  action_required: "ask_user" | "auto_reexec";
  message: string;
  command: string;
}

function defaultReadInstalledVersion(execPath: string): string | null {
  try {
    const proc = Bun.spawnSync([execPath, "--version"], { stdout: "pipe", stderr: "ignore" });
    if (!proc.success) return null;
    const out = new TextDecoder().decode(proc.stdout).trim();
    return /^\d+\.\d+\.\d+/.test(out) ? out.split(/\s+/)[0]! : null;
  } catch {
    return null;
  }
}

export function isPartyBinaryPath(execPath: string): boolean {
  return basename(execPath).includes("party");
}

function normalizeReleaseVersion(version: string): string | null {
  const trimmed = version.trim().replace(/^v/, "");
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

export function detectReleaseTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  const os =
    platform === "darwin" ? "darwin" :
    platform === "linux" ? "linux" :
    platform === "win32" ? "windows" :
    null;
  const cpu =
    arch === "x64" || arch === "amd64" ? "x64" :
    arch === "arm64" || arch === "aarch64" ? "arm64" :
    null;
  if (os === null || cpu === null) return null;
  if (os === "windows" && cpu !== "x64") return null;
  return `${os}-${cpu}`;
}

async function resolveLatestReleaseVersion(fetcher: typeof fetch): Promise<string> {
  const api = await fetcher(`https://api.github.com/repos/${OWNER_REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" },
  }).catch(() => null);
  if (api?.ok) {
    const body = (await api.json().catch(() => null)) as { tag_name?: unknown } | null;
    const version = typeof body?.tag_name === "string" ? normalizeReleaseVersion(body.tag_name) : null;
    if (version !== null) return version;
  }
  const redirected = await fetcher(`https://github.com/${OWNER_REPO}/releases/latest`, {
    method: "HEAD",
    redirect: "follow",
  });
  const match = redirected.url.match(/\/tag\/v?(\d+\.\d+\.\d+)/);
  if (match) return match[1]!;
  throw new Error("cannot resolve latest release version");
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith("file://")) return new Uint8Array(readFileSync(fileURLToPath(url)));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function sha256Hex(bytes: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

async function defaultExtractPartyBinary(archivePath: string, outDir: string, platform: NodeJS.Platform): Promise<string> {
  const proc = Bun.spawn(["tar", "-xzf", archivePath, "-C", outDir], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer()).trim();
    throw new Error(`tar extraction failed${stderr ? `: ${stderr}` : ""}`);
  }
  const binary = join(outDir, platform === "win32" ? "party.exe" : "party");
  if (!existsSync(binary)) throw new Error("archive missing party binary");
  return binary;
}

function defaultInstallBinary(sourcePath: string, targetPath: string): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.party.${process.pid}.${Date.now()}.tmp`);
  try {
    copyFileSync(sourcePath, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, targetPath);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export interface PartyUpgradeOptions {
  version?: string;
  checkOnly?: boolean;
}

export interface PartyUpgradeResult {
  running_version: string;
  target_version: string;
  target: string;
  asset_url: string;
  installed: boolean;
  install_path: string;
  reason?: "already_current";
}

export async function downloadPartyUpgrade(
  options: PartyUpgradeOptions = {},
  deps: UpgradeDeps = {},
): Promise<PartyUpgradeResult> {
  const running = deps.runningVersion ?? RUNNING_VERSION;
  const execPath = deps.execPath ?? process.execPath;
  if (!isPartyBinaryPath(execPath)) {
    throw new Error(`party upgrade must be run from a compiled party binary; fallback: ${INSTALL_LINE}`);
  }
  const platform = deps.platform ?? process.platform;
  const target = detectReleaseTarget(platform, deps.arch ?? process.arch);
  if (target === null) throw new Error(`unsupported platform for party upgrade: ${platform}/${deps.arch ?? process.arch}`);
  const fetcher = deps.fetch ?? fetch;
  const requested = options.version ?? "latest";
  const explicitVersion = requested !== "latest";
  const targetVersion = explicitVersion
    ? normalizeReleaseVersion(requested)
    : await resolveLatestReleaseVersion(fetcher);
  if (targetVersion === null) throw new Error(`invalid release version: ${requested}`);
  const versionDelta = compareVersions(targetVersion, running);
  if (!explicitVersion && versionDelta < 0) {
    throw new Error(`refusing downgrade from ${running} to ${targetVersion}`);
  }
  if (versionDelta === 0) {
    return {
      running_version: running,
      target_version: targetVersion,
      target,
      asset_url: "",
      installed: false,
      install_path: execPath,
      reason: "already_current",
    };
  }
  const mirror = deps.mirror ?? process.env.AGENTPARTY_MIRROR ?? `https://github.com/${OWNER_REPO}/releases/download`;
  if (!mirror.startsWith("https://") && !mirror.startsWith("file://")) {
    throw new Error("AGENTPARTY_MIRROR must use https:// or file://");
  }
  const base = `${mirror.replace(/\/$/, "")}/v${targetVersion}`;
  const asset = `party-${target}.tar.gz`;
  const assetUrl = `${base}/${asset}`;
  if (options.checkOnly === true) {
    return { running_version: running, target_version: targetVersion, target, asset_url: assetUrl, installed: false, install_path: execPath };
  }
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const [archiveBytes, checksumBytes] = await Promise.all([
    fetchBytes(assetUrl),
    fetchBytes(`${assetUrl}.sha256`),
  ]);
  const want = new TextDecoder().decode(checksumBytes).trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(want)) throw new Error("release checksum file is invalid");
  const got = sha256Hex(archiveBytes);
  if (got.toLowerCase() !== want.toLowerCase()) {
    throw new Error(`sha256 mismatch: want ${want} got ${got}`);
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), "party-upgrade-"));
  try {
    const archivePath = join(tmpRoot, asset);
    writeFileSync(archivePath, archiveBytes);
    const extracted = await (deps.extractPartyBinary ?? defaultExtractPartyBinary)(archivePath, tmpRoot, platform);
    (deps.installBinary ?? defaultInstallBinary)(extracted, execPath);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
  return { running_version: running, target_version: targetVersion, target, asset_url: assetUrl, installed: true, install_path: execPath };
}

// 磁盘二进制比运行版新 → 返回新版本号，否则 null。
export function pendingUpgrade(deps: UpgradeDeps = {}): string | null {
  const running = deps.runningVersion ?? RUNNING_VERSION;
  const execPath = deps.execPath ?? process.execPath;
  const read = deps.readInstalledVersion ?? defaultReadInstalledVersion;
  // 只有 execPath 看起来是 party 二进制（basename 含 party）才比——dev 下 execPath=bun，跳过。
  if (!isPartyBinaryPath(execPath)) return null;
  const installed = read(execPath);
  if (!installed) return null;
  return compareVersions(installed, running) > 0 ? installed : null;
}

export function upgradeNotice(auto: boolean, deps: UpgradeDeps = {}): CliUpgradeNotice | null {
  const installed = pendingUpgrade(deps);
  if (!installed) return null;
  const running = deps.runningVersion ?? RUNNING_VERSION;
  const action = auto ? "auto_reexec" : "ask_user";
  return {
    running_version: running,
    installed_version: installed,
    available_version: installed,
    auto_upgrade: auto,
    action_required: action,
    message: auto
      ? `检测到 party CLI 已有新版本 v${installed}（当前运行 v${running}）。本轮唤醒结束后 serve 会自动 re-exec 新版。`
      : `检测到 party CLI 已有新版本 v${installed}（当前运行 v${running}）。继续任务前先询问用户是否升级；用户同意后再让用户运行升级命令并重启 serve。`,
    command: INSTALL_LINE,
  };
}

/**
 * 服务器 /api/version 已经跑在更新的正式版本时，提醒旧 CLI 的 agent 联系 owner 升级（#485）。
 * `dev` / commit hash / 非 SemVer 一律忽略，避免预览部署误导稳定版用户。
 */
export function serverVersionUpgradeNotice(
  serverVersion: string,
  deps: { runningVersion?: string } = {},
): CliUpgradeNotice | null {
  // 只接受正式版和 build metadata；prerelease 的优先级低于同号正式版，不能当成已发布。
  const match = serverVersion.trim().match(/^v?(\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  const available = match[1]!;
  const running = deps.runningVersion ?? RUNNING_VERSION;
  if (compareVersions(available, running) <= 0) return null;
  return {
    running_version: running,
    available_version: available,
    auto_upgrade: false,
    action_required: "ask_user",
    message: `AgentParty 服务器已发布 party CLI v${available}，当前 agent 仍在使用 v${running}。请用 party send 在本频道主动提醒 owner 升级，然后结束本轮、继续监听；owner 同意后运行升级命令并重启 serve。`,
    command: INSTALL_LINE,
  };
}

// 服务端声明的最低客户端版本（#137）高于本机运行版本时的升级提示——与磁盘自升级（cli_upgrade）
// 互补：cli_upgrade 是「磁盘已有新版、re-exec 即可」，这条是「服务端要求更高、需真正去装新版」。
// 形状对齐 CliUpgradeNotice（action_required=ask_user + command），runner 复用同一条询问用户的处理流。
export interface ServerMinVersionNotice {
  running_version: string;
  min_client_version: string;
  enforced: boolean;
  action_required: "ask_user";
  message: string;
  command: string;
}

export function serverMinVersionNotice(
  minClientVersion: string,
  enforced: boolean,
  deps: { runningVersion?: string } = {},
): ServerMinVersionNotice | null {
  const running = deps.runningVersion ?? RUNNING_VERSION;
  if (compareVersions(running, minClientVersion) >= 0) return null;
  return {
    running_version: running,
    min_client_version: minClientVersion,
    enforced,
    action_required: "ask_user",
    message: enforced
      ? `服务端要求 party CLI 最低 v${minClientVersion}，当前 v${running} 已被拒绝。请先运行升级命令再继续。`
      : `服务端声明 party CLI 最低支持版本 v${minClientVersion}，当前 v${running} 偏旧（协议可能有破坏性变更）。继续任务前先询问用户是否升级。`,
    command: INSTALL_LINE,
  };
}

// #703：给挂在 watch 上的 agent 一条「该升级了」的单行非阻断提示。
// 优先级：低于服务端 min（协议可能已破，enforced 时更急）> 落后于最新发布版。都不落后则返回 null。
// 引导用 `party upgrade`——原地校验+替换二进制、**无需重跑接入包 / party init 重绑**（这正是 #703
// owner 的痛点：agent 常年靠人肉 curl install.sh + 重绑）。装二进制失败的兜底安装串仍随附。
export function upgradeHintForServer(
  serverVersion: { version: string; min_client_version: string; min_client_enforced: boolean },
  deps: { runningVersion?: string } = {},
): string | null {
  const min = serverMinVersionNotice(serverVersion.min_client_version, serverVersion.min_client_enforced, deps);
  if (min !== null) {
    return `${min.message} 原地升级：party upgrade（回退：${INSTALL_LINE}）`;
  }
  const behind = serverVersionUpgradeNotice(serverVersion.version, deps);
  if (behind !== null) {
    return `party CLI 有新版 v${behind.available_version}（当前 v${behind.running_version}）。原地升级：party upgrade，无需重跑接入包/重绑。`;
  }
  return null;
}

// re-exec 磁盘上的新二进制：spawn 同 argv、继承 stdio、detach，然后让调用方退出。
// PID 会变——launchctl KeepAlive 天然重启；nohup 场景新进程接管（旧进程退出）。
function defaultReexec(execPath: string, argv: string[]): void {
  Bun.spawn([execPath, ...argv], { stdio: ["inherit", "inherit", "inherit"] }).unref();
}

// serve 在唤醒间隙调用：有新版且 auto=true 就 re-exec 并返回 true（调用方应停循环退出）。
export function maybeReexecUpgrade(auto: boolean, deps: UpgradeDeps = {}): { pending: string | null; reexeced: boolean } {
  const pending = pendingUpgrade(deps);
  if (!pending) return { pending: null, reexeced: false };
  if (!auto) return { pending, reexeced: false };
  const execPath = deps.execPath ?? process.execPath;
  const argv = process.argv.slice(2);
  (deps.reexec ?? defaultReexec)(execPath, argv);
  return { pending, reexeced: true };
}
