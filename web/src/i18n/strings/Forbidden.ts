import { registerDict, type LocaleDict } from "../dict";

// #919：按服务端 error.code 分叉的 403 文案。每条都必须给出「下一步能做什么」，
// 并把服务端原文带在 {detail} 里——排查时那句英文原文往往才是决定性的线索。
export const ForbiddenStrings: LocaleDict = {
  en: {
    "Forbidden.quotaExceeded": "Channel quota reached — archive or delete unused channels, or ask this instance's operator to raise the limit. Server said: {detail}",
    "Forbidden.readonly": "This token is read-only, so it can't perform this action. Sign in with (or switch to) a token that has write access. Server said: {detail}",
    "Forbidden.scopedToken": "This token is scoped to a single channel and can only create/act on that one. Server said: {detail}",
    "Forbidden.withDetail": "The server refused this request: {detail}",
  },
  zh: {
    "Forbidden.quotaExceeded": "已达频道数上限——先归档或删掉不用的频道，或找本实例运营方抬高上限。服务端原文：{detail}",
    "Forbidden.readonly": "这枚 token 是只读的，做不了这个操作。换一枚有写权限的 token 再试。服务端原文：{detail}",
    "Forbidden.scopedToken": "这枚 token 绑定在单个频道上，只能操作它自己 scope 的那一个。服务端原文：{detail}",
    "Forbidden.withDetail": "服务端拒绝了这次请求：{detail}",
  },
};

registerDict(ForbiddenStrings);
