#!/usr/bin/env sh
# agentparty install.sh — macos / linux 安装器
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh
# 环境变量:
#   AGENTPARTY_VERSION   要装的版本，默认 latest（解析 releases/latest 重定向）。
#                        形如 0.2.0 或 v0.2.0，两种写法都吃。用于复现 pin。
#   AGENTPARTY_MIRROR    下载 base url，默认 github releases。GFW/内网兜底或离线源。
#                        支持 https:// 与 file://（离线 tar 目录）。
#   AGENTPARTY_INSTALL_DIR  安装目录，默认 $HOME/.local/bin。
#
# 安全结论落实（M4 party 频道收敛）:
#   - 只走 5 平台白名单 target，未知平台直接拒装。
#   - sha256 强校验；有 cosign 时用 pinned 公钥离线 verify-blob（不依赖联网 rekor）。
#   - 拒绝低于 MIN_VERSION 的版本 —— 防降级攻击（签名覆盖 version 由 CI 侧保证）。
#   - 下载失败有上限退避重试，不静默循环自我 DoS。
set -eu

# ---- 常量（与 CI release 产物命名强耦合，改这里要同步改 workflow）----
OWNER_REPO="leeguooooo/agentparty"
DEFAULT_MIRROR="https://github.com/${OWNER_REPO}/releases/download"
# 最低可接受版本 —— 防降级。发布新的强制升级点时提高它。
MIN_VERSION="0.1.0"
BIN_NAME="party"

# pinned cosign 公钥（离线验签，不依赖 rekor / 联网）。
# CI 侧配套: cosign sign-blob --key <私钥> --output-signature party-<target>.tar.gz.sig <tar>
# 私钥存 GH Actions secret COSIGN_PRIVATE_KEY，公钥就是下面这段，随脚本一起分发。
# 占位符 —— 首次发版前用 `cosign generate-key-pair` 生成后替换 BEGIN/END 之间内容。
COSIGN_PUBKEY='-----BEGIN PUBLIC KEY-----
REPLACE_WITH_PINNED_COSIGN_PUBLIC_KEY_BEFORE_FIRST_RELEASE
-----END PUBLIC KEY-----'

INSTALL_DIR="${AGENTPARTY_INSTALL_DIR:-$HOME/.local/bin}"
MIRROR="${AGENTPARTY_MIRROR:-$DEFAULT_MIRROR}"

log()  { printf '%s\n' "agentparty: $*" >&2; }
die()  { printf '%s\n' "agentparty: error: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1; }

# ---- 平台探测: uname -sm → target 白名单 ----
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)  os_tag="linux" ;;
    Darwin) os_tag="darwin" ;;
    *) die "unsupported os: $os (windows 用 install.ps1)" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch_tag="x64" ;;
    arm64|aarch64) arch_tag="arm64" ;;
    *) die "unsupported arch: $arch" ;;
  esac
  # 5 平台白名单里 unix 侧只有 4 个；windows-x64 归 install.ps1。
  echo "${os_tag}-${arch_tag}"
}

# ---- semver 比较: 返回 0 当 $1 >= $2 ----
# 只比 major.minor.patch，忽略 -pre 后缀（预发布视为不低于对应正式号的下界）。
version_ge() {
  a="${1#v}"; b="${2#v}"
  a="${a%%-*}"; b="${b%%-*}"
  IFS=. read -r a1 a2 a3 <<EOF
$a
EOF
  IFS=. read -r b1 b2 b3 <<EOF
$b
EOF
  a1=${a1:-0}; a2=${a2:-0}; a3=${a3:-0}
  b1=${b1:-0}; b2=${b2:-0}; b3=${b3:-0}
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0
  [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -ge "$b3" ] && return 0
  return 1
}

# ---- 解析要装的版本 ----
resolve_version() {
  v="${AGENTPARTY_VERSION:-latest}"
  if [ "$v" != "latest" ]; then
    echo "${v#v}"; return 0
  fi
  # latest: 优先 gh api（带鉴权配额高），否则跟 releases/latest 的 302 重定向。
  if need gh; then
    tag="$(gh api "repos/${OWNER_REPO}/releases/latest" --jq .tag_name 2>/dev/null || true)"
    [ -n "$tag" ] && { echo "${tag#v}"; return 0; }
  fi
  # curl -sI 拿 location: .../tag/vX.Y.Z
  loc="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
        "https://github.com/${OWNER_REPO}/releases/latest" 2>/dev/null || true)"
  tag="${loc##*/tag/}"
  case "$tag" in
    v[0-9]*|[0-9]*) echo "${tag#v}"; return 0 ;;
  esac
  die "cannot resolve latest version; 显式指定 AGENTPARTY_VERSION"
}

