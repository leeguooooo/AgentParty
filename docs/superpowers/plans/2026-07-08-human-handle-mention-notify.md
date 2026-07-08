# 人类可@昵称(handle) + 被@浏览器通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让人类账号设置全局唯一、可读、可被 @ 的 handle（取代 email/sub 显示），并在被 @ 且标签页未聚焦时弹浏览器通知。

**Architecture:** Approach A —— handle 是"显示 + 被@检测"别名，不改核心 `name` 身份键、不动 ACL。新表 `account_profiles(account, handle)`；worker 查出 handle 经 `x-ap-handle` 头下发给 DO（沿用 `x-ap-owner` 套路），DO 盖到 presence 并 stamp 到消息（沿用 `sender_owner` 套路）。R5 纯客户端：`/api/me` 返回 handle，客户端检测 `msg.mentions` 是否含自己的 handle。

**Tech Stack:** Cloudflare Worker + Hono + partyserver(Durable Object) + D1；shared TS 协议；web React 19 + Vite；worker 测试 vitest(`@cloudflare/vitest-pool-workers`)，web 纯函数测试 bun:test。包管理 bun。

## Global Constraints

- 设计源：`docs/superpowers/specs/2026-07-08-human-handle-mention-notify-design.md`（逐条对照）。
- **不改身份/ACL 键**：account(email) 仍是唯一 ACL 锚点；handle 不授予任何权限。
- 协议新增字段全部**可选**，旧客户端忽略（向后兼容）。migration 纯新增（新表 + 新列）。
- handle 校验：正则 `^[a-z0-9][a-z0-9._-]{1,31}$`；不得等于任何 `tokens.name`；拒绝 `RESERVED_NAMES`（含 `system`）。**唯一性两侧校验**：PUT handle 与铸 token 路径都要查对方命名空间。
- **提交约定**：commit message 与 PR 正文**不加任何 Claude 署名**（无 `Co-Authored-By: Claude`、无 `Claude-Session`、无 `Generated with Claude Code`）。git 身份用项目本地已配的 `Evan233 <45483911+Tewii233@users.noreply.github.com>`。
- 默认无 handle = 零破坏（人类照旧显示 email）。
- 每个任务：先写失败测试 → 跑到失败 → 最小实现 → 跑到通过 → 提交。改 worker 后 `cd worker && bunx tsc --noEmit`；改 web 后 `cd web && bunx tsc --noEmit && bunx vite build`。
- 高风险任务（migration / 协议 / DO / 铸 token 唯一性）实现后启用独立 Claude-Critic 复审。

---

## Phase A — 后端：handle 落库与下发

### Task A1: migration 0014 + DO schema 加列

**Files:**
- Create: `worker/migrations/0014_account_profiles.sql`
- Modify: `worker/src/do.ts`（DO 建表/迁移块，加 `messages.sender_handle`、`presence.handle` 列，与现有 `sender_owner`/`presence.account` 的 ALTER 同处）
- Test: `worker/test/profile.spec.ts`（新建，后续 A4 复用）；`worker/scripts/verify-remote-schema.mjs`（若枚举了列则补）

**Interfaces:**
- Produces: 表 `account_profiles(account TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`；DO `messages.sender_handle TEXT`、`presence.handle TEXT`。

- [ ] **Step 1: 写 migration**

`worker/migrations/0014_account_profiles.sql`：
```sql
-- 人类全局唯一 handle（可@昵称，spec 2026-07-08）。handle 是显示+被@检测别名，不授予权限。
CREATE TABLE account_profiles (
  account    TEXT PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_account_profiles_handle ON account_profiles(handle);
```

- [ ] **Step 2: DO schema 加列**

在 `worker/src/do.ts` 现有 `messages`/`presence` 的迁移块（搜 `ADD COLUMN sender_owner` / `ADD COLUMN account`）后追加幂等 ALTER：
```ts
// sender_handle：发送时快照人类 handle（同 sender_owner 手法）
"ALTER TABLE messages ADD COLUMN sender_handle TEXT",
// presence.handle：当前连接的人类 handle
"ALTER TABLE presence ADD COLUMN handle TEXT",
```
（按该文件既有 try/catch 逐条 ALTER 的幂等写法照抄。）

