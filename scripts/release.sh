#!/usr/bin/env bash
# AgentParty release：bump → 门禁 → tag → 推送 → 盯 CI → 装机验证。
# 用法: scripts/release.sh 0.2.70
# CI 或本地观察失败时保留已发布 tag，避免重复 workflow / Release 竞争。
set -euo pipefail

CLI_PACKAGE=""
DESKTOP_PACKAGE=""
DESKTOP_CARGO=""
DESKTOP_CARGO_LOCK=""
CLAUDE_PLUGIN_MANIFEST=""
CODEX_PLUGIN_MANIFEST=""
CLI_PACKAGE_BACKUP=""
DESKTOP_PACKAGE_BACKUP=""
CLI_PACKAGE_BUMPED=""
DESKTOP_PACKAGE_BUMPED=""
DESKTOP_CARGO_BACKUP=""
DESKTOP_CARGO_LOCK_BACKUP=""
DESKTOP_CARGO_BUMPED=""
DESKTOP_CARGO_LOCK_BUMPED=""
CLAUDE_PLUGIN_MANIFEST_BACKUP=""
CODEX_PLUGIN_MANIFEST_BACKUP=""
CLAUDE_PLUGIN_MANIFEST_BUMPED=""
CODEX_PLUGIN_MANIFEST_BUMPED=""
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
    [[ -z "$CLAUDE_PLUGIN_MANIFEST" ]] || git show ":$CLAUDE_PLUGIN_MANIFEST" 2>/dev/null | cmp -s - "$CLAUDE_PLUGIN_MANIFEST_BUMPED" || staged_changed+=("$CLAUDE_PLUGIN_MANIFEST")
    [[ -z "$CODEX_PLUGIN_MANIFEST" ]] || git show ":$CODEX_PLUGIN_MANIFEST" 2>/dev/null | cmp -s - "$CODEX_PLUGIN_MANIFEST_BUMPED" || staged_changed+=("$CODEX_PLUGIN_MANIFEST")
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
    [[ -z "$CLAUDE_PLUGIN_MANIFEST" ]] || cmp -s "$CLAUDE_PLUGIN_MANIFEST" "$CLAUDE_PLUGIN_MANIFEST_BUMPED" || changed+=("$CLAUDE_PLUGIN_MANIFEST")
    [[ -z "$CODEX_PLUGIN_MANIFEST" ]] || cmp -s "$CODEX_PLUGIN_MANIFEST" "$CODEX_PLUGIN_MANIFEST_BUMPED" || changed+=("$CODEX_PLUGIN_MANIFEST")
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
    [[ -z "$CLAUDE_PLUGIN_MANIFEST" ]] || staged+=("$CLAUDE_PLUGIN_MANIFEST")
    [[ -z "$CODEX_PLUGIN_MANIFEST" ]] || staged+=("$CODEX_PLUGIN_MANIFEST")
    git restore --staged -- "${staged[@]}"
  fi
  cp "$CLI_PACKAGE_BACKUP" "$CLI_PACKAGE"
  cp "$DESKTOP_PACKAGE_BACKUP" "$DESKTOP_PACKAGE"
  [[ -z "$DESKTOP_CARGO" ]] || cp "$DESKTOP_CARGO_BACKUP" "$DESKTOP_CARGO"
  [[ -z "$DESKTOP_CARGO_LOCK" ]] || cp "$DESKTOP_CARGO_LOCK_BACKUP" "$DESKTOP_CARGO_LOCK"
  [[ -z "$CLAUDE_PLUGIN_MANIFEST" ]] || cp "$CLAUDE_PLUGIN_MANIFEST_BACKUP" "$CLAUDE_PLUGIN_MANIFEST"
  [[ -z "$CODEX_PLUGIN_MANIFEST" ]] || cp "$CODEX_PLUGIN_MANIFEST_BACKUP" "$CODEX_PLUGIN_MANIFEST"
  echo "!! 已恢复 CLI、desktop 与 plugin 的发布版本文件" >&2
}

