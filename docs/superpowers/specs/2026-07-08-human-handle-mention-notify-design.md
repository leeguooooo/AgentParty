# 人类可 @ 昵称（handle）+ 被 @ 浏览器通知 — 设计

- 日期：2026-07-08
- 状态：设计已评审，待实现
- 关联需求：R4（人类可设置昵称，现用 email/sub 不好认）+ R5（当前人类被 @ 时弹浏览器通知）
- 风险等级：**高**（触及协议 + worker + D1 migration + Durable Object + 身份/mention 相关）。实现时一树一 worktree 隔离，实现前后启用独立评审（Claude-Critic）。

## 1. 动机与现状

- 人类身份（OIDC 网页会话）当前 `name = OIDC sub`（不可读 ID），`owner/account = email`。前端到处显示 sub/email，不好认（R4）。
- mention 候选（`web/src/lib/mentions.ts`）目前"human 只在当前在线时才作 @ 目标"，但其 name 是 UUID/sub，`@<uuid>` 实际打不出、@ 不到人类。
- 没有任何"被 @ 时通知"的机制（R5）。

因此 R4 与 R5 是一条链路：**人类先要有一个可读、可 @ 的 handle，"被 @ 通知"才有意义。**

## 2. 目标 / 非目标

**目标**
- 人类账号可设置一个**全局唯一、可读、可被 @** 的 handle。
- handle 在 mention 菜单中作为人类的 @ 目标；显示层用 handle 取代 email/sub。
- 当前登录人类被 @（消息 mentions 含其 handle）且标签页未聚焦时，弹浏览器通知。

**非目标**
- 不改 agent 的命名/ mention（agent 已有 name）。
- 不做 per-channel 昵称（作用域=全局账号级）。
- 不改身份/账号 ACL 模型：account(email) 仍是唯一 ACL 锚点；handle 只是显示+被@检测别名。
- 不做硬删除、不动 markdown img 白名单等无关项。

## 3. 方案（Approach A：handle 作显示 + 被@检测别名）

handle 是**附加层**，不改核心 `name` 身份键：
- 人类内部身份键仍是 account/sub 不变。
- handle 经 worker 查出后随连接/消息以 `x-ap-handle` 头下发给 DO（沿用现有 `x-ap-owner` 套路）；DO 盖到 presence 并 stamp 到每条消息（沿用现有 `sender_owner` 套路）。
- @ 别人：mention 菜单里人类以 handle 出现，`@<handle>` 是普通 mention 字符串。
- 被 @ 检测（R5）：`/api/me` 返回我的 handle，客户端看新消息 mentions 是否含我的 handle → 纯客户端，无需服务端为人类 mention 路由（人类无 wake/loop-guard）。

（否决 Approach B：让 handle 直接变成人类 `name`——需改身份键、presence 键、历史 sender_name，且 OIDC 人类无 tokens 行、唯一性需另建机制，改动大、风险高。）

## 4. 数据模型（migration `0014`）

