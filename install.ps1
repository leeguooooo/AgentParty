# agentparty install.ps1 — windows 安装器 (P1)
# 用法:
#   irm https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.ps1 | iex
# 环境变量:
#   AGENTPARTY_VERSION      要装的版本，默认 latest。形如 0.2.0 或 v0.2.0。用于复现 pin。
#   AGENTPARTY_MIRROR       下载 base url，默认 github releases。GFW/内网兜底或离线源。
#   AGENTPARTY_INSTALL_DIR  安装目录，默认 %LOCALAPPDATA%\agentparty\bin。
#
# 安全结论落实（与 install.sh 对齐）:
#   - 只走 windows-x64 白名单 target，未知架构直接拒装。
#   - sha256 强校验；有 cosign.exe 时用 pinned 公钥离线 verify-blob。
#   - 拒绝低于 MIN_VERSION 的版本 —— 防降级攻击。
#   - 下载失败有上限退避重试，不静默循环。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---- 常量（与 CI release 产物命名强耦合）----
$OwnerRepo     = 'leeguooooo/agentparty'
$DefaultMirror = "https://github.com/$OwnerRepo/releases/download"
$MinVersion    = '0.1.0'
$BinName       = 'party'

# pinned cosign 公钥（离线验签）。首次发版前用 cosign generate-key-pair 生成后替换。
$CosignPubkey = @'
-----BEGIN PUBLIC KEY-----
REPLACE_WITH_PINNED_COSIGN_PUBLIC_KEY_BEFORE_FIRST_RELEASE
-----END PUBLIC KEY-----
'@

$InstallDir = if ($env:AGENTPARTY_INSTALL_DIR) { $env:AGENTPARTY_INSTALL_DIR }
              else { Join-Path $env:LOCALAPPDATA 'agentparty\bin' }
$Mirror = if ($env:AGENTPARTY_MIRROR) { $env:AGENTPARTY_MIRROR } else { $DefaultMirror }

function Log { param($m) Write-Host "agentparty: $m" }
function Die { param($m) Write-Error "agentparty: error: $m"; exit 1 }

# ---- 平台探测: 只支持 windows-x64 ----
function Get-Target {
  $arch = $env:PROCESSOR_ARCHITECTURE
  switch ($arch) {
    'AMD64' { return 'windows-x64' }
    'x86'   { Die "unsupported arch: x86 (需 64 位)" }
    'ARM64' { Die "unsupported arch: arm64 (windows arm64 暂无产物)" }
    default { Die "unsupported arch: $arch" }
  }
}

# ---- semver 比较: 返回 $true 当 a >= b，只比 major.minor.patch ----
function Version-Ge {
  param($a, $b)
  $a = ($a -replace '^v','') -replace '-.*$',''
  $b = ($b -replace '^v','') -replace '-.*$',''
  try { return ([version]$a) -ge ([version]$b) }
  catch { Die "bad version string: $a or $b" }
}