remove_release_temp_files() {
  local file
  for file in "$CLI_PACKAGE_BACKUP" "$DESKTOP_PACKAGE_BACKUP" "$DESKTOP_CARGO_BACKUP" "$DESKTOP_CARGO_LOCK_BACKUP" "$CLAUDE_PLUGIN_MANIFEST_BACKUP" "$CODEX_PLUGIN_MANIFEST_BACKUP" "$CLI_PACKAGE_BUMPED" "$DESKTOP_PACKAGE_BUMPED" "$DESKTOP_CARGO_BUMPED" "$DESKTOP_CARGO_LOCK_BUMPED" "$CLAUDE_PLUGIN_MANIFEST_BUMPED" "$CODEX_PLUGIN_MANIFEST_BUMPED"; do
    [[ -z "$file" ]] || rm -f "$file"
  done
}

# 版本提交已经打在本地、但没能进 origin/main 时的收尾。
#
# 这里**不能**只说一句「排查后重跑」：此刻本地多了一条 bump 提交，而版本文件已经
# 是新版号。直接重跑会先被发布前的基线校验挡下（HEAD ≠ origin/main）；就算手工把
# 基线对齐，release-version.ts 也已无 diff 可 bump，`git commit` 会因为没有暂存内容
# 失败。也就是说不回滚的话，「重跑」这条路根本走不通。
#
# 所以默认把本地那条发布提交回滚掉，让「重跑」重新成为一条真的能走的路。
#
# 但回滚是破坏性动作，而这套脚本从入口校验到这里要跑好几分钟（完整门禁 + 推送），
# 期间仓库可能已经不是脚本以为的样子了——本仓常有多个 agent 会话共用同一棵工作树，
# 别人随时可能在里面改文件甚至提交。所以回滚前必须重新确认状态，而不是照着几分钟
# 前的假设动手：HEAD 必须仍然正好是脚本自己打的那条提交，工作树必须仍然干净。
# 任何一条对不上就一步都不碰，只打印手工恢复命令。
#
# 即便两项都满足，也走 `git reset --keep` 而不是 `--hard`：前者在发现会覆盖本地
# 修改时会自己拒绝执行，等于多一道 git 自己把关的保险。
abort_unpushed_release() {
  local base_sha="$1" release_sha="$2" version="$3"
  local head_now tree_state
  head_now=$(git rev-parse HEAD 2>/dev/null || true)
  tree_state=$(git status --porcelain 2>/dev/null || echo "?")
  if [[ -n "$base_sha" && "$head_now" == "$release_sha" && -z "$tree_state" ]] &&
    git reset --keep "$base_sha" >/dev/null 2>&1; then
    echo "   已回滚本地发布提交 ${release_sha}，工作树复位到 ${base_sha}（git reflog 可找回）。" >&2
    echo "   修好后可直接重跑： scripts/release.sh ${version}" >&2
    return 0
  fi
  if [[ "$head_now" != "$release_sha" || -n "$tree_state" ]]; then
    echo "   仓库状态已变（HEAD=${head_now:-未知}，工作树${tree_state:+不干净}${tree_state:-干净}），不自动回滚。" >&2
  else
    echo "   自动回滚未成功。" >&2
  fi
  print_release_manual_recovery "$base_sha" "$release_sha" "$version"
  return 0
}

print_release_manual_recovery() {
  local base_sha="$1" release_sha="$2" version="$3"
  echo "   本地仍停在 ${release_sha}（版本文件已是 ${version}）。" >&2
  echo "   二选一：" >&2
  echo "     1) 手工补推： git push origin ${release_sha}:refs/heads/main" >&2
  echo "        然后手工补 tag： git tag v${version} ${release_sha} && git push origin v${version}" >&2
  echo "     2) 丢弃这条提交后重跑： git reset --keep ${base_sha:-<发布前的 SHA>} && scripts/release.sh ${version}" >&2
}

# 远端 main 现在指向哪。拿不到就回空——空字符串代表「未知」，不代表「没落地」。
remote_main_sha() {
  local line
  line=$(git ls-remote origin refs/heads/main 2>/dev/null) || return 0
  printf '%s' "${line%%[[:space:]]*}"
}