- [ ] **Step 3: 应用本地 migration 验证**

Run: `cd worker && echo y | bunx wrangler d1 migrations apply agentparty --local`
Expected: `0014_account_profiles.sql ✅`

- [ ] **Step 4: 提交**

```bash
git add worker/migrations/0014_account_profiles.sql worker/src/do.ts
git commit -m "feat(worker): account_profiles 表 + DO sender_handle/presence.handle 列"
```

---

### Task A2: 协议字段

**Files:**
- Modify: `shared/src/protocol.ts`（`Sender`、`PresenceEntry` 加 `handle?`）

**Interfaces:**
- Produces: `Sender.handle?: string`；`PresenceEntry.handle?: string`。

- [ ] **Step 1: 加字段**

`Sender` 接口加：
```ts
  /** 人类全局唯一昵称（可@别名）。仅人类且已设置时下发；agent/未设置省略。旧客户端忽略。 */
  handle?: string;
```
`PresenceEntry` 接口加同样的 `handle?: string`（附注释）。

- [ ] **Step 2: tsc**

Run: `cd shared && bunx tsc --noEmit`  Expected: 通过（纯类型新增）
Run: `cd worker && bunx tsc --noEmit`  Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add shared/src/protocol.ts
git commit -m "feat(shared): Sender/PresenceEntry 增可选 handle 字段"
```

---

### Task A3: handle 校验 + 唯一性纯逻辑

**Files:**
- Create: `worker/src/handle.ts`（`HANDLE_RE`、`validateHandleFormat`、`isHandleTaken`）
- Test: `worker/test/handle.spec.ts`

**Interfaces:**
- Produces:
  - `export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/`
  - `export function validateHandleFormat(input: unknown): string | null`（合法返回规范化 handle，否则 null）
  - `export async function handleConflict(db: D1Database, handle: string, forAccount: string | null): Promise<"token_name" | "taken" | "reserved" | null>`（无冲突返回 null）

- [ ] **Step 1: 写失败测试**

`worker/test/handle.spec.ts`：
```ts
import { describe, it, expect } from "vitest";
import { validateHandleFormat, HANDLE_RE } from "../src/handle";

