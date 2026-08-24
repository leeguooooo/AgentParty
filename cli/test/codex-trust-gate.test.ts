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
    const p = probeCodexTrustGate(fakeDeps(ownerWorld()));
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
    const p = probeCodexTrustGate(fakeDeps(world));
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
    const p = probeCodexTrustGate(fakeDeps(world));
    expect(probes.length).toBe(3);
    expect(p.gated).toEqual([]);
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
    expect(() => probeCodexTrustGate(boom)).not.toThrow();
    // 进程表和目录都炸了，PATH 那条路还在——降级不等于失明。
    expect(probeCodexTrustGate(boom).onPath?.path).toBe(SHIM);
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
    const probe = probeCodexTrustGate(partial);
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
    expect(() => probeCodexTrustGate(hostile)).not.toThrow();
    expect(probeCodexTrustGate(hostile)).toEqual({ onPath: null, candidates: [], gated: [], desktop: null });
    // 退化后给出的仍是一条不撒谎的建议。
    const g = codexTrustApprovalGuidance(probeCodexTrustGate(hostile));
    expect([g.do, ...g.notes].join("\n")).toContain("没探测到任何 codex 二进制");
  });
});

describe("修法：用户照做就能成功", () => {
  const guidance = (world: FakeWorld) => codexTrustApprovalGuidance(probeCodexTrustGate(fakeDeps(world)));
  const all = (g: { do: string; notes: string[] }) => [g.do, ...g.notes].join("\n");

  // ── 本 issue 的验收场景，逐字照抄 owner 的机器 ──────────────────────────────
  test("桌面版形态：给的是【那个二进制的绝对路径】，不是「直接跑 codex」", () => {
    const g = guidance(ownerWorld());
    expect(g.do).toContain(DESKTOP);
    // 这正是 owner 照着做、什么也没发生的那句话。它绝不能再出现在「现在只做这一件事」里。
    expect(g.do).not.toContain("直接跑 `codex`");
  });

  test("桌面版形态：明说它不会自己弹 review，批准后要重启", () => {
    const text = all(guidance(ownerWorld()));
    expect(text).toContain("ChatGPT（桌面版）");
    expect(text).toContain("永远不会");
    expect(text).toContain("重启");
    expect(text).toContain("~/.codex/config.toml");
  });

  test("PATH 上版本过低：把版本号和路径都摆出来，明说批准不了", () => {
    const text = all(guidance(ownerWorld()));
    expect(text).toContain(UNGATED);
    expect(text).toContain(SHIM);
    expect(text).toContain("没有 hook 信任闸");
    // 判据必须带上，否则用户没法自己复核这个 0.149 是怎么来的。
    expect(text).toContain("startup_hooks_review.rs");
  });

  // ── 单闸对照：只改「桌面二进制的版本」一个字段，结论必须翻面 ────────────────
  // 如果哪天把版本判定删掉、无脑指向桌面二进制，这条会红：桌面版也是 0.145 时它同样没有闸，
  // 指过去照样批不了，只能如实说「找不到」。
  test("对照：桌面二进制也是旧版时，绝不把它当答案", () => {
    const g = guidance(ownerWorld({ bins: { [DESKTOP]: UNGATED, [SHIM]: UNGATED } }));
    expect(g.do).not.toContain(DESKTOP);
    expect(all(g)).toContain("没找到");
  });

  // 同上，反向：只把 PATH 上那个换成带闸版本，就该退回终端形态的老文案。
  test("对照：PATH 上那个本身带闸 ⇒ 维持「直接跑 codex」（终端形态的正路）", () => {
    const g = guidance(
      ownerWorld({ bins: { [DESKTOP]: GATED, [SHIM]: GATED } }),
    );
    expect(g.do).toContain("直接跑 `codex`");
    expect(g.do).not.toContain(DESKTOP);
    // 版本没错配，就别拿版本吓唬人。
    expect(all(g)).not.toContain("没有 hook 信任闸");
    // 但桌面版还开着，「批准后重启它」这句仍然要说。
    expect(all(g)).toContain("重启");
  });

  test("一个带闸的都找不到：如实说找不到 + 给判据 + 列出探到了什么，不猜路径", () => {
    const g = guidance({
      bins: { [SHIM]: UNGATED },
      pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"],
    });
    const text = all(g);
    expect(text).toContain("没找到");
    expect(text).toContain(SHIM);
    expect(text).toContain("startup_hooks_review.rs");
    expect(text).toContain("不猜");
    // 绝不凭空给一个 /Applications/... 让用户去试。
    expect(text).not.toContain("/Applications/");
  });

  test("这台机器上一个 codex 都没有：说「没探测到」，不说「读不出版本」", () => {
    const text = all(guidance({ bins: {} }));
    expect(text).toContain("没探测到任何 codex 二进制");
  });

  // 保守：说不准就别断言。这是 issue 里点名的要求。
  test("版本读不出时不断言「用它批准不了」，只请用户自己核对", () => {
    const text = all(
      guidance({
        bins: { [SHIM]: null },
        pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"],
      }),
    );
    expect(text).toContain("读不出 PATH 上 codex 的版本");
    expect(text).toContain("--version");
    expect(text).not.toContain("没有 hook 信任闸");
    expect(text).not.toContain("批准不了");
  });

  // #926 划的死线，每一档都不许越。
  for (const [name, world] of [
    ["桌面版形态", ownerWorld()],
    ["终端形态", ownerWorld({ bins: { [DESKTOP]: GATED, [SHIM]: GATED } })],
    ["找不到带闸的", { bins: { [SHIM]: UNGATED }, pathDirs: ["/var/folders/f1/xx/T/cmux-cli-shims/84883385"] }],
    ["什么都没探到", { bins: {} }],
  ] as [string, FakeWorld][]) {
    test(`${name}：绝不提 --dangerously-bypass-hook-trust`, () => {
      expect(all(guidance(world))).not.toContain("dangerously-bypass-hook-trust");
    });
  }

  test("带空格的路径会被引起来，粘进 shell 不会跑成两条命令", () => {
    const spaced = "/Applications/My Codex.app/Contents/Resources/codex";
    expect(shellQuote(spaced)).toBe(`'${spaced}'`);
    expect(shellQuote(DESKTOP)).toBe(DESKTOP);
  });
});
