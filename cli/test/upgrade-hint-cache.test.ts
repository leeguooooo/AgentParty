import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldProbeUpgrade, UPGRADE_HINT_TTL_MS } from "../src/upgrade-hint-cache";

// shouldProbeUpgrade 的落盘目录由 AGENTPARTY_HOME 决定（cache-slot → config.agentpartyHome）。
// 用临时 home 隔离，避免碰真实 ~/.agentparty。
let home: string;
let cwd: string;
const origHome = process.env.AGENTPARTY_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-uhc-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-uhc-cwd-"));
  process.env.AGENTPARTY_HOME = home;
  // cache-slot 会读 config 指纹；给个最小 config 让 readConfigWithSource 有据可依（缺了也只是 fingerprint 变化，不影响节流语义）。
  writeFileSync(join(cwd, ".agentparty.json"), JSON.stringify({ server: "https://s", token: "ap_x" }));
});

afterEach(() => {
  if (origHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

test("首次探测放行并落盘；同窗口内再问被拦", () => {
  const t0 = 1_000_000;
  expect(shouldProbeUpgrade("kyc", cwd, t0)).toBe(true);
  // 立即再问：仍在窗口内 → false
  expect(shouldProbeUpgrade("kyc", cwd, t0 + 1000)).toBe(false);
  expect(shouldProbeUpgrade("kyc", cwd, t0 + UPGRADE_HINT_TTL_MS - 1)).toBe(false);
});

test("超过 TTL 后再次放行", () => {
  const t0 = 2_000_000;
  expect(shouldProbeUpgrade("kyc", cwd, t0)).toBe(true);
  expect(shouldProbeUpgrade("kyc", cwd, t0 + UPGRADE_HINT_TTL_MS)).toBe(true);
  // 放行后又落了新时间戳，紧接着再问被拦
  expect(shouldProbeUpgrade("kyc", cwd, t0 + UPGRADE_HINT_TTL_MS + 5)).toBe(false);
});

test("不同频道各自独立节流", () => {
  const t0 = 3_000_000;
  expect(shouldProbeUpgrade("kyc", cwd, t0)).toBe(true);
  // 另一个频道第一次仍放行
  expect(shouldProbeUpgrade("ops", cwd, t0 + 1000)).toBe(true);
  // 各自窗口内再问都被拦
  expect(shouldProbeUpgrade("kyc", cwd, t0 + 2000)).toBe(false);
  expect(shouldProbeUpgrade("ops", cwd, t0 + 2000)).toBe(false);
});