describe("validateHandleFormat", () => {
  it("接受合法 handle", () => {
    expect(validateHandleFormat("leo")).toBe("leo");
    expect(validateHandleFormat("a1._-b")).toBe("a1._-b");
  });
  it("拒绝非法：大写/太短/太长/非法首字/非串", () => {
    expect(validateHandleFormat("Leo")).toBeNull();
    expect(validateHandleFormat("a")).toBeNull();
    expect(validateHandleFormat("-abc")).toBeNull();
    expect(validateHandleFormat("a".repeat(33))).toBeNull();
    expect(validateHandleFormat(123)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑到失败**

Run: `cd worker && bunx vitest run test/handle.spec.ts`  Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`worker/src/handle.ts`：
```ts
import { RESERVED_NAMES } from "@agentparty/shared";

export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function validateHandleFormat(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const h = input.trim();
  return HANDLE_RE.test(h) ? h : null;
}

// 冲突检查：撞保留名 / 撞任意 token 名 / 已被别的账号占用。无冲突返回 null。
export async function handleConflict(
  db: D1Database,
  handle: string,
  forAccount: string | null,
): Promise<"reserved" | "token_name" | "taken" | null> {
  if (RESERVED_NAMES.includes(handle)) return "reserved";
  const tok = await db.prepare("SELECT 1 FROM tokens WHERE name = ?").bind(handle).first();
  if (tok) return "token_name";
  const owner = await db
    .prepare("SELECT account FROM account_profiles WHERE handle = ?")
    .bind(handle)
    .first<{ account: string }>();
  if (owner && owner.account !== forAccount) return "taken";
  return null;
}
```

- [ ] **Step 4: 跑到通过**

Run: `cd worker && bunx vitest run test/handle.spec.ts`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add worker/src/handle.ts worker/test/handle.spec.ts
git commit -m "feat(worker): handle 格式校验 + 命名空间冲突检查"
```

---

### Task A4: `PUT /api/me/handle` + `GET /api/me` 带 handle

**Files:**
- Modify: `worker/src/index.ts`（`GET /api/me` 约 `:482`；新增 `PUT /api/me/handle`）
- Test: `worker/test/profile.spec.ts`

**Interfaces:**
- Consumes: `validateHandleFormat`、`handleConflict`（Task A3）。
- Produces: `GET /api/me` 响应含 `handle: string | null`；`PUT /api/me/handle` body `{handle}` → `{handle}` / 400 / 403 / 409。

- [ ] **Step 1: 写失败测试**

`worker/test/profile.spec.ts`（用仓库既有 worker 测试 harness / helpers.ts 建 human 账号会话 token）：
```ts
import { describe, it, expect } from "vitest";
// 参照 worker/test/helpers.ts 的既有工具铸 human 账号 token、发起请求
import { newHumanToken, app, env } from "./helpers";

describe("PUT /api/me/handle", () => {
  it("设置合法 handle 后 /api/me 返回它", async () => {
    const token = await newHumanToken({ owner: "leo@x.com" });
    const put = await app.request("/api/me/handle", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "leo" }),
    }, env);
    expect(put.status).toBe(200);
    const me = await (await app.request("/api/me", { headers: { authorization: `Bearer ${token}` } }, env)).json();
    expect(me.handle).toBe("leo");
  });
  it("撞已存在 token 名 → 409", async () => {
    // 先铸个 agent token 名 "bob"，再让人类想占 handle "bob"
    const token = await newHumanToken({ owner: "z@x.com" });
    // ...铸 agent "bob"（参照 helpers）...
    const put = await app.request("/api/me/handle", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ handle: "bob" }),
    }, env);
    expect(put.status).toBe(409);
  });
});
```
> 注：`helpers.ts` 的确切工具名以仓库现状为准（实现时先读 `worker/test/helpers.ts`），保持与既有 spec 一致的建 token/发请求方式。

- [ ] **Step 2: 跑到失败**

Run: `cd worker && bunx vitest run test/profile.spec.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`GET /api/me`（`index.ts:482` 内）：查 `account_profiles` 加字段：
```ts
const profile = id.account == null ? null : await c.env.DB
  .prepare("SELECT handle FROM account_profiles WHERE account = ?").bind(id.account)
  .first<{ handle: string }>();
// ...原返回对象里加：
handle: profile?.handle ?? null,
```
新增端点（放在 `/api/me` 附近）：
```ts
app.put("/api/me/handle", requireBearer, async (c) => {
  const id = c.get("identity");
  if (id.role === "readonly" || id.account == null) {
    return c.json(errorBody("forbidden", "setting a handle requires a human account session"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as { handle?: unknown } | null;
  const handle = validateHandleFormat(body?.handle);
  if (handle === null) {
    return c.json(errorBody("bad_request", "handle must match ^[a-z0-9][a-z0-9._-]{1,31}$"), 400);
  }
  const conflict = await handleConflict(c.env.DB, handle, id.account);
  if (conflict !== null) {
    return c.json(errorBody("conflict", `handle unavailable (${conflict})`), 409);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO account_profiles (account, handle, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at`,
  ).bind(id.account, handle, now, now).run();
  return c.json({ handle });
});
```

- [ ] **Step 4: 跑到通过**

Run: `cd worker && bunx vitest run test/profile.spec.ts && bunx tsc --noEmit`  Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add worker/src/index.ts worker/test/profile.spec.ts
git commit -m "feat(worker): PUT /api/me/handle + GET /api/me 返回 handle"
```

---

### Task A5: 铸 token 侧唯一性（反向冲突）

**Files:**
- Modify: `worker/src/index.ts`（`persistToken` 或其调用点 `/api/tokens`、`/api/agents`、`/api/spawn`：铸名前查 `account_profiles.handle`）
- Test: `worker/test/tokens.spec.ts`（追加）

**Interfaces:**
- Consumes: `account_profiles`（Task A1）。
- Produces: 铸 token 名若等于某已存在 handle → 409（与现有 name 冲突同样处理）。

