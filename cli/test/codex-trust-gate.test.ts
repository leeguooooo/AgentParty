// #942：`party wake check` 说对了病、开错了药。这里钉死那副药。
//
// 真实故障形态（owner 那台机器，2026-08-24 实测）：
//   - PATH 上的 `codex` 是 **0.145.0**（cmux 的 shim）—— 这个版本根本没有 hook 信任闸；
//   - 真正带闸的是 **/Applications/ChatGPT.app/Contents/Resources/codex**（0.149.0-alpha.4.1）；
//   - 而 ChatGPT.app 是 app-server 形态，**永远不会**自己弹出 "Hooks need review"。
// 我们过去给的修法是「新开一个 codex 交互式会话（直接跑 `codex`）」——照做什么也不会发生。
//
// 每个 fixture 都遵守一条纪律：**只让被测的那一道闸能决定结果**。凡是「某档单独满足条件就绿」
// 的写法（本仓 8-23 反复出现的假绿形态）在这里都配了一个只差那一个字段的对照 fixture。
import { describe, expect, test } from "bun:test";
import {
  appBundleName,
  codexTrustApprovalGuidance,
  codexVersionHasTrustGate,
  discoverCodexBinaries,
  executablePathFromPsLine,
  parseCodexVersion,
  probeCodexTrustGate,
  shellQuote,
  type CodexBinaryProbeDeps,
} from "../src/codex-trust-gate";
import type { CodexHookTarget, CodexTrustRemedy } from "../src/codex-hook-trust";

const DESKTOP = "/Applications/ChatGPT.app/Contents/Resources/codex";
const SHIM = "/var/folders/f1/xx/T/cmux-cli-shims/84883385/codex";
const GATED = "codex-cli 0.149.0-alpha.4.1";
const UNGATED = "codex-cli 0.145.0";

interface FakeWorld {
  /** 可执行文件 → `--version` 的输出（null = 跑得起来但读不出版本）。 */
  bins: Record<string, string | null>;
  /** `ps -axo args=` 的输出行。 */
  ps?: string[];
  /** PATH 上的目录，按查找顺序。 */
  pathDirs?: string[];
  /** 目录 → 条目（给 .app 扫描用）。 */
  dirs?: Record<string, string[]>;
  platform?: NodeJS.Platform;
  /** 每个二进制被 `--version` 探了几次——用来钉「够用就收工」。 */
  probes?: string[];
}

function fakeDeps(world: FakeWorld): CodexBinaryProbeDeps {
  const probes = world.probes ?? [];
  return {
    isExecutable: (p) => Object.prototype.hasOwnProperty.call(world.bins, p),
    fingerprint: (p) => (Object.prototype.hasOwnProperty.call(world.bins, p) ? "1:1" : null),
    listDir: (p) => world.dirs?.[p] ?? [],
    processCommandLines: () => world.ps ?? [],
    versionOf: (p) => {
      probes.push(p);
      return world.bins[p] ?? null;
    },
    realPath: (p) => p,
    pathDirs: world.pathDirs ?? [],
    home: "/Users/leo",
    platform: world.platform ?? "darwin",
  };
}

/** owner 那台机器：桌面版带闸、PATH 上是旧版。整个 issue 就是为这个形态开的。 */
/**
 * 单元测试一律不吃磁盘缓存：指向一个不存在的目录，读会失败、写也会失败（都是 fail-open），
 * 于是每次都真的走一遍探测逻辑——否则缓存会把被测的那道闸整个遮住。
 */
const NO_CACHE_ENV = { AGENTPARTY_HOME: "/nonexistent-agentparty-home-for-tests" } as NodeJS.ProcessEnv;

function ownerWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    bins: { [DESKTOP]: GATED, [SHIM]: UNGATED },
    ps: [`${DESKTOP} -c features.code_mode_host=true app-server --analytics-default-enabled`],
    dirs: { "/Applications": ["ChatGPT.app", "Safari.app"] },
    pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"],
    ...over,
  };
}

