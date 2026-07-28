import { type ReactElement, useMemo, useState } from "react";
import type { TFunc } from "../i18n/useT";
import type { OrgTree, OrgTreeNode } from "../lib/orgTree";

// issue #281 + #370：频道组织/汇报关系整体预览。DivisionBoard 逐行标注汇报对象，这里折成
// 一棵可整体查看的组织架构图（办公软件式管理层级）。唯一权威来源是 channel_roles；
// moderator 只能编辑已有正式 assignment 的「向谁汇报」，自报/未分工节点保持只读。
// 树构建（含环/孤儿处理）在 lib/orgTree.ts。

interface OrgInteractive {
  canModerate: boolean;
  allNames: string[];
  busyName: string | null;
  onSetReportsTo: (name: string, reportsTo: string | null) => void;
  onOpenMember?: (name: string) => void;
  onManageAgent?: (name: string) => void;
  manageableAccount?: string | null;
}

export interface MemberDirectoryGroup {
  key: string;
  people: OrgTreeNode[];
  agents: OrgTreeNode[];
}

function flattenTree(tree: OrgTree): OrgTreeNode[] {
  const nodes: OrgTreeNode[] = [];
  const seen = new Set<string>();
  const visit = (node: OrgTreeNode) => {
    if (seen.has(node.name)) return;
    seen.add(node.name);
    nodes.push(node);
    node.children.forEach(visit);
  };
  tree.roots.forEach(visit);
  tree.unassigned.forEach(visit);
  return nodes;
}

function accountKey(node: OrgTreeNode): string {
  const account = node.accountLabel?.trim();
  return account === undefined || account === "" ? `unowned:${node.name}` : `account:${account}`;
}

