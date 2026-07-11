#!/usr/bin/env sh
# agentparty install-desktop.sh — macOS 桌面端一键安装器（#248）
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install-desktop.sh | sh
# 环境变量:
#   AGENTPARTY_VERSION       要装的版本，默认 latest（解析 releases/latest 重定向）。形如 0.2.90 或 v0.2.90。
#   AGENTPARTY_MIRROR        下载 base url，默认 github releases。GFW/内网兜底。
#   AGENTPARTY_APP_DIR       安装目录，默认 /Applications（无写权时回落 $HOME/Applications）。
#
# 为什么需要这个脚本（#248）:
#   当前 desktop 是「未公证 preview」——没有 Apple Developer ID 证书，.app 未做 Developer ID 签名。
#   macOS Gatekeeper 会把「未签名、带 quarantine」的 app 当成损坏/来路不明，双击直接拒绝甚至运行时挪进废纸篓。
#   本脚本用**不需要开发者账号**的两步让它可装可用:
#     1) 去掉下载隔离标记 `xattr -dr com.apple.quarantine`
#     2) ad-hoc 签名 `codesign --force --deep --sign -`（`-` = ad-hoc，免证书免账号）
#   ad-hoc 签名后系统视其为「已签名、未公证」——不再自动 trash，可正常启动（不是 Developer ID 公证，
#   但对自用/内测足够）。真正的公证仍需 Apple 开发者账号（见 #248 其余验收项）。
#
# 安全:
#   - 只装 macOS（Darwin）；其他平台直接拒绝。
#   - sha256 强校验 .dmg（与 CI 产出的 .dmg.sha256 比对），失败即中止。
#   - 下载失败有上限退避重试，不静默循环。
set -eu

OWNER_REPO="leeguooooo/agentparty"
DEFAULT_MIRROR="https://github.com/${OWNER_REPO}/releases/download"
MIN_VERSION="0.2.90"   # 首个带一键安装的桌面版本；防降级到没有本脚本约定资产名的旧版
APP_NAME="AgentParty.app"

MIRROR="${AGENTPARTY_MIRROR:-$DEFAULT_MIRROR}"

log() { printf '%s\n' "agentparty-desktop: $*" >&2; }
die() { printf '%s\n' "agentparty-desktop: error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

# ---- 平台探测: 仅 macOS ----
detect_asset() {
  os="$(uname -s)"
  [ "$os" = "Darwin" ] || die "本安装器仅支持 macOS（当前 $os）。CLI 用 install.sh。"
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) echo "darwin-arm64" ;;
    x86_64|amd64)  echo "darwin-x64" ;;
    *) die "unsupported arch: $arch" ;;
  esac
}

# ---- semver: 返回 0 当 $1 >= $2 ----
version_ge() {
  [ "$1" = "$2" ] && return 0
  lower="$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)"
  [ "$lower" = "$2" ]
}

# ---- 解析版本（latest 走 releases/latest 重定向）----
resolve_version() {
  v="${AGENTPARTY_VERSION:-latest}"
  if [ "$v" = "latest" ]; then
    loc="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${OWNER_REPO}/releases/latest" 2>/dev/null || true)"
    v="${loc##*/}"
    [ -n "$v" ] || die "无法解析 latest 版本（网络？可设 AGENTPARTY_VERSION 指定）。"
  fi
  echo "${v#v}"
}

# ---- 带退避的下载（最多 3 次）----
fetch() {
  url="$1"; out="$2"
  i=1
  while [ "$i" -le 3 ]; do
    if curl -fsSL "$url" -o "$out"; then return 0; fi
    log "下载失败（第 $i 次）: $url"
    sleep "$((i * 3))"
    i="$((i + 1))"
  done
  return 1
}

main() {
  need curl || die "需要 curl。"
  need shasum || die "需要 shasum。"
  need hdiutil || die "需要 hdiutil（macOS 自带）。"
  need codesign || die "需要 codesign（装 Xcode Command Line Tools: xcode-select --install）。"

  asset="$(detect_asset)"
  version="$(resolve_version)"
  version_ge "$version" "$MIN_VERSION" || die "版本 $version 低于最低 $MIN_VERSION（防降级）。"
  log "安装 AgentParty Desktop v$version ($asset)"

  tag="v$version"
  base="$MIRROR/$tag"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"; [ -n "${mnt:-}" ] && hdiutil detach "$mnt" -quiet 2>/dev/null || true' EXIT

  dmg="agentparty-desktop-${asset}.dmg"
  log "下载 $dmg …"
  fetch "$base/$dmg" "$tmp/$dmg" || die "下载 dmg 失败。"
  fetch "$base/$dmg.sha256" "$tmp/$dmg.sha256" || die "下载 sha256 失败。"

  # sha256 强校验（.sha256 首字段是 hash）
  want="$(awk '{print $1}' "$tmp/$dmg.sha256")"
  got="$(shasum -a 256 "$tmp/$dmg" | awk '{print $1}')"
  [ -n "$want" ] || die "sha256 文件为空。"
  [ "$want" = "$got" ] || die "sha256 不匹配（期望 $want，实得 $got）。已中止，未安装。"
  log "sha256 校验通过。"

  # 挂载 dmg，取出 .app
  mnt="$(hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountrandom /tmp | awk '/\/Volumes\//{print $NF}' | tail -n1)"
  [ -n "$mnt" ] && [ -d "$mnt" ] || die "挂载 dmg 失败。"
  src="$(find "$mnt" -maxdepth 1 -name '*.app' -type d | head -n1)"
  [ -n "$src" ] || die "dmg 里找不到 .app。"

  # 安装目录（/Applications 无写权时回落 ~/Applications）
  appdir="${AGENTPARTY_APP_DIR:-/Applications}"
  if [ ! -w "$appdir" ] && [ "$appdir" = "/Applications" ]; then
    appdir="$HOME/Applications"
    mkdir -p "$appdir"
    log "/Applications 无写权限，改装到 $appdir"
  fi
  dst="$appdir/$APP_NAME"

  # 若目标正在运行，先退出
  if pgrep -f "$appdir/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1; then
    log "检测到 AgentParty 正在运行，先退出它…"
    osascript -e 'quit app "AgentParty"' 2>/dev/null || true
    sleep 2
  fi

  log "安装到 $dst …"
  rm -rf "$dst"
  cp -R "$src" "$dst"
  hdiutil detach "$mnt" -quiet 2>/dev/null || true
  mnt=""

  # 免开发者账号的可用化（#248）：去隔离 + ad-hoc 签名，防 Gatekeeper 把未公证 app 当损坏/自动 trash
  log "去除 quarantine 隔离标记…"
  xattr -dr com.apple.quarantine "$dst" 2>/dev/null || true
  log "ad-hoc 签名（免证书，防运行时被移入废纸篓）…"
  codesign --force --deep --sign - "$dst" || die "ad-hoc 签名失败。"
  codesign --verify --deep --strict "$dst" 2>/dev/null || log "警告：codesign --verify 未通过（ad-hoc 仍可运行，公证需 Apple 账号）。"

  log "✅ 已安装：$dst"
  log "启动：open \"$dst\"    或在 Launchpad/访达里双击。"
  log "注意：这是未公证 preview（ad-hoc 签名）。正式公证发布需 Apple 开发者账号（#248）。"
}

main "$@"
