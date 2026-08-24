// 「去哪个 codex 里批准这条 hook」——把修法从一句写死的话，换成对这台机器的探测（issue #942）。
//
// #910/#926 把接入的最后一步从「指令」改成了「验证」：`party wake check` 会说出还差几步。
// 但 owner 照着那句修法做了一遍，什么也没发生——**我们说对了病，开错了药**：
//
//   1. 我们说「新开一个 codex 交互式会话（直接跑 `codex`），启动时它会提示 Hooks need review」。
//      那个界面属于 codex 的**终端 TUI**（`tui/src/startup_hooks_review.rs`）。owner 用的是
//      **ChatGPT.app 桌面版**（app-server 形态），它不走 TUI 启动路径，**永远不会弹这个界面**。
//      于是他在等一个不存在的提示。
//   2. 「直接跑 `codex`」在他机器上跑到的是 PATH 上的 **0.145.0**（cmux 的 shim），而信任闸是
//      **0.149** 才引入的。用它开会话既不提示、也不需要批准——用户于是得出「批准了还是不行」
//      的错误结论，而真正带闸的那个二进制在 `/Applications/ChatGPT.app/Contents/Resources/codex`。
//
// 所以本模块只回答一个问题：**这台机器上，哪个 codex 二进制带信任闸？** 拿到答案才有资格给修法。
//
// 硬边界（沿用 #926，别越）：
//   - 绝不提、绝不写 `--dangerously-bypass-hook-trust`。那是让用户关掉一个安全控制来换我们的功能。
//   - 绝不硬编码 `/Applications/ChatGPT.app/...` 当唯一答案——用户可能装在别处、或用别的发行版。
//     探测不到就**如实说找不到并给出判据**，不猜一个路径让人去试（猜错＝再来一轮「照做了还是不行」）。
//   - 全路径 fail-open：任何一步探测失败都不能让 `party wake check` 挂掉或给出更糟的建议。
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { sanitizeSingleLine } from "./format";

/**
 * 信任闸最早出现在 codex **0.149**。
 *
 * 依据（2026-08-24 在 owner 那台机器上实测，不是拍脑袋的魔数）：
 *   - `/Applications/ChatGPT.app/Contents/Resources/codex`（codex-cli 0.149.0-alpha.4.1）的二进制里
 *     同时有 `tui/src/startup_hooks_review.rs` 与 `' hooks need review before they can run.'`；
 *   - `~/.local/bin/codex`（0.145.0）与 `~/Library/pnpm/codex`（0.144.4）里两者**都搜不到**。
 *
 * 这个阈值只用来**解释**，不用来放行：版本读不出时一律返回 null（说不准），
 * 绝不对着一个我们没读出版本的二进制断言「用它批准不了」。
 */
export const CODEX_TRUST_GATE_MIN_VERSION = { major: 0, minor: 149, patch: 0 } as const;

/** 每一句「这个版本没有信任闸」都必须带上判据，否则用户没法自己复核。 */
export const CODEX_TRUST_GATE_EVIDENCE =
  "判据：信任闸的那段 TUI（tui/src/startup_hooks_review.rs、\"Hooks need review\"）最早出现在 codex 0.149 的二进制里，0.145 及更早的二进制里搜不到。";

export interface CodexVersion {
  major: number;
  minor: number;
  patch: number;
  /** `codex --version` 的原文，报给用户时用它（别把 alpha 后缀吃掉）。 */
  raw: string;
}

/** `codex-cli 0.149.0-alpha.4.1` → 0.149.0。解析不出返回 null（＝说不准，不是「旧版」）。 */
export function parseCodexVersion(raw: string | null): CodexVersion | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === "") return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (m === null) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch, raw: text };
}

/**
 * 这个版本有没有 hook 信任闸。
 * true = 确知有；false = 确知没有；**null = 说不准**（版本拿不到或解析不了）。
 * 三态是刻意的：null 时我们只提示用户去核对，绝不断言。
 */
