# 团队面板 博客风（#504）设计参考

来源：claude.ai/design `团队面板 博客风.dc.html`（davianpearson1 账号）。截图存 `/tmp/wt-504-design/`。

## 总纲（终端/博客风）
- 等宽字体（`--font-mono`/`--t-mono`）、`$ 命令` 提示符、`-rw-r--r-- team.p…` 文件列表装饰。
- 单一强调色（`--accent`，Tweaks 可换 红/橙/绿/黑）。卡片左侧色条按语义。角色 pill 标签。
- 空态用虚线一行占位（不撑满）。长 `lark:on_…` ID 缩短显示、悬停看全。
- **三个页签替代一整页长滚动**：`01 分工` / `02 Agent 看板` / `03 协调`，页签带角标（未认领数、@数）。

## 头部
`团队` 标题 + 下一行 `$ cat ./team/overview`；右侧状态徽标 `N 分工 / N 在线 / N 离线 / N 未认领(红)`；最右 `-rw-r--r-- team.p…`。

## 01 分工（= DivisionBoard）
- `$ ls ./roles/ --assigned` + 动作按钮：`↑ 同步到公告`、`📖 agent 规则`、`📁 组织架构`。
- 已分工成员卡（左色条 + 名(mono) + 角色 pill[agent/host/主负责人] + 缩短 ID + 在线点 + `✎ 编辑`）；下方 `⟩` 一行交接说明。编辑控件默认隐藏，点「✎ 编辑」才展开。
- 未认领成员收进一条**虚线折叠条**：`▸ 未认领 · N 人 已连接，但还没认领分工 — 点开认领`；展开是可点选认领 chips。右侧 `⟩ 你是 agent? 看怎么把自己登记进分工`。

## 02 Agent 看板（= AgentBoardPanel）
- `$ watch ./agents/ --status`，右侧 `0 忙 · 0 阻塞 · N 空闲 · N 离线`。
- 空的忙/阻塞列压成**一行虚线占位**：`忙 · 0 — 空`、`阻塞 · 0 — 空`。
- `空闲 N`（绿 pill）→ 空闲卡片**三列网格**：`● name` + `▸ 进行 0  排队 0  待验 0`。
- `▾ 离线 · N` 折叠列表，右侧 `N 个留了交接说明`；行 `◎ name   交接说明`，**带交接说明的排前面**。

## 03 协调（= coordinationContent）
- 「你离开期间 #a..#b」摘要卡（右上 `✓ 已读完`）：chips `N 条新消息 / @N 提到你(红) / N 完成(绿) / N 发布 / N 回复`；消息行按类型左色条 `#seq [type pill] 内容`。
- 「主机看板 #seq」卡：`⚠ 主机过期 · X stale` 警示 pill；接管命令黑框 `$ party status … --decision-kind takeover --takeover-from X` + `复制`。
- 底部 `$ grep --by` 筛选：`全部 N / 全人类 / 全机器人 / ⟩ 按成员筛选 (N)`，成员筛选默认收起。

## 实现映射
渲染点 `Channel.tsx` `activePanel==="team"`：现三段堆叠（DivisionBoard + AgentBoardPanel + coordinationContent）→ 包进 3-tab `TeamTabs`。DivisionBoard 数据逻辑不动（大量现存测试保绿），只重塑表现层。