# push 失败、或推送后的核实 fetch 失败之后的收尾。
#
# 关键：`git push` 返回非 0 **不等于**远端没落地——服务端完全可能已经更新了 ref，
# 只是客户端在拿到响应之前断了。fetch 失败同理，只说明「没能核实」。在落地与否未知
# 的时候回滚本地提交，会让本地与可能已经落地的远端劈叉，而操作者以为什么都没发生。
#
# 所以先用 ls-remote 把「未知」尽量变成「已知」：确认已落地就别回滚（只差补 tag），
# 确认没落地才允许回滚，仍然拿不准就一个字节都不改。
settle_unlanded_release() {
  local base_sha="$1" release_sha="$2" version="$3"
  case "$(release_landing_state "$base_sha" "$release_sha")" in
    landed)
      echo "   远端 origin/main 的历史里已经有 ${release_sha}（推送其实生效了），不回滚。" >&2
      echo "   只需补 tag： git tag v${version} ${release_sha} && git push origin v${version}" >&2
      ;;
    missing)
      echo "   已向远端确认这条提交确实没落地。" >&2
      abort_unpushed_release "$base_sha" "$release_sha" "$version"
      ;;
    *)
      # 未知态下操作者最容易懵：既不知道该补推还是该补 tag，也不知道能不能重跑。
      # 所以这里不给「二选一」，而是先给确认命令，再按确认结果分三条路写清楚。
      echo "   拿不准远端到底落没落地，不自动回滚。本地仍停在 ${release_sha}（版本文件已是 ${version}）。" >&2
      echo "   先确认远端： git ls-remote origin refs/heads/main" >&2
      echo "     远端已含 ${release_sha} → 只差 tag： git tag v${version} ${release_sha} && git push origin v${version}" >&2
      echo "     远端还没有 → 先补推： git push origin ${release_sha}:refs/heads/main，落地后再按上一条补 tag" >&2
      echo "     不想继续这一版 → git reset --keep ${base_sha:-<发布前的 SHA>} && scripts/release.sh ${version}" >&2
      ;;
  esac
}

# 远端那个 tag 现在指向哪。
# 退出码 0 = 问到了（stdout 为空表示远端确实没有这个 tag）；非 0 = 没问成，状态未知。
# 「远端没有」和「没问出来」必须分开——把后者当成前者，就会用肯定语气说一件没核实过
# 的事，这条线上正是在治这个。
remote_tag_sha() {
  local line
  line=$(git ls-remote origin "refs/tags/$1" 2>/dev/null) || return 1
  printf '%s' "${line%%[[:space:]]*}"
}

# tag 没能推上去时的收尾。
#
# 此刻 main 已经落地，处境和「版本提交没进 main」正好相反：绝不能回滚，缺的只是一个
# tag。这个中间态是真实可达的——分支保护会限制 ref creation，只有带 bypass 权限的
# 凭据能建 tag，CI runner 或别人的凭据推到这里就会失败。
#
# 也不要建议重跑 release.sh：重跑先被「tag 已存在」挡下；就算删掉本地 tag，版本文件
# 已经是新版号，bump 无 diff，commit 会因为没有暂存内容失败。唯一正确的恢复方式是把
# tag 单独补上去。
settle_unpushed_tag() {
  local tag="$1" release_sha="$2" version="$3"
  local remote_tag lookup_ok=1
  remote_tag=$(remote_tag_sha "$tag") || lookup_ok=0
  if [[ "$lookup_ok" == "0" ]]; then
    echo "   连远端 tag 状态也没问出来（git ls-remote 失败），先确认： git ls-remote origin refs/tags/${tag}" >&2
    echo "   远端已有且指向 ${release_sha} ⇒ 发布其实已完成；没有 ⇒ 重推： git push origin ${tag}" >&2
    echo "   无论哪种都不要回滚，也不要重跑 scripts/release.sh。" >&2
    return 0
  fi
  if [[ -n "$remote_tag" && "$remote_tag" == "$release_sha" ]]; then
    echo "   远端其实已经有 ${tag} 且指向 ${release_sha}（推送已生效，只是客户端没拿到响应）。" >&2
    echo "   发布流程实际已经完成，直接去看 CI： gh run list --workflow=release.yml --branch ${tag}" >&2
    return 0
  fi
  if [[ -n "$remote_tag" ]]; then
    echo "   ⚠ 远端已存在 ${tag}，却指向 ${remote_tag}，与本次发布提交对不上。" >&2
    echo "   先查清那个 tag 是谁建的，不要贸然覆盖。" >&2
    return 0
  fi
  echo "   重试： git push origin ${tag}" >&2
  echo "   若是凭据没有创建 tag 的权限（分支保护限制 ref creation），换有权限的凭据再推。" >&2
  echo "   不要重跑 scripts/release.sh：会被「tag ${tag} 已存在」挡下，删掉本地 tag 也只会卡在" >&2
  echo "   「版本文件已是 ${version}、bump 无 diff、commit 空提交」上。缺的只是这一个 tag。" >&2
}

