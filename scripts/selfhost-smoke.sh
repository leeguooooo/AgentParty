#!/usr/bin/env sh
# 自部署验收：从零走到「@ 真能叫醒 agent」，全绿才算部署成功。
#
# 为什么要有它：`/api/health` 返回 ok **不代表能用**。真机上踩过的三个坑，
# 每一个都能让 health 正常而功能全废：
#   - D1 迁移没跑    → 铸 token 直接 500（日志里只有 500，没有 no such table）
#   - 没设 ADMIN_SECRET → 自部署没有任何登录方式，第一个 token 根本铸不出来
#   - supervisor 用了旧 Node → 端口 LISTEN、请求零字节永远挂住
# 所以判据是**功能**：铸 token → 建频道 → 发消息 → 读回来。
set -eu

BASE="${1:-http://127.0.0.1:${AGENTPARTY_SELFHOST_PORT:-8787}}"
SECRET="${AGENTPARTY_ADMIN_SECRET:-}"
CHANNEL="${AGENTPARTY_SMOKE_CHANNEL:-selfhost-smoke}"
[ -n "$SECRET" ] || { echo "smoke: 需要 AGENTPARTY_ADMIN_SECRET" >&2; exit 1; }

fail() { printf 'smoke: ✗ %s\n' "$*" >&2; exit 1; }
ok() { printf 'smoke: ✓ %s\n' "$*"; }

# 1) 活着
curl -fsS --max-time 10 "$BASE/api/health" >/dev/null 2>&1 || fail "/api/health 不通（${BASE}）"
ok "health"

# 每次跑用唯一名字：smoke 要能反复跑。第一版复用固定名字，第二次就撞重名，
# 而错误信息却把它归到「迁移没跑」——错因指错方向比不报错更浪费时间。
RUN="$(date +%s)-$$"   # 秒数会在同一秒内两次运行时撞名（409），拼上 pid

# 分诊靠**真实 HTTP 状态**，不靠猜。curl 把状态码附在正文末尾一行。
post() { # $1=path $2=headers-name $3=header-value $4=json
  curl -sS --max-time 15 -X POST "$BASE$1" -H "$2: $3" -H 'content-type: application/json' \
    -d "$4" -w '\n%{http_code}' 2>/dev/null || printf '\n000'
}
body_of() { printf '%s' "$1" | sed '$d'; }
code_of() { printf '%s' "$1" | tail -1; }

# 2) 能铸 token —— 这一步会同时暴露「迁移没跑」（500）和「secret 不对」（401）
r="$(post /api/tokens x-admin-secret "$SECRET" "{\"name\":\"smoke-human-$RUN\",\"role\":\"human\",\"owner\":\"selfhost:smoke\"}")"
human="$(body_of "$r")"; code="$(code_of "$r")"
case "$code" in
  200|201) : ;;
  401) fail "ADMIN_SECRET 不匹配（注意请求头是 x-admin-secret，不是 Authorization）" ;;
  500) fail "服务端 500 —— 多半是 D1 迁移没跑：先 scripts/selfhost.sh migrate" ;;
  000) fail "连不上 ${BASE}（服务没起？端口不对？）" ;;
  *) fail "铸 token 失败（HTTP ${code}）：$human" ;;
esac
HT="$(printf '%s' "$human" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$HT" ] || fail "铸出来了但解析不出 token"
ok "bootstrap token（ADMIN_SECRET 路径可用）"

# 3) 建频道
r="$(post /api/channels authorization "Bearer $HT" "{\"slug\":\"$CHANNEL\",\"title\":\"selfhost smoke\"}")"
code="$(code_of "$r")"
case "$code" in
  200|201) ok "建频道 #$CHANNEL" ;;
  # 复跑时频道已存在是**正常**，不是失败——smoke 必须能反复跑
  409|422) ok "频道 #$CHANNEL 已存在（复跑）" ;;
  *) fail "建频道失败（HTTP ${code}）：$(body_of "$r")" ;;
esac

# 4) 铸 agent token（走的是「human 账号自助铸」那条路，与 bootstrap 不同）
r="$(post /api/agents authorization "Bearer $HT" "{\"name\":\"smoke-bot-$RUN\"}")"
AT="$(body_of "$r" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
[ -n "$AT" ] || fail "铸 agent token 失败（HTTP $(code_of "$r")）：$(body_of "$r")"
ok "agent token"

# 5) 发消息 —— 这一步真正穿过 Durable Object。
#    kind 必须是 "message"（不是 "msg"）：格式以 worker/src/do.ts 的 parseSendFrame 为准，
#    别照直觉猜——我第一版就猜错了，返回的只是笼统的 invalid send payload。
r="$(post "/api/channels/$CHANNEL/messages" authorization "Bearer $AT" "{\"kind\":\"message\",\"body\":\"selfhost smoke $RUN\",\"mentions\":[]}")"
SEQ="$(body_of "$r" | sed -n 's/.*"seq":\([0-9][0-9]*\).*/\1/p' | head -1)"
[ -n "$SEQ" ] || fail "发消息失败（HTTP $(code_of "$r")）：$(body_of "$r")"
ok "发消息（穿过 ChannelDO，seq ${SEQ}）"

# 6) 读回来 —— 证明它真的落盘了，不只是被接受。
#    必须按本次的 seq 精确读：`?limit=5` 给的是最旧的 5 条，频道里积累超过 5 条
#    （smoke 跑到第 6 次）就读不到自己那条，会把「一切正常」误报成失败。
hist="$(curl -fsS --max-time 15 "$BASE/api/channels/$CHANNEL/messages?since=$((SEQ - 1))&limit=1" \
  -H "authorization: Bearer $AT" 2>/dev/null || true)"
case "$hist" in
  *"selfhost smoke $RUN"*) ok "读回消息（DO 存储可用）" ;;
  *) fail "读不回刚发的消息（seq ${SEQ}）：$hist" ;;
esac

printf '\nsmoke: 全部通过 —— 这台自部署实例可以用了（%s）\n' "$BASE"
