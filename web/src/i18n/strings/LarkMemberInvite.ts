import { registerDict, type LocaleDict } from "../dict";

export const LarkMemberInviteStrings: LocaleDict = {
  en: {
    "LarkInvite.title": "Invite from Lark",
    "LarkInvite.searchLabel": "Search Lark organization",
    "LarkInvite.placeholder": "Name",
    "LarkInvite.search": "Search",
    "LarkInvite.searching": "Searching...",
    "LarkInvite.empty": "No matching people",
    "LarkInvite.invite": "Invite",
    "LarkInvite.inviting": "Inviting...",
    "LarkInvite.added": "Added",
    "LarkInvite.more": "Load more",
    "LarkInvite.error.permission": "Lark contact permission is not enabled for this deployment.",
    "LarkInvite.error.forbidden": "Only a Lark organization administrator for this channel can use this directory.",
    "LarkInvite.error.rateLimited": "Too many searches. Wait a moment and try again.",
    "LarkInvite.error.search": "The Lark directory is unavailable.",
    "LarkInvite.error.invite": "The Lark member could not be invited.",
  },
  zh: {
    "LarkInvite.title": "从 Lark 邀请",
    "LarkInvite.searchLabel": "搜索同组织成员",
    "LarkInvite.placeholder": "姓名",
    "LarkInvite.search": "搜索",
    "LarkInvite.searching": "搜索中...",
    "LarkInvite.empty": "没有匹配的成员",
    "LarkInvite.invite": "邀请",
    "LarkInvite.inviting": "邀请中...",
    "LarkInvite.added": "已添加",
    "LarkInvite.more": "加载更多",
    "LarkInvite.error.permission": "当前部署尚未开通 Lark 通讯录权限。",
    "LarkInvite.error.forbidden": "只有通过同组织 Lark 登录的频道管理员可以使用通讯录。",
    "LarkInvite.error.rateLimited": "搜索过于频繁，请稍后再试。",
    "LarkInvite.error.search": "暂时无法读取 Lark 通讯录。",
    "LarkInvite.error.invite": "无法邀请该 Lark 成员。",
  },
};

registerDict(LarkMemberInviteStrings);
