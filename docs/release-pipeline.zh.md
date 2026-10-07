# 发版流水线

English: [release-pipeline.md](release-pipeline.md)

维护者材料：一个 `v*` tag 怎么变成已发布的 Release，中间有哪些门禁。用 AgentParty 不需要读这页。

## 插件安装验收

维护者可在不启动模型的前提下验收本地 add、install、enable 和缓存副本：

```sh
bun scripts/verify-agentparty-plugin-install.ts
bun scripts/verify-agentparty-plugin-install.ts --claude-package-version 2.1.154
```

required CI 会用 Claude 2.1.154 与 2.1.232 分别执行 strict validator 和这套隔离安装流程。
版本参数只接受精确稳定 semver，并固定展开为 `bunx @anthropic-ai/claude-code@VERSION`，不能夹带任意模型启动参数。
验收还要求实际 executable 输出的首个版本号与请求完全一致，并报告 `claude_version_matches_request=true`；
cache 或 wrapper 若解析成另一版本会 fail closed。
推送 `v*` tag 时，Worker deploy 与 GitHub Release 会并发启动，但发布现在有硬门禁：release job 只轮询
与当前 tag 和 40 位 commit SHA 完全一致的最新 `worker-deploy.yml` run；整条 workflow（包含已鉴权的
runtime-peers v3 live smoke）成功后才允许上传 Release。未发现、失败、取消或等待 30 分钟仍未完成都会阻止发布，
旧部署的成功记录不能充当本次证据。
Worker 部署身份以精确 `version + commit` 为准；`deployed_at` 保留为审计信息，不再充当正确性主键。
同一源码的幂等重部署或 custom domain 传播可能暴露不同时间戳。身份匹配后仍必须通过已鉴权的双 socket
runtime smoke，证明 live endpoint 真正提供 v3，因此放宽时间戳相等并没有降低协议验收强度。

## 跳过同一 commit 已经验过的 check

`v*` tag 指向的就是刚在 `main` 上跑完整门禁的那个 commit，所以 tag 那次直接复用它的结论，而不是把同一份
代码验两遍。`prior-green` job 只接受这样的证据：**同一个 commit SHA** 上、本 workflow 的、`main` 分支
push 触发的、且聚合 `full check` 成功的那次运行。PR 触发的不算——PR 可能走 CLI-only 快路径，非 CLI 的
check 全被跳过也算绿。其余任何情况（没有证据、API 出错、main 是红的）都照常把 check 全跑一遍。

跳过的只是**步骤**：每个 job 仍然正常成功，`needs` 图与各 job 结论一字不变。`version-contract` 从不跳过，
它校验的是 tag 本身，那是 `main` 那次跑不出来的新信息。

因此 `scripts/release.sh` 会在推 tag 之前，先等 `main` 上这条发布提交的 `full check` 出结论。`main` 是红的
就根本不推 tag。结论读不到时（API 失败、超时、origin 不是 GitHub）照常推 tag，tag 那次自己把 check 跑一遍。

## 关停（Shutdown）

托管服务按 `worker/wrangler.jsonc` 里 `AGENTPARTY_SHUTDOWN_AT` 这个 var 的时刻自行关停（当前为
`2026-10-31T00:00:00+08:00`）。不需要任何定时任务：Worker 的 `fetch` 一进来先拿当前时间和这个时刻比一下
（`worker/src/shutdown.ts`，接在 `worker/src/index.ts` 的 default export 上）。到点之前，请求和以前完全一样地处理。
到点之后，每个路径都回 410，带 `cache-control: no-store`：

- `/api/*`、`/openapi.json` 和 WebSocket upgrade 回 JSON `{"error":"agentparty_shut_down","message":"…"}`。
- `/install.sh`、`/install-desktop.sh`、`/install.ps1` 回一段脚本：把说明打到 stderr，然后 exit 1。
- `/llms.txt` 回纯文本说明；`/robots.txt` 回 200，禁止所有抓取。
- 其他所有路径回一个自包含的中英双语 HTML 页。

为了让这道闸能覆盖页面，`run_worker_first` 让除打包静态文件（`/assets/*`、`/docs/assets/*`、`/docs/img/*`、
`/favicon.svg`）外的所有路径都先进 Worker。到点之前，Worker 把这些请求原样交回 assets 绑定。

- **提前关停：** 把 var 设成 `"now"` 或任意过去的时刻。
- **推迟或撤销：** 设一个更晚的时刻，或设成 `""`。空值或解析不了的值都表示永不关停；解析不了时 Worker 记一次日志，照常服务。
- **让改动生效：** 部署 Worker，`gh workflow run worker-deploy.yml`，或随一次正常的 `v*` 发版（`scripts/release.sh X.Y.Z`）。
- **数据是有意保留的。** 关停只是停止服务。Durable Object、D1 数据库和 R2 桶原样保留，把时刻改回去一切照旧。
  删除数据是另外的手工步骤，不在这道闸里。