- [ ] **Step 1: 写失败测试**：先设 handle "leo"，再尝试铸名为 "leo" 的 agent token → 期望 409。

- [ ] **Step 2: 跑到失败** — Run: `cd worker && bunx vitest run test/tokens.spec.ts`

- [ ] **Step 3: 实现**：在 `persistToken`（`index.ts` 内）插入/复用行之前加一查：
```ts
const handleOwner = await db.prepare("SELECT 1 FROM account_profiles WHERE handle = ?")
  .bind(opts.name).first();
if (handleOwner) return { conflict: true };
```
（放在现有同名活 token 检查旁，保证 `/api/tokens`、`/api/agents`、`/api/spawn` 三入口都覆盖。）

- [ ] **Step 4: 跑到通过** — Run: `cd worker && bunx vitest run test/tokens.spec.ts && bunx tsc --noEmit`

- [ ] **Step 5: 提交**
```bash
git add worker/src/index.ts worker/test/tokens.spec.ts
git commit -m "feat(worker): 铸 token 名不得撞已存在 handle（双向唯一性）"
```

---

### Task A6: worker 转发 `x-ap-handle` 给 DO

**Files:**
- Modify: `worker/src/index.ts`（WS 升级转发 + `POST /api/channels/:slug/messages` 转发，加 `x-ap-handle` 头 + 计入 `AP_FORWARD_HEADERS` 剥离清单）
- Test: `worker/test/ws-header-injection.spec.ts`（追加：客户端注入 `x-ap-handle` 被剥离）

**Interfaces:**
- Consumes: `account_profiles`。
- Produces: DO 收到权威 `x-ap-handle`（仅当发送者是有 handle 的人类）。

- [ ] **Step 1: 写失败测试**：客户端连接时自带伪造 `x-ap-handle: evil` → DO 侧 presence/sender 不应采信（应为该账号真实 handle 或空）。

- [ ] **Step 2: 跑到失败**

- [ ] **Step 3: 实现**：
  - 把 `"x-ap-handle"` 加入 `AP_FORWARD_HEADERS` 剥离清单（`index.ts:57` 附近）。
  - 加辅助 `async function handleHeader(db, account): Promise<Record<string,string>>`：account 非空则查 handle，返回 `{ "x-ap-handle": handle }` 或 `{}`。
  - 在 WS 升级转发与 `POST .../messages` 转发处 `...(await handleHeader(c.env.DB, identity.account))`。

- [ ] **Step 4: 跑到通过** — Run: `cd worker && bunx vitest run test/ws-header-injection.spec.ts && bunx tsc --noEmit`

- [ ] **Step 5: 提交**
```bash
git add worker/src/index.ts worker/test/ws-header-injection.spec.ts
git commit -m "feat(worker): 转发权威 x-ap-handle 给 DO（剥离客户端注入）"
```

---

### Task A7: DO 消费 handle → presence + 消息 + 下发

**Files:**
- Modify: `worker/src/do.ts`（onConnect 读 `x-ap-handle` 存 conn state + presence.handle；handleSend stamp `sender_handle`；`senderFromIdentity` / presence 构造带 handle；`rowToFrame` 回填 `sender.handle`）
- Test: `worker/test/history.spec.ts` 或新 `worker/test/handle-wire.spec.ts`

**Interfaces:**
- Consumes: `x-ap-handle` 头（Task A6）、`sender_handle`/`presence.handle` 列（Task A1）。
- Produces: 下发的 `MsgFrame.sender.handle`、`PresenceEntry.handle`。

- [ ] **Step 1: 写失败测试**：带 `x-ap-handle: leo` 发一条消息 → 该消息 `sender.handle === "leo"`；presence 该 name 的 `handle === "leo"`；历史拉取仍带 handle。

- [ ] **Step 2: 跑到失败**