# ---- 带退避的下载（file:// 与 https:// 都吃）----
# 上限 3 次，退避 1/2/4s；失败即 die，不静默循环 —— 防网断/429 自我 DoS。
fetch() {
  url="$1"; out="$2"
  case "$url" in
    file://*)
      src="${url#file://}"
      [ -f "$src" ] || die "offline source missing: $src"
      cp "$src" "$out"
      return 0
      ;;
  esac
  i=1; delay=1
  while [ "$i" -le 3 ]; do
    if curl -fsSL "$url" -o "$out" 2>/dev/null; then
      return 0
    fi
    log "download failed ($i/3): $url — retry in ${delay}s"
    sleep "$delay"
    i=$((i + 1)); delay=$((delay * 2))
  done
  die "download failed after 3 attempts: $url"
}

# ---- sha256 校验（跨平台: sha256sum 或 shasum -a 256）----
sha256_of() {
  if need sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif need shasum;    then shasum -a 256 "$1" | awk '{print $1}'
  else die "no sha256 tool (need sha256sum or shasum)"; fi
}

main() {
  need curl || die "curl is required"
  need tar  || die "tar is required"

  # mirror 只允许 https:// 或 file://，拒绝明文 http://（中间人可篡改 tar/sha256 同源）。
  case "$MIRROR" in
    https://*|file://*) : ;;
    http://*) die "AGENTPARTY_MIRROR 拒绝明文 http://（中间人风险），请用 https:// 或 file://" ;;
    *) die "AGENTPARTY_MIRROR 仅支持 https:// 或 file://: $MIRROR" ;;
  esac

  TARGET="$(detect_target)"
  VERSION="$(resolve_version)"

  # 防降级门槛: 拒绝低于 MIN_VERSION 的版本。
  if ! version_ge "$VERSION" "$MIN_VERSION"; then
    die "refusing version $VERSION < minimum $MIN_VERSION (anti-downgrade)"
  fi

  log "target=$TARGET version=$VERSION mirror=$MIRROR"

  base="${MIRROR%/}/v${VERSION}"
  asset="${BIN_NAME}-${TARGET}.tar.gz"
  tmp="$(mktemp -d)"
  tmp_out=""
  cleanup() {
    [ -z "$tmp_out" ] || rm -f "$tmp_out" || true
    rm -rf "$tmp" || true
  }
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  fetch "${base}/${asset}"          "${tmp}/${asset}"
  fetch "${base}/${asset}.sha256"   "${tmp}/${asset}.sha256"

  # sha256: 取校验文件里第一段 hash，与实际比对。
  want="$(awk '{print $1; exit}' "${tmp}/${asset}.sha256")"
  got="$(sha256_of "${tmp}/${asset}")"
  [ -n "$want" ] || die "empty sha256 checksum file"
  [ "$want" = "$got" ] || die "sha256 mismatch: want $want got $got"
  log "sha256 ok"

  # cosign 验签（可选增强）: 有 cosign 且公钥已填 → 用 pinned 公钥离线 verify-blob。
  case "$COSIGN_PUBKEY" in
    *REPLACE_WITH_PINNED*)
      log "cosign pubkey is placeholder — skipping signature verify"
      ;;
    *)
      if need cosign; then
        fetch "${base}/${asset}.sig" "${tmp}/${asset}.sig"
        printf '%s\n' "$COSIGN_PUBKEY" > "${tmp}/cosign.pub"
        # COSIGN_EXPERIMENTAL=0 强制离线（不打 rekor），GFW/内网可用。
        if COSIGN_EXPERIMENTAL=0 cosign verify-blob \
             --key "${tmp}/cosign.pub" \
             --signature "${tmp}/${asset}.sig" \
             "${tmp}/${asset}" >/dev/null 2>&1; then
          log "cosign verify ok"
        else
          die "cosign signature verification failed"
        fi
      else
        log "cosign not installed — relying on sha256 (装 cosign 可加验签)"
      fi
      ;;
  esac

  # 解压 → 安装。tar 内含单个可执行文件 party。
  tar -xzf "${tmp}/${asset}" -C "$tmp"
  [ -f "${tmp}/${BIN_NAME}" ] || die "archive missing ${BIN_NAME} binary"

  mkdir -p "$INSTALL_DIR"
  tmp_out="$(mktemp "${INSTALL_DIR}/.${BIN_NAME}.XXXXXX")"
  install -m 0755 "${tmp}/${BIN_NAME}" "$tmp_out" 2>/dev/null \
    || { cp "${tmp}/${BIN_NAME}" "$tmp_out" && chmod 0755 "$tmp_out"; }
  mv -f "$tmp_out" "${INSTALL_DIR}/${BIN_NAME}"
  tmp_out=""

  log "installed ${INSTALL_DIR}/${BIN_NAME} (v${VERSION})"

  # PATH 提示: 若安装目录不在 PATH，给出对应 shell 的追加行。
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) : ;;
    *)
      log "note: ${INSTALL_DIR} 不在 PATH，追加到你的 shell rc:"
      log "  export PATH=\"${INSTALL_DIR}:\$PATH\""
      ;;
  esac
}

main "$@"
