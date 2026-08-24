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

function Write-Log($msg) {
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $LogFile -Value "[$ts] $msg"
}

# 항로 DB 앱은 GYSJ와 달리 .env를 자동으로 읽어들이는 코드(pydantic-settings 등)가
# 없고, os.environ만 직접 읽는다 — 그래서 uvicorn을 띄우기 전에 이 스크립트가 .env를
# 직접 파싱해서 프로세스 환경변수로 넣어줘야 ADMIN_PASSWORD 등이 실제로 적용된다.
# (안 하면 관리자 기능이 "환경변수가 설정되지 않았습니다"로 전부 500 에러남 — 실제로
# 겪은 문제.)
function Import-DotEnv($EnvFile) {
    if (-not (Test-Path $EnvFile)) { return }
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $val = $line.Substring($idx + 1).Trim()
        [System.Environment]::SetEnvironmentVariable($key, $val, 'Process')
    }
}

Import-DotEnv (Join-Path $BackendDir '.env')

function Get-Port {
    if ($env:PORT) { return $env:PORT }
    return '8001'
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
