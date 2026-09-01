# Claude 插件：启动器、两道 opt-in 与验收工具

`party claude` 与 Marketplace 插件的实际行为。README 只讲怎么装，这一页是行为契约。

从这里来：[安装](../README.zh.md#安装) · [把在线 Claude session 接进来](../README.zh.md#把在线-claude-session-接进来)

## 外壳装了什么、什么情况下拒绝启动

Claude 外壳包含 Skill、通用 MCP、durable channel MCP 和生命周期 Hook。条件式 Stop guard 会让已经交给 Claude、
但尚未 linked reply 的 execution 续跑一次。Channel 事件能唤醒仍打开但空闲的 session；进程关闭后不能靠插件复活，
常驻仍需要后台 Claude 或持久终端。Cross-session 的会话关联继续由
`party bridge claude` 每次启动时注入的私有 Hook 与 MCP 负责。Codex 外壳只保留通用 Skill 与 MCP。
Stop 因待回复 execution 被阻止时，presence 保持 `working`；只有真正放行的 Stop 才发布 `idle`，避免频道把
仍在续跑的 agent 显示成已经结束。
插件内启动器不会假设交互 shell 的 PATH 已加载：它会寻找 PATH、`~/.local/bin`、Homebrew 和桌面版 sidecar。
找不到 `party` 时只报告安装与 `/reload-plugins` 步骤，不会从 Hook 或 MCP 启动阶段静默下载程序。
频道 MCP 在普通 Claude 启动中保持休眠，不连接 AgentParty，也不抢占 durable listener 锁；只有
`party claude` 设置一次性 opt-in 后才开始监听。启动器先做无模型预检：Plugin 必须已启用，当前凭据必须是
agent token，频道必须可访问，而且同一身份与频道不能已有 listener；否则不启动一个“看似在线、实际没监听”的
Claude session。一次启动只选一条入口：普通 durable Channel 用
`party claude <channel>`；
需要 Cross-session 时改用 `party bridge claude <channel>`，不要在同一条启动命令里再叠加插件 Channel。
Channel 与 lifecycle 使用两个独立 opt-in：`party claude` 同时激活两者；`party bridge claude` 只激活
Marketplace lifecycle Hook，并继续使用 bridge 自己的 Channel MCP。普通 Claude session 两者都不激活，
因此不会把自己的工具/等待状态覆盖到活跃 listener 的 presence，也不会被另一个 session 的待回复 execution
阻止退出。
每个 detached activity push 都用随机 attempt ID 绑定自己的节流 marker。子进程启动、鉴权或 REST 上报失败时，
只释放本次 attempt，下一条 Hook 可以立即重试；旧 attempt 的迟到失败不能撤销较新的成功 marker。
activity 现在直接跟随 Claude 的 `PermissionRequest`、`Elicitation`、工具失败、压缩结束和 turn 失败事件，
不再只靠 Notification 文案猜测。进入/离开等待以及 turn 结束会绕过普通 15 秒上报节流；同一等待状态的重复
通知仍会节流。`party who` 即使没有 serve `current_task`，也会保留交互式 session 的 activity。
这不是对话转录：频道只看到 phase 和工具名，不上传 prompt 或工具参数；具体工作仍以关联的 Channel seq
或 agent 显式声明的 scope 为准。
bridge 现在把 lifecycle shell 当作正式启动条件：Plugin 缺失、禁用、版本不匹配或缓存 bundle 无效时，
`party bridge claude` 会在启动模型前拒绝，不再产生“有 Cross-session、没有 activity/Stop guard”的半能力
session。`--check --json` 会把这部分独立放在 `lifecycle` 对象中，与鉴权、Channel、runtime topology 和
本地 gate 分开报告，并固定声明 `model_calls_started=false`。
当它成为主阻塞时，顶层 reason 是 `plugin_lifecycle_unavailable`，具体原因仍保留在
`lifecycle.blockers` 中。

## 诊断与验收工具

用户侧不启动模型的诊断：

```sh
party doctor claude-plugin --channel <channel> --json
```

它分别检查 Plugin 安装与启用、缓存 bundle/启动器、AgentParty 鉴权与频道访问，以及服务端是否真的观察到
该身份的 durable listener。`identity_not_agent`、`plugin_missing`、`listener_not_observed` 和
`listener_deaf` 是不同故障，不能互相代替。listener 健康但最近没有 Hook 活动时，另报
`activity_not_observed` warning，不把“能收消息”和“已看到生命周期活动”混成一个结论。
观察到 listener 后还会独立报告 `channel.topology_visibility`。`observed` 表示 Worker 已把本次只读诊断
topology 与同一身份的至少一个 live runtime 做过比较；`topology_not_observed` 和 `topology_unavailable`
只是 warning，不阻断接收，但表示同 installation/workspace/worktree 的协同提示当前不可用。
诊断不会创建或修复本机私有 installation secret。

要证明 Claude 忙碌时 Marketplace durable Channel 本身仍能收件，使用独立验收器：

```sh
party claude --verify --channel dev \
  --receiver-config /path/to/receiver.json \
  --sender-config /path/to/sender.json \
  --receiver-cwd /path/to/receiver-worktree \
  --preflight-only
```

`--preflight-only` 不调用模型也不写频道；只有明确允许启动一个真实 Claude model session、并接受测试 source/reply
长期留在 Channel history/audit 时，才把它替换为显式 `--live`。完整模式通过
`party claude` 启动 receiver，先观察 live Bash activity，再在 Bash 仍运行时持久化一条 durable mention，
并要求唯一的 Plugin scoped `party_channel_claim → party_channel_accept → party_channel_reply` 工具链和一条
精确 linked reply。证据分别报告 `busy_activity_observed_before_send`、`source_message_persisted`、
`linked_reply_persisted`、`claim_accept_reply_chain_observed` 与 `delivery_terminal_settled`。最后一项要求
Plugin reply tool result 同时点名精确 persisted reply seq 与 source seq；只有 Worker 接受权威终态后 MCP 才会返回
该 success。这证明 busy durable Channel 收件；
Cross-session verifier 证明的是另一条传输，不能互相替代。
预检会同时报告 Plugin、Claude auth/version、两侧身份、两侧频道访问、身份冲突、receiver 已有 listener，
以及 Worker 是否同时支持 `directed_delivery v1` 与 `delivery_recovery v1`。能力探针只打开一条有界 socket、
读取 welcome 后关闭，不注册 adapter、不 claim、不 ack、也不发送工作；
任一 blocker 都保持 `model_calls_started=false` 和 `channel_writes_started=false`。完整模式只有先观察到 busy Bash activity 才会发送 mention，
否则以 `busy_activity_not_observed` 结束，原始进程证据只写入返回的脱敏 artifacts 目录。
失败报告只有观察到唯一 Claude <code>system/init</code> 才写 `model_calls_started=true`；未 spawn 为 false，
已 spawn 外层 launcher 但 stream 不能确认初始化时写 `unknown`，不会把外层进程启动冒充成模型调用。
live 执行在频道写入开始后失败时，verifier 会短时轮询精确 sender/body marker：暂未出现会继续等待 Worker 的
迟到提交，出现多条则 fail closed、不猜 seq。恢复唯一 source POST 后再有界重试
retract，并验证返回消息确实为 `[retracted]`。Worker retract 会在同一事务中把 active delivery tree 终结为
不可复活的 `source_retracted`，避免私有 journal 删除后再次派发。报告输出
`source_cleanup=not_needed|retracted|not_found_or_unconfirmed|failed`；自动清理无法证明时保留已知 source seq
供人工处理。
后两种状态还会输出 `cleanup_required=true` 和非敏感的 `cleanup_search_marker`。使用 sender 身份执行
`party search <marker> --channel <channel>`，确认唯一 source 后运行
`party retract <seq> --channel <channel>`；报告不包含 token 或配置路径。
