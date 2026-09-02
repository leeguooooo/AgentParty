// docs/ 的双语约定：`X.md` 是英文正本，`X.zh.md` 是中文版，两个 README 各链各的。
//
// 我刚违反过一次：新写的 docs/self-host-intranet.md 里是**中文正文**——比缺英文更糟，
// 英文读者点进去看到的是自己读不懂的语言，而且从文件名上完全看不出来。
// 这种事不该靠人眼在 review 里抓，用守卫扫。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const docs = resolve(import.meta.dir, "..", "docs");
const all = readdirSync(docs).filter((f) => f.endsWith(".md"));
const zh = all.filter((f) => f.endsWith(".zh.md"));
const en = all.filter((f) => !f.endsWith(".zh.md"));

const cjkRatio = (text: string): number => {
  const cjk = [...text].filter((c) => c >= "一" && c <= "鿿").length;
  return text.length === 0 ? 0 : cjk / text.length;
};

describe("docs 双语约定", () => {
  test("每个 .zh.md 都有对应的英文正本", () => {
    const orphans = zh.filter((f) => !en.includes(f.replace(/\.zh\.md$/, ".md")));
    expect(orphans).toEqual([]);
  });

  /**
   * 历史遗留：这三份是中文正文占着英文文件名，且没有 .zh 变体。
   * 显式列出来而不是把阈值调松——**记录债务、禁止再增**。要还这笔债得真去翻译，
   * 那是独立的一件事；擅自改名会打断外部链接。
   */
  const KNOWN_CHINESE_ONLY = ["deploy-rollback.md", "loops-playbook.md", "party-etiquette.md"];

  test("英文正本里不能是中文正文（否则文件名在骗人）", () => {
    // 阈值给得宽松：正文里出现少量中文（指向中文版的那行链接、专有名词）是可以的；
    // 整篇中文一定会远超过它。
    const offenders = en
      .filter((f) => !KNOWN_CHINESE_ONLY.includes(f))
      .map((f) => ({ f, ratio: cjkRatio(readFileSync(join(docs, f), "utf8")) }))
      .filter(({ ratio }) => ratio > 0.05)
      .map(({ f, ratio }) => `${f} (${(ratio * 100).toFixed(1)}% 汉字)`);
    expect(offenders).toEqual([]);
  });

  test("白名单只减不增：里面的文件必须真存在，且不许有人往里加新的", () => {
    // 名单里的文件被翻译或删掉之后，要从名单里划掉——否则它会变成新债务的藏身处。
    for (const f of KNOWN_CHINESE_ONLY) expect(en).toContain(f);
    expect(KNOWN_CHINESE_ONLY).toHaveLength(3);
  });

  test("成对的文档要互相指得到（省得读者自己猜文件名）", () => {
    const missing: string[] = [];
    for (const z of zh) {
      const e = z.replace(/\.zh\.md$/, ".md");
      if (!en.includes(e)) continue;
      if (!readFileSync(join(docs, z), "utf8").includes(e)) missing.push(`${z} 没链到 ${e}`);
      if (!readFileSync(join(docs, e), "utf8").includes(z)) missing.push(`${e} 没链到 ${z}`);
    }
    expect(missing).toEqual([]);
  });
});
