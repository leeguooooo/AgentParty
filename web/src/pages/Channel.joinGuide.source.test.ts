// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(import.meta.dir + "/Channel.tsx", "utf8");

// #1009：「接入凭证」面板的引导入口必须接到 AgentJoin 的四步 stepper 上——
// AgentTokens 只回调，stepper 只有一份（不许在面板里复制第二份）。
test("AgentTokens 的 onGuide 接到 AgentJoin 的 guideSession，并把面板切到 agentJoin", () => {
  expect(source).toContain("onGuide={openJoinGuide}");
  expect(source).toContain("onlineNames={memberOnlineNames}");
  expect(source).toContain("guideSession={joinGuideSession}");
  expect(source).toContain("const openJoinGuide = useCallback((session: JoinGuideSession) => {");
  expect(source).toContain("setJoinGuideSession(session);");
  expect(source).toContain('setActiveAdminSurface("agentJoin");');
  // 清理必须覆盖**所有**离开 agentJoin 的路径（含直接 setActiveAdminSurface(null) 的那些），
  // 所以判据是那个 effect，而不是只在 setAdminSurface 里清一次（pr_agent on #1010）。
  expect(source).toContain('if (activeAdminSurface !== "agentJoin") setJoinGuideSession(null);');
  expect(source).toContain("}, [activeAdminSurface]);");
  expect(source).not.toContain('if (!open || surface !== "agentJoin") setJoinGuideSession(null);');
});
