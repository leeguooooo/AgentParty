#!/usr/bin/env bash
# AgentParty release：bump → 门禁 → tag → 推送 → 盯 CI → 装机验证。
# 用法: scripts/release.sh 0.2.70
# CI 或本地观察失败时保留已发布 tag，避免重复 workflow / Release 竞争。
set -euo pipefail

CLI_PACKAGE=""
DESKTOP_PACKAGE=""
DESKTOP_CARGO=""
DESKTOP_CARGO_LOCK=""
CLI_PACKAGE_BACKUP=""
DESKTOP_PACKAGE_BACKUP=""
CLI_PACKAGE_BUMPED=""
DESKTOP_PACKAGE_BUMPED=""
DESKTOP_CARGO_BACKUP=""
DESKTOP_CARGO_LOCK_BACKUP=""
DESKTOP_CARGO_BUMPED=""
DESKTOP_CARGO_LOCK_BUMPED=""
RESTORE_PENDING=0
INDEX_PENDING=0
BUMPED_SNAPSHOTS_COMPLETE=0
RELEASE_RUN_ID=""
RELEASE_RUN_STATUS=""
RELEASE_RUN_CONCLUSION=""

should_skip_local_check() {
  [[ "${SKIP_LOCAL_CHECK:-}" == "1" ]]
}

release_cleanup_required() {
  [[ "$RESTORE_PENDING" == "1" || "$INDEX_PENDING" == "1" ]]
}

disable_release_cleanup() {
  RESTORE_PENDING=0
  INDEX_PENDING=0
  BUMPED_SNAPSHOTS_COMPLETE=0
}

