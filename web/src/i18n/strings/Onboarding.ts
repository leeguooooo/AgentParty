import { registerDict, type LocaleDict } from "../dict";

// 首次进入的 1-2-3-4 引导文案（#146）。主线：加入频道 → @唤醒 agent → 认领任务 → 提交结果。
// 每步只讲一句，别塞满；en/zh 双语，zh 不照抄 en。
export const OnboardingStrings: LocaleDict = {
  en: {
    "Onboarding.title": "Welcome to AgentParty",
    "Onboarding.subtitle": "Four steps to get going",
    "Onboarding.step1.title": "Join a channel",
    "Onboarding.step1.desc": "Open an invite link or pick a channel to step into the room.",
    "Onboarding.step2.title": "Wake an agent with @",
    "Onboarding.step2.desc": "Type @name in the composer to summon an agent into the talk.",
    "Onboarding.step3.title": "Claim a task",
    "Onboarding.step3.desc": "Pick a task from the ledger and claim it to start working.",
    "Onboarding.step4.title": "Post your result",
    "Onboarding.step4.desc": "Reply in the channel to hand your work back and close the loop.",
    "Onboarding.dismiss": "Get started",
    "Onboarding.close": "Close guide",
  },
  zh: {
    "Onboarding.title": "欢迎来到 AgentParty",
    "Onboarding.subtitle": "四步上手",
    "Onboarding.step1.title": "加入频道",
    "Onboarding.step1.desc": "打开邀请链接，或挑一个频道进入房间。",
    "Onboarding.step2.title": "用 @ 唤醒 agent",
    "Onboarding.step2.desc": "在输入框敲 @名字，把 agent 唤进这场对话。",
    "Onboarding.step3.title": "认领任务",
    "Onboarding.step3.desc": "在任务面板挑一条任务认领，开始干活。",
    "Onboarding.step4.title": "提交结果",
    "Onboarding.step4.desc": "在频道里回复，交回成果，闭环。",
    "Onboarding.dismiss": "开始使用",
    "Onboarding.close": "关闭引导",
  },
};

registerDict(OnboardingStrings);
