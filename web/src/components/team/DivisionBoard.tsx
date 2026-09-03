import { useEffect, useRef, useState } from "react";
import type { CollaborationRole, PresenceEntry, Sender } from "@agentparty/shared";
import type { ChannelIdentity, ChannelRoleInfo } from "../../lib/api";
import { OrgTreePreview } from "../OrgTreePreview";
import { buildOrgTree, type OrgMemberInput } from "../../lib/orgTree";
import { formatDivisionSection, mergeDivisionIntoCharter, type DivisionCharterRole } from "../../lib/divisionCharter";
import { declaredAgentRoles } from "../../lib/divisionSummary";
import { COLLAB_ROLES, roleDraftFrom, teamRoleBuckets, type RoleDraft } from "../../lib/channelRoles";
import { useT, type TFunc } from "../../i18n/useT";
import "../../i18n/strings/Channel";
import "../../i18n/strings/Composer";

function roleViewFor(role: ChannelRoleInfo, identity: ChannelIdentity | undefined, t: TFunc) {
  const kind = role.kind ?? identity?.kind ?? "agent";
  const account = role.account ?? identity?.account;
  const display = role.display ?? identity?.display ?? (kind === "human" && account ? account : role.name);
  const accountLabel = account && account !== "" ? account : kind === "human" ? display : t("Channel.roles.unowned");
  const owner = account && account !== display ? account : null;
  return { role, display, accountLabel, owner, kind };
}

function roleCountLabel(role: CollaborationRole, count: number, t: TFunc): string {
  return t("Channel.roles.roleCount", { role, count: String(count) });
}

export interface DivisionBoardProps {
  canModerate: boolean;
  slug: string;
  roles: ChannelRoleInfo[];
  roleDrafts: Record<string, RoleDraft>;
  roleError: string | null;
  roleSaving: string | null;
  roleName: string;
  roleDraft: RoleDraft;
  identities: ChannelIdentity[];
  presence: Record<string, PresenceEntry>;
  participants: Sender[];
  onlineNames?: ReadonlySet<string>;
  onRoleDraft: (name: string, draft: RoleDraft) => void;
  onNewRoleName: (name: string) => void;
  onNewRoleDraft: (draft: RoleDraft) => void;
  onSaveRole: (name: string, draft: RoleDraft) => Promise<boolean>;
  onSetReportsTo?: (name: string, reportsTo: string | null) => void;
  onDeleteRole: (name: string) => void;
  forceOpen?: boolean;
  // issue #150：一键把当前已声明分工同步进公告——DivisionBoard 只负责拼内容，
  // 落盘（网络请求 + rev 刷新）交给上层（Channel.tsx 已有 charter 状态机）。
  charterText: string | null;
  onSyncToCharter: (text: string) => void;
  syncingCharter: boolean;
  // issue #171：分工面板到「查看/编辑每个 agent 自己的规则」（AgentTokens，已在
  // commit 7f7e8e1 落地）的入口——门禁复用 Channel.tsx 里 AgentTokens 本身的门禁
  // （canMintAgent && accountKey !== null），不在这里重新定义一套。
  canManageAgentRules: boolean;
  manageableAgentAccount?: string | null;
  onOpenAgentRules: () => void;
  onOpenAgentRulesFor?: (name: string) => void;
  // issue #272（审计重开）：点分工面板里的某个成员，打开它的单 Agent 详情弹窗
  // （工作状态/历史工作内容/在线状态）。可选——未接的调用方（如既有测试）行内保持只读展示。
  onOpenAgentDetail?: (name: string) => void;
}