watch_tag_run() {
  local lookup_attempts="${RELEASE_RUN_LOOKUP_ATTEMPTS:-6}"
  local poll_attempts="${RELEASE_RUN_POLL_ATTEMPTS:-180}"
  local retry_attempts="${RELEASE_GH_RETRY_ATTEMPTS:-3}"
  local retry_delay="${RELEASE_GH_RETRY_DELAY:-5}"
  local poll_interval="${RELEASE_RUN_POLL_INTERVAL:-10}"
  local initial_delay="${RELEASE_RUN_INITIAL_DELAY:-8}"
  local response state attempt observation_errors=0

  sleep "$initial_delay"
  for ((attempt = 1; attempt <= lookup_attempts; attempt++)); do
    if response=$(gh run list --workflow=release.yml --limit 8 --json databaseId,headBranch); then
      if RELEASE_RUN_ID=$(python3 -c '
import json
import sys

tag = sys.argv[1]
runs = [run for run in json.load(sys.stdin) if run.get("headBranch") == tag]
print(runs[0]["databaseId"] if runs else "")
' "$TAG" <<<"$response"); then
        [[ -z "$RELEASE_RUN_ID" ]] || break
      fi
    fi
    echo "!! 暂时无法定位 $TAG 的 release run（${attempt}/${lookup_attempts}）" >&2
    (( attempt == lookup_attempts )) || sleep "$retry_delay"
  done

  if [[ -z "$RELEASE_RUN_ID" ]]; then
    echo "!! 找不到 $TAG 的 release run；GitHub API 可能不可用或 workflow 尚未出现" >&2
    return 2
  fi

  echo "== poll run $RELEASE_RUN_ID =="
  for ((attempt = 1; attempt <= poll_attempts; attempt++)); do
    if response=$(gh run view "$RELEASE_RUN_ID" --json status,conclusion); then
      if state=$(python3 -c '
import json
import sys

run = json.load(sys.stdin)
status = run.get("status")
conclusion = run.get("conclusion")
if not isinstance(status, str) or conclusion is not None and not isinstance(conclusion, str):
    raise SystemExit(1)
print(f"{status}\t{conclusion or chr(45)}")
' <<<"$response"); then
        IFS=$'\t' read -r RELEASE_RUN_STATUS RELEASE_RUN_CONCLUSION <<<"$state"
        observation_errors=0
        if [[ "$RELEASE_RUN_STATUS" == "completed" ]]; then
          if [[ "$RELEASE_RUN_CONCLUSION" == "success" ]]; then
            return 0
          fi
          if [[ "$RELEASE_RUN_CONCLUSION" != "-" ]]; then
            return 1
          fi
        elif [[ "$RELEASE_RUN_STATUS" == "queued" || "$RELEASE_RUN_STATUS" == "in_progress" || "$RELEASE_RUN_STATUS" == "pending" || "$RELEASE_RUN_STATUS" == "requested" || "$RELEASE_RUN_STATUS" == "waiting" ]]; then
          (( attempt == poll_attempts )) || sleep "$poll_interval"
          continue
        fi
      fi
    fi

    observation_errors=$((observation_errors + 1))
    echo "!! 读取 release run $RELEASE_RUN_ID 状态失败（${observation_errors}/${retry_attempts}）" >&2
    if (( observation_errors >= retry_attempts )); then
      return 2
    fi
    (( attempt == poll_attempts )) || sleep "$retry_delay"
  done

  echo "!! release run $RELEASE_RUN_ID 在轮询期限内没有成功结束" >&2
  return 2
}

verify_release_assets() {
  python3 -c '
import json
import os
import sys

required = {
    "party-darwin-arm64.tar.gz",
    "party-darwin-arm64.tar.gz.sha256",
    "party-darwin-x64.tar.gz",
    "party-darwin-x64.tar.gz.sha256",
    "party-linux-arm64.tar.gz",
    "party-linux-arm64.tar.gz.sha256",
    "party-linux-x64.tar.gz",
    "party-linux-x64.tar.gz.sha256",
    "party-windows-x64.tar.gz",
    "party-windows-x64.tar.gz.sha256",
    "agentparty-desktop-darwin-arm64.dmg",
    "agentparty-desktop-darwin-arm64.dmg.sha256",
    "agentparty-desktop-darwin-arm64.app.tar.gz",
    "agentparty-desktop-darwin-arm64.app.tar.gz.sig",
    "agentparty-desktop-darwin-arm64.signing-status.json",
    "agentparty-desktop-darwin-x64.dmg",
    "agentparty-desktop-darwin-x64.dmg.sha256",
    "agentparty-desktop-darwin-x64.app.tar.gz",
    "agentparty-desktop-darwin-x64.app.tar.gz.sig",
    "agentparty-desktop-darwin-x64.signing-status.json",
    "latest.json",
}
mode = os.environ.get("DESKTOP_UPDATER_KEY_MODE", "legacy")
if mode in {"bridge", "v2"}:
    required.add("latest-v2.json")
if mode == "bridge":
    required.update({
        "agentparty-desktop-darwin-arm64.app.tar.gz.sig.v2",
        "agentparty-desktop-darwin-x64.app.tar.gz.sig.v2",
    })

try:
    payload = json.loads(os.environ["RELEASE_ASSETS_JSON"])
    assets = payload["assets"]
    actual = {asset["name"] for asset in assets}
except (KeyError, TypeError, json.JSONDecodeError) as error:
    print(f"invalid release asset response: {error}", file=sys.stderr)
    raise SystemExit(1)

missing = sorted(required - actual)
if missing:
    print(f"missing release assets: {chr(44).join(missing)}", file=sys.stderr)
    raise SystemExit(1)

empty = sorted(
    asset["name"]
    for asset in assets
    if asset["name"] in required
    and (not isinstance(asset.get("size"), int) or asset["size"] <= 0)
)
if empty:
    print(f"empty release assets: {chr(44).join(empty)}", file=sys.stderr)
    raise SystemExit(1)

print(f"{len(required)} required release assets ok")
'
}

restore_package_versions() {
  local changed=()
  local staged_changed=()
  if [[ "$BUMPED_SNAPSHOTS_COMPLETE" == "1" && "$INDEX_PENDING" == "1" ]]; then
    git show ":$CLI_PACKAGE" 2>/dev/null | cmp -s - "$CLI_PACKAGE_BUMPED" || staged_changed+=("$CLI_PACKAGE")
    git show ":$DESKTOP_PACKAGE" 2>/dev/null | cmp -s - "$DESKTOP_PACKAGE_BUMPED" || staged_changed+=("$DESKTOP_PACKAGE")
    [[ -z "$DESKTOP_CARGO" ]] || git show ":$DESKTOP_CARGO" 2>/dev/null | cmp -s - "$DESKTOP_CARGO_BUMPED" || staged_changed+=("$DESKTOP_CARGO")
    [[ -z "$DESKTOP_CARGO_LOCK" ]] || git show ":$DESKTOP_CARGO_LOCK" 2>/dev/null | cmp -s - "$DESKTOP_CARGO_LOCK_BUMPED" || staged_changed+=("$DESKTOP_CARGO_LOCK")
    if (( ${#staged_changed[@]} > 0 )); then
      echo "!! package 内容在 bump 后被修改或重新暂存，未自动恢复 index 或工作树: ${staged_changed[*]}。请手工核对。" >&2
      return 1
    fi
  fi

  if [[ "$BUMPED_SNAPSHOTS_COMPLETE" == "1" ]]; then
    cmp -s "$CLI_PACKAGE" "$CLI_PACKAGE_BUMPED" || changed+=("$CLI_PACKAGE")
    cmp -s "$DESKTOP_PACKAGE" "$DESKTOP_PACKAGE_BUMPED" || changed+=("$DESKTOP_PACKAGE")
    [[ -z "$DESKTOP_CARGO" ]] || cmp -s "$DESKTOP_CARGO" "$DESKTOP_CARGO_BUMPED" || changed+=("$DESKTOP_CARGO")
    [[ -z "$DESKTOP_CARGO_LOCK" ]] || cmp -s "$DESKTOP_CARGO_LOCK" "$DESKTOP_CARGO_LOCK_BUMPED" || changed+=("$DESKTOP_CARGO_LOCK")
    if (( ${#changed[@]} > 0 )); then
      echo "!! package 内容在 bump 后被修改，未自动恢复 index 或工作树: ${changed[*]}。请手工核对备份文件。" >&2
      return 1
    fi
  else
    echo "!! bumped snapshot 未完整写入，按 bump 前备份恢复发布版本文件" >&2
  fi

  if [[ "$INDEX_PENDING" == "1" ]]; then
    local staged=("$CLI_PACKAGE" "$DESKTOP_PACKAGE")
    [[ -z "$DESKTOP_CARGO" ]] || staged+=("$DESKTOP_CARGO")
    [[ -z "$DESKTOP_CARGO_LOCK" ]] || staged+=("$DESKTOP_CARGO_LOCK")
    git restore --staged -- "${staged[@]}"
  fi
  cp "$CLI_PACKAGE_BACKUP" "$CLI_PACKAGE"
  cp "$DESKTOP_PACKAGE_BACKUP" "$DESKTOP_PACKAGE"
  [[ -z "$DESKTOP_CARGO" ]] || cp "$DESKTOP_CARGO_BACKUP" "$DESKTOP_CARGO"
  [[ -z "$DESKTOP_CARGO_LOCK" ]] || cp "$DESKTOP_CARGO_LOCK_BACKUP" "$DESKTOP_CARGO_LOCK"
  echo "!! 已恢复 CLI 与 desktop 的发布版本文件" >&2
}

remove_release_temp_files() {
  local file
  for file in "$CLI_PACKAGE_BACKUP" "$DESKTOP_PACKAGE_BACKUP" "$DESKTOP_CARGO_BACKUP" "$DESKTOP_CARGO_LOCK_BACKUP" "$CLI_PACKAGE_BUMPED" "$DESKTOP_PACKAGE_BUMPED" "$DESKTOP_CARGO_BUMPED" "$DESKTOP_CARGO_LOCK_BUMPED"; do
    [[ -z "$file" ]] || rm -f "$file"
  done
}

cleanup_release_version() {
  local exit_status=$?
  trap - EXIT
  if release_cleanup_required && ! restore_package_versions; then
    exit_status=1
  fi
  remove_release_temp_files
  exit "$exit_status"
}

main() {
  local VER="${1:?用法: scripts/release.sh <version 如 0.2.70>}"
  local TAG="v$VER"
  local ROOT
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT"

  # 0) 前置检查
  [[ -z "$(git status --porcelain)" ]] || { echo "工作树不干净，先提交或 stash:"; git status --short; return 1; }
  git rev-parse "$TAG" >/dev/null 2>&1 && { echo "tag $TAG 已存在"; return 1; }
  CLI_PACKAGE="cli/package.json"
  DESKTOP_PACKAGE="desktop/package.json"
  DESKTOP_CARGO="desktop/src-tauri/Cargo.toml"
  DESKTOP_CARGO_LOCK="desktop/src-tauri/Cargo.lock"
  trap cleanup_release_version EXIT
  CLI_PACKAGE_BACKUP=$(mktemp)
  DESKTOP_PACKAGE_BACKUP=$(mktemp)
  DESKTOP_CARGO_BACKUP=$(mktemp)
  DESKTOP_CARGO_LOCK_BACKUP=$(mktemp)
  CLI_PACKAGE_BUMPED=$(mktemp)
  DESKTOP_PACKAGE_BUMPED=$(mktemp)
  DESKTOP_CARGO_BUMPED=$(mktemp)
  DESKTOP_CARGO_LOCK_BUMPED=$(mktemp)
  cp "$CLI_PACKAGE" "$CLI_PACKAGE_BACKUP"
  cp "$DESKTOP_PACKAGE" "$DESKTOP_PACKAGE_BACKUP"
  cp "$DESKTOP_CARGO" "$DESKTOP_CARGO_BACKUP"
  cp "$DESKTOP_CARGO_LOCK" "$DESKTOP_CARGO_LOCK_BACKUP"

  # 1) bump + 本地完整门禁（与 CI 同一 bun run check；先在本地挂掉比在 CI 挂便宜）
  echo "== 同步 package 版本到 $VER =="
  bun scripts/release-version.ts "$VER"
  RESTORE_PENDING=1
  cp "$CLI_PACKAGE" "$CLI_PACKAGE_BUMPED"
  cp "$DESKTOP_PACKAGE" "$DESKTOP_PACKAGE_BUMPED"
  cp "$DESKTOP_CARGO" "$DESKTOP_CARGO_BUMPED"
  cp "$DESKTOP_CARGO_LOCK" "$DESKTOP_CARGO_LOCK_BUMPED"
  BUMPED_SNAPSHOTS_COMPLETE=1
  echo "== 本地门禁 bun run check =="
  if ! bun run check; then
    if should_skip_local_check; then
      echo "!! 门禁失败，但 SKIP_LOCAL_CHECK=1，继续发布" >&2
    else
      echo "!! 门禁失败，退出时将恢复两份 package 文件" >&2
      return 1
    fi
  fi

  # 2) 提交 + tag + 推送
  git add cli/package.json desktop/package.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock
  INDEX_PENDING=1
  git commit -m "chore(release): $TAG" -m "Claude-Session: ${CLAUDE_SESSION_URL:-scripts/release.sh}"
  disable_release_cleanup
  git tag "$TAG"
  git push origin main
  git push origin "$TAG"

  # 3) 轮询 tag 的 CI；任何失败都保留 tag，交由操作者诊断。
  if watch_tag_run; then
    :
  else
    local watch_status=$?
    if [[ "$watch_status" == "1" ]]; then
      echo "!! CI 已确认失败: status=$RELEASE_RUN_STATUS conclusion=${RELEASE_RUN_CONCLUSION}。tag $TAG 已保留，未自动重推。" >&2
      echo "查看失败日志: gh run view $RELEASE_RUN_ID --log-failed" >&2
    else
      echo "!! 观察 release run 失败。tag $TAG 已保留，未自动重推。" >&2
      if [[ -n "$RELEASE_RUN_ID" ]]; then
        echo "重新查看状态: gh run view $RELEASE_RUN_ID --json status,conclusion" >&2
      else
        echo "重新查找 run: gh run list --workflow=release.yml --branch $TAG" >&2
      fi
    fi
    return 1
  fi

  # 4) 确认 release 资产 + 装机验证
  echo "== release 资产 =="
  local RELEASE_ASSETS_JSON
  RELEASE_ASSETS_JSON=$(gh release view "$TAG" --json assets)
  export RELEASE_ASSETS_JSON
  local DESKTOP_UPDATER_KEY_MODE
  DESKTOP_UPDATER_KEY_MODE=$(gh variable get DESKTOP_UPDATER_KEY_MODE --repo leeguooooo/AgentParty 2>/dev/null || printf 'legacy')
  export DESKTOP_UPDATER_KEY_MODE
  verify_release_assets
  echo "== 装机 =="
  curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh
  local INSTALLED
  INSTALLED=$(party --version)
  [[ "$INSTALLED" == "$VER" ]] || { echo "!! 装机版本 $INSTALLED ≠ $VER"; return 1; }
  echo "✅ $TAG 发布完成，本机 party=$INSTALLED"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