# ---- 解析要装的版本 ----
function Resolve-Version {
  $v = if ($env:AGENTPARTY_VERSION) { $env:AGENTPARTY_VERSION } else { 'latest' }
  if ($v -ne 'latest') { return ($v -replace '^v','') }
  # latest: 跟 releases/latest 的 302 重定向拿 tag。
  try {
    $resp = Invoke-WebRequest -Uri "https://github.com/$OwnerRepo/releases/latest" `
              -MaximumRedirection 0 -ErrorAction SilentlyContinue
  } catch {
    $resp = $_.Exception.Response
  }
  $loc = $null
  if ($resp -and $resp.Headers -and $resp.Headers['Location']) { $loc = $resp.Headers['Location'] }
  elseif ($resp -and $resp.Headers.Location) { $loc = $resp.Headers.Location }
  if ($loc -and $loc -match '/tag/(v?[0-9][^/]*)$') { return ($Matches[1] -replace '^v','') }
  Die "cannot resolve latest version; 显式指定 AGENTPARTY_VERSION"
}

# ---- 带退避的下载（file:// 与 https:// 都吃），上限 3 次 ----
function Fetch {
  param($url, $out)
  if ($url -like 'file://*') {
    $src = $url -replace '^file://',''
    if (-not (Test-Path $src)) { Die "offline source missing: $src" }
    Copy-Item -LiteralPath $src -Destination $out -Force
    return
  }
  $delay = 1
  for ($i = 1; $i -le 3; $i++) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
      return
    } catch {
      Log "download failed ($i/3): $url — retry in ${delay}s"
      Start-Sleep -Seconds $delay
      $delay *= 2
    }
  }
  Die "download failed after 3 attempts: $url"
}

function Sha256-Of {
  param($path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLower()
}

function Main {
  # mirror 只允许 https:// 或 file://，拒绝明文 http://（中间人可篡改 tar/sha256 同源）。
  if ($Mirror -notmatch '^(https|file)://') {
    if ($Mirror -match '^http://') {
      Die "AGENTPARTY_MIRROR 拒绝明文 http://（中间人风险），请用 https:// 或 file://"
    }
    Die "AGENTPARTY_MIRROR 仅支持 https:// 或 file://: $Mirror"
  }

  $target  = Get-Target
  $version = Resolve-Version

  if (-not (Version-Ge $version $MinVersion)) {
    Die "refusing version $version < minimum $MinVersion (anti-downgrade)"
  }

  Log "target=$target version=$version mirror=$Mirror"

  $base  = ($Mirror.TrimEnd('/')) + "/v$version"
  $asset = "$BinName-$target.tar.gz"
  $tmp   = Join-Path ([System.IO.Path]::GetTempPath()) ("agentparty-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null

  try {
    Fetch "$base/$asset"        (Join-Path $tmp $asset)
    Fetch "$base/$asset.sha256" (Join-Path $tmp "$asset.sha256")

    # sha256 校验
    $want = ((Get-Content (Join-Path $tmp "$asset.sha256") -Raw).Trim() -split '\s+')[0].ToLower()
    $got  = Sha256-Of (Join-Path $tmp $asset)
    if (-not $want) { Die "empty sha256 checksum file" }
    if ($want -ne $got) { Die "sha256 mismatch: want $want got $got" }
    Log "sha256 ok"

    # cosign 验签（可选增强）
    if ($CosignPubkey -notmatch 'REPLACE_WITH_PINNED') {
      $cosign = Get-Command cosign -ErrorAction SilentlyContinue
      if ($cosign) {
        Fetch "$base/$asset.sig" (Join-Path $tmp "$asset.sig")
        $pub = Join-Path $tmp 'cosign.pub'
        Set-Content -Path $pub -Value $CosignPubkey -NoNewline
        $env:COSIGN_EXPERIMENTAL = '0'
        & cosign verify-blob --key $pub --signature (Join-Path $tmp "$asset.sig") (Join-Path $tmp $asset) *> $null
        if ($LASTEXITCODE -ne 0) { Die "cosign signature verification failed" }
        Log "cosign verify ok"
      } else {
        Log "cosign not installed — relying on sha256"
      }
    } else {
      Log "cosign pubkey is placeholder — skipping signature verify"
    }

    # 解压 → 安装。tar 内含 party.exe（windows），tar.exe 随 win10+ 自带。
    & tar -xzf (Join-Path $tmp $asset) -C $tmp
    $binSrc = Join-Path $tmp "$BinName.exe"
    if (-not (Test-Path $binSrc)) { $binSrc = Join-Path $tmp $BinName }
    if (-not (Test-Path $binSrc)) { Die "archive missing $BinName binary" }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $dest = Join-Path $InstallDir "$BinName.exe"
    Copy-Item -LiteralPath $binSrc -Destination $dest -Force
    Log "installed $dest (v$version)"

    # PATH 提示: 若安装目录不在用户 PATH，给出永久追加命令。
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not ($userPath -split ';' | Where-Object { $_ -eq $InstallDir })) {
      Log "note: $InstallDir 不在 PATH，永久追加:"
      Log "  [Environment]::SetEnvironmentVariable('Path', `"`$env:Path;$InstallDir`", 'User')"
    }

    # Agent Party 已停止维护：装完提示迁移到 open-cross-session（只打提示，不影响安装结果；不写关停日期）。
    Log ""
    Log "NOTE: Agent Party is no longer maintained - please move to open-cross-session (ocs)."
    Log "  Existing channels keep working. ocs: one local binary, no server/account."
    Log "  install: irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex"
    Log "  https://github.com/leeguooooo/open-cross-session"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Main