export function DivisionBoard({
  canModerate,
  slug,
  roles,
  roleDrafts,
  roleError,
  roleSaving,
  roleName,
  roleDraft,
  identities,
  presence,
  participants,
  onlineNames,
  onRoleDraft,
  onNewRoleName,
  onNewRoleDraft,
  onSaveRole,
  onSetReportsTo,
  onDeleteRole,
  forceOpen = false,
  charterText,
  onSyncToCharter,
  syncingCharter,
  canManageAgentRules,
  manageableAgentAccount,
  onOpenAgentRules,
  onOpenAgentRulesFor,
  onOpenAgentDetail,
}: DivisionBoardProps) {
  const t = useT();
  const [selfHintOpen, setSelfHintOpen] = useState(false);
  const [selfHintCopied, setSelfHintCopied] = useState(false);
  const [editingRoleName, setEditingRoleName] = useState<string | null>(null);
  const editingRoleNameRef = useRef<string | null>(null);
  const editableRolesRef = useRef<Map<string, ChannelRoleInfo>>(new Map());
  const onRoleDraftRef = useRef(onRoleDraft);
  const editButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  onRoleDraftRef.current = onRoleDraft;
  const [unassignedOpen, setUnassignedOpen] = useState(false);
  // #504 还原度：组织架构树默认折叠（设计里是个按钮，不是常驻大卡），点开才展开，别顶乱分工列表。
  // 成员页首先回答「频道里有哪些人、每个人有哪些 agent」；汇报关系只是次级信息。
  // 默认展开目录，避免用户进入 Members 后还要猜一次“组织架构”按钮才看得到 roster。
  const [orgOpen, setOrgOpen] = useState(true);
  useEffect(() => {
    if (!selfHintCopied) return;
    const timer = window.setTimeout(() => setSelfHintCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [selfHintCopied]);
  const selfReportCmd = `party status --channel ${slug} working --role worker --note ${JSON.stringify(
    t("Channel.roles.selfReport.exampleNote"),
  )}`;
  const copySelfReportCmd = () => {
    if (navigator.clipboard !== undefined) {
      void navigator.clipboard
        .writeText(selfReportCmd)
        .then(() => setSelfHintCopied(true))
        .catch(() => undefined);
    }
  };
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const roleBuckets = teamRoleBuckets(roles, presence, identities, participants, t);
  const selfRoles = roleBuckets.selfReported;
  editableRolesRef.current = new Map(
    [...roles, ...selfRoles].map((role) => [role.name, role]),
  );
  const resetRoleDraft = (name: string) => {
    const source = editableRolesRef.current.get(name);
    if (source !== undefined) onRoleDraftRef.current(name, roleDraftFrom(source));
  };
  const restoreEditButtonFocus = (name: string) => {
    globalThis.setTimeout(() => editButtonRefs.current.get(name)?.focus(), 0);
  };
  const cancelRoleEdit = (name: string, restoreFocus = true) => {
    if (roleSaving !== null) return;
    resetRoleDraft(name);
    editingRoleNameRef.current = null;
    setEditingRoleName(null);
    if (restoreFocus) restoreEditButtonFocus(name);
  };
  const beginRoleEdit = (name: string) => {
    if (roleSaving !== null) return;
    const previous = editingRoleNameRef.current;
    if (previous !== null && previous !== name) resetRoleDraft(previous);
    editingRoleNameRef.current = name;
    setEditingRoleName(name);
  };
  const finishRoleEdit = (name: string) => {
    editingRoleNameRef.current = null;
    setEditingRoleName(null);
    restoreEditButtonFocus(name);
  };
  useEffect(() => () => {
    const name = editingRoleNameRef.current;
    if (name !== null) resetRoleDraft(name);
  }, []);
  // issue #169：unassigned 也并入同一份 roleViews，保证 roster 完整。header 的
  // 「N 个分工」只数正式 channel_roles；presence self report 仍显示，但标为待确认。
  const unassigned = roleBuckets.unassigned;
  // 只有 channel_roles 是正式分工；presence 自报只是一条待确认 claim。
  const declaredCount = roles.length;
  const roleViews = [
    ...roles.map((role) => ({ ...roleViewFor(role, identityByName.get(role.name), t), source: "assigned" as const, name: role.name })),
    ...selfRoles.map((role) => ({ ...roleViewFor(role, identityByName.get(role.name), t), source: "self" as const, name: role.name })),
    ...unassigned.map((member) => ({ ...member, role: null, source: "unassigned" as const })),
  ]
    .sort(
      (a, b) =>
        a.accountLabel.localeCompare(b.accountLabel) ||
        (a.role?.role ?? "\uffff").localeCompare(b.role?.role ?? "\uffff") ||
        a.display.localeCompare(b.display),
    );
  // issue #168 + #370：只有 channel_roles assignment 是正式组织权威。
  // presence.lineage 仍可在运行时详情里解释派生关系，但不能提升成角色、负责人或汇报线。
  const knownAssignedNames = new Set(
    roleViews.filter((view) => view.source === "assigned").map((view) => view.name),
  );
  const roleViewsWithReports = roleViews.map((view) => ({
    ...view,
    reportsTo: view.source === "assigned" ? view.role?.reports_to ?? null : null,
  }));
  // self/unassigned 仍作为 roster 节点显示，但不携带正式 role/reportsTo/lead 语义。
  const orgMembers: OrgMemberInput[] = roleViewsWithReports.map((view) => ({
    name: view.name,
    display: view.display,
    role: view.source === "assigned" ? view.role?.role ?? null : null,
    reportsTo: view.reportsTo,
    kind: view.kind,
    accountLabel: view.accountLabel,
    source: view.source,
  }));
  const orgTree = buildOrgTree(orgMembers);
  const assignedRoleViews = roleViewsWithReports.filter((view) => view.role !== null);
  const groups: Array<{ accountLabel: string; roles: typeof roleViewsWithReports }> = [];
  for (const view of assignedRoleViews) {
    const current = groups.at(-1);
    if (current !== undefined && current.accountLabel === view.accountLabel) current.roles.push(view);
    else groups.push({ accountLabel: view.accountLabel, roles: [view] });
  }
  const roleCounts = COLLAB_ROLES
    .map((role) => ({
      role,
      count: roleViews.filter((item) => item.source === "assigned" && item.role?.role === role).length,
    }))
    .filter((item) => item.count > 0);

  // issue #150：拿当前正式分工（不含 self report 与未分工占位）拼成 markdown
  // 小节，合并进现有公告文本。这里只计算候选文本；写入必须由 moderator 明确点击
  // 「同步到公告」触发，挂载 Team、切换页签或刷新角色数据都不能产生隐式写操作。
  const declaredRoleIdentities = roleViews
    .filter(
      (view): view is typeof view & { role: NonNullable<typeof view.role> } =>
        view.source === "assigned" && view.role !== null,
    )
    .map((view) => ({
      ...view,
      kind: view.role.kind ?? identityByName.get(view.name)?.kind ?? presence[view.name]?.kind,
      roleName: view.role.role,
    }));
  const declared: DivisionCharterRole[] = declaredAgentRoles(
    declaredRoleIdentities.map((view) => ({
      name: view.name,
      display: view.display,
      kind: view.kind,
      role: view.roleName,
      source: view,
    })),
  )
    .map((view) => ({
      display: view.source.display,
      accountLabel: view.source.accountLabel,
      role: view.source.role.role,
      responsibility: view.source.role.responsibility,
    }));
  const currentCharterText = charterText ?? "";
  const nextCharterText = mergeDivisionIntoCharter(
    currentCharterText,
    formatDivisionSection(declared, {
      heading: t("Channel.roles.syncHeading"),
      empty: t("Channel.roles.syncEmpty"),
    }),
  );
  const syncDivisionToCharter = () => {
    if (charterText === null) return;
    onSyncToCharter(nextCharterText);
  };

  return (
    <details className="role-board" aria-label={t("Channel.roles.label")} open={forceOpen ? true : undefined}>
      <summary className="role-board-head">
        <div>
          <h2>{t("Channel.roles.label")}</h2>
          <p className="t-mono">{t("Channel.roles.help")}</p>
        </div>
        <div className="role-board-summary">
          <span className="t-mono role-board-count">{t("Channel.roles.count", { count: String(declaredCount) })}</span>
          {roleCounts.map((item) => (
            <span key={item.role} className="t-mono role-board-role-count">
              {roleCountLabel(item.role, item.count, t)}
            </span>
          ))}
        </div>
      </summary>
      <div className="role-board-body">
        <div className="role-board-actions">
          {canModerate && (
            <button
              type="button"
              className="d-btn role-sync-charter-btn"
              disabled={syncingCharter || charterText === null}
              onClick={syncDivisionToCharter}
            >
              {syncingCharter ? t("Channel.roles.syncingCharter") : t("Channel.roles.syncToCharter")}
            </button>
          )}
          {canManageAgentRules && (
            <button type="button" className="d-btn role-open-rules-btn" onClick={onOpenAgentRules}>
              {t("Channel.roles.openAgentRules")}
            </button>
          )}
          <button
            type="button"
            className="d-btn role-org-toggle"
            aria-expanded={orgOpen}
            aria-controls="division-org-tree"
            onClick={() => setOrgOpen((v) => !v)}
          >
            {t("Channel.roles.orgToggle")} <span aria-hidden="true">{orgOpen ? "▾" : "▸"}</span>
          </button>
        </div>
        <div className="role-selfhint">
          <button
            type="button"
            className="role-selfhint-toggle t-mono"
            aria-expanded={selfHintOpen}
            onClick={() => setSelfHintOpen((v) => !v)}
          >
            <span>{t("Channel.roles.selfReport.summary")}</span>
            <span className="role-selfhint-arrow" aria-hidden="true">{selfHintOpen ? "▾" : "▸"}</span>
          </button>
          {selfHintOpen && (
            <div className="role-selfhint-body">
              <p>{t("Channel.roles.selfReport.intro")}</p>
              <div className="role-selfhint-cmd">
                <code className="t-mono">{selfReportCmd}</code>
                <button type="button" className="d-btn role-selfhint-copy" onClick={copySelfReportCmd}>
                  {selfHintCopied ? t("Channel.roles.selfReport.copied") : t("Channel.roles.selfReport.copy")}
                </button>
              </div>
              <p className="t-mono role-selfhint-meta">{t("Channel.roles.selfReport.roles")}</p>
              <p className="role-selfhint-caveat">{t("Channel.roles.selfReport.hostCaveat")}</p>
            </div>
          )}
        </div>
        {orgOpen && (
          <OrgTreePreview
            id="division-org-tree"
            tree={orgTree}
            t={t}
            interactive={{
              canModerate,
              allNames: orgMembers
                .filter((member) => member.source === "assigned")
                .map((member) => member.name),
              busyName: roleSaving,
              onSetReportsTo: onSetReportsTo ?? (() => {}),
              onOpenMember: onOpenAgentDetail,
              onManageAgent: canManageAgentRules ? onOpenAgentRulesFor : undefined,
              manageableAccount: manageableAgentAccount,
            }}
          />
        )}
        {groups.length > 0 ? (
          <div className="role-account-list">
            {groups.map((group) => (
              <section key={group.accountLabel} className="role-account-group">
                <header className="role-account-head">
                  <span className="role-account-label">{group.accountLabel}</span>
                  <span className="t-mono role-account-count">
                    {t("Channel.roles.accountCount", { count: String(group.roles.length) })}
                  </span>
                </header>
                <div className="role-list">
                  {group.roles.map(({ role, display, owner, accountLabel, kind, source, name, reportsTo }) => {
                    // issue #169：role 为 null 代表「已连接/曾出现过，但从没声明过角色」的
                    // 未分工成员——只读展示占位文案，不接可编辑的 role-select/input（那需要一个
                    // 真实的 ChannelRoleInfo；moderator 要给他分工，走下面的「添加」新建行）。
                    const draftForRole = role !== null ? roleDrafts[role.name] ?? roleDraftFrom(role) : null;
                    const savingThisRole =
                      role !== null
                      && (roleSaving === role.name || (source === "self" && roleSaving === "__new__"));
                    // issue #168：汇报对象是否在本频道 roster 里可见——不可见就提示，帮助
                    // 发现/避免跨出本频道边界的汇报关系。
                    const reportsToVisible = reportsTo !== null && knownAssignedNames.has(reportsTo);
                    const online = onlineNames?.has(name) ?? presence[name]?.live === true;
                    const title = [
                      name !== display ? name : null,
                      t("Composer.owner", { account: accountLabel }),
                      t(`Composer.kind.${kind}`),
                      role !== null ? t("Composer.role", { role: role.role }) : null,
                      role?.responsibility ? t("Composer.responsibility", { responsibility: role.responsibility }) : null,
                    ].filter((part): part is string => part !== null).join("\n");
                    return (
                      <div
                        key={name}
                        className={`role-row role-row--card role-row--${role?.role ?? "unassigned"}`}
                        aria-busy={editingRoleName === role?.name && roleSaving !== null}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || role === null || editingRoleName !== role.name) return;
                          event.preventDefault();
                          event.stopPropagation();
                          cancelRoleEdit(role.name);
                        }}
                      >
                        <div className="role-person" title={title}>
                          <span
                            className={`role-live-dot${online ? " is-online" : ""}`}
                            role="img"
                            aria-label={t(online ? "Channel.team.member.online" : "Channel.team.member.offline")}
                          />
                          {onOpenAgentDetail !== undefined ? (
                            <button
                              type="button"
                              className="role-person-name role-person-name--btn t-mono"
                              data-team-member={name}
                              onClick={() => onOpenAgentDetail(name)}
                            >
                              {display}
                            </button>
                          ) : (
                            <span className="role-person-name t-mono">{display}</span>
                          )}
                          <span className={`role-kind role-kind--${kind}`}>{t(`Composer.kind.${kind}`)}</span>
                          {source === "assigned" && role !== null && role.role === "host" && (
                            <span className="role-lead-tag t-mono">{t("Channel.roles.channelLead")}</span>
                          )}
                          {source === "self" && <span className="role-source t-mono">{t("Channel.roles.selfReported")}</span>}
                          {source === "unassigned" && (
                            <span className="role-source role-source--unassigned t-mono">{t("Channel.roles.unassigned")}</span>
                          )}
                          {owner !== null && <span className="role-owner t-mono">{owner}</span>}
                          {reportsTo !== null && (
                            <span
                              className={"role-report" + (reportsToVisible ? "" : " role-report--external") + " t-mono"}
                            >
                              {reportsToVisible
                                ? t("Channel.roles.reportsTo", { parent: reportsTo })
                                : t("Channel.roles.reportsToExternal", { parent: reportsTo })}
                            </span>
                          )}
                        </div>
                        {role === null || draftForRole === null ? (
                          <span className="role-text role-text--unassigned">{t("Channel.roles.noRoleYet")}</span>
                        ) : canModerate && editingRoleName === role.name ? (
                          <>
                            <select
                              className="role-select t-mono"
                              aria-label={t("Channel.roles.roleLabel")}
                              value={draftForRole.role}
                              disabled={roleSaving !== null}
                              autoFocus
                              onChange={(e) => onRoleDraft(role.name, { ...draftForRole, role: e.target.value as CollaborationRole })}
                            >
                              {COLLAB_ROLES.map((item) => (
                                <option key={item} value={item}>{item}</option>
                              ))}
                            </select>
                            <input
                              className="role-input"
                              aria-label={t("Channel.roles.responsibilityLabel")}
                              value={draftForRole.responsibility}
                              disabled={roleSaving !== null}
                              onChange={(e) => onRoleDraft(role.name, { ...draftForRole, responsibility: e.target.value })}
                              autoComplete="off"
                              placeholder={t("Channel.roles.responsibilityPlaceholder")}
                            />
                            <button
                              className="d-btn"
                              type="button"
                              disabled={roleSaving !== null}
                              onClick={() => {
                                void onSaveRole(role.name, draftForRole)
                                  .then((saved) => {
                                    if (saved) finishRoleEdit(role.name);
                                  })
                                  .catch(() => undefined);
                              }}
                            >
                              {savingThisRole
                                ? t("Channel.roles.saving")
                                : source === "self"
                                  ? t("Channel.roles.saveAndConfirm")
                                  : t("Channel.roles.save")}
                            </button>
                            <button
                              className="d-btn"
                              type="button"
                              disabled={roleSaving !== null}
                              onClick={() => cancelRoleEdit(role.name)}
                            >
                              {t("Channel.roles.cancel")}
                            </button>
                            {source === "assigned" && (
                              <button className="d-btn" type="button" disabled={roleSaving !== null} onClick={() => onDeleteRole(role.name)}>
                                {t("Channel.roles.clear")}
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            <span className="role-badge t-mono">{role.role}</span>
                            <span className="role-text">{role.responsibility ?? t("Channel.roles.noResponsibility")}</span>
                            {canModerate && (
                              <button
                                className="d-btn role-edit-btn"
                                type="button"
                                data-role-edit={role.name}
                                ref={(node) => {
                                  if (node === null) editButtonRefs.current.delete(role.name);
                                  else editButtonRefs.current.set(role.name, node);
                                }}
                                disabled={roleSaving !== null}
                                onClick={() => beginRoleEdit(role.name)}
                              >
                                {source === "self" ? t("Channel.roles.confirm") : t("Channel.roles.edit")}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="charter-empty">{t("Channel.roles.empty")}</p>
        )}
        {unassigned.length > 0 && (
          <section className="role-unassigned-fold">
            <button
              type="button"
              className="role-unassigned-toggle t-mono"
              aria-expanded={unassignedOpen}
              onClick={() => setUnassignedOpen((open) => !open)}
            >
              <span aria-hidden="true">{unassignedOpen ? "▾" : "▸"}</span>
              <span>
                {t(canModerate ? "Channel.roles.unassignedFold" : "Channel.roles.unassignedFoldReadonly", {
                  count: String(unassigned.length),
                })}
              </span>
            </button>
            {unassignedOpen && (
              <div className="role-unassigned-chips">
                {unassigned.map((member) => canModerate ? (
                  <button
                    key={member.name}
                    type="button"
                    className="role-unassigned-chip role-person-name role-person-name--btn t-mono"
                    title={member.owner ?? member.accountLabel}
                    disabled={roleSaving !== null}
                    onClick={() => onNewRoleName(member.name)}
                  >
                    {member.display}
                  </button>
                ) : (
                  <span
                    key={member.name}
                    className="role-unassigned-chip role-person-name t-mono"
                    title={member.owner ?? member.accountLabel}
                  >
                    {member.display}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}
        {canModerate && (
          <div className="role-row role-row--new">
            <input
              className="role-name-input t-mono"
              aria-label={t("Channel.roles.nameLabel")}
              value={roleName}
              disabled={roleSaving !== null}
              onChange={(e) => onNewRoleName(e.target.value)}
              list="channel-role-targets"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("Channel.roles.namePlaceholder")}
            />
            <select
              className="role-select t-mono"
              aria-label={t("Channel.roles.roleLabel")}
              value={roleDraft.role}
              disabled={roleSaving !== null}
              onChange={(e) => onNewRoleDraft({ ...roleDraft, role: e.target.value as CollaborationRole })}
            >
              {COLLAB_ROLES.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <input
              className="role-input"
              aria-label={t("Channel.roles.responsibilityLabel")}
              value={roleDraft.responsibility}
              disabled={roleSaving !== null}
              onChange={(e) => onNewRoleDraft({ ...roleDraft, responsibility: e.target.value })}
              autoComplete="off"
              placeholder={t("Channel.roles.responsibilityPlaceholder")}
            />
            <button
              className="d-btn d-btn--primary"
              type="button"
              disabled={roleSaving !== null}
              onClick={() => {
                void onSaveRole(roleName, roleDraft).catch(() => undefined);
              }}
            >
              {roleSaving === "__new__" ? t("Channel.roles.saving") : t("Channel.roles.add")}
            </button>
            <datalist id="channel-role-targets">
              {identities.map((identity) => (
                <option key={identity.name} value={identity.name}>{identity.display}</option>
              ))}
            </datalist>
          </div>
        )}
        {roleError !== null && <p className="banner banner--red" role="alert">{roleError}</p>}
      </div>
    </details>
  );
}
