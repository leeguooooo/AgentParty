// 频道实测(leo-zego-im/macmini/codex-002):内置 codex runner 跑在无网络沙箱,原 prompt 却教模型
// 用 `party send --reply-to` 自己发回频道 → 连续连接失败,还把「未能发回频道」误写进回复。
// 内置 runner 的输出本就由 serve 自动投递,模型不该(codex 也不能)自己 party send。
import { describe, expect, test } from "bun:test";
import { wakePrompt } from "../src/commands/serve";

describe("wakePrompt 内置 runner 投递契约", () => {
  const prompt = wakePrompt("/tmp/ctx.json", null); // 普通单频道内置 runner(非 managed profile)

  test("告诉模型:输出由 serve 自动发回,别自己 party send", () => {
    expect(prompt).toContain("serve 自动发回");
    expect(prompt).toContain("不要自己调用 `party send`");
  });

  test("不再教模型用 `party send --reply-to` 自己发回(无网络沙箱会失败的老指令已删)", () => {
    expect(prompt).not.toContain("`party send --reply-to <seq>` 发回本频道");
  });

  test("警告无网络沙箱下 party history/decision 直连会失败", () => {
    expect(prompt).toContain("无网络沙箱");
    expect(prompt).toContain("party history");
  });

  test("仍带上下文文件路径与先读上下文的引导", () => {
    expect(prompt).toContain("/tmp/ctx.json");
    expect(prompt).toContain("先读它");
  });

  // 隔离验证(#747 CodeRabbit):ADVISORY_FRONT_REMINDER 的改动不得泄漏到 managed/worker 路径——
  // 它们各自用 MANAGED_FRONT_/WORKER_ reminder,不该出现内置 advisory 特有的「serve 自动发回」措辞。
  const managedFront = { runtime_role: "front", protocol: "mcp", workers: [{ name: "w1" }] } as never;
  const worker = { runtime_role: "worker", protocol: "mcp", workers: [] } as never;

  test("managed front(有 worker)路径不受影响:走 JSON 契约、无内置 advisory 措辞", () => {
    const p = wakePrompt("/tmp/ctx.json", managedFront);
    expect(p).not.toContain("serve 自动发回");
    expect(p).not.toContain("不要自己调用 `party send`");
    expect(p).toContain("managed front agent"); // managed front 自己的契约仍在
  });

  test("worker 路径不受影响:走 execution worker 契约、无内置 advisory 措辞", () => {
    const p = wakePrompt("/tmp/ctx.json", worker);
    expect(p).not.toContain("serve 自动发回");
    expect(p).not.toContain("不要自己调用 `party send`");
    expect(p).toContain("execution worker"); // worker 契约仍在
  });
});
