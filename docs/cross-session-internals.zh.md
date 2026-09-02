# Cross-session：闸、Hook 与验收内部规则

English: [cross-session-internals.md](cross-session-internals.md)

`party bridge claude` 背后的证据规则。先读
[把在线 Claude session 接进来](../README.zh.md#把在线-claude-session-接进来)——这一页是 fail-closed 的
规格说明，不是上手指南。

## 发现、许可与发送屏障

预检不要求另一条 session 已在线；真正的 peer 发现仍在 bridge 内先调用
`party_channel_peers`，再以 Claude 当次的 `ListAgents` 结果确认地址，并在 `SendMessage` 前立即用
`party_channel_peer_check` 复核同一个短命候选。必须先看到复核确认，不能把复核与发送放进同一个并行工具批次。
复核结果中的 `send_to` 必须等于这条新鲜 `ListAgents` 地址；验收脚本会把 hint、candidate、confirmed
`send_to` 和实际收件人作为同一条证据链核对。
同一次 peers 结果若把同一个 `candidate_ref` 绑定到冲突身份，本地门禁会丢弃该 ref。完全相同的 peer-check
confirmed 包装可以去重；出现两个不同的 confirmed 结果则属于歧义，不生成 permit。
Hook 结果采用迭代遍历，上限为 64 层、4096 个节点和 256 KiB 嵌入 JSON。任一预算超限都会让整次解析失效，
包括结构化 remote-session 分类；不能保留超限前已经找到的对象作为局部证据。
每次相关 `PreToolUse` 还会绑定 Claude 文档规定的 `tool_use_id`。`PostToolBatch` 只有同时匹配当前 pending ID
和工具阶段，才可以推进或清除这条链。旧调用迟到的结果不能改动新链或 send barrier；匹配当前调用但包含
多个工具的 batch 只会清链，不会把其中一个结果当作局部证据。
隐藏 Hook 命令还把完整 stdin envelope 限制为 4 MiB。超限输入会在 JSON 解析前固定退出 2，因为没有读取完整
envelope 就无法安全判断事件类型。
这条地址在 `ListAgents` 结果中只能出现一次；作为 AgentParty 的本地防御上限，带方括号时，`[ref]`
必须完整且长度为 1–64 个字符。
重复行、未闭合或过长的 ref 都会关闭发送链。
完整随机地址 token 前后的空白、`@` 或其他异常装饰也不会被当成普通 Claude team 名绕过门禁。
Claude MCP 初始化可能略早于接收端的 AgentParty topology 可见；因此第一次满足门禁、identity 和 topology
前提的 `party_channel_peers`，会在同一次工具调用内取 0/100/350/850 ms 四个 ready 快照并返回最新结果。
另一个 peer 先出现也不会提前终止这段启动等待。
错误立即返回，后续发现不等待，发送前的 `party_channel_peer_check` 永远只取一次不重试的新鲜快照。
bridge 会为自己生成的 `apcs-...` 地址配置一次性本地 Hook 门禁：正常顺序是
`party_channel_peers` → `ListAgents` → `party_channel_peer_check` → `SendMessage`，并绑定精确收件地址、
限制 512 UTF-8 bytes。只有 bridge 固定的 `mcp__agentparty-channel__...` peer 工具能写入门禁状态；其他
MCP server 暴露的同名工具会被忽略。只有 Claude 精确的内置 `ListAgents` 能生成 listing，精确的内置
`SendMessage` 能消费 permit；MCP lookalike 不能推进这两步。只有顶层 Claude 会话实际执行过 `SessionStart` Hook，MCP 才会返回候选；subagent
不能装载或消费这条链，成功发送后同一批次的其他工具也会在执行前被拒绝。收到 Cross-session 消息后回复也必须
重新完成这条链。入站 reply address 只是未受信的路由 hint，不是身份、授权或 AgentParty permit；只有新鲜发现
与复核独立解析到同一精确地址时才能复用。bridge 会在所有探针和启动前从
Claude 的全局环境中删除私有 gate 路径，只通过 exec-form Hook 参数和 AgentParty MCP 专属 `env` 分别交给
两个消费者；普通 Bash 子进程不会因环境继承拿到该路径，隐藏 Hook 命令也会忽略同名继承变量。这能减少意外
暴露和陈旧环境串线，但不能抵御同 UID 的恶意进程。显式 Claude `--settings`
可能替换这组 Hook，所以 `auto` 会关闭自动关联，
`required` 会拒绝启动。这层主要防误发和旧候选重放，不是主机安全边界：Claude 官方说明 command Hook
无法启动或超时时不会阻止工具调用。权威证明仍是 Worker 的 live-socket caller binding，以及 Claude 自己的
inbound 和 permission 控制。
Claude 现在也会列出另一台电脑上的 Remote Control 会话和 Claude Code Web 会话。AgentParty 的关联仍限于
本机：每次启用关联时，bridge 都会注入 `isolatePeerMachines: true`；只要目标实际位于另一台机器，Claude
就必须先取得用户明确批准。若精确名称所在的 ListAgents 行带有当前的 `on another machine (Remote Control)`、
`in the cloud` 或 Claude Code Web 标签，本地 Hook 不会生成 listing；模型也会收到同样的启动约束。
启动行中的 `cross_machine=approval_required` 只说明出站审批边界已配置，不证明候选在本机，
也不证明消息送达。
无模型调用的 JSON 检查会用
`cross_machine_policy_on_launch=explicit_approval_required` 报告同一项预期启动配置；
`--cross-session off` 返回 `not_applicable`。这个字段不证明会话已启动、候选属于本机或消息已送达。
bridge 默认不替用户选择 inbound 策略。受控验收可把 `--cross-session required` 与
`--cross-session-inbound accept` 连用；bridge 会把它
与本次 Hook 合并进同一份自有设置，调用方不必再传一份相冲突的 Claude `--settings`。Claude 的组织、
项目或本地 `hold`/`refuse` 仍可按官方优先级收紧它。只有在接收端唯一 `system/init` 之后恰好出现一次、
且带同一 `session_id` 的纯文本主会话 inbound user 事件才算送达；缺失或不同 session ID、重复 marker、
`tool_result`、重放 prompt、不是严格布尔值的 `isReplay`，以及 `agent_id` 或 `parent_tool_use_id` 非空的
子 agent 事件都不能充当投递证明。
v3 Worker 只有在请求匹配同 agent、同 token、同完整 topology 的唯一活 WebSocket 时才返回 Claude 候选；
启动预检走单独的不返回 peer 的能力探针。
Cross-session 需要 macOS 或 Linux、Claude Code 2.1.224+。原始 Claude Channel capability 从 2.1.80
开始提供，但本仓完整 Marketplace Plugin 外壳依赖 <code>defaultEnabled</code>、<code>channels</code> 和严格
Plugin 校验，因此要求 Claude Code 2.1.154+；组织策略还必须允许 development Channels。
`party claude` 与 `party bridge claude` 在旧版本上会于模型启动前失败，不把“有裸 Channel”误当成“完整 Plugin 可用”。
Claude 官方不在 Bedrock、Claude Platform on AWS、Google Cloud Agent Platform 或 Microsoft Foundry
提供 Cross-session。bridge 从继承的 provider 变量或 `claude auth status` 识别到这些 provider 时，会返回
`reason=unsupported_provider`。已解析的 `apiProvider` 优先，因为 Claude 此时已经应用 settings；只有 auth
输出缺少该字段时才回退到继承的 provider 变量。它也按 Claude 官方的环境变量语义返回
`reason=feature_flag_evaluation_disabled`：`DISABLE_TELEMETRY` 和
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 只要非空就关闭 feature-flag evaluation，连 `0`、`false`
也算；`DO_NOT_TRACK` 和 `DISABLE_GROWTHBOOK` 只有设为 `1` 或 `true` 才关闭。
父进程能看到的 feature-flag 值会保守降级；settings 或远端 managed policy 仍可能在预检后改变 session
的有效环境。因此只有顶层
`SessionStart` 的真实 arming receipt 和 Claude 当次 `/list-agents` 结果才是可用性的权威证据。
每次 bridge 启动都会用子进程将继承的同一份工作目录和环境执行 `claude auth status`。确认未登录，
或无法解析登录状态时，命令会在访问 Channel、创建 Claude 子进程之前停止；先运行
`claude auth login`，再重试。
验收器执行 `claude --version` 和 `claude auth status` 时，各自使用覆盖进程退出与 stdout/stderr 完整排空的
10 秒截止时间。超时会终止整个 detached 进程组，卡住的 wrapper 不会留下 Claude 后代，也不会让 JSON 预检一直等下去。
`--check --json` 会以当前 AgentParty 身份执行同一套启动预检，但不会启动 Claude。结果会分开报告
Claude 登录、Channel 权限、runtime comparison 和本地 gate 是否可创建。增量字段 `blockers` 会列出
所有已独立确认的阻塞项，即使兼容字段 `status` 和 `reason` 只保留主阻塞项；空数组只证明启动前提，
不证明真实投递。runtime capability 探针返回 HTTP 404 时，blocker 为 `worker_upgrade_required`；
其他探针失败仍为 `runtime_comparison_unavailable`。若探针能取得对应证据，
`claude_api_provider` 会给出经清理的 Claude resolved provider，
`cross_session_conflict_variables` 只列出冲突环境变量名，不泄露变量值。内建 Channel 探针失败时还会给出
可选的稳定子阶段 `channel_probe_phase=authentication|identity|presence|identity_binding`；旧式注入探针若只抛出
普通错误，该字段保持缺省。内建端点探针失败时，还会用 `channel_probe_attempts`（identity/Presence）或
`runtime_probe_attempts`（runtime capability）报告实际端点调用次数：1 表示终局错误未重试，3 表示两次
有界重试都已耗尽。字段缺省表示没有内建端点尝试证据，不等于尝试了 0 次。内建 identity、Presence 与
runtime capability HTTP 探针只对 429 和 5xx 按
150/500 ms 重试，所有尝试仍共用原来的五秒总时限。重复的 capability probe 仍然只做比较：不返回 peer，
也不发布 topology 或候选。其他 HTTP 错误和注入探针保持单次调用。这些诊断字段都是 v1 schema 的可选增量字段。
输出中的
`session_start_armed`、`peer_presence_checked`、`delivery_verified` 固定为 `false`；只有真实 bridge
启动、顶层 Hook 执行并完成 peer 投递后，才能证明这三项。`auto` 模式下，如果 Channel 仍可用，缺少
Cross-session 条件不会让预检失败；`required` 遇到同一情况会返回非零退出码。
`SessionStart` Hook 不输出 stdout，因为 Claude 会把这段内容放进模型上下文。顶层会话完成武装后，bridge
会在 Claude 仍运行时读取私有 arming 文件并发布结构化回执。普通启动把回执打印到 bridge stderr；如果 Claude
退出时仍未武装，`required` 返回非零码，`auto` 输出 `cross_session=session_start_unarmed`。双 agent 验收则给
bridge 一个位于其私有目录、尚不存在的文件路径；
bridge 会先从所有 Claude probe 和子进程环境中删除该变量，再以 0600 模式独占创建文件并写入回执。验收只有在
每条回执的随机启动地址和 session ID 分别匹配该进程的启动行与唯一 `system/init.session_id` 时才通过，最终分别输出
`receiver_session_start_armed=true` 和 `sender_session_start_armed=true`；MCP 初始化或 marker 投递不能代替
这项证明。验收还要求 `distinct_claude_session_ids=true` 和 `distinct_bridge_addresses=true`；同一个
session 或同一个生成地址的两份回执不能冒充双会话。
如果只检查 Claude 原生传输的本机前提，先运行
`bun scripts/verify-claude-cross-session.ts --preflight-only`。它只执行带截止时间的
`claude --version` 和 `claude auth status`，输出
`agentparty.claude-cross-session-native-preflight.v1`，并在任何 `claude -p` 模型会话启动前退出。
结果固定保留 `model_calls_started=false` 和 `delivery_verified=false`；`blockers` 会区分已确认未登录、
认证探针不可用、不支持的 provider、feature flag 求值被禁用、Claude 版本过旧和平台不支持。对应状态与
退出码沿用全链路预检语义。`ready` 只证明本机静态前提，不证明 Claude 注册、原生送达、AgentParty topology
或线上 Worker。
未知或重复参数仍返回同一 schema：`status=invalid_request`、`error_code=invalid_arguments`、退出码 9，
并且发生在两个 Claude 探针之前。未分类错误返回 `internal_error` 和退出码 1；两条路径都不回显被拒绝的参数或
底层异常文本。
原生完整验收现在对所有非 help 结果都使用 acceptance v1 schema。失败阶段固定为
`request|preflight|receiver_startup|execution|evidence|internal`，并带稳定 `error_code`。如果前一次预检后
环境发生变化，完整命令会嵌入一份新的 `preflight` 结果，并继续声明 `model_calls_started=false`。receiver
启动或执行阶段的原始诊断只写入输出中指定的证据目录，不进入 stdout/stderr。进程失败和证据不足分开报告；
只有真实完整链路才会输出 `delivery_verified=true`。
发布版 `party` 已内置双 agent 全链路验收器：

```sh
party bridge claude --verify --channel dev \
  --receiver-config /path/to/receiver.json \
  --sender-config /path/to/sender.json \
  --receiver-cwd /path/to/receiver-worktree \
  --sender-cwd /path/to/sender-worktree \
  --preflight-only
```

只有准备启动两个真实 Claude 模型会话时才移除 `--preflight-only`。验收器始终通过当前这份
`party` 可执行文件启动两个 bridge，不依赖源码仓库或另一份全局安装。所有预检结果，包括参数错误，
都固定输出 `model_calls_started=false` 和 `delivery_verified=false`。`blockers` 数组会
同时列出全部可独立判定的 Marketplace lifecycle、鉴权、provider、feature flag 与 runtime 阻塞；Plugin
缺失、auth 探针损坏、不受支持的 provider 和旧 Worker 可以一起出现。嵌套的 `lifecycle` 对象复用
`party bridge claude --check` 的 Plugin-only 检查；任何 lifecycle blocker 都会在模型启动前返回
`plugin_lifecycle_unavailable` 和退出码 11。`claude_auth_status` 会把确认未登录的 `logged_out` 与探针不可用的
`unavailable` 分开，只有前者应提示 `claude auth login`。已有的 `ready`、`claude_auth_required`、
`worker_upgrade_required`、`runtime_peer_unavailable` 状态和退出码保持兼容。空数组只表示这些静态前提已就绪，
不代表 session 已注册或消息已送达。完整 live 验收还会为两侧各保留最多 10 秒的 presence 观察窗口，并要求
`receiver_lifecycle_activity_observed=true` 与 `sender_lifecycle_activity_observed=true`。activity 必须属于
对应的 live daemon 身份，且时间晚于该侧进程启动；历史 activity、离线记录、watch/observer 连接或其他 agent
都不能替代。这证明 Marketplace Hook 确实到达频道 presence，而不只是安装和清单看起来正确。
receiver 与 sender 的 AgentParty 检查互相独立：即使 token 已撤销，
`receiver_identity`/`sender_identity` 和 `receiver_channel_access`/`sender_channel_access` 仍保持机器可读。
这时主状态是 `agentparty_unavailable`，每一侧分别报告 blocker 与 HTTP 状态；依赖该身份的检查写
`not_checked`，不会伪装成端点不可用。
两个 cwd 参数可省略，各自默认使用 verifier 的当前目录。传入参数后，两个 bridge 子进程会分别在规范化后的
目录中启动。模型调用前，verifier 会计算最强关系：`same_worktree`、`same_workspace` 或
`same_local_installation`。两个方向的证据链都必须返回同一条期望关系和对应的 coordination action；JSON 用
`expected_topology_relation` 报告结果。verifier 能证明两个子进程由本机启动，但 topology 关系仍是
client-asserted，不代表身份或授权。失败证据会脱敏两个 cwd 路径。
验收器还会在模型调用前读取不走缓存的 `/api/health` 部署身份。预检通过 `worker_deployment_status`
报告准确的 version、40 位 commit 和部署时间；metadata 缺失或不合法时加入 `worker_deployment_unavailable`，
远程 server 的主状态为 `worker_upgrade_required`。通过的远程 v2 结果会写入同一个 `worker_deployment` 对象，让往返证据指向实际受测 Worker。
loopback 开发环境可以标成 `worker_deployment_status=development_unversioned` 继续验收，但这不算发布证明。
启动参数和本机条件也沿用同一份 v1 JSON。参数、频道名、配置或 server 配对有误时，状态为
`invalid_request`，附稳定的 `error_code`，退出码为 9。平台不支持、找不到 Claude、Claude 版本过旧或无法生成
runtime topology 时，状态为 `environment_unavailable`，退出码为 10。未分类异常只返回 `internal_error` 和退出码 1；
JSON 不回显配置路径、token 或底层异常全文。
AgentParty 完整验收对所有非 help 结果都使用 v2 acceptance schema。它在启动任一模型前执行与
`--preflight-only` 相同的完整静态检查；失败时嵌入这份新结果，并写明 `model_calls_started=false`。稳定的
`failure_phase=request|preflight|receiver_startup|execution|evidence|internal` 和 `error_code` 会区分参数、
Worker/auth/topology 前提、bridge 启动、进程执行和证据不足。原始 bridge 输出只进入已脱敏 token 与私有路径的
证据文件；只有双向门禁链完整通过时才输出 `delivery_verified=true`。
Worker 发布前必须提供 runtime smoke agent token：优先读取 `AGENTPARTY_RUNTIME_SMOKE_TOKEN`，否则要求
`AGENTPARTY_SMOKE_TOKEN` 本身是 agent。部署前只读 preflight 会先调用 `/api/me` 和频道列表，确认 token 对应
具名 agent、目标频道可访问，并确认发布机具备 WebSocket 客户端；任一失败都会发生在迁移和 deploy 之前。
这一步仍明确输出 `protocol_checked=false`。
部署后脚本会先运行已鉴权的 live-topology smoke，再进入写路径 smoke。它临时建立两条 WebSocket：两端使用同一个随机
`node_ref`，但 workspace/worktree 引用不同；每端的 topology `hello` 都要经过应用队列中的 ping/pong 顺序屏障。随后脚本只接受
v3、`caller_binding=live_socket`，以及唯一可寻址的 `same_local_installation` Claude 候选。脚本等待两条连接在有限时限内完成
关闭握手后才报告 `sockets_closed=true`；
响应也不能包含请求侧的四类原始 topology ref。脚本不发送 Channel 或 Claude 消息。因此这能证明线上 Worker 的调用方绑定、
拓扑比较和引用脱敏，不能证明 Cross-session 已投递。
只有需要较弱的空 peer 端点诊断时，才使用 `smoke-runtime-peers.mjs --capability-only`。
本地发布还会检查 Worker、shared、web 及其构建依赖，已暂存、已修改和未跟踪文件都会阻止发布，保证
`/api/health` 返回的 commit 对应 Wrangler 实际打包的代码和静态资源。CLI 或文档等非部署输入不会卡住 Worker 发布。
v2 验收还要求 receiver 观察到首个 marker 后，针对 sender 独立重跑
`party_channel_peers` → `ListAgents` → `party_channel_peer_check` → `SendMessage`，发送另一枚 reply marker，
并由 sender 在自己的主会话入站事件中观察到它。两个方向还必须各有一条与本次发送对应、非错误且唯一的
`SendMessage` result。只看到任一 marker、却没有对应的完整出站门禁链，不能通过。
两条 headless session 都要接收消息，因此 verifier 通过 bridge 给两端设置
`--cross-session-inbound accept`；`-p` session 在默认策略 hold 消息时无法处理批准对话框。
verifier 不用固定 sleep 猜模型耗时。两端各在一次 Bash 工具调用中等待私有的 0600 信号文件；harness 只有观察到
另一端匹配的、顶层单调用 `SendMessage` tool result 后才创建文件，让 Claude 在下一个工具边界读取已排队消息。
输出还要求 `timing_barriers_intact=true`；信号文件已存在或无法写入都会让验收失败。stream 证据会另行检查：
receiver 的等待结果必须早于首个入站 marker，sender 的等待结果必须早于 reply marker。信号文件或孤立的 marker
都不能代替这两个有序工具边界。
两个 bridge 退出共用同一个 180 秒总时限。任一侧非零退出会立即终止另一侧的隔离进程组；零码退出可以先发生，
让另一侧完成合法往返。两个 bridge 主进程都退出后，verifier 会先终止仍持有 pipe 的后代，再排空证据流。
receiver 的 Claude/MCP 初始化、bridge 启动地址，以及同时匹配该地址与唯一 `system/init.session_id` 的武装回执，
共用同一个 20 秒 readiness 时限；三项未齐时 receiver 提前退出，验收会在启动 sender 前立即失败。
每条出站工具链只接受其唯一 `system/init` 之后、带同一 `session_id` 的事件。恰好一次调用仍按完整流计数：
缺失或外来 session 的事件不能补齐步骤，外来 session 的重复调用也会让验收失败。
每一步还必须是 Claude stream envelope 中顶层、直接且单独出现的 `tool_use` 或 `tool_result` 内容块，步骤之间
不能插入无关工具。嵌套的仿造对象、subagent 子事件和并行批次里的 sibling result 都不能充当证据。live Hook
采用同一条 fail-closed 规则：任何非空 `agent_id` 都按子 agent 处理，畸形 sibling 也会让该批次保持非单调用，
不会先过滤再放行余下的一条。相关 `PreToolUse` 和 `PostToolBatch` 结果还必须匹配 Claude 文档规定的同一个
`tool_use_id`；迟到结果不能推进或清除更新后的链。peers、ListAgents、peer-check、SendMessage
和等待边界的 result 还必须是完整流中该 tool-use ID 唯一且非错误的结果；外来 session 或子 agent 的同 ID
重复结果也会让该阶段失效。
`PreToolUse` 读取或写入私有 gate 状态时一旦抛错，隐藏命令会转换成 Claude 真正阻断调用的退出码 2，
不会落到 CLI 通用但不阻断工具的退出码 1。语法合法的 JSON 标量、数组、空对象
或未知 Hook 事件也属于畸形 envelope，固定退出 2，不会作为无关事件静默退出 0。新的 `SessionStart` 重武装后，
上一条 session 迟到的 `PreToolUse` 或 `PostToolBatch` 不能读取、清空或消费新 session 的许可链。
三类状态转换共用 consume lock，并在持锁时重查 armed session；旧事件即使先通过乐观检查、后等待锁，
也不能在重武装后恢复执行。
