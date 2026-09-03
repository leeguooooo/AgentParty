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
# Wrangler 在 launch() 里会 cd 到 worker/。相对状态目录若不在这里固定，预检/迁移和
# 运行时会悄悄落到两个不同目录（例如调用方的 state 与 worker/state）。
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$(pwd -P)/$DATA_DIR" ;;
esac
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
  command -v node >/dev/null 2>&1 || die "找不到 node。需要 Node >= ${MIN_NODE_MAJOR}（wrangler 的 engines 要求）。"
  raw="$(node -v 2>/dev/null || echo '')"
  major="$(node_major "$raw")"
  case "$major" in
    ''|*[!0-9]*) die "读不出 node 版本（node -v 输出：'$raw'）。需要 Node >= ${MIN_NODE_MAJOR}。" ;;
  esac
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    cat >&2 <<EOF
selfhost: Node 版本太低：${raw}（需要 >= v$MIN_NODE_MAJOR.0.0）

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
  note "预检通过：node ${raw}，web 产物已就绪"
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

prepare_data_dir() {
  ( umask 077; mkdir -p "$DATA_DIR" )
  chmod 700 "$DATA_DIR"
}

apply_migrations() {
  note "应用 D1 迁移到 $DATA_DIR"
  ( cd "$REPO/worker" && node "$(wrangler_js)" d1 migrations apply agentparty --local --persist-to "$DATA_DIR" )
}

migrate() {
  preflight
  prepare_data_dir
  apply_migrations
}

# 版本元数据：注入到 /api/health 的 version / commit / deployed_at。
# 生产部署由 worker/scripts/deployment-metadata.mjs 用同样的 --define 注入；这里是它的 POSIX sh 等价物。
# 没有它，自部署实例永远报 version=dev、commit=unknown，升级后根本核不出「跑的是哪一版」。
repo_version() {
  v="$(sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/cli/package.json" 2>/dev/null | head -1)"
  printf '%s' "${v:-dev}"
}
repo_commit() { git -C "$REPO" rev-parse HEAD 2>/dev/null || printf 'unknown'; }

# 所有运行模式的公共前置：预检、数据目录、secret、.dev.vars。
# 迁移刻意不放在这里：受 supervisor 托管的 `serve` 会在 Wrangler 意外退出后频繁重跑，
# 恢复路径不应重复执行只在安装/升级时需要的 schema 工作（#1061）。
prepare_runtime() {
  preflight
  # D1 里存着**所有 token**，DO 存储里是频道全部内容：只给属主（真机实测改之前是 0755/0644）。
  prepare_data_dir
  [ -n "${AGENTPARTY_ADMIN_SECRET:-}" ] || die "必须设 AGENTPARTY_ADMIN_SECRET —— 自部署没有任何登录方式，第一个 token 只能靠它铸出来（见 docs/self-host-intranet.md）。"
  # 凭据**绝不进 argv**：`ps -axww` 同机任何用户都看得见（真机实测：改之前那里明文躺着
  # ADMIN_SECRET，而它能铸任意 token）。改用 wrangler 的 .dev.vars，0600 只给属主。
  vars="$REPO/worker/.dev.vars"
  ( umask 077; printf 'HOSTED_MEMBERSHIP_GATING=false\nADMIN_SECRET=%s\n' "$AGENTPARTY_ADMIN_SECRET" > "$vars" )
  chmod 600 "$vars"
}

# start 与 run 保持一条命令即可首次启动的兼容行为：准备运行时后应用迁移。
prepare() {
  prepare_runtime
  apply_migrations
}

# 用 workerd 替换当前进程（exec）：调用方的 pid 就是 worker 的 pid，退出码原样透传。
# `run` / `serve` 直接用它（systemd Type=exec / 容器入口）；`start` 通过 `_launch` 在后台用它。
launch() {
  W="$(wrangler_js)"
  version="$(repo_version)"
  commit="$(repo_commit)"
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cd "$REPO/worker" || die "进不去 $REPO/worker"
  exec node "$W" dev --local --ip "$HOST" --port "$PORT" --persist-to "$DATA_DIR" \
    --define "__AGENTPARTY_BUILD_VERSION__:\"${version}\"" \
    --define "__AGENTPARTY_BUILD_COMMIT__:\"${commit}\"" \
    --define "__AGENTPARTY_DEPLOYED_AT__:\"${started_at}\""
}

