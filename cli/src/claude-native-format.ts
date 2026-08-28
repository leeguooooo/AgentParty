// 从**装着的 claude 二进制**里抠出原生 cross-session-message 的接收侧正则（issue #953）。
//
// 为什么需要它：我们发出去的那条消息格式是**逆向**出来的，而原生接收侧是一条
// **顺序固定的严格正则**——调一次属性顺序、加一个必选属性、换一个字符集，我们发的整条
// 消息就匹配不上。而失败表现是**接收方什么都不会发生，也不会报错**（socket 写成功、
// 对方一个字都收不到、两侧零告警）。
//
// 仓里原有的守卫钉的是**我们自己的输出**，防的是我们改坏自己；Claude 那边改了格式它照样
// 全绿。用「我们的输出没变」代替「原生还认不认」，正是拿便宜信号替真实判据。这个模块把
// 真实判据取回来：直接问二进制。
//
// 拿不到就 **skip 不红**：CI 上没装 claude 是常态，为此常红会让人把守卫关掉，那就白做了。
// 要抓的是「装了 claude 的开发机上原生格式已经变了」。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 原生严格解析器里那段可复核的事实。抠不出任何一项就返回 null（调用方 skip）。 */
export interface ClaudeNativeCrossSessionFormat {
  /** 接收侧那条严格正则的原文（属性顺序就固化在它里面）。 */
  strictSource: string;
  /** `from` 属性允许的字符集，例如 `A-Za-z0-9%:_/.\-`。 */
  fromCharset: string | null;
  /** `from-mode` 的合法取值。 */
  fromModes: string[] | null;
  /** 抠到的二进制路径，报错时打印出来好复核。 */
  binaryPath: string;
}

/** 找到本机 claude 二进制。找不到返回 null。 */
export function locateClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.AGENTPARTY_CLAUDE_BINARY;
  if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
  // 优先 versions 目录下最新的那个：`which claude` 常指向一个 shim/软链，strings 抠不到东西。
  const versions = join(env.HOME ?? homedir(), ".local", "share", "claude", "versions");
  try {
    // 按**语义序**挑最新，不能用字典序：`2.1.9` 字典序排在 `2.1.246` 之后，会挑到旧版本，
    // 于是守卫拿一个过时二进制的格式去核对——比不核还糟（它会给出肯定但过时的结论）。
    const entries = readdirSync(versions)
      .map((name) => ({ name, parts: name.split(".").map((n) => Number.parseInt(n, 10)) }))
      .filter((e) => e.parts.every((n) => Number.isFinite(n)) && e.parts.length > 0)
      .sort((a, b) => {
        const len = Math.max(a.parts.length, b.parts.length);
        for (let i = 0; i < len; i += 1) {
          const d = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
          if (d !== 0) return d;
        }
        return 0;
      });
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const p = join(versions, entries[i]!.name);
      if (existsSync(p)) return p;
    }
  } catch {
    /* 目录不在，继续走 PATH */
  }
  // 显式指了路径却不存在 ⇒ 调用方是在**要求用这一个**（测试/定向诊断），不要偷偷回落到
  // PATH 上另一个 claude —— 那会让"降级路径"的行为取决于跑测试的机器装没装 claude。
  if (explicit !== undefined && explicit !== "") return null;
  const which = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8", timeout: 5_000 });
  const path = (which.stdout ?? "").trim();
  return path !== "" && existsSync(path) ? path : null;
}

/**
 * 从二进制里读出原生格式。
 *
 * 锚点选的是接收侧那条严格正则里**独一无二**的片段（`from-session="(` 紧跟在
 * `cross-session-message` 之后的那一段）——用它定位，比按行号或偏移量稳。
 */
