# ============================================================================
# 항로 DB(Flight Route Dashboard) 윈도우 서버 설치 스크립트
# 더블클릭용 진입점은 Install-FlightRouteDB.bat 입니다 — 이 파일을 직접 실행하지 마세요.
#
# GYSJ(JFPS)와 같은 PC에, 완전히 별도 프로세스로 설치됩니다 (포트가 다름). 이 저장소는
# 공개(public)라 GYSJ 설치 때처럼 SSH 배포키를 등록하는 절차가 필요 없습니다.
# ============================================================================

$ErrorActionPreference = 'Stop'
$InstallDir = 'C:\FlightRouteDB'
$RepoHttps  = 'https://github.com/seongjongc1107-creator/-DB.git'

function Write-Log($msg) {
    if (-not $LogFile) { return }
    try {
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        [System.IO.File]::AppendAllText($LogFile, "[$ts] $msg`r`n", $LogEncoding)
    } catch { }
}

function Write-Step($n, $total, $msg) {
    Write-Host ""
    Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
    Write-Log "[STEP $n/$total] $msg"
}
function Write-Ok($msg)   { Write-Host "  -> $msg" -ForegroundColor Green;  Write-Log "[OK] $msg" }
function Write-Warn($msg) { Write-Host "  -> $msg" -ForegroundColor Yellow; Write-Log "[WARN] $msg" }
function Write-Err($msg)  { Write-Host "  -> $msg" -ForegroundColor Red;    Write-Log "[ERR] $msg" }

function Fail($msg) {
    Write-Log "[FAIL] $msg"
    Write-Host ""
    Write-Host "설치가 중단되었습니다: $msg" -ForegroundColor Red
    Write-Host "이 창의 내용을 그대로 복사하거나, 아래 로그 파일을 함께 보내 문의해 주세요:" -ForegroundColor Red
    Write-Host "  $LogFile" -ForegroundColor Red
    Write-Host ""
    Read-Host "Enter를 누르면 창이 닫힙니다"
    exit 1
}

# ── 0. 배너 + 관리자 권한 확인 ───────────────────────────────────────────────
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   항로 DB 윈도우 서버 설치 마법사" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "관리자 권한이 필요합니다." -ForegroundColor Red
    Write-Host "Install-FlightRouteDB.bat 파일을 마우스 오른쪽 클릭 -> '관리자 권한으로 실행'을 눌러서 다시 시작해 주세요." -ForegroundColor Red
    Read-Host "Enter를 누르면 창이 닫힙니다"
    exit 1
}

$LogDir = 'C:\ProgramData\FlightRouteDB'
try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $LogFile = Join-Path $LogDir 'install.log'
} catch {
    $LogFile = Join-Path $env:TEMP 'FlightRouteDB-install.log'
}
$LogEncoding = New-Object System.Text.UTF8Encoding($false)
Write-Log ""
Write-Log "==================== 설치 세션 시작: $(Get-Date) ===================="

trap {
    Write-Log "[FATAL-UNHANDLED] $_"
    Write-Host ""
    Write-Host "예상치 못한 오류로 설치가 중단되었습니다: $_" -ForegroundColor Red
    Write-Host "이 창의 내용을 그대로 복사하거나, 아래 로그 파일을 함께 보내 문의해 주세요:" -ForegroundColor Red
    Write-Host "  $LogFile" -ForegroundColor Red
    Write-Host ""
    Read-Host "Enter를 누르면 창이 닫힙니다"
    exit 1
}

$TotalSteps = 7

# ── 1. uv 설치 (GYSJ 설치 때 이미 깔려있을 가능성이 높음) ───────────────────
Write-Step 1 $TotalSteps "uv(파이썬 실행 도구) 설치 확인 중..."
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
if ($uvCmd) {
    Write-Ok "이미 설치되어 있습니다 ($($uvCmd.Source))"
} else {
    try {
        Invoke-Expression (Invoke-RestMethod https://astral.sh/uv/install.ps1)
        $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
            Fail "uv 설치 후에도 실행 파일을 찾을 수 없습니다. 인터넷 연결을 확인하고 다시 실행해 주세요."
        }
        Write-Ok "uv 설치 완료"
    } catch {
        Fail "uv 설치 실패 (인터넷 연결 확인 필요): $_"
    }
}