- [ ] **Step 3: 实现**（按 do.ts 既有 sender_owner/context 的存取镜像）：
  - `ConnState` 加 `handle?: string`；onConnect 读 `h.get("x-ap-handle")` 存入。
  - `senderFromIdentity`（或消息 insert 处）把 handle 写入 `sender.handle` 与 `sender_handle` 列。
  - presence upsert 写 `handle` 列；`presenceFor`/`PresenceEntry` 构造带 handle。
  - `rowToFrame` 读 `sender_handle` 回填 `sender.handle`。

- [ ] **Step 4: 跑到通过** — Run: `cd worker && bunx vitest run test/handle-wire.spec.ts && bunx tsc --noEmit`

- [ ] **Step 5: 提交**
```bash
git add worker/src/do.ts worker/test/handle-wire.spec.ts
git commit -m "feat(worker): DO 盖 presence.handle + stamp sender_handle + 下发 handle"
```

---

## Phase B — 前端 R4：显示 / 设置 / mention

### Task B1: api.ts setHandle + me.handle 类型

**Files:**
- Modify: `web/src/lib/api.ts`（`Me` 类型加 `handle: string | null`；新增 `setHandle(handle): Promise<{handle:string}>`）

**Interfaces:**
- Produces: `setHandle(handle: string)` → `PUT /api/me/handle`；409→`ConflictError`、400→`ValidationError`、403→`ForbiddenError`。

- [ ] **Step 1: 实现**（复用现有错误类与 `getToken()`，仿 `reviseMessage` 风格）：
```ts
export async function setHandle(handle: string): Promise<{ handle: string }> {
  const token = getToken();
  if (token === null) throw new AuthError("missing token");
  const res = await fetch("/api/me/handle", {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (res.status === 400) throw new ValidationError("invalid handle");
  if (res.status === 409) throw new ConflictError("handle unavailable");
  if (!res.ok) throw new Error(`PUT /api/me/handle failed (${res.status})`);
  return (await res.json()) as { handle: string };
}
```
并把 `Me`（`fetchMe` 返回类型）加 `handle: string | null`。

- [ ] **Step 2: tsc** — Run: `cd web && bunx tsc --noEmit`  Expected: 通过
- [ ] **Step 3: 提交**
```bash
git add web/src/lib/api.ts
git commit -m "feat(web): api.setHandle + Me.handle 类型"
```

### Task B2: 设置 handle 的 UI（非强制提示 + 改名入口）

**Files:**
- Create: `web/src/components/HandleSetup.tsx`（设置/改名表单：输入 + 保存 + 内联错误）
- Modify: `web/src/App.tsx`（me chip 处放"设置显示名"入口；人类无 handle 时显眼但可关的提示）
- Modify: `web/src/i18n/strings/App.ts`（+ 新文案 en/zh）

**Interfaces:**
- Consumes: `setHandle`（B1）、`me.handle`。
- Produces: 用户可设置/修改 handle；成功后本地刷新 me.handle。

- [ ] Step 1: 实现 HandleSetup（输入校验前端也提示 `^[a-z0-9][a-z0-9._-]{1,31}$`；ConflictError→"已被占用"、ValidationError→"格式不符"）。
- [ ] Step 2: App.tsx 接入：人类 `me.handle === null` 时在顶栏显示可关闭的"设置显示名"提示；me chip 下拉/按钮打开 HandleSetup。i18n 走现有机制（en+zh，默认 en）。
- [ ] Step 3: tsc + build — Run: `cd web && bunx tsc --noEmit && bunx vite build`
- [ ] Step 4: 提交
```bash
git add web/src/components/HandleSetup.tsx web/src/App.tsx web/src/i18n/strings/App.ts
git commit -m "feat(web): 人类设置/修改 handle 的 UI（非强制提示）"
```

### Task B3: mention 候选把人类 handle 作 @ 目标

**Files:**
- Modify: `web/src/lib/mentions.ts`（人类候选：有 handle 时 `name`(@插入token)=handle、`display`=handle）
- Test: `web/src/lib/mentions.test.ts`（追加）

**Interfaces:**
- Consumes: `PresenceEntry.handle`（协议已加）。
- Produces: mention 候选中人类以 handle 作 @ 目标。