run() {
  prepare
  note "前台启动 workerd（$HOST:${PORT}，数据在 ${DATA_DIR}）；日志走标准输出"
  launch
}

# 给 systemd / launchd / 容器 supervisor 的快速恢复入口。安装或升级时必须先单独 migrate；
# 意外退出后的自动重启只走这里，不再把 schema 迁移放进每次 crash recovery 的关键路径。
serve() {
  prepare_runtime
  note "前台启动 workerd（不执行迁移，$HOST:${PORT}，数据在 ${DATA_DIR}）；日志走标准输出"
  launch
}

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    die "已经在跑了（pid $(cat "$PIDFILE")）。先 \`$0 stop\`。"
  fi
  prepare
  note "启动 workerd（$HOST:${PORT}，数据在 ${DATA_DIR}）"
  # pid 必须是 **worker 自己的**。写成 `( ... & echo $! )` 记下的是这条子 shell 的 pid：
  # setsid 会把 node 放进新的会话组，于是 `kill -- -$pid` 根本够不到它——旧版 stop 因此
  # 「打印已停、删掉 pidfile，而 worker 还在跑」，是静默失败（真机实测撞到）。
  # 让子进程先把自己的 $$ 写下来，再 exec 进本脚本的 _launch → exec node：pid 全程不变。
  rm -f "$PIDFILE"
  ( setsid sh -c 'echo $$ > "$1"; shift; exec "$@"' _ "$PIDFILE" sh "$0" _launch \
      >"$LOG" 2>&1 </dev/null & )
  i=0; while [ ! -s "$PIDFILE" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.2; done
  [ -s "$PIDFILE" ] || die "启动后没拿到 pid，看日志：${LOG}"
  note "pid $(cat "$PIDFILE")，日志 ${LOG}"
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

# 这个 pid 是不是我们起的那个？pid 会被系统复用——认错了就是杀掉别人的进程。
# 判据：命令行里同时有 wrangler 和我们这次的端口。宁可不杀，也不错杀。
ours() {
  cmd="$(ps -o command= -p "$1" 2>/dev/null || true)"
  case "$cmd" in
    *wrangler*"$PORT"*) return 0 ;;
    *) return 1 ;;
  esac
}

stop() {
  [ -f "$PIDFILE" ] || { note "没在跑"; return 0; }
  pid="$(cat "$PIDFILE")"
  case "$pid" in ''|*[!0-9]*) rm -f "$PIDFILE"; die "pidfile 内容不是 pid：'$pid'（已清掉，没有杀任何进程）" ;; esac
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PIDFILE"; note "进程已不在（pid ${pid}），清掉 pidfile"; return 0
  fi
  if ! ours "$pid"; then
    die "pid $pid 已经不是我们起的 wrangler 了（pid 被复用）。没有杀任何进程；确认后手工处理并删掉 $PIDFILE"
  fi
  # 只杀自己这棵进程树，绝不 pkill —— 同机可能有别人的 workerd。
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
usage: $0 <start|stop|status|run|serve|migrate|preflight>

  start      后台启动（pidfile + 日志文件），配合 stop / status
  run        前台启动，自动迁移后运行；适合首次启动或手工运行
  serve      前台启动，不执行迁移；先 migrate，给 supervisor 的自动重启入口用
  stop       停掉 start 起的那个进程（只认自己的 pidfile，不碰别的进程）
  status     进程与 /api/health
  migrate    只应用 D1 迁移
  preflight  只做预检（Node 版本、web 产物）

环境变量：
  AGENTPARTY_ADMIN_SECRET   必填（start / run / serve）。铸第一个 token 用，见 docs/self-host-intranet.md
  AGENTPARTY_SELFHOST_DATA  状态目录，默认 <repo>/.selfhost-state（备份就备份它）
  AGENTPARTY_SELFHOST_HOST  默认 0.0.0.0
  AGENTPARTY_SELFHOST_PORT  默认 8787
EOF
}

case "${1:-}" in
  start) start ;;
  run) run ;;
  serve) serve ;;
  _launch) launch ;;
  stop) stop ;;
  status) status ;;
  migrate) migrate ;;
  preflight) preflight ;;
  *) usage; exit 1 ;;
esac