# ── 2. git 설치 (GYSJ 설치 때 이미 깔려있을 가능성이 높음) ──────────────────
Write-Step 2 $TotalSteps "git 설치 확인 중..."
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Ok "이미 설치되어 있습니다"
} else {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "git이 없고 winget도 없습니다. https://git-scm.com/download/win 에서 직접 설치한 뒤 이 스크립트를 다시 실행해 주세요."
    }
    try {
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null
        $env:Path = "$env:ProgramFiles\Git\cmd;$env:Path"
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            Fail "git 설치 후에도 실행 파일을 찾을 수 없습니다. PC를 재부팅한 뒤 이 스크립트를 다시 실행해 주세요."
        }
        Write-Ok "git 설치 완료"
    } catch {
        Fail "git 설치 실패: $_"
    }
}

# ── 3. 저장소 클론 (공개 저장소라 별도 인증 없이 바로 clone) ────────────────
Write-Step 3 $TotalSteps "저장소 다운로드 중 ($InstallDir)..."
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Ok "이미 설치되어 있습니다 — 최신 상태로 갱신합니다"
    Push-Location $InstallDir
    git pull origin main
    if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "저장소 업데이트(git pull)에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요." }
    Pop-Location
} else {
    $dbBackupDir = $null
    if (Test-Path $InstallDir) {
        Write-Warn "이전 설치 시도가 실패해 남은 폴더를 정리합니다 (기존 데이터베이스는 보존합니다)..."
        $dbBackupDir = Join-Path $env:TEMP 'flightroutedb_db_backup'
        New-Item -ItemType Directory -Path $dbBackupDir -Force | Out-Null
        foreach ($dbName in @('fpl_archive.db', 'metar_archive.db')) {
            $existingDb = Join-Path $InstallDir "backend\$dbName"
            if (Test-Path $existingDb) {
                Copy-Item -Path $existingDb -Destination (Join-Path $dbBackupDir $dbName) -Force
                Write-Log "[BACKUP] 삭제 전 기존 $dbName 를 $dbBackupDir 로 백업"
            }
        }
        Remove-Item -Recurse -Force $InstallDir
    }
    git clone $RepoHttps $InstallDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $InstallDir '.git'))) {
        Fail "저장소 클론에 실패했습니다. 인터넷 연결을 확인한 뒤 다시 실행해 주세요."
    }
    if ($dbBackupDir -and (Test-Path $dbBackupDir)) {
        $newBackendDir = Join-Path $InstallDir 'backend'
        foreach ($dbFile in (Get-ChildItem $dbBackupDir -File)) {
            Copy-Item -Path $dbFile.FullName -Destination (Join-Path $newBackendDir $dbFile.Name) -Force
        }
        Remove-Item -Recurse -Force $dbBackupDir
        Write-Ok "기존 데이터베이스(항로 실적·기상 이력) 복원 완료"
    }
    Write-Ok "다운로드 완료"
}

# ── 4. 설치 정보 입력 + 이력 DB 최초 이식 ────────────────────────────────────
Write-Step 4 $TotalSteps "설치 정보를 입력해 주세요"

$port = ''
while ($true) {
    $portInput = Read-Host "  포트 번호 (엔터 = 기본값 8001 — GYSJ가 8000을 쓰므로 겹치지 않게)"
    if ([string]::IsNullOrWhiteSpace($portInput)) { $port = '8001'; break }
    if ($portInput -match '^\d+$' -and [int]$portInput -ge 1 -and [int]$portInput -le 65535) { $port = $portInput; break }
    Write-Warn "1~65535 사이의 숫자만 입력해 주세요."
}

$adminPw = ''
while ($true) {
    $adminPw = Read-Host "  관리자 비밀번호 (근간 데이터 업로드·지금 업데이트 실행용, 직접 정하세요)"
    if (-not [string]::IsNullOrWhiteSpace($adminPw)) { break }
    Write-Warn "비밀번호를 입력해 주세요."
}