- [ ] Step 1: 写失败测试：presence 含一个 `{name:<uuid>, kind:"human", handle:"leo"}` → `mentionCandidates(...)` 产出一条 `name==="leo"`（可 @）且 `display==="leo"`。
- [ ] Step 2: 跑到失败 — Run: `cd web && bun test src/lib/mentions.test.ts`
- [ ] Step 3: 实现：在候选构造处，人类且有 `handle` 时用 handle 覆盖 `name`/`display`（无 handle 维持现状）。
- [ ] Step 4: 跑到通过 — Run: `cd web && bun test src/lib/mentions.test.ts`
- [ ] Step 5: 提交
```bash
git add web/src/lib/mentions.ts web/src/lib/mentions.test.ts
git commit -m "feat(web): mention 候选以 handle 作人类的 @ 目标"
```

### Task B4: 显示层用 handle（MessageCard / PresenceBar）

**Files:**
- Modify: `web/src/components/MessageCard.tsx`（sender 显示优先 `msg.sender.handle`，回退现有 name/owner 逻辑；email 进 title 锚点）
- Modify: `web/src/components/PresenceBar.tsx`（参与者优先显示 `entry.handle`）

**Interfaces:**
- Consumes: `Sender.handle` / `PresenceEntry.handle`。

- [ ] Step 1: 实现：`const shown = msg.sender.handle ?? <现有显示>`；`title` 里保留 sender/account/email（防冒充锚点）。PresenceBar 同理。
- [ ] Step 2: tsc + build — Run: `cd web && bunx tsc --noEmit && bunx vite build`
- [ ] Step 3: 提交
```bash
git add web/src/components/MessageCard.tsx web/src/components/PresenceBar.tsx
git commit -m "feat(web): 消息卡/presence 优先显示 handle，email 作锚点"
```

---

## Phase C — 前端 R5：被@浏览器通知

### Task C1: `shouldNotify` 纯函数

**Files:**
- Create: `web/src/lib/notify.ts`
- Test: `web/src/lib/notify.test.ts`

**Interfaces:**
- Produces: `export function shouldNotify(msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean): boolean`

- [ ] **Step 1: 写失败测试**

`web/src/lib/notify.test.ts`：
```ts
import { test, expect } from "bun:test";
import { shouldNotify } from "./notify";
const base = (over = {}) => ({ type:"msg", kind:"message", seq:5, mentions:["leo"], retracted:undefined,
  sender:{name:"bob",kind:"agent"}, body:"hi @leo", ...over } as any);

test("被@ + 隐藏 + 已授权 → true", () => {
  expect(shouldNotify(base(), "leo", true, true)).toBe(true);
});
test("标签页可见 → false", () => {
  expect(shouldNotify(base(), "leo", false, true)).toBe(false);
});
test("未授权 → false", () => {
  expect(shouldNotify(base(), "leo", true, false)).toBe(false);
});
test("没@我 → false", () => {
  expect(shouldNotify(base({mentions:["carol"]}), "leo", true, true)).toBe(false);
});
test("我没 handle → false", () => {
  expect(shouldNotify(base(), null, true, true)).toBe(false);
});
test("已撤回 / status / 自己发 → false", () => {
  expect(shouldNotify(base({retracted:true}), "leo", true, true)).toBe(false);
  expect(shouldNotify(base({kind:"status"}), "leo", true, true)).toBe(false);
  expect(shouldNotify(base({sender:{name:"leo",kind:"human",handle:"leo"}}), "leo", true, true)).toBe(false);
});
```

- [ ] **Step 2: 跑到失败** — Run: `cd web && bun test src/lib/notify.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`web/src/lib/notify.ts`：
```ts
import type { MsgFrame } from "@agentparty/shared";

