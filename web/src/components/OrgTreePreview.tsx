import type { ReactElement } from "react";
import type { TFunc } from "../i18n/useT";
import type { OrgTree, OrgTreeNode } from "../lib/orgTree";

// issue #281：整个频道的组织/汇报关系应该可以「预览」。DivisionBoard 逐行标注了汇报对象，
// 但看不出整体层级；这里把 buildOrgTree() 折出来的汇报树渲染成一棵可整体查看的组织架构图。
// 纯展示组件：树的构建（含环/孤儿处理）在 lib/orgTree.ts 里，这里只负责画。

function OrgNodeRow({ node, t }: { node: OrgTreeNode; t: TFunc }): ReactElement {
  const roleText = node.role !== null && !node.isLead ? node.role : null;
  return (
    <li className="org-node">
      <div className="org-node-self">
        <span className="org-node-name t-mono">{node.display}</span>
        <span className={`role-kind role-kind--${node.kind}`}>{t(`Composer.kind.${node.kind}`)}</span>
        {node.isLead && <span className="org-lead-tag t-mono">{t("Channel.roles.channelLead")}</span>}
        {roleText !== null && <span className="org-node-role t-mono">{roleText}</span>}
        {node.accountLabel !== null && node.accountLabel !== node.display && (
          <span className="org-node-owner t-mono">{node.accountLabel}</span>
        )}
        {node.reportsTo !== null && (
          <span className={"org-report t-mono" + (node.reportsToExternal ? " org-report--external" : "")}>
            {node.reportsToExternal
              ? t("Channel.roles.reportsToExternal", { parent: node.reportsTo })
              : t("Channel.roles.reportsTo", { parent: node.reportsTo })}
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="org-children">
          {node.children.map((child) => (
            <OrgNodeRow key={child.name} node={child} t={t} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function OrgTreePreview({ tree, t }: { tree: OrgTree; t: TFunc }): ReactElement {
  const isEmpty = tree.roots.length === 0 && tree.unassigned.length === 0;
  return (
    <details className="org-tree" aria-label={t("Channel.org.label")}>
      <summary className="org-tree-head">
        <div>
          <h3>{t("Channel.org.label")}</h3>
          <p className="t-mono">{t("Channel.org.help")}</p>
        </div>
        <span className="t-mono org-tree-count">{t("Channel.org.count", { count: String(tree.memberCount) })}</span>
      </summary>
      <div className="org-tree-body">
        {isEmpty ? (
          <p className="charter-empty">{t("Channel.org.empty")}</p>
        ) : (
          <>
            {tree.roots.length > 0 && (
              <ul className="org-roots">
                {tree.roots.map((node) => (
                  <OrgNodeRow key={node.name} node={node} t={t} />
                ))}
              </ul>
            )}
            {tree.unassigned.length > 0 && (
              <section className="org-unassigned">
                <header className="org-unassigned-head t-mono">{t("Channel.org.unassignedGroup")}</header>
                <ul className="org-roots">
                  {tree.unassigned.map((node) => (
                    <OrgNodeRow key={node.name} node={node} t={t} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </details>
  );
}