export function codexVersionHasTrustGate(version: CodexVersion | null): boolean | null {
  if (version === null) return null;
  const { major, minor, patch } = CODEX_TRUST_GATE_MIN_VERSION;
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

export type CodexBinaryOrigin = "running" | "app-bundle" | "path";

export interface CodexBinary {
  /** 绝对路径——给用户的修法就是让他跑这一行，所以必须是能直接粘贴的。 */
  path: string;
  origin: CodexBinaryOrigin;
  /** 所属 app bundle 的名字（`ChatGPT`）；不在 .app 里就是 null。用于「批准后重启它」。 */
  app: string | null;
  /** `codex --version` 原文；拿不到为 null。 */
  version: string | null;
  /** 三态，见 codexVersionHasTrustGate。 */
  gate: boolean | null;
  /**
   * 有没有真的去跑过 `--version`。false = 我们提前收工了，没探它。
   * 这一位是为了**别撒谎**：没探过就说「版本读不出」，会把一个好好的二进制说成坏的。
   */
  probed: boolean;
}

export interface CodexTrustGateProbe {
  /** 用户敲 `codex` 实际会跑到的那一个（PATH 上第一个）。找不到为 null。 */
  onPath: CodexBinary | null;
  /** 探到的全部候选，按证据强度排序（正在跑的 > 装在 .app 里的 > PATH 上的）。 */
  candidates: CodexBinary[];
  /** 其中**确知带闸**的那些，同序。空 = 这台机器上没找到能用来批准的 codex。 */
  gated: CodexBinary[];
  /** 探到的桌面版 codex（app-server 形态）。null = 没探到桌面形态。 */
  desktop: CodexBinary | null;
}

export interface CodexBinaryProbeDeps {
  isExecutable(path: string): boolean;
  listDir(path: string): string[];
  /** `ps -axo args=` 的每一行；拿不到返回空数组。 */
  processCommandLines(): string[];
  /** 跑 `<bin> --version` 拿原文；失败返回 null。 */
  versionOf(path: string): string | null;
  /** 解析到真身用于去重；失败原样返回。 */
  realPath(path: string): string;
  /** PATH 上的目录，按查找顺序。第一个命中的 codex 就是用户敲 `codex` 会跑到的那个。 */
  pathDirs: string[];
  home: string;
  platform: NodeJS.Platform;
}

/** 一次 wake check 最多发现这么多个二进制。 */
const MAX_CANDIDATES = 12;

/**
 * 最多跑这么多次 `--version`。
 * 真机实测：PATH 上那个 cmux shim 一次 `--version` 要 **2.6 秒**（它是个包装脚本，不是原生二进制），
 * 而这台机器上有 5 个 codex 在 PATH 上。无脑全探＝一次自检 5 秒以上。所以除了这个上限，
 * 下面还有「够用就收工」的提前退出。
 */
const MAX_VERSION_PROBES = 8;

/** ps 一行里，可执行文件路径最多由这么多个空格分隔的片段拼成（应对 `/Applications/My App.app/...`）。 */
const MAX_EXE_TOKENS = 6;

export function defaultCodexBinaryProbeDeps(
  env: NodeJS.ProcessEnv = process.env,
): CodexBinaryProbeDeps {
  return {
    isExecutable(path) {
      try {
        const st = statSync(path);
        if (!st.isFile()) return false;
        // win32 上 mode 位没意义，存在即算。
        return process.platform === "win32" ? true : (st.mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    listDir(path) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    processCommandLines() {
      if (process.platform === "win32") return [];
      try {
        const r = spawnSync("ps", ["-axo", "args="], { encoding: "utf8", timeout: 4000 });
        if (r.status !== 0 || typeof r.stdout !== "string") return [];
        return r.stdout.split("\n");
      } catch {
        return [];
      }
    },
    versionOf(path) {
      try {
        // 参数走数组、不过 shell，路径不会被当命令拼接；输出上限防一个坏二进制把我们撑爆。
        const r = spawnSync(path, ["--version"], {
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        });
        const text = typeof r.stdout === "string" ? r.stdout.trim() : "";
        if (text === "") return null;
        // 只负责取第一行原文；ANSI / 控制字符的清理统一在 probeCodexTrustGate 里做——
        // 那是所有 deps 实现的**唯一**收口，放在这里会让替换掉 deps 的调用方绕过它。
        return text.split("\n")[0]!.trim();
      } catch {
        return null;
      }
    },
    realPath(path) {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    pathDirs: (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d.trim() !== ""),
    home: homedir(),
    platform: process.platform,
  };
}

/** 路径里那个 `<名字>.app` 段 → `<名字>`。不在 .app 里返回 null。 */
export function appBundleName(path: string): string | null {
  for (const seg of path.split("/")) {
    if (seg.length > 4 && seg.endsWith(".app")) return seg.slice(0, -4);
  }
  return null;
}

function codexNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat", "codex"] : ["codex"];
}

/**
 * 从一行 `ps` 输出里抠出可执行文件的绝对路径。
 *
 * 不能简单地按空格取第一段：`/Applications/My App.app/Contents/Resources/codex` 会被截断。
 * 所以逐段加长地试，第一个**真实存在且可执行**的前缀就是它。试不出来就返回 null（少认一个，
 * 不会认错一个）——.app 目录扫描那条路会把带空格的桌面版补回来。
 */
export function executablePathFromPsLine(line: string, deps: CodexBinaryProbeDeps): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("/")) return null;
  const tokens = trimmed.split(" ");
  for (let i = 1; i <= Math.min(tokens.length, MAX_EXE_TOKENS); i += 1) {
    const candidate = tokens.slice(0, i).join(" ");
    if (!codexNames(deps.platform).includes(basename(candidate))) continue;
    if (deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

function appRoots(deps: CodexBinaryProbeDeps): string[] {
  if (deps.platform !== "darwin") return [];
  return ["/Applications", "/Applications/Utilities", "/System/Applications", join(deps.home, "Applications")];
}

/**
 * 找出这台机器上所有的 codex 二进制，按证据强度排序：
 *   1. **正在跑的** —— 最强证据：这就是用户此刻真正在用的那个（桌面版的 app-server 也在这里现身）；
 *   2. 装在 `.app` 里的 —— 桌面版此刻没开着时靠它；扫的是「所有 .app」，不是写死某一个；
 *   3. PATH 上的 —— 用户敲 `codex` 会跑到的。
 * 不做版本探测，纯发现。任何一步失败都只是少发现几个，不抛。
 */
export function discoverCodexBinaries(deps: CodexBinaryProbeDeps): CodexBinary[] {
  const out: CodexBinary[] = [];
  const seen = new Set<string>();
  // PATH 上第一个 codex 永远要进名单：「你敲 `codex` 跑到的是没有信任闸的旧版」是本 issue
  // 更要命的那一半，绝不能因为这台机器 .app 装得多、把它挤出上限而说不出来。
  const mustKeep = firstCodexOnPath(deps);
  const push = (path: string, origin: CodexBinaryOrigin): void => {
    if (out.length >= MAX_CANDIDATES && path !== mustKeep) return;
    if (!isAbsolute(path)) return;
    let key: string;
    try {
      key = deps.realPath(path);
    } catch {
      key = path;
    }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, origin, app: appBundleName(path), version: null, gate: null, probed: false });
  };

  try {
    for (const line of deps.processCommandLines()) {
      if (!line.includes("codex")) continue;
      const exe = executablePathFromPsLine(line, deps);
      if (exe !== null) push(exe, "running");
    }
  } catch {
    /* fail-open：探不到进程表就少一路证据，不影响其余 */
  }

  try {
    for (const root of appRoots(deps)) {
      for (const entry of deps.listDir(root)) {
        if (!entry.endsWith(".app")) continue;
        const candidate = join(root, entry, "Contents", "Resources", "codex");
        if (deps.isExecutable(candidate)) push(candidate, "app-bundle");
      }
    }
  } catch {
    /* 同上 */
  }

  try {
    for (const dir of deps.pathDirs) {
      for (const name of codexNames(deps.platform)) {
        const candidate = join(dir, name);
        if (deps.isExecutable(candidate)) {
          push(candidate, "path");
          break;
        }
      }
    }
  } catch {
    /* 同上 */
  }

  return out;
}

/** PATH 上第一个 codex —— 用户敲 `codex` 实际跑到的就是它。 */
export function firstCodexOnPath(deps: CodexBinaryProbeDeps): string | null {
  for (const dir of deps.pathDirs) {
    for (const name of codexNames(deps.platform)) {
      const candidate = join(dir, name);
      if (deps.isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

const EMPTY_PROBE: CodexTrustGateProbe = { onPath: null, candidates: [], gated: [], desktop: null };

/** 没被探过的候选怎么描述——绝不说成「版本读不出」（那是另一回事）。 */
function versionLabel(b: CodexBinary): string {
  if (b.version !== null) return b.version;
  return b.probed ? "版本读不出" : "未探测";
}

/**
 * 发现 + 版本探测，得到一份「这台机器上谁带信任闸」。
 *
 * 整体包在 try 里：这是**诊断**路径，宁可退化成「说不准」，也绝不能让 `party wake check` 本身挂掉。
 */
export function probeCodexTrustGate(
  deps: CodexBinaryProbeDeps = defaultCodexBinaryProbeDeps(),
): CodexTrustGateProbe {
  try {
    const found = discoverCodexBinaries(deps);
    const pathReal = firstCodexOnPath(deps);
    // PATH 上那个可能已经在发现阶段被按 realpath 去重掉了（`~/.bun/bin/codex` 常是个软链）。
    // 所以这里也按 realpath 认人，别因为字面路径不同就把它当成「没探过」。
    const key = (path: string): string => {
      try {
        return deps.realPath(path);
      } catch {
        return path;
      }
    };
    const pathKey = pathReal === null ? null : key(pathReal);
    const onPathIndex = pathKey === null ? -1 : found.findIndex((b) => key(b.path) === pathKey);
    // 我们只需要两个事实：**PATH 上那个的版本**（版本错配是本 issue 更要命的一半）和
    // **一个确知带闸的二进制**（修法要给它的绝对路径）。两个都拿到就收工——继续探下去
    // 只会让自检变慢，不会让建议更对。一个带闸的都没找到时才会把候选真的探完，
    // 因为那一档要如实列出「我们看到了什么」。
    let gatedFound = false;
    let onPathProbed = onPathIndex < 0;
    let probes = 0;
    const candidates = found.map((b, i) => {
      // wantOnPath 同时豁免「够用就收工」和探测次数上限——理由同 mustKeep。
      const wantOnPath = !onPathProbed && i === onPathIndex;
      if (!wantOnPath && ((gatedFound && onPathProbed) || probes >= MAX_VERSION_PROBES)) return b;
      probes += 1;
      // 单个二进制探崩了只该丢掉它自己的版本，不该把整份探测拖垮——PATH 上那个 shim 是外部脚本，
      // 我们对它一无所知。外层还有一道兜底，这里是**降级**而不是重复保险。
      let version: string | null;
      try {
        // `--version` 是**外部二进制的 stdout**，最终会被原样印进终端。剥掉 ANSI / 控制字符，
        // 否则一行版本号就能伪造出别的输出行（#652 同款）。这里是唯一收口，别挪到 deps 里去。
        const raw = deps.versionOf(b.path);
        const clean = raw === null ? "" : sanitizeSingleLine(raw).trim();
        version = clean === "" ? null : clean;
      } catch {
        version = null;
      }
      const gate = codexVersionHasTrustGate(parseCodexVersion(version));
      if (gate === true) gatedFound = true;
      if (i === onPathIndex) onPathProbed = true;
      return { ...b, version, gate, probed: true };
    });
    const resolved = onPathIndex < 0 ? undefined : candidates[onPathIndex];
    const onPath: CodexBinary | null =
      pathReal === null
        ? null
        : resolved === undefined
          ? { path: pathReal, origin: "path", app: appBundleName(pathReal), version: null, gate: null, probed: false }
          // 报给用户的是**他敲 `codex` 会跑到的**那个字面路径，不是去重后的真身路径。
          : { ...resolved, path: pathReal };
    return {
      onPath,
      candidates,
      gated: candidates.filter((c) => c.gate === true),
      // 桌面形态的判据是「这个 codex 装在一个 .app 里」，不是「它叫 ChatGPT」。
      desktop: candidates.find((c) => c.app !== null) ?? null,
    };
  } catch {
    return EMPTY_PROBE;
  }
}

export interface CodexTrustApprovalGuidance {
  /** 现在就该做的那一件事，一行，可直接粘贴。 */
  do: string;
  /** 必须一起说的话：版本错配警告、桌面版要重启、codex exec 不触发 hook。 */
  notes: string[];
}

/**
 * 路径进终端前的清理。路径片段来自 `ps` 输出、PATH 环境变量与 readdir——都不是我们写的。
 * 执行时用的仍是原始路径，只有**印给人看**的那一份走这里。
 */
export function displayPath(path: string): string {
  return sanitizeSingleLine(path);
}

/** 路径里有空格就加引号，否则用户粘进 shell 会跑成两条命令。 */
export function shellQuote(path: string): string {
  const safe = displayPath(path);
  return /^[A-Za-z0-9_.\-/]+$/.test(safe) ? safe : `'${safe.replaceAll("'", "'\\''")}'`;
}

function describe(b: CodexBinary): string {
  return `${displayPath(b.path)}（${versionLabel(b)}）`;
}

/**
 * 一份探测 → 一条**用户照做就能成功**的修法。
 *
 * 分叉的依据是「哪个二进制带闸」，不是「用户自称用桌面版还是终端」——用户答不上来这个问题，
 * 而二进制我们探得到。三种结局，各自都不留「无可奉告」的出口：
 *   A. PATH 上那个就带闸 ⇒ 维持原来的说法（直接跑 `codex`），这是终端形态的正路；
 *   B. PATH 上那个不带闸 / 说不准，但别处有带闸的 ⇒ 给**那个二进制的绝对路径**；
 *   C. 一个带闸的都没找到 ⇒ 如实说找不到 + 给判据 + 列出探到了什么。**绝不猜一个路径让人去试。**
 */
export function codexTrustApprovalGuidance(probe: CodexTrustGateProbe): CodexTrustApprovalGuidance {
  const notes: string[] = [];
  const onPath = probe.onPath;
  const pathGate = onPath?.gate ?? null;

  // 桌面版永远不会自己弹出那个界面——这是本 issue 的第一处错，任何一档都必须说。
  const desktopNote = (app: string | null): string =>
    `${app === null ? "桌面版 codex" : `${sanitizeSingleLine(app)}（桌面版）`}是 app-server 形态，不走 TUI 启动路径，【永远不会】自己弹出 "Hooks need review"；` +
    "它和终端里的 codex 共用同一份 ~/.codex/config.toml，所以在终端批准一次就对它生效——批准完把它重启一下。";

  // A：PATH 上就带闸 —— 终端形态的正路，文案保持不变。
  if (pathGate === true) {
    if (probe.desktop !== null && probe.desktop.path !== onPath?.path) notes.push(desktopNote(probe.desktop.app));
    return {
      do:
        "新开一个 codex 交互式会话（直接跑 `codex`）；启动时它会提示 \"Hooks need review\"，" +
        "在那里把 AgentParty 的 stop hook 选为启用。",
      notes,
    };
  }

  // 版本错配比「跑哪个二进制」更要命：不明说，用户会以为自己照做了。所以它排在最前面。
  if (pathGate === false && onPath !== null) {
    notes.push(
      `⚠ 你 PATH 上的 codex 是 ${onPath.version ?? "未知版本"}（${displayPath(onPath.path)}），这个版本【没有 hook 信任闸】——` +
        `用它开会话既不会提示、也批准不了；照着「直接跑 codex」做一遍会什么都不发生。${CODEX_TRUST_GATE_EVIDENCE}`,
    );
  } else if (onPath !== null) {
    notes.push(
      `⚠ 读不出 PATH 上 codex 的版本（${displayPath(onPath.path)}），无法判断它有没有信任闸——请自己核对一下（\`${shellQuote(onPath.path)} --version\`）。${CODEX_TRUST_GATE_EVIDENCE}`,
    );
  }

  // B：别处有确知带闸的 —— 给绝对路径。
  const target = probe.gated[0];
  if (target !== undefined) {
    if (target.app !== null) notes.push(desktopNote(target.app));
    else if (probe.desktop !== null) notes.push(desktopNote(probe.desktop.app));
    return {
      do:
        `在终端里跑一次【这个】二进制（不是 PATH 上的 \`codex\`）：${shellQuote(target.path)}` +
        `  —— 它是 ${target.version ?? "带信任闸的版本"}，启动时会提示 "Hooks need review"，在那里把 AgentParty 的 stop hook 选为启用，然后退出。`,
      notes,
    };
  }

  // C：一个都没找到。不猜路径——猜错就是再来一轮「照做了还是不行」。
  if (probe.desktop !== null) notes.push(desktopNote(probe.desktop.app));
  notes.push(
    probe.candidates.length === 0
      ? `这台机器上没探测到任何 codex 二进制（找过：正在跑的进程、/Applications 等目录下的 .app、PATH）。${CODEX_TRUST_GATE_EVIDENCE}`
      : `这台机器上没找到【确知带信任闸】的 codex 二进制。已探测到：${probe.candidates.map(describe).join("；")}。${CODEX_TRUST_GATE_EVIDENCE}`,
  );
  notes.push("我们不猜一个路径让你去试——猜错只会让你再得出一次「照做了还是不行」。");
  return {
    do: "先确认你实际在用的是哪个 codex（`codex --version` 要 ≥ 0.149），用【那一个】在终端开一次交互式会话，在 \"Hooks need review\" 里把 AgentParty 的 stop hook 选为启用。",
    notes,
  };
}