新表：
```sql
CREATE TABLE account_profiles (
  account    TEXT PRIMARY KEY,      -- principal.account（人类 = email/sub）
  handle     TEXT NOT NULL UNIQUE,  -- 全局唯一 handle
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

DO 侧（`worker/src/do.ts` 建表/ALTER，随连接首次访问迁移，与现有 `sender_owner`/`presence.account` 同款）：
- `messages` 加列 `sender_handle TEXT`（发送时快照）。
- `presence` 加列 `handle TEXT`。

**handle 校验规则**
- 格式：`^[a-z0-9][a-z0-9._-]{1,31}$`（name-like，可被 `@` 打出；2–32 字符）。
- 唯一性：`account_profiles.handle` 全局唯一；且**不得等于任何 `tokens.name`**（handle 与 agent/token 名共用 @ 命名空间，避免撞名/冒充 agent）。
- 保留名：拒绝 `RESERVED_NAMES`（如 `system`）。
- 一个账号至多一个 handle（PRIMARY KEY account）；可改名（UPDATE，新 handle 仍须过全部校验）。

## 5. 协议（`shared/src/protocol.ts`，全部可选字段，旧客户端忽略）

- `Sender` 增 `handle?: string`。
- `PresenceEntry` 增 `handle?: string`。
- `/api/me` 响应增 `handle: string | null`。

向后兼容：字段缺失 → 前端回退 email/sub 显示、handle 视为未设。

## 6. Worker 端点（`worker/src/index.ts`）

- `GET /api/me`（现 `index.ts:482`）→ 增 `handle`（按 `identity.account` 查 `account_profiles`）。
- `PUT /api/me/handle`（新）：
  - 前置：人类账号会话（`identity.account != null`）；readonly/无账号 → 403。
  - body `{ handle }`；跑第 4 节全部校验：格式不合 400；等于某 token 名 / 已被别的账号占 / 保留名 → 409。
  - upsert `account_profiles(account, handle)`；返回 `{ handle }`。
- 转发人类的 WS 升级 + REST 发消息给 DO 时，按 `identity.account` 查 handle，带 `x-ap-handle` 头（与 `x-ap-owner` 并列；worker 权威、剥离客户端注入值）。
- （不新增 availability check 端点；UI 靠 PUT 的 409 反馈——YAGNI。）

## 7. Durable Object（`worker/src/do.ts`）

- 读 `x-ap-handle`：写入 presence.handle；每条 insert 的消息 stamp `sender_handle`。
- 下发的 `Sender` / `PresenceEntry` 带 handle（存在时）。
- 历史消息经 `rowToFrame` 回填 `sender.handle = sender_handle`。

## 8. 前端 R4（`web`）

- `/api/me` 有 handle 后：
  - **进频道时若人类还没 handle → 显眼提示可设置显示名**（非强制打断弹窗；一个可关闭的 banner/按钮）。另在 me chip / 资料处放随时改名入口。
  - `lib/api.ts` 增 `setHandle(handle)` → `PUT /api/me/handle`；映射 409（被占/撞名）/400（非法）为内联提示。
- **mention 候选**（`lib/mentions.ts`）：人类候选的 @ 插入 token 用 handle（有 handle 时）；无 handle 的人类维持现状（在线才留、显示 account）。display=handle。
- **显示**（`MessageCard` / `PresenceBar`）：有 handle 时显示 handle，email 作 tooltip 可信锚点（沿用现有 owner 显示位）；无 handle 回退 email/sub。

## 9. 前端 R5（`web`）

- 纯函数 `shouldNotify(msg, myHandle, documentHidden, permissionGranted): boolean`：
  - `msg.kind === "message"` 且非 retracted 且非自己发；
  - `myHandle !== null` 且 `msg.mentions` 含 `myHandle`；
  - `documentHidden === true`（标签页未聚焦）；
  - `permissionGranted === true`。
- Hook：订阅入帧，命中 `shouldNotify` → `new Notification("有人在 #<频道> @了你", { body: <正文预览> })`；去重（按 seq）。
- **授权（opt-in）**：不自动请求。频道头放"通知铃铛"开关，用户点开时才 `Notification.requestPermission()`；opt-in 状态存 localStorage，**全局生效**（一次开启对所有频道有效）。
- 点通知 → `window.focus()` + 跳 `#msg-<seq>`（锚点已存在）。

## 10. 防冒充

- handle 全局唯一（只一个 "leo"）+ 不得撞 token 名 + 保留名拒绝。
- 展示始终把 account/email 作可信锚点（tooltip/副标签）——底层是谁永远可查。
- handle 只影响显示与"被@检测"，**不授予任何权限**；ACL 判定完全不看 handle。

## 11. 历史消息显示

- 靠 stamp 的 `sender_handle`：老消息显示**发送当时**的 handle；设 handle 之前的老消息无 stamp → 回退 email/sub。
- 改名不回溯改写老消息（简单；"显示当时是谁"也更合理）。

## 12. 向后兼容 / 灰度

- 默认无 handle → 人类照旧显示 email，**零破坏**。
- 协议字段全可选；migration 纯新增（新表 + 新列）。
- 旧 worker 响应缺字段 → 前端回退。

## 13. 测试

- worker（vitest）：`account_profiles` upsert；handle 校验（格式/唯一/撞 token 名/保留名/改名）；`/api/me` 带 handle；转发 `x-ap-handle`；DO stamp `sender_handle` + presence.handle。migration 幂等 + `verify:remote-schema`。
- web（bun:test）：`shouldNotify` 纯函数全分支；mention 候选含人类 handle 且插入 token 正确；MessageCard/PresenceBar 显示 handle/回退。
- chrome-use（真实页面）：设置 handle 流程、改名 409 提示、别人 @handle 后显示、R5 检测+权限 gating（通知本体在无头难验，重点验检测逻辑与 opt-in 门）。

## 14. 风险 / 待实现时确认

- mention 命名空间冲突：handle 与 token 名唯一性需在 `PUT` 和铸 token（`persistToken` / `/api/tokens` / `/api/agents` / `/api/spawn`）**两侧都校验**，避免 A 先占 handle "leo"、B 再铸 token "leo"（或反向）。实现时需在铸 token 路径也查 `account_profiles.handle`。
- 改名后老 presence/连接的 handle 刷新时机（下次连接/下条消息才更新；可接受）。
