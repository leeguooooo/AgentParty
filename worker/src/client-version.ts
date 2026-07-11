// CLI↔worker 版本协商（issue #137，发布/回滚与版本兼容维度）。
//
// CLI 按二进制分发天然滞后，协议破坏性变更（如 loop guard 默认值翻转）对老客户端此前无任何护栏。
// 这里让服务端声明一个「最低支持客户端版本」（min-version），并对带版本头的调用做判定：
//   - 默认「建言（advisory）」：低版本客户端照常放行，仅通过响应头 x-ap-client-too-old 给出可执行信号，
//     避免滞后的老客户端被一刀切锁死——护栏的意义是**信号**，不是墙。
//   - 仅当显式开启 MIN_CLIENT_ENFORCE 才硬拒（426 + 结构化 client_too_old），供必要时的紧急护栏。
// 缺版本头 = legacy/unknown，永不硬拒，也不打 too-old 标（避免误伤浏览器等本就不带头的客户端）。

export const CLIENT_VERSION_HEADER = "x-ap-client-version";
export const MIN_CLIENT_VERSION_HEADER = "x-ap-min-client-version";
export const CLIENT_TOO_OLD_HEADER = "x-ap-client-too-old";

// 默认最低版本：取一个保守下限，当前所有在跑的 CLI（0.2.x）都在其上，纯建言不打扰任何人；
// 运维可经 MIN_CLIENT_VERSION 环境变量把它收紧到某次破坏性变更之后的版本，逐步收紧而非一次锁死。
export const DEFAULT_MIN_CLIENT_VERSION = "0.2.0";

export const CLI_INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh";

// 与 do.ts 的 presence client_version 同一套字符集约束：首字符字母/数字，总长 ≤64。
const CLIENT_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function parseClientVersion(input: unknown): string | null {
  return typeof input === "string" && CLIENT_VERSION_RE.test(input) ? input : null;
}

// semver X.Y.Z 比较：a>b→1, a<b→-1, ==→0。只认前三段数字，其余（-beta.1 等预发行后缀）忽略。
// 规则与 cli/src/upgrade.ts 的 compareVersions 一致，两端对 min-version 的判定不会分叉。
export function compareClientVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 从环境变量解析声明的最低版本；缺失/非法一律回落到内置默认（绝不因配置错误意外锁死客户端）。
export function resolveMinClientVersion(raw: string | undefined | null): string {
  return parseClientVersion(typeof raw === "string" ? raw.trim() : "") ?? DEFAULT_MIN_CLIENT_VERSION;
}

// enforce 开关：仅接受常见真值串，其余（含缺省）一律视为关（默认建言、不硬拒）。
export function isEnforced(raw: string | undefined | null): boolean {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type ClientVersionStatus = "ok" | "too_old" | "unknown";

export interface ClientVersionVerdict {
  status: ClientVersionStatus;
  client_version: string | null;
  min_client_version: string;
}

// 判定调用方版本。缺头/非法头 → unknown（legacy，永不硬拒、不打标）；有头且低于下限 → too_old；否则 ok。
export function evaluateClientVersion(
  header: string | null | undefined,
  minVersion: string,
): ClientVersionVerdict {
  const parsed = parseClientVersion(header);
  if (parsed === null) return { status: "unknown", client_version: null, min_client_version: minVersion };
  const status: ClientVersionStatus = compareClientVersions(parsed, minVersion) < 0 ? "too_old" : "ok";
  return { status, client_version: parsed, min_client_version: minVersion };
}

// 破坏性版本护栏给过时客户端的结构化信号——形状对齐 cli 的 cli_upgrade（action_required + command），
// 让 runner 复用同一条「询问用户是否升级」的处理流。仅在 enforce 硬拒（426）时作为响应体返回。
export interface ClientTooOldNotice {
  error: { code: "client_too_old"; message: string };
  min_client_version: string;
  client_version: string | null;
  action_required: "ask_user";
  command: string;
}

export function clientTooOldNotice(verdict: ClientVersionVerdict): ClientTooOldNotice {
  return {
    error: {
      code: "client_too_old",
      message: `party CLI ${verdict.client_version ?? "(unknown)"} 低于服务端要求的最低版本 ${
        verdict.min_client_version
      }，请升级后重试：${CLI_INSTALL_COMMAND}`,
    },
    min_client_version: verdict.min_client_version,
    client_version: verdict.client_version,
    action_required: "ask_user",
    command: CLI_INSTALL_COMMAND,
  };
}