# 这条发布提交到底进没进 origin/main：landed / missing / unknown。
#
# 只比远端 tip 是不够的。别人完全可能在我们推上去之后紧接着又推一笔，此时 tip 不是
# 我们的提交，但我们的提交确实已经在 main 的历史里。把这种情况判成「没落地」去回滚，
# 等于把已经发布出去的提交从本地抹掉；重跑还会为同一个版本号造出第二条 bump 提交，
# tag 最终指向的东西和 main 里的那条对不上。
#
# 所以：tip 正好是它 ⇒ landed；tip 还停在发布前的基线 ⇒ 确实 missing；tip 是第三个
# 值 ⇒ 必须把远端历史取下来做祖先判定才能分清，取不下来就老实说 unknown。
release_landing_state() {
  local base_sha="$1" release_sha="$2"
  local tip
  tip=$(remote_main_sha)
  if [[ -n "$tip" && "$tip" == "$release_sha" ]]; then
    printf 'landed'
    return 0
  fi
  if [[ -n "$tip" && -n "$base_sha" && "$tip" == "$base_sha" ]]; then
    printf 'missing'
    return 0
  fi
  if git fetch origin main --quiet 2>/dev/null; then
    if git merge-base --is-ancestor "$release_sha" FETCH_HEAD 2>/dev/null; then
      printf 'landed'
    else
      printf 'missing'
    fi
    return 0
  fi
  printf 'unknown'
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
  # 发版必须正好从当前 origin/main 切出。主仓工作树常年是脏的，实际发版多在临时
  # worktree 里跑，而 worktree 通常是 detached HEAD——那里本地 `main` 引用停在旧
  # 位置，后面按分支名推送会静默推空。这里先把基线钉死。
  git fetch origin main --quiet || { echo "fetch origin main 失败"; return 1; }
  local BASE_SHA REMOTE_MAIN_SHA
  BASE_SHA=$(git rev-parse HEAD)
  REMOTE_MAIN_SHA=$(git rev-parse FETCH_HEAD)
  [[ "$BASE_SHA" == "$REMOTE_MAIN_SHA" ]] || {
    echo "HEAD 与 origin/main 不一致，拒绝发版：" >&2
    echo "  HEAD        = $BASE_SHA" >&2
    echo "  origin/main = $REMOTE_MAIN_SHA" >&2
    echo "先把发布基线对齐到 origin/main（worktree 请用 git worktree add --detach <path> origin/main）" >&2
    return 1
  }
  CLI_PACKAGE="cli/package.json"
  DESKTOP_PACKAGE="desktop/package.json"
  DESKTOP_CARGO="desktop/src-tauri/Cargo.toml"
  DESKTOP_CARGO_LOCK="desktop/src-tauri/Cargo.lock"
  CLAUDE_PLUGIN_MANIFEST="plugins/agentparty/.claude-plugin/plugin.json"
  CODEX_PLUGIN_MANIFEST="plugins/agentparty/.codex-plugin/plugin.json"
  trap cleanup_release_version EXIT
  CLI_PACKAGE_BACKUP=$(mktemp)
  DESKTOP_PACKAGE_BACKUP=$(mktemp)
  DESKTOP_CARGO_BACKUP=$(mktemp)
  DESKTOP_CARGO_LOCK_BACKUP=$(mktemp)
  CLAUDE_PLUGIN_MANIFEST_BACKUP=$(mktemp)
  CODEX_PLUGIN_MANIFEST_BACKUP=$(mktemp)
  CLI_PACKAGE_BUMPED=$(mktemp)
  DESKTOP_PACKAGE_BUMPED=$(mktemp)
  DESKTOP_CARGO_BUMPED=$(mktemp)
  DESKTOP_CARGO_LOCK_BUMPED=$(mktemp)
  CLAUDE_PLUGIN_MANIFEST_BUMPED=$(mktemp)
  CODEX_PLUGIN_MANIFEST_BUMPED=$(mktemp)
  cp "$CLI_PACKAGE" "$CLI_PACKAGE_BACKUP"
  cp "$DESKTOP_PACKAGE" "$DESKTOP_PACKAGE_BACKUP"
  cp "$DESKTOP_CARGO" "$DESKTOP_CARGO_BACKUP"
  cp "$DESKTOP_CARGO_LOCK" "$DESKTOP_CARGO_LOCK_BACKUP"
  cp "$CLAUDE_PLUGIN_MANIFEST" "$CLAUDE_PLUGIN_MANIFEST_BACKUP"
  cp "$CODEX_PLUGIN_MANIFEST" "$CODEX_PLUGIN_MANIFEST_BACKUP"

  # 1) bump + 本地完整门禁（与 CI 同一 bun run check；先在本地挂掉比在 CI 挂便宜）
  echo "== 同步 package 版本到 $VER =="
  bun scripts/release-version.ts "$VER"
  RESTORE_PENDING=1
  cp "$CLI_PACKAGE" "$CLI_PACKAGE_BUMPED"
  cp "$DESKTOP_PACKAGE" "$DESKTOP_PACKAGE_BUMPED"
  cp "$DESKTOP_CARGO" "$DESKTOP_CARGO_BUMPED"
  cp "$DESKTOP_CARGO_LOCK" "$DESKTOP_CARGO_LOCK_BUMPED"
  cp "$CLAUDE_PLUGIN_MANIFEST" "$CLAUDE_PLUGIN_MANIFEST_BUMPED"
  cp "$CODEX_PLUGIN_MANIFEST" "$CODEX_PLUGIN_MANIFEST_BUMPED"
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
  git add cli/package.json desktop/package.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock \
    plugins/agentparty/.claude-plugin/plugin.json plugins/agentparty/.codex-plugin/plugin.json
  INDEX_PENDING=1
  git commit -m "chore(release): $TAG" -m "Claude-Session: ${CLAUDE_SESSION_URL:-scripts/release.sh}"
  disable_release_cleanup
  local RELEASE_SHA
  RELEASE_SHA=$(git rev-parse HEAD)
  # 必须按 HEAD 推，不能写 `git push origin main`：detached HEAD 下后者推的是本地
  # main 引用（还停在 bump 之前），git 会打印 "Everything up-to-date" 当作成功，
  # 于是 tag 上去了、版本提交没进 main，线上 /api/version 与 tag 对不上。
  if ! git push origin "HEAD:refs/heads/main"; then
    # 注意：push 非 0 不代表远端没落地，交给 settle 去向远端确认。
    echo "!! 推送 origin/main 失败（网络或权限）。tag 未推。" >&2
    settle_unlanded_release "$BASE_SHA" "$RELEASE_SHA" "$VER"
    return 1
  fi
  # 推完必须核实远端确实指向这条提交——上面那条静默失败就是这么漏过去的。
  if ! git fetch origin main --quiet; then
    echo "!! 推送后 fetch origin main 失败，无法用本地引用核实。tag 未推。" >&2
    settle_unlanded_release "$BASE_SHA" "$RELEASE_SHA" "$VER"
    return 1
  fi
  # 用祖先判定而不是 tip 相等：别人在我们之后又推一笔时 tip 会不是我们的提交，
  # 但发布提交确实已经在 main 的历史里，那种情况直接继续打 tag 就对了。
  git merge-base --is-ancestor "$RELEASE_SHA" FETCH_HEAD || {
    echo "!! origin/main 的历史里没有 ${RELEASE_SHA}，版本提交没进 main。tag 未推。" >&2
    echo "   origin/main = $(git rev-parse FETCH_HEAD)" >&2
    # 这条分支是**已经核实过**远端没落地，可以直接走带状态门的回滚。
    abort_unpushed_release "$BASE_SHA" "$RELEASE_SHA" "$VER"
    return 1
  }
  # tag 放在 main 落地之后：main 没推成就绝不留下一个指向本地提交的 tag。
  git tag "$TAG"
  if ! git push origin "$TAG"; then
    echo "!! tag $TAG 推送失败。版本提交已经在 main（${RELEASE_SHA}），缺的只是这个 tag。" >&2
    echo "   **不要回滚**——回滚会把已经发布出去的提交从本地抹掉。" >&2
    settle_unpushed_tag "$TAG" "$RELEASE_SHA" "$VER"
    return 1
  fi

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
