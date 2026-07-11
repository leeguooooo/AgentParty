// #137 供应链输入侧：产物侧（release.yml 的 cosign sign-blob + attest-build-provenance）
// 之前就做得不错，输入侧（依赖树自动更新 + 漏洞告警）是空白——.github/ 下只有
// workflows/，没有 dependabot/renovate 配置，"full check" 也没有 bun audit/lockfile
// 审计步骤。这里补两件事并守住不变量：
//   1. .github/dependabot.yml 存在、是合法 YAML、覆盖 bun/cargo/github-actions 三个生态。
//   2. release.yml 有一个 bun audit 步骤，且它不进 "full check" 的 needs（非阻断，
//      不能因为第三方新披露的 CVE 让历史 PR 突然变红）。
//
// YAML 解析用 Bun 内置的 Bun.YAML.parse（bun runtime 自带，无需额外依赖），
// 不是字符串猜测——真解析出对象后再断言字段。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type DependabotUpdate = {
  "package-ecosystem": string;
  directory: string;
  schedule?: { interval?: string };
  groups?: Record<string, { "update-types"?: string[] }>;
};

type DependabotConfig = {
  version: number;
  updates: DependabotUpdate[];
};

const repoRoot = join(import.meta.dir, "..");
const dependabotPath = join(repoRoot, ".github", "dependabot.yml");
const dependabotYaml = readFileSync(dependabotPath, "utf8");
const releaseYml = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

describe(".github/dependabot.yml (#137 供应链输入侧)", () => {
  test("是合法 YAML（真解析，不是字符串猜测）", () => {
    expect(() => Bun.YAML.parse(dependabotYaml)).not.toThrow();
  });

  const config = Bun.YAML.parse(dependabotYaml) as DependabotConfig;

  test("顶层 version: 2", () => {
    expect(config.version).toBe(2);
  });

  test("覆盖 bun / cargo / github-actions 三个生态", () => {
    const ecosystems = config.updates.map((u) => u["package-ecosystem"]);
    for (const eco of ["bun", "cargo", "github-actions"]) {
      expect(ecosystems).toContain(eco);
    }
  });

  test("bun 生态指向 workspace 根目录（单一 bun.lock 管住 5 个 workspace 成员）", () => {
    const bunEntry = config.updates.find((u) => u["package-ecosystem"] === "bun");
    expect(bunEntry?.directory).toBe("/");
  });

  test("cargo 生态指向 desktop/src-tauri（唯一的 Rust crate）", () => {
    const cargoEntry = config.updates.find((u) => u["package-ecosystem"] === "cargo");
    expect(cargoEntry?.directory).toBe("/desktop/src-tauri");
  });

  test("每个生态都配了 schedule.interval，且不是 daily（daily 太吵）", () => {
    for (const update of config.updates) {
      expect(update.schedule?.interval).toBeTruthy();
      expect(update.schedule?.interval).not.toBe("daily");
    }
  });

  test("每个生态都把 minor/patch 分组，避免逐包刷屏；major 不分组，单独出 PR 走人工审", () => {
    for (const update of config.updates) {
      const groupNames = Object.keys(update.groups ?? {});
      expect(groupNames.length).toBeGreaterThan(0);
      for (const group of Object.values(update.groups ?? {})) {
        const types = group["update-types"] ?? [];
        expect(types).toContain("minor");
        expect(types).toContain("patch");
        expect(types).not.toContain("major");
      }
    }
  });
});

describe("release.yml bun audit 步骤 (#137 供应链输入侧)", () => {
  test("release.yml 本身仍是合法 YAML（改动没有打断缩进/结构）", () => {
    expect(() => Bun.YAML.parse(releaseYml)).not.toThrow();
  });

  test("有 dependency-audit job 跑 bun audit", () => {
    expect(releaseYml).toContain("dependency-audit:");
    expect(releaseYml).toContain("bun audit");
  });

  test("dependency-audit 只在 PR 上跑（不在 main push / tag 上重复扫）", () => {
    expect(releaseYml).toMatch(/dependency-audit:[\s\S]*?if: github\.event_name == 'pull_request'/);
  });

  test("dependency-audit 非阻断：不进 required 门禁 \"full check\" 的 needs 列表", () => {
    const checkJobMatch = releaseYml.match(/\n  check:\n    name: full check\n    needs:\n([\s\S]*?)\n {4}if: always\(\)/);
    expect(checkJobMatch).not.toBeNull();
    const needsBlock = checkJobMatch?.[1] ?? "";
    expect(needsBlock).not.toContain("dependency-audit");
  });

  test('required 门禁 job 名字仍是 "full check"（改名会让分支保护的 required check 消失）', () => {
    expect(releaseYml).toContain("name: full check");
  });
});