export function buildMemberDirectory(tree: OrgTree): MemberDirectoryGroup[] {
  const groups = new Map<string, MemberDirectoryGroup>();
  for (const node of flattenTree(tree)) {
    const key = accountKey(node);
    const group = groups.get(key) ?? { key, people: [], agents: [] };
    const list = node.kind === "human" ? group.people : group.agents;
    // Lark/SSO 可能为同一个账号留下多个会话身份。目录按「账号 + 展示名」折叠，
    // 不再把同一个人重复画成两名成员；agent 仍按 runtime name 保留，便于逐个管理。
    if (
      node.kind === "agent"
      || !list.some((item) => item.display === node.display)
    ) {
      list.push(node);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.people.length > 0 || group.agents.length > 0)
    .sort((left, right) => {
      const leftLabel = left.people[0]?.display ?? left.agents[0]?.display ?? left.key;
      const rightLabel = right.people[0]?.display ?? right.agents[0]?.display ?? right.key;
      return leftLabel.localeCompare(rightLabel);
    });
}

function isOpaqueAccount(value: string | null): boolean {
  return value !== null && /^(?:lark|oidc|apple|github):/i.test(value);
}

function agentLabel(node: OrgTreeNode, t: TFunc): string {
  if (node.display !== node.name) return node.display;
  const generated = /^lark-([a-f0-9]{6,})-/i.exec(node.name);
  if (generated !== null) {
    return t("Channel.org.unnamedAgent", { suffix: generated[1]!.slice(0, 4) });
  }
  if (/^[a-f0-9]{32,}(?::|$)/i.test(node.name)) {
    return t("Channel.org.unnamedAgent", { suffix: node.name.slice(0, 4) });
  }
  return node.display;
}

function MemberDirectory({
  tree,
  t,
  interactive,
}: {
  tree: OrgTree;
  t: TFunc;
  interactive?: OrgInteractive;
}): ReactElement | null {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => buildMemberDirectory(tree), [tree]);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = groups
    .map((group) => ({
      ...group,
      people: group.people.filter((person) =>
        normalized === ""
        || `${person.display} ${person.name}`.toLocaleLowerCase().includes(normalized)
        || group.agents.some((agent) => `${agent.display} ${agent.name}`.toLocaleLowerCase().includes(normalized))
      ),
      agents: group.agents.filter((agent) =>
        normalized === ""
        || `${agent.display} ${agent.name}`.toLocaleLowerCase().includes(normalized)
        || group.people.some((person) => `${person.display} ${person.name}`.toLocaleLowerCase().includes(normalized))
      ),
    }))
    .filter((group) => group.people.length > 0 || group.agents.length > 0);
  const peopleCount = groups.reduce((sum, group) => sum + group.people.length, 0);
  const agentCount = groups.reduce((sum, group) => sum + group.agents.length, 0);

  if (groups.length === 0) return null;
  return (
    <section className="org-directory" aria-label={t("Channel.org.directoryLabel")}>
      <header className="org-directory-head">
        <div>
          <h4>{t("Channel.org.directoryLabel")}</h4>
          <p>{t("Channel.org.directoryHelp")}</p>
        </div>
        <span className="t-mono">
          {t("Channel.org.directoryCount", { people: peopleCount, agents: agentCount })}
        </span>
      </header>
      <input
        className="org-directory-search t-mono"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("Channel.org.directorySearch")}
        aria-label={t("Channel.org.directorySearch")}
      />
      {visible.length === 0 ? (
        <p className="charter-empty">{t("Channel.org.directoryNoResults")}</p>
      ) : (
        <ul className="org-person-list">
          {visible.map((group) => {
            const people = group.people;
            return (
              <li key={group.key} className="org-person-card">
                <div className="org-person-head">
                  {people.length > 0 ? (
                    <div className="org-person-identities">
                      {people.map((person) =>
                        interactive?.onOpenMember !== undefined ? (
                          <button
                            key={person.name}
                            type="button"
                            className="org-person-name"
                            onClick={() => interactive.onOpenMember?.(person.name)}
                          >
                            {person.display}
                          </button>
                        ) : (
                          <strong key={person.name} className="org-person-name">
                            {person.display}
                          </strong>
                        ),
                      )}
                    </div>
                  ) : (
                    <strong className="org-person-name">
                      {t("Channel.org.ownerUnknown")}
                    </strong>
                  )}
                  <span className="t-mono org-person-agent-count">
                    {t("Channel.org.agentCount", { count: group.agents.length })}
                  </span>
                </div>
                {group.agents.length === 0 ? (
                  <p className="org-person-empty">{t("Channel.org.noAgents")}</p>
                ) : (
                  <ul className="org-agent-list">
                    {group.agents.map((agent) => (
                      <li key={agent.name} className="org-agent-row">
                        <button
                          type="button"
                          className="org-agent-identity"
                          disabled={interactive?.onOpenMember === undefined}
                          onClick={() => interactive?.onOpenMember?.(agent.name)}
                        >
                          <span className="org-agent-name">{agentLabel(agent, t)}</span>
                          <span className="t-mono org-agent-raw">{agent.name}</span>
                        </button>
                        {interactive?.onManageAgent !== undefined
                          && interactive.manageableAccount !== null
                          && interactive.manageableAccount !== undefined
                          && agent.accountLabel === interactive.manageableAccount && (
                          <button
                            type="button"
                            className="d-btn org-agent-manage"
                            onClick={() => interactive.onManageAgent?.(agent.name)}
                          >
                            {t("Channel.org.manageAgent")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OrgNodeRow({ node, t, interactive }: { node: OrgTreeNode; t: TFunc; interactive?: OrgInteractive }): ReactElement {
  const roleText = node.role !== null && !node.isLead ? node.role : null;
  return (
    <li className="org-node">
      <div className="org-node-self">
        <span className="org-node-name t-mono">{node.display}</span>
        <span className={`role-kind role-kind--${node.kind}`}>{t(`Composer.kind.${node.kind}`)}</span>
        {node.isLead && <span className="org-lead-tag t-mono">{t("Channel.roles.channelLead")}</span>}
        {roleText !== null && <span className="org-node-role t-mono">{roleText}</span>}
        {node.accountLabel !== null && node.accountLabel !== node.display && !isOpaqueAccount(node.accountLabel) && (
          <span className="org-node-owner t-mono">{node.accountLabel}</span>
        )}
        {node.reportsTo !== null && (
          <span className={"org-report t-mono" + (node.reportsToExternal ? " org-report--external" : "")}>
            {node.reportsToExternal
              ? t("Channel.roles.reportsToExternal", { parent: node.reportsTo })
              : t("Channel.roles.reportsTo", { parent: node.reportsTo })}
          </span>
        )}
        {node.skipLevel && node.reportsTo !== null && (
          <span
            className="org-report org-report--skip t-mono"
            title={t("Channel.roles.skipLevelHint", { parent: node.reportsTo })}
          >
            {t("Channel.roles.skipLevel", { parent: node.reportsTo })}
          </span>
        )}
        {interactive?.canModerate && node.source === "assigned" && (
          <select
            className="org-report-select"
            value={node.reportsTo ?? ""}
            disabled={interactive.busyName !== null}
            aria-label={t("Channel.org.setReportsToAria", { name: node.name })}
            onChange={(e) => interactive.onSetReportsTo(node.name, e.target.value === "" ? null : e.target.value)}
          >
            <option value="">{t("Channel.org.reportsToTop")}</option>
            {interactive.allNames
              .filter((n) => n !== node.name)
              .map((n) => (
                <option key={n} value={n}>
                  {t("Channel.org.reportsToOption", { name: n })}
                </option>
              ))}
          </select>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="org-children">
          {node.children.map((child) => (
            <OrgNodeRow key={child.name} node={child} t={t} interactive={interactive} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTreePreview({
  tree,
  t,
  interactive,
  id,
}: {
  tree: OrgTree;
  t: TFunc;
  interactive?: OrgInteractive;
  id?: string;
}): ReactElement {
  const isEmpty = tree.roots.length === 0 && tree.unassigned.length === 0;
  return (
    <section id={id} className="org-tree" aria-label={t("Channel.org.label")}>
      <header className="org-tree-head">
        <div>
          <h3>{t("Channel.org.label")}</h3>
          <p className="t-mono">{t("Channel.org.help")}</p>
        </div>
        <span className="t-mono org-tree-count">{t("Channel.org.count", { count: String(tree.memberCount) })}</span>
      </header>
      <div className="org-tree-body">
        {isEmpty ? (
          <p className="charter-empty">{t("Channel.org.empty")}</p>
        ) : (
          <>
            <MemberDirectory tree={tree} t={t} interactive={interactive} />
            {tree.roots.length > 0 && (
              <details className="org-reporting">
                <summary>{t("Channel.org.reportingLabel")}</summary>
                <ul className="org-roots">
                  {tree.roots.map((node) => (
                    <OrgNodeRow key={node.name} node={node} t={t} interactive={interactive} />
                  ))}
                </ul>
              </details>
            )}
            {tree.unassigned.length > 0 && (
              <details className="org-unassigned">
                <summary className="org-unassigned-head t-mono">{t("Channel.org.rawRoster")}</summary>
                <ul className="org-roots">
                  {tree.unassigned.map((node) => (
                    <OrgNodeRow key={node.name} node={node} t={t} interactive={interactive} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}
