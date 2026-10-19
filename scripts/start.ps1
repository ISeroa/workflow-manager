# Workflow Manager 실행기 (start.cmd가 호출한다)
# Node.js가 없으면 winget으로 설치하고, 패키지가 없거나 바뀌었으면 npm ci 후 앱을 실행한다.
# Git, Claude Code, GitHub CLI, 로그인은 앱의 환경 점검 화면에서 설치·설정한다.

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user;$env:Path"
}

function Fail($message) {
  Write-Host ''
  Write-Host $message -ForegroundColor Red
  exit 1
}

if ($root.Length -gt 120) {
  Write-Host "경고: 앱 폴더 경로가 길어요 ($($root.Length)자). 설치가 실패하면 D:\Tools\workflow-manager 같은 짧은 경로로 옮기세요." -ForegroundColor Yellow
}

Write-Host '[1/3] Node.js 확인'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Refresh-Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Fail 'winget이 없어 Node.js를 자동으로 설치할 수 없어요. https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요.'
  }
  Write-Host '  Node.js가 없어 설치해요 (winget 공식 패키지 OpenJS.NodeJS.LTS). 관리자 권한 창이 뜨면 허용하세요.'
  winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail 'Node.js 설치를 확인하지 못했어요. 이 창을 닫고 start.cmd를 다시 실행하거나, https://nodejs.org 에서 직접 설치하세요.'
  }
}
$version = (node --version).Trim()
$major = [int]($version.TrimStart('v').Split('.')[0])
if ($major -lt 22) {
  Fail "Node.js 22 이상이 필요해요 (현재 $version). winget upgrade --id OpenJS.NodeJS.LTS 로 업데이트한 뒤 다시 실행하세요."
}
Write-Host "  $version"

Write-Host '[2/3] 패키지 확인'
$lock = Join-Path $root 'package-lock.json'
$stamp = Join-Path $root 'node_modules\.package-lock.json'
$needInstall = -not (Test-Path $stamp)
if (-not $needInstall) { $needInstall = (Get-Item $lock).LastWriteTime -gt (Get-Item $stamp).LastWriteTime }
if ($needInstall) {
  Write-Host '  npm ci 실행 (처음이거나 패키지 목록이 바뀌었어요)'
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci에 실패했어요. 네트워크를 확인한 뒤 다시 실행하세요.' }
} else {
  Write-Host '  최신 상태'
}

Write-Host '[3/3] 앱 실행 (처음에는 Electron을 한 번 내려받아요)'
npm start
if ($LASTEXITCODE -ne 0) { Fail '앱 실행에 실패했어요. 위 메시지를 확인하세요.' }