export function readClaudeNativeCrossSessionFormat(
  binaryPath: string,
): ClaudeNativeCrossSessionFormat | null {
  const res = spawnSync("strings", ["-a", binaryPath], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.status !== 0 || typeof res.stdout !== "string") return null;
  const lines = res.stdout.split("\n");

  // 锚点只能用 `from-session="(` ——严格正则那行里标签是模板占位符 `${f}`，**不含**
  // 字面量 `cross-session-message`；要求两者同时出现会永远匹配不上（这一条是实测踩出来的）。
  // 再要求它同时含 hop-chain 与 from-mode，把它与别处零散的 from-session 提及区分开。
  const strict = lines.find((l) =>
    l.includes('from-session="(') && l.includes('hop-chain="(') && l.includes('from-mode="('),
  );
  if (strict === undefined) return null;

  // 按**内容特征**找，不按变量名：压缩过的产物里变量名（m / y）随构建变化，
  // 而「这串字符集」和「这个取值列表」本身是稳定的。
  const charset = lines.find((l) => /^[A-Za-z0-9%:_/.\\-]+$/.test(l) && l.includes("A-Za-z0-9%")) ?? null;

  // 真的把取值抠出来，不要"确认含某串之后返回硬编码列表"——那样原生新增一个 mode
  // （例如变成 ["bypass","prompting","silent"]）时，我们仍然报告旧列表，守卫就瞎了。
  const modesLine = lines.find((l) => /\[\s*"bypass"\s*,\s*"prompting"[^\]]*\]/.test(l));
  const modesRaw = modesLine === undefined
    ? null
    : /\[\s*("bypass"\s*,\s*"prompting"[^\]]*)\]/.exec(modesLine)?.[1] ?? null;
  const modes = modesRaw === null
    ? null
    : modesRaw.split(",").map((v) => v.trim().replace(/^"|"$/g, "")).filter((v) => v !== "");

  return { strictSource: strict, fromCharset: charset, fromModes: modes, binaryPath };
}

/**
 * 把抠到的严格正则还原成可执行的 RegExp。
 *
 * 二进制里那段是**模板字符串**（`${vj}` `${ea}` `${t}` …），要把占位符替回真值才能用。
 * 任何一处还原不出就返回 null —— 宁可 skip，也不要拿一条半成品正则去判「原生不认」，
 * 那会变成一条骗人的红灯。
 *
 * #969：占位符**按角色**替，不按变量名。压缩产物里的变量名随构建变化（2.1.24x 之前是
 * `f/m/n/r/y`，之后成了 `vj/ea/t/r/ZP`），第一版按名替换在 2.1.247+ 上全部落空、守卫恒红——
 * 而属性顺序与框架一字未变。角色由占位符**所处的位置**决定：`^<${X}` / `</${X}>` 是标签名，
 * `[${X}]` 是 from 的字符集，`from-mode="(${X.join("|")})"` 是取值集，其余 `="(${X})"` 是
 * from-session / hop-chain 的内部格式（我们不复现，宽松占位）。
 */
const TEMPLATE_IDENT = String.raw`\$\{[A-Za-z_$][\w$]*\}`;

export function buildNativeStrictRegex(fmt: ClaudeNativeCrossSessionFormat): RegExp | null {
  const start = fmt.strictSource.indexOf("^<");
  if (start === -1) return null;
  const end = fmt.strictSource.indexOf("$`", start);
  if (end === -1) return null;
  let src = fmt.strictSource.slice(start, end + 1);
  if (fmt.fromCharset === null || fmt.fromModes === null) return null;
  src = src
    .replace(new RegExp(String.raw`^\^<${TEMPLATE_IDENT}`), "^<cross-session-message")
    .replace(new RegExp(String.raw`</${TEMPLATE_IDENT}>`, "g"), "</cross-session-message>")
    .replace(new RegExp(String.raw`\[${TEMPLATE_IDENT}\]`, "g"), `[${fmt.fromCharset}]`)
    .replace(
      new RegExp(String.raw`from-mode="\(\$\{[A-Za-z_$][\w$]*\.join\("\|"\)\}\)"`, "g"),
      `from-mode="(${fmt.fromModes.join("|")})"`,
    )
    // from-session / hop-chain 的取值形状我们不复现，用宽松占位——本守卫要抓的是
    // **属性顺序与框架**变没变，不是去复刻它们各自的内部格式。
    .replace(new RegExp(String.raw`="\(${TEMPLATE_IDENT}\)"`, "g"), '="([^"]*)"');
  if (src.includes("${")) return null;
  try {
    // 二进制里那段是**源码文本**：正则里的 `\s` 在源码里写作 `\\s`。逐个还原会漏
    // （第一版只还原了 \n / \r，漏了 \s / \S，导致 body 段匹配不上、守卫误报"原生不认"）。
    // 统一把双反斜杠折成单反斜杠（抠到的 charset 同样是源码文本，一并折）。
    return new RegExp(src.replace(/\\\\/g, "\\"));
  } catch {
    return null;
  }
}
