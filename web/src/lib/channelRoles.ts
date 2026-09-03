import type { CollaborationRole } from "@agentparty/shared";

/** 频道角色写接口的输入：角色 + 职责。汇报对象另走 reports_to。 */
export interface RoleDraft {
  role: CollaborationRole;
  responsibility: string;
}
