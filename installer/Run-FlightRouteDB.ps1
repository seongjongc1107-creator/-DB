# 항로 DB 백엔드를 죽지 않고 계속 돌게 하는 실행 루프.
# GYSJ(JFPS)와 동일한 패턴 — Windows 서비스(NSSM 등) 대신 Task Scheduler(로그온 시 트리거)가
# 이 스크립트 자체를 실행하고, 이 스크립트 내부의 while 루프가 uvicorn이 종료될 때마다
# (코드 업데이트로 인한 자기-재시작 포함) 다시 띄운다.

$ErrorActionPreference = 'Continue'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot 'backend'
$LogFile    = Join-Path $PSScriptRoot 'run.log'

function Get-UvPath {
    $cmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $fallback) { return $fallback }
    return 'uv'
}

function Get-Port {
    $envFile = Join-Path $BackendDir '.env'
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
        if ($line) { return ($line -split '=', 2)[1].Trim() }
    }
    return '8001'
}

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $LogFile -Value "[$ts] $msg"
}

$uv   = Get-UvPath
$port = Get-Port

Set-Location $BackendDir
Write-Log "항로 DB 실행 루프 시작 (uv=$uv, port=$port)"

while ($true) {
    Write-Log "uvicorn 시작 시도"
    & $uv run uvicorn app.main:app --host 0.0.0.0 --port $port *>> $LogFile
    Write-Log "uvicorn 프로세스 종료됨 — 3초 후 재시작"
    Start-Sleep -Seconds 3
}