describe("版本判定：三态，说不准就不断言", () => {
  test("`codex-cli 0.149.0-alpha.4.1` 解析得出 0.149.0，且判定为带闸", () => {
    const v = parseCodexVersion(GATED);
    expect(v).toEqual({ major: 0, minor: 149, patch: 0, raw: GATED });
    expect(codexVersionHasTrustGate(v)).toBe(true);
  });

  // 阈值两侧各一个，且只差版本号一个变量——保证是「阈值」在决定，不是别的什么。
  test("0.148.x 判无闸，0.149.0 判有闸（阈值两侧只差版本号）", () => {
    expect(codexVersionHasTrustGate(parseCodexVersion("codex-cli 0.148.9"))).toBe(false);
    expect(codexVersionHasTrustGate(parseCodexVersion("codex-cli 0.149.0"))).toBe(true);
    expect(codexVersionHasTrustGate(parseCodexVersion("codex-cli 0.150.0"))).toBe(true);
    expect(codexVersionHasTrustGate(parseCodexVersion("codex-cli 1.0.0"))).toBe(true);
  });

  test("读不出版本 ⇒ null（说不准），绝不当成「旧版」", () => {
    expect(codexVersionHasTrustGate(parseCodexVersion(null))).toBeNull();
    expect(codexVersionHasTrustGate(parseCodexVersion(""))).toBeNull();
    expect(codexVersionHasTrustGate(parseCodexVersion("codex-cli (unknown)"))).toBeNull();
  });
});

describe("发现：探测本机，不硬编码 ChatGPT.app", () => {
  test("正在跑的 app-server 是最强证据，排在最前", () => {
    const found = discoverCodexBinaries(fakeDeps(ownerWorld()));
    expect(found[0]!.path).toBe(DESKTOP);
    expect(found[0]!.origin).toBe("running");
    expect(found[0]!.app).toBe("ChatGPT");
  });

  // 「不硬编码」的真正验收：换一个别的 app 名，照样找得到。
  test("任何 .app 里的 codex 都算数——判据是「装在 .app 里」，不是「叫 ChatGPT」", () => {
    const alt = "/Users/leo/Applications/Codex Desktop.app/Contents/Resources/codex";
    const found = discoverCodexBinaries(
      fakeDeps({
        bins: { [alt]: GATED },
        dirs: { "/Users/leo/Applications": ["Codex Desktop.app"] },
      }),
    );
    expect(found.map((f) => f.path)).toEqual([alt]);
    expect(found[0]!.app).toBe("Codex Desktop");
  });

  test("ps 行里带空格的 app 路径也认得出（逐段加长地试）", () => {
    const spaced = "/Applications/My Codex.app/Contents/Resources/codex";
    const deps = fakeDeps({ bins: { [spaced]: GATED } });
    expect(executablePathFromPsLine(`${spaced} app-server --flag`, deps)).toBe(spaced);
  });

  test("命令行里出现 codex 字样但可执行文件不是 codex ⇒ 不认（判据只看可执行文件本体）", () => {
    const deps = fakeDeps({ bins: { "/usr/bin/vim": null } });
    expect(executablePathFromPsLine("/usr/bin/vim codex-notes.md", deps)).toBeNull();
  });

  test("appBundleName 只认 .app 段", () => {
    expect(appBundleName(DESKTOP)).toBe("ChatGPT");
    expect(appBundleName("/opt/homebrew/bin/codex")).toBeNull();
  });

  test("非 darwin 不扫 .app 目录（那儿没有 app bundle 这回事）", () => {
    const found = discoverCodexBinaries(
      fakeDeps({ ...ownerWorld(), ps: [], platform: "linux" }),
    );
    expect(found.every((f) => f.app === null)).toBe(true);
  });
});

