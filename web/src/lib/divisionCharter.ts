// issue #150：把分工内容同步到公告（charter）时，这里负责纯文本合成/合并——
// "分工 -> markdown 小节 -> 写进公告全文" 三步中的前两步。写入只能由调用方在用户
// 明确点击「同步到公告」后触发；这个模块本身不碰网络、不碰 React。
//
// 合并策略：小节包在一对稳定的 HTML 注释 marker 里。已有 marker 就整体替换（避免
// 反复点「同步」在公告里堆出一串重复小节），没有就追加在末尾，两边都保留 marker
// 之外人工手写的公告正文不动。

const START_MARKER = "<!-- ap:division:start -->";
const END_MARKER = "<!-- ap:division:end -->";

export interface DivisionCharterRole {
  display: string;
  accountLabel: string;
  role: string;
  responsibility: string | null;
}

export interface DivisionCharterLabels {
  heading: string;
  empty: string;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatDivisionSection(roles: DivisionCharterRole[], labels: DivisionCharterLabels): string {
  const body =
    roles.length === 0
      ? labels.empty
      : roles
          .map((role) => {
            const resp = role.responsibility !== null && role.responsibility !== "" ? `：${role.responsibility}` : "";
            return `- **${role.display}**（${role.accountLabel}）— ${role.role}${resp}`;
          })
          .join("\n");
  return `${START_MARKER}\n### ${labels.heading}\n${body}\n${END_MARKER}`;
}

export function mergeDivisionIntoCharter(charterText: string, section: string): string {
  const markerRe = new RegExp(`${escapeForRegExp(START_MARKER)}[\\s\\S]*?${escapeForRegExp(END_MARKER)}`);
  if (markerRe.test(charterText)) {
    return charterText.replace(markerRe, section);
  }
  const trimmed = charterText.trimEnd();
  return trimmed === "" ? section : `${trimmed}\n\n${section}`;
}
