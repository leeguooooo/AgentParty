#!/usr/bin/env sh
# 内网私有部署：在自己的机器上跑 AgentParty，不连 Cloudflare 任何服务。
#
# 运行时是 workerd —— Cloudflare Worker 运行时的开源实现。Durable Object / D1 / R2
# 在本地都有实现，状态落在一个目录里（见 --data）。真机验证过：建频道、CLI 接入、
# WebSocket @ 唤醒、定向投递、重启不丢数据，全部可用。
#
# 这个脚本存在的首要理由是**预检**。在 AlmaLinux 9 + Node 16 的真机上实测：
# 服务能启动、端口能 LISTEN、TCP 能连上，然后请求**零字节零报错永远挂住**——
# 因为 workerd 通过 loopback 回调 supervisor 取绑定，而 supervisor 在旧 Node 上是坏的。
# 那个形态几乎不可能自己查出来（我是跑了个 hello-world worker 才排除掉「是我们代码的问题」）。
# 所以：宁可在这里响亮地拒绝启动，也不让人撞上那个静默挂起。
#
# 预检只用 POSIX sh 内建能力——它必须在「Node 太旧」的机器上照样跑得起来，
# 不能反过来依赖 node/bun。
set -eu

# wrangler 4.118+ 的 package.json 写死 engines.node >= 22。别在这里凭印象写数字。
MIN_NODE_MAJOR=22

REPO="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DATA_DIR="${AGENTPARTY_SELFHOST_DATA:-$REPO/.selfhost-state}"
HOST="${AGENTPARTY_SELFHOST_HOST:-0.0.0.0}"
PORT="${AGENTPARTY_SELFHOST_PORT:-8787}"
LOG="${AGENTPARTY_SELFHOST_LOG:-$DATA_DIR/worker.log}"
PIDFILE="$DATA_DIR/worker.pid"

die() { printf '%s\n' "selfhost: $*" >&2; exit 1; }
note() { printf '%s\n' "selfhost: $*"; }

node_major() {
  # `node -v` 形如 v22.14.0；取中间那个数字，纯参数展开，不起子进程。
  v="$1"; v="${v#v}"; echo "${v%%.*}"
}

preflight() {
  command -v node >/dev/null 2>&1 || die "找不到 node。需要 Node >= $MIN_NODE_MAJOR（wrangler 的 engines 要求）。"
  raw="$(node -v 2>/dev/null || echo '')"
  major="$(node_major "$raw")"
  case "$major" in
    ''|*[!0-9]*) die "读不出 node 版本（node -v 输出：'$raw'）。需要 Node >= $MIN_NODE_MAJOR。" ;;
  esac
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    cat >&2 <<EOF
selfhost: Node 版本太低：$raw（需要 >= v$MIN_NODE_MAJOR.0.0）

  这不是「可能会有问题」——真机实测的表现是：
    服务照常启动、端口照常 LISTEN、TCP 照常连上，
    然后每个请求都**零字节、零报错、永远挂住**。
  原因：workerd 通过本地回环调用 supervisor 取 D1/R2/DO 绑定，
        而 supervisor 在旧 Node 上不工作，且不报任何错。

  装一个新版 Node（不必替换系统的那个）：
    curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o /tmp/n22.tar.xz
    tar -C /opt -xf /tmp/n22.tar.xz && mv /opt/node-v22.14.0-linux-x64 /opt/node22
    export PATH=/opt/node22/bin:\$PATH
EOF
    exit 1
  fi
  [ -f "$REPO/web/dist/index.html" ] || die "web 还没构建：先跑 \`cd web && bunx vite build\`（旧 Node 上用 \`bun --bun x vite build\`）。"
  note "预检通过：node $raw，web 产物已就绪"
}

wrangler_js() {
  # 用仓库里装好的那份，不依赖全局 wrangler。
  found=""
  for p in "$REPO"/node_modules/.bun/wrangler@*/node_modules/wrangler/bin/wrangler.js "$REPO"/node_modules/wrangler/bin/wrangler.js; do
    [ -f "$p" ] && found="$p"
  done
  [ -n "$found" ] || die "找不到 wrangler，先在仓库根目录跑 \`bun install\`。"
  printf '%s' "$found"
}

migrate() {
  preflight
  mkdir -p "$DATA_DIR"
  note "应用 D1 迁移到 $DATA_DIR"
  ( cd "$REPO/worker" && node "$(wrangler_js)" d1 migrations apply agentparty --local --persist-to "$DATA_DIR" )
}

start() {
  preflight
  mkdir -p "$DATA_DIR"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    die "已经在跑了（pid $(cat "$PIDFILE")）。先 \`$0 stop\`。"
  fi
  [ -n "${AGENTPARTY_ADMIN_SECRET:-}" ] || die "必须设 AGENTPARTY_ADMIN_SECRET —— 自部署没有任何登录方式，第一个 token 只能靠它铸出来（见 docs/self-host-intranet.md）。"
  migrate
  note "启动 workerd（$HOST:$PORT，数据在 $DATA_DIR）"
  ( cd "$REPO/worker" && setsid node "$(wrangler_js)" dev --local \
      --ip "$HOST" --port "$PORT" --persist-to "$DATA_DIR" \
      --var HOSTED_MEMBERSHIP_GATING:false \
      --var "ADMIN_SECRET:$AGENTPARTY_ADMIN_SECRET" \
      >"$LOG" 2>&1 </dev/null & echo $! > "$PIDFILE" )
  note "pid $(cat "$PIDFILE")，日志 $LOG"
  note "等它就绪…"
  i=0
  while [ "$i" -lt 60 ]; do
    if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      note "就绪：http://$HOST:$PORT"
      return 0
    fi
    i=$((i + 1)); sleep 2
  done
  die "60 秒内没就绪，看日志：$LOG"
}

stop() {
  [ -f "$PIDFILE" ] || { note "没在跑"; return 0; }
  pid="$(cat "$PIDFILE")"
  # 只杀自己这棵进程树，绝不 pkill -f workerd —— 同机可能有别人的 workerd。
  kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  note "已停"
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    note "运行中，pid $(cat "$PIDFILE")"
    curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || note "但 /api/health 没应答"
    echo
  else
    note "没在跑"
  fi
}

usage() {
  cat <<EOF
usage: $0 <start|stop|status|migrate|preflight>

环境变量：
  AGENTPARTY_ADMIN_SECRET   必填（start）。铸第一个 token 用，见 docs/self-host-intranet.md
  AGENTPARTY_SELFHOST_DATA  状态目录，默认 <repo>/.selfhost-state（备份就备份它）
  AGENTPARTY_SELFHOST_HOST  默认 0.0.0.0
  AGENTPARTY_SELFHOST_PORT  默认 8787
EOF
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  migrate) migrate ;;
  preflight) preflight ;;
  *) usage; exit 1 ;;
esac
