// #197：serve 的唤醒上下文按 channel+seq 落盘，路径不含身份 → 同机多个 agent serve
// 同一频道时互相覆盖，runner 读到别人的上下文（self 是别人的名字），而 --runner claude|codex
// 把这个文件直接喂给模型。
//
// 回炉（190-codex-dev / LEO-MAIN on PR #208）：把身份塞进文件名是**有损映射**——
// `tenant|alice` 与 `tenant/alice` 消毒后同名；文件名也没有 server/profile 维度，
// 一个用户同时连 prod / test 私有部署仍会串；长 IdP subject 还会 ENAMETOOLONG。
// 正解是每个 serve 实例一个私有 mkdtemp 命名空间。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MsgFrame } from "@agentparty/shared";
import { createWakeContextDir, writeContextFile } from "../src/commands/serve";
import { msgFrame } from "./mock-server";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctxDir(): string {
  const d = createWakeContextDir();
  dirs.push(d);
  return d;
}

function frame(seq: number): MsgFrame {
  return msgFrame(seq, "@both of you", { mentions: ["alice", "bob"] }) as unknown as MsgFrame;
}

describe("serve 唤醒上下文按实例隔离 (#197 / #208 回炉)", () => {
  test("两个 serve 实例（同频道同 seq，不同身份）→ 不同文件，互不覆盖", () => {
    const a = writeContextFile(ctxDir(), frame(272), "dev", "alice", []);
    const b = writeContextFile(ctxDir(), frame(272), "dev", "bob", []);
    expect(a).not.toBe(b);
    expect(JSON.parse(readFileSync(a, "utf8")).self).toBe("alice");
    expect(JSON.parse(readFileSync(b, "utf8")).self).toBe("bob");
  });

  test("有损碰撞不复存在：`tenant|alice` 与 `tenant/alice` 是不同实例，写不到一起", () => {
    // 这两个身份任何「消毒成文件名」的方案都会映射成同名。私有目录方案里它们压根不进路径。
    const a = writeContextFile(ctxDir(), frame(9), "dev", "tenant|alice", []);
    const b = writeContextFile(ctxDir(), frame(9), "dev", "tenant/alice", []);
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(JSON.parse(readFileSync(a, "utf8")).self).toBe("tenant|alice");
    expect(JSON.parse(readFileSync(b, "utf8")).self).toBe("tenant/alice");
  });

  test("跨部署不串：同频道同身份同 seq，连 prod 与 test 的两个实例各写各的", () => {
    const a = writeContextFile(ctxDir(), frame(5), "agentparty", "leo", []);
    const b = writeContextFile(ctxDir(), frame(5), "agentparty", "leo", []);
    expect(a).not.toBe(b);
  });

  test("超长 IdP subject 不撑爆文件名（ENAMETOOLONG）", () => {
    const longSelf = "oidc|" + "x".repeat(4000);
    const p = writeContextFile(ctxDir(), frame(1), "dev", longSelf, []);
    expect(existsSync(p)).toBe(true);
    // 路径长度由目录决定，与身份长度无关
    expect(p.length).toBeLessThan(256);
    expect(JSON.parse(readFileSync(p, "utf8")).self).toBe(longSelf); // 正文里仍是原名
  });

  test("同一实例、同一 seq 重复写 → 同一路径（幂等，不堆垃圾）", () => {
    const d = ctxDir();
    const a = writeContextFile(d, frame(9), "dev", "alice", []);
    const b = writeContextFile(d, frame(9), "dev", "alice", []);
    expect(a).toBe(b);
    expect(readdirSync(d)).toHaveLength(1);
  });

  test("私有目录只有属主可进（0700）", () => {
    const d = ctxDir();
    const { statSync } = require("node:fs");
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });
});