describe("探测：PATH 上那个是谁、谁带闸", () => {
  test("onPath 是 PATH 上第一个 codex —— 用户敲 `codex` 实际跑到的那个", () => {
    const p = probeCodexTrustGate(fakeDeps(ownerWorld()), NO_CACHE_ENV);
    expect(p.onPath?.path).toBe(SHIM);
    expect(p.onPath?.version).toBe(UNGATED);
    expect(p.onPath?.gate).toBe(false);
    expect(p.gated.map((g) => g.path)).toEqual([DESKTOP]);
    expect(p.desktop?.path).toBe(DESKTOP);
  });

  // 「够用就收工」：真机上 PATH 里那个 shim 一次 --version 要 2.6 秒，全探会让自检慢到没人用。
  test("拿到「带闸的一个」＋「PATH 上那个的版本」后就不再探别的", () => {
    const probes: string[] = [];
    const world = ownerWorld({
      probes,
      bins: { [DESKTOP]: GATED, [SHIM]: UNGATED, "/opt/homebrew/bin/codex": UNGATED },
      pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385", "/opt/homebrew/bin"],
    });
    const p = probeCodexTrustGate(fakeDeps(world), NO_CACHE_ENV);
    expect(probes).toEqual([DESKTOP, SHIM]);
    // 没探过的绝不谎称「版本读不出」。
    const skipped = p.candidates.find((c) => c.path === "/opt/homebrew/bin/codex");
    expect(skipped?.probed).toBe(false);
  });

  test("一个带闸的都没有时，候选会被探完——那一档要如实列出看到了什么", () => {
    const probes: string[] = [];
    const world = ownerWorld({
      probes,
      bins: { [DESKTOP]: UNGATED, [SHIM]: UNGATED, "/opt/homebrew/bin/codex": UNGATED },
      pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385", "/opt/homebrew/bin"],
    });
    const p = probeCodexTrustGate(fakeDeps(world), NO_CACHE_ENV);
    expect(probes.length).toBe(3);
    expect(p.gated).toEqual([]);
  });

  // CodeRabbit#943：装了一堆内置 codex 的 .app 时，PATH 上那个会被上限挤出名单——
  // 而「你敲 codex 跑到的是旧版」恰恰是本 issue 更要命的那一半，绝不能被挤掉。
  // fixture 只有一个变量：前面塞了多少个 .app 候选。
  test("候选多到超上限时，PATH 上那个仍在名单里、仍被探测", () => {
    const probes: string[] = [];
    const bins: Record<string, string | null> = { [SHIM]: UNGATED };
    const apps: string[] = [];
    // 20 个都不带闸：确保不会因为「找到带闸的就收工」而提前轮到 SHIM——
    // 只有「PATH 那个必须留、必须探」这条豁免能让它出现。
    for (let i = 0; i < 20; i += 1) {
      apps.push(`App${i}.app`);
      bins[`/Applications/App${i}.app/Contents/Resources/codex`] = UNGATED;
    }
    const p = probeCodexTrustGate(
      fakeDeps({ probes, bins, dirs: { "/Applications": apps }, pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"] }),
      NO_CACHE_ENV,
    );
    expect(p.candidates.map((c) => c.path)).toContain(SHIM);
    expect(probes).toContain(SHIM);
    expect(p.onPath?.version).toBe(UNGATED);
    expect(p.onPath?.gate).toBe(false);
    const text = [codexTrustApprovalGuidance(p).do, ...codexTrustApprovalGuidance(p).notes].join("\n");
    expect(text).toContain("没有 hook 信任闸");
  });

  // CodeRabbit#943：版本号是**外部二进制的 stdout**，会被原样印进终端。
  test("外部二进制吐出的 ANSI / 控制字符不会进到输出里", () => {
    const evil = "\u001b[2Kcodex-cli 0.145.0\u0007";
    const p = probeCodexTrustGate(
      fakeDeps({ bins: { [SHIM]: evil }, pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"] }),
      NO_CACHE_ENV,
    );
    expect(p.onPath?.version).toBe("codex-cli 0.145.0");
    const g = codexTrustApprovalGuidance(p);
    const text = [g.do, ...g.notes].join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });

  test("探测抛异常也不能炸——诊断路径 fail-open", () => {
    const deps = fakeDeps(ownerWorld());
    const boom: CodexBinaryProbeDeps = {
      ...deps,
      processCommandLines: () => {
        throw new Error("ps exploded");
      },
      listDir: () => {
        throw new Error("readdir exploded");
      },
    };
    expect(() => probeCodexTrustGate(boom, NO_CACHE_ENV)).not.toThrow();
    // 进程表和目录都炸了，PATH 那条路还在——降级不等于失明。
    expect(probeCodexTrustGate(boom, NO_CACHE_ENV).onPath?.path).toBe(SHIM);
  });

  test("单个二进制 --version 崩了，只丢它自己的版本，其余照常", () => {
    const deps = fakeDeps(ownerWorld());
    const partial: CodexBinaryProbeDeps = {
      ...deps,
      versionOf: (p) => {
        if (p === SHIM) throw new Error("shim exploded");
        return deps.versionOf(p);
      },
    };
    const probe = probeCodexTrustGate(partial, NO_CACHE_ENV);
    expect(probe.gated.map((g) => g.path)).toEqual([DESKTOP]);
    // 崩了的那个是「说不准」，不是「旧版」——下游据此不会去断言「用它批准不了」。
    expect(probe.onPath?.version).toBeNull();
    expect(probe.onPath?.gate).toBeNull();
  });

  // 这一条专门压外层那道兜底：pathDirs 在最外面被读，discoverCodexBinaries 里的分段 try 够不着它。
  test("最外层也有兜底：连 PATH 都读崩了也只是退化成「什么都没探到」，不抛", () => {
    const base = fakeDeps(ownerWorld());
    const hostile: CodexBinaryProbeDeps = Object.create(base) as CodexBinaryProbeDeps;
    Object.defineProperty(hostile, "pathDirs", {
      get(): string[] {
        throw new Error("PATH exploded");
      },
    });
    expect(() => probeCodexTrustGate(hostile, NO_CACHE_ENV)).not.toThrow();
    expect(probeCodexTrustGate(hostile, NO_CACHE_ENV)).toEqual({ onPath: null, candidates: [], gated: [], desktop: null });
    // 退化后给出的仍是一条不撒谎的建议。
    const g = codexTrustApprovalGuidance(probeCodexTrustGate(hostile, NO_CACHE_ENV));
    expect([g.do, ...g.notes].join("\n")).toContain("没探测到任何 codex 二进制");
  });
});

describe("修法：用户照做就能成功", () => {
  // #942 第二轮：修法的第一依据是**这几条 hook 在信任表里的状态**，不是「用哪个二进制」——
  // 真机验证已经证伪了「去 TUI 里批准」：codex 只对「新的或改动过的」hook 发问，
  // 带 trusted_hash 且 enabled=false 的它再也不会问。所以每个 fixture 都必须带上 remedy。
  const HOOKS = "/tmp/codexhome/hooks.json";
  const CONFIG = "/tmp/codexhome/config.toml";

  function target(kind: "codex-stop" | "codex-report", state: "disabled" | "absent"): CodexHookTarget {
    const event = kind === "codex-stop" ? "Stop" : "SessionStart";
    return {
      kind,
      label: kind === "codex-stop" ? "前台唤醒" : "会话入册",
      event,
      group: 2,
      index: 0,
      key: `${HOOKS}:${kind === "codex-stop" ? "stop" : "session_start"}:2:0`,
      command: `party hook ${kind}`,
      state,
      trustedHash: state === "disabled" ? "sha256:ours" : null,
    };
  }

  function remedyOf(state: "disabled" | "absent" | "none"): CodexTrustRemedy {
    const targets = state === "none" ? [] : [target("codex-stop", state), target("codex-report", state)];
    return {
      hooksPath: HOOKS,
      configPath: CONFIG,
      targets,
      enableable: targets.filter((t) => t.state === "disabled"),
      absent: targets.filter((t) => t.state === "absent"),
      snippet: targets.length === 0 ? [] : [`SNIPPET ${targets.map((t) => t.key).join(" ")}`],
      detail: "",
    };
  }

  const guidance = (world: FakeWorld, remedy: CodexTrustRemedy | null) =>
    codexTrustApprovalGuidance(probeCodexTrustGate(fakeDeps(world), NO_CACHE_ENV), remedy);
  const all = (g: { do: string; notes: string[] }) => [g.do, ...g.notes].join("\n");

  // ── owner 那台机器的真实死角：条目带着 hash 且 enabled=false，codex 再也不会问 ──
  test("能就地翻 ⇒ 主路径是 party hook install --codex，而不是去 codex 里等提示", () => {
    const g = guidance(ownerWorld(), remedyOf("disabled"));
    expect(g.do).toContain("party hook install --codex");
    expect(g.do).toContain("--yes");
    // 这句是第一轮给错的药，绝不能再出现在「现在只做这一件事」里。
    expect(g.do).not.toContain("直接跑 `codex`");
    expect(g.do).not.toContain(DESKTOP);
  });

  test("必须说清为什么不能靠 codex 弹窗（否则用户会以为我们绕过了什么）", () => {
    const text = all(guidance(ownerWorld(), remedyOf("disabled")));
    expect(text).toContain("只对「新的或改动过的」hook 发问");
    expect(text).toContain("再也不会问");
    expect(text).toContain("只动自己装的那两条");
  });

  test("桌面版形态：明说它不会自己弹 review", () => {
    const text = all(guidance(ownerWorld(), remedyOf("disabled")));
    expect(text).toContain("ChatGPT（桌面版）");
    expect(text).toContain("永远不会");
  });

  test("PATH 上版本过低：把版本号和路径都摆出来，明说批准不了（这条保留）", () => {
    const text = all(guidance(ownerWorld(), remedyOf("disabled")));
    expect(text).toContain(UNGATED);
    expect(text).toContain(SHIM);
    expect(text).toContain("没有 hook 信任闸");
    expect(text).toContain("startup_hooks_review.rs");
  });

  test("每一档都给得出兜底的「粘这个」——这是底线交付", () => {
    for (const state of ["disabled", "absent"] as const) {
      expect(all(guidance(ownerWorld(), remedyOf(state)))).toContain("SNIPPET");
    }
  });

  // ── 单闸对照：**只改条目状态**这一个变量，别的一个字不动，结论必须翻面 ──
  // 条目还没进过信任表 ⇒ codex 下次在带闸的 TUI 里确实会问，这一档才轮到形态探测出场。
  test("对照：条目还没进信任表 ⇒ 给带闸二进制的绝对路径（那条路这时是有效的）", () => {
    const g = guidance(ownerWorld(), remedyOf("absent"));
    expect(g.do).toContain(DESKTOP);
    expect(g.do).not.toContain("party hook install --codex");
  });

  test("对照：还没进信任表 + PATH 上那个自己带闸 ⇒ 直接跑 codex 就行", () => {
    const g = guidance(ownerWorld({ bins: { [DESKTOP]: GATED, [SHIM]: GATED } }), remedyOf("absent"));
    expect(g.do).toContain("直接跑 `codex`");
    expect(all(g)).not.toContain("没有 hook 信任闸");
  });

  test("对照：hooks.json 里根本没有我们的条目 ⇒ 先装，别乱指路", () => {
    const g = guidance(ownerWorld(), remedyOf("none"));
    expect(g.do).toContain("party hook install --codex");
    expect(all(g)).toContain("没找到我们自己的 hook 条目");
    expect(all(g)).toContain("不猜");
  });

  test("读不出 hooks.json / config.toml ⇒ 如实说，不猜路径", () => {
    const text = all(guidance({ bins: {} }, null));
    expect(text).toContain("读不出 codex 的 hooks.json / config.toml");
    expect(text).toContain("没探测到任何 codex 二进制");
    expect(text).toContain("不猜");
  });

  // 保守：说不准就别断言。
  test("版本读不出时不断言「用它批准不了」，只请用户自己核对", () => {
    const text = all(
      guidance(
        { bins: { [SHIM]: null }, pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"] },
        remedyOf("disabled"),
      ),
    );
    expect(text).toContain("读不出 PATH 上 codex 的版本");
    expect(text).toContain("--version");
    expect(text).not.toContain("没有 hook 信任闸");
    expect(text).not.toContain("批准不了");
  });

  // #926 划的死线，每一档都不许越。我们是**收集**用户的批准，不是**取消**这道闸。
  for (const [name, world, remedy] of [
    ["能就地翻", ownerWorld(), remedyOf("disabled")],
    ["还没进信任表", ownerWorld(), remedyOf("absent")],
    ["终端形态", ownerWorld({ bins: { [DESKTOP]: GATED, [SHIM]: GATED } }), remedyOf("absent")],
    ["什么都没探到", { bins: {} } as FakeWorld, null],
  ] as [string, FakeWorld, CodexTrustRemedy | null][]) {
    test(`${name}：绝不提 --dangerously-bypass-hook-trust`, () => {
      expect(all(guidance(world, remedy))).not.toContain("dangerously-bypass-hook-trust");
    });
  }

  test("带空格的路径会被引起来，粘进 shell 不会跑成两条命令", () => {
    const spaced = "/Applications/My Codex.app/Contents/Resources/codex";
    expect(shellQuote(spaced)).toBe(`'${spaced}'`);
    expect(shellQuote(DESKTOP)).toBe(DESKTOP);
  });
});