$backendDir = Join-Path $InstallDir 'backend'
Write-Host ""
Write-Host "  (선택) 항로 실적·기상 이력 DB를 이미 다른 곳(예: 이 작업을 준비한 Mac)에서" -ForegroundColor Yellow
Write-Host "  받아둔 게 있다면, 그 fpl_archive.db / metar_archive.db 파일이 든 폴더 경로를" -ForegroundColor Yellow
Write-Host "  넣어주세요. 없으면 그냥 엔터 — 새로 쌓이기 시작합니다." -ForegroundColor Yellow
$seedDir = Read-Host "  이력 DB 폴더 경로 (엔터 = 건너뜀)"
if (-not [string]::IsNullOrWhiteSpace($seedDir) -and (Test-Path $seedDir)) {
    foreach ($dbName in @('fpl_archive.db', 'metar_archive.db')) {
        $src = Join-Path $seedDir $dbName
        if (Test-Path $src) {
            Copy-Item -Path $src -Destination (Join-Path $backendDir $dbName) -Force
            Write-Ok "$dbName 이식 완료"
        }
    }
}

# ── 5. .env 생성 + 패키지 설치 ─────────────────────────────────────────────
Write-Step 5 $TotalSteps "환경 설정 및 패키지 설치 중..."
$envContent = @"
ADMIN_PASSWORD=$adminPw
PORT=$port
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $backendDir '.env'), $envContent, $utf8NoBom)
Write-Ok ".env 생성 완료"

Push-Location $backendDir
uv venv --clear
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "가상환경 생성 실패" }
uv pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "패키지 설치 실패" }
Pop-Location
Write-Ok "패키지 설치 완료"

# ── 6. Task Scheduler 등록 + 방화벽 + 바탕화면 바로가기 ─────────────────────
Write-Step 6 $TotalSteps "자동 시작 · 방화벽 · 바로가기 설정 중..."
$runScript = Join-Path $InstallDir 'installer\Run-FlightRouteDB.ps1'
$taskName = 'FlightRouteDB'

try {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runScript`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Ok "자동 시작 등록 완료 (앞으로 이 계정으로 윈도우에 로그인할 때마다 GYSJ와 함께 자동 시작됩니다)"
} catch {
    Fail "자동 시작 등록 실패 (회사 그룹 정책으로 Task Scheduler 사용이 제한되어 있을 수 있습니다): $_"
}

try {
    $fwRuleName = "FlightRouteDB ($port)"
    if (-not (Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $fwRuleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    }
    Write-Ok "방화벽 포트 $port 개방 완료"

    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop '항로DB.url'
    Set-Content -Path $shortcutPath -Value "[InternetShortcut]`nURL=http://localhost:$port" -Encoding ASCII

    Copy-Item -Path (Join-Path $InstallDir 'installer\Update-FlightRouteDB.bat') -Destination (Join-Path $desktop '항로DB 업데이트.bat') -Force
    Write-Ok "바탕화면에 바로가기 생성 완료"
} catch {
    Fail "방화벽 규칙 또는 바탕화면 바로가기 생성 실패: $_"
}

# ── 7. 헬스체크 + 초기 정적파일 부트스트랩 ───────────────────────────────────
Write-Step 7 $TotalSteps "정상 동작 확인 중..."

$healthy = $false
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 3
        if ($res.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
}

if (-not $healthy) {
    Fail "서버가 응답하지 않습니다. $InstallDir\installer\run.log 파일을 확인해 주세요."
}
Write-Ok "서버 응답 확인됨"

try {
    $form = @{ password = $adminPw }
    Invoke-RestMethod -Uri "http://localhost:$port/api/admin/update-now" -Method Post -Body $form | Out-Null
    Write-Ok "화면(프론트엔드) 초기 다운로드 요청 완료 (몇 초 후 서버가 자동으로 한 번 재시작됩니다)"
} catch {
    Write-Warn "화면 초기 다운로드에 실패했습니다 — 바탕화면의 '항로DB 업데이트.bat'을 눌러 다시 시도해 주세요."
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "   설치 완료!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  이 PC에서 접속: http://localhost:$port" -ForegroundColor Green
Write-Host "  사내 다른 PC에서 접속: http://<이 PC의 IP주소>:$port" -ForegroundColor Green
Write-Host "  바탕화면에 바로가기가 생성되었습니다." -ForegroundColor Green
Write-Host "  설치 로그: $LogFile" -ForegroundColor Green
Write-Host ""
Write-Log "==================== 설치 완료 ===================="
Read-Host "Enter를 누르면 창이 닫힙니다"