export function shouldNotify(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean,
): boolean {
  if (!permissionGranted || !documentHidden || myHandle === null) return false;
  if (msg.kind !== "message" || msg.retracted) return false;
  if (msg.sender.handle === myHandle) return false; // 自己发的
  return msg.mentions.includes(myHandle);
}
```

- [ ] **Step 4: 跑到通过** — Run: `cd web && bun test src/lib/notify.test.ts`  Expected: PASS

- [ ] **Step 5: 提交**
```bash
git add web/src/lib/notify.ts web/src/lib/notify.test.ts
git commit -m "feat(web): shouldNotify 纯函数（被@通知判定）"
```

### Task C2: 通知铃铛开关 + hook + 点击跳转

**Files:**
- Create: `web/src/components/NotifyToggle.tsx`（铃铛：off→点开请求权限、on/off 存 localStorage）
- Modify: `web/src/pages/Channel.tsx`（入帧处调用 `shouldNotify`，命中则 `new Notification(...)`；点通知 `window.focus()`+跳 `#msg-<seq>`；�reçu铛放频道头）
- Modify: `web/src/i18n/strings/Channel.ts`（+ 文案）

**Interfaces:**
- Consumes: `shouldNotify`（C1）、`me.handle`。
- Produces: 未聚焦被@时弹通知。opt-in 全局存 localStorage key `ap_notify_optin`。

- [ ] Step 1: 实现 NotifyToggle：读/写 `localStorage.ap_notify_optin`；点开时 `Notification.requestPermission()`，拒绝则回落 off + 提示。
- [ ] Step 2: Channel.tsx：在处理入 `msg` 帧处（reducer 外的副作用点，如 `dispatch` 后的 effect 或帧回调），`if (shouldNotify(frame, me.handle, document.hidden, optin && Notification.permission==="granted")) { const n = new Notification(...); n.onclick = ()=>{ window.focus(); location.hash = "#msg-"+frame.seq; }; }`；按 seq 去重。
- [ ] Step 3: tsc + build — Run: `cd web && bunx tsc --noEmit && bunx vite build`
- [ ] Step 4: 提交
```bash
git add web/src/components/NotifyToggle.tsx web/src/pages/Channel.tsx web/src/i18n/strings/Channel.ts
git commit -m "feat(web): 被@浏览器通知（铃铛 opt-in + 未聚焦弹 + 点击跳转）"
```

---

## Phase D — 集成验证（不改产品码，除非修 bug）

### Task D1: 全量 check + 本地全栈 chrome-use

- [ ] Step 1: `cd worker && bunx tsc --noEmit && bunx vitest run`  Expected: 全绿
- [ ] Step 2: `cd web && bunx tsc --noEmit && bun test && bunx vite build`  Expected: 全绿
- [ ] Step 3: 本地 wrangler dev 全栈 + chrome-use（参照上批做法）逐条验：
  - 设置 handle → me chip/消息/presence 显示 handle
  - 另一账号 @handle → 出现在 @ 菜单、消息带 mention
  - 被@ + 切走标签页 + 铃铛已开 → 收到通知；点通知跳到该消息
  - 撞 token 名 / 撞已占 handle → 409 内联提示
  - 未设 handle 的人类照旧显示 email（零破坏）
- [ ] Step 4: 记录到 `.claude/context/runtime/verification.md`
- [ ] Step 5（可选）：改动 worker 后 remote schema 验证 `cd worker && bun run verify:test-runtime`

---

## Self-Review（对照 spec）

**Spec 覆盖**：§4 数据模型→A1；§5 协议→A2；§6 端点→A4/A5/A6；§7 DO→A7；§8 前端 R4→B1-B4；§9 前端 R5→C1-C2；§10 防冒充→A3(校验)+A5(反向)+B4(锚点)；§11 历史显示→A7(sender_handle)+B4；§13 测试→各任务 + D1；§14 命名空间双向唯一→A3+A4+A5。✅ 无遗漏。

**Placeholder 扫描**：A4 测试里 `helpers.ts` 工具名标注"以仓库现状为准"（实现时先读 helpers），非占位而是显式适配点；其余步骤含实际代码。✅

**类型一致**：`validateHandleFormat`/`handleConflict`(A3) 在 A4/A5 一致引用；`setHandle`(B1) 在 B2 引用；`shouldNotify`(C1) 签名在 C2 引用一致。✅

**风险复审点**：A1/A2/A6/A7（migration/协议/DO/转发）与 A5（铸 token 唯一性）实现后各跑一次独立 Claude-Critic（防冒充、命名空间、ACL 不受影响、向后兼容）。
