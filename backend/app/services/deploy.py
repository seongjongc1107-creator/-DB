"""사내 물리 서버(JFPS PC) 자체 호스팅용 업데이트 메커니즘.

GYSJ(같은 PC에서 도는 별도 프로젝트)의 backend/app/services/deploy.py와 동일한
패턴 — main 브랜치(백엔드 코드)와 deploy-static 브랜치(미리 빌드된 프론트)를
각각 git으로 받아 반영하고, 반영됐으면 프로세스를 재시작한다(재시작 자체는
Run-*.ps1의 while-loop가 담당). Render처럼 push마다 컨테이너를 새로 만드는 게
아니라 이 PC의 디스크를 계속 재사용하므로, 실패 시 직전 커밋으로 롤백하는
안전장치가 특히 중요하다.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# backend/app/services/deploy.py -> 리포지토리 루트
REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
STATIC_DIR = REPO_ROOT / "frontend" / "dist"
DEPLOY_TMP_DIR = REPO_ROOT / "deploy"
STATIC_BRANCH = "deploy-static"
STATE_FILE = BACKEND_DIR / "deploy_state.json"


def _run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def _install_requirements() -> subprocess.CompletedProcess:
    return _run(["uv", "pip", "install", "-r", "requirements.txt"], BACKEND_DIR)


def _load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_state(**updates: str) -> dict:
    state = _load_state()
    state.update(updates)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return state


def get_update_status() -> dict:
    state = _load_state()
    return {
        "current_commit": _current_commit(),
        "current_static_commit": state.get("current_static_commit", "unknown"),
        "last_update_check": state.get("last_update_check"),
        "last_update_applied": state.get("last_update_applied"),
        "last_update_error": state.get("last_update_error") or None,
    }


def _current_commit() -> str:
    result = _run(["git", "rev-parse", "--short", "HEAD"], REPO_ROOT)
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _origin_url() -> str:
    return _run(["git", "remote", "get-url", "origin"], REPO_ROOT).stdout.strip()


def _rollback_backend(good_commit: str) -> None:
    """새 코드가 깨졌을 때 마지막으로 정상 동작하던 커밋으로 되돌림."""
    _run(["git", "reset", "--hard", good_commit], REPO_ROOT)
    _install_requirements()


def _update_backend_code_from_git() -> bool:
    """main 브랜치 git pull + 패키지 설치. 새 코드가 정상 임포트되는지 확인 후,
    실패 시 자동 롤백. 실제로 갱신됐으면 True."""
    fetch = _run(["git", "fetch", "origin", "main"], REPO_ROOT)
    if fetch.returncode != 0:
        raise RuntimeError(f"git fetch 실패 (인터넷/방화벽 확인 필요): {fetch.stderr.strip()}")

    local = _run(["git", "rev-parse", "HEAD"], REPO_ROOT).stdout.strip()
    remote = _run(["git", "rev-parse", "origin/main"], REPO_ROOT).stdout.strip()
    if local == remote:
        return False

    pull = _run(["git", "pull", "origin", "main"], REPO_ROOT)
    if pull.returncode != 0:
        raise RuntimeError(f"git pull 실패: {pull.stderr.strip()}")

    install = _install_requirements()
    if install.returncode != 0:
        _rollback_backend(local)
        raise RuntimeError(f"패키지 설치 실패, {local[:7]}로 롤백함: {install.stderr.strip()}")

    # "코드가 import되는지"뿐 아니라 "NAVDATA/항로DB CSV가 실제로 파싱되는지"까지 확인.
    # NAVDATA.csv/Navblue_Route.csv도 git으로 같이 pull되는 대상이라, 형식이 깨진 CSV를
    # push했을 때 이 체크 없이 재시작해버리면 store.load()가 매번 실패해서 서버가 영영
    # 못 뜨는 무한 재시작 루프에 빠질 수 있다.
    preflight = _run(
        ["uv", "run", "python", "-c", "from app.data_loader import store; store.load()"],
        BACKEND_DIR,
    )
    if preflight.returncode != 0:
        _rollback_backend(local)
        raise RuntimeError(f"새 코드/데이터 검증 실패, {local[:7]}로 롤백함: {preflight.stderr.strip()[-500:]}")

    return True


def _cleanup_dir_best_effort(path: Path, attempts: int = 3, delay: float = 1.0) -> None:
    for _ in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except Exception:
            time.sleep(delay)
    logger.warning(f"임시 폴더 정리 실패(무시하고 진행): {path}")


def _swap_dir(new_dir: Path, target_dir: Path) -> None:
    """target_dir을 new_dir 내용으로 교체 — 가능하면 rename(원자적)으로,
    안 되면 rmtree+copytree로 폴백."""
    if target_dir.exists():
        backup = target_dir.parent / f"{target_dir.name}_old_{int(time.time())}"
        try:
            target_dir.rename(backup)
        except Exception:
            _cleanup_dir_best_effort(target_dir, attempts=5, delay=2.0)
            backup = None
        try:
            new_dir.rename(target_dir)
        except Exception:
            shutil.copytree(new_dir, target_dir, dirs_exist_ok=True)
            _cleanup_dir_best_effort(new_dir)
        if backup is not None:
            _cleanup_dir_best_effort(backup)
    else:
        target_dir.parent.mkdir(parents=True, exist_ok=True)
        new_dir.rename(target_dir)


def _update_static_from_git() -> bool:
    """deploy-static 브랜치를 새 임시 폴더에 clone받아 frontend/dist/에 교체."""
    stamp = int(time.time())
    clone_dir = DEPLOY_TMP_DIR / f"static_src_{stamp}"
    DEPLOY_TMP_DIR.mkdir(parents=True, exist_ok=True)

    clone = _run(
        ["git", "clone", "--branch", STATIC_BRANCH, "--single-branch", "--depth", "1",
         _origin_url(), str(clone_dir)],
        REPO_ROOT,
    )
    if clone.returncode != 0:
        raise RuntimeError(f"deploy-static clone 실패: {clone.stderr.strip()}")

    new_commit = _run(["git", "rev-parse", "--short", "HEAD"], clone_dir).stdout.strip()
    old_commit = _load_state().get("current_static_commit")
    if new_commit == old_commit:
        _cleanup_dir_best_effort(clone_dir)
        return False

    staging_dir = DEPLOY_TMP_DIR / f"static_staging_{stamp}"
    shutil.copytree(clone_dir, staging_dir, ignore=shutil.ignore_patterns(".git"))
    if not (staging_dir / "index.html").exists():
        _cleanup_dir_best_effort(staging_dir)
        _cleanup_dir_best_effort(clone_dir)
        raise RuntimeError("새로 받은 static에 index.html이 없음 — clone/복사가 불완전함")

    _swap_dir(staging_dir, STATIC_DIR)
    _cleanup_dir_best_effort(clone_dir)
    _save_state(current_static_commit=new_commit)
    return True


def check_and_apply_update() -> dict:
    """백엔드 코드(main) + 프론트 정적 파일(deploy-static) 업데이트 확인/적용.
    반환값의 updated=True면 호출부가 restart_process()로 재시작을 트리거해야 함.
    static 실패가 backend 재시작 여부를 막지 않도록 각각 별도 try/except로 처리."""
    now = datetime.now().isoformat(timespec="seconds")

    backend_changed = False
    error: str | None = None
    try:
        backend_changed = _update_backend_code_from_git()
    except Exception as e:
        error = f"백엔드 업데이트 실패: {e}"
        logger.error(error)

    static_changed = False
    try:
        static_changed = _update_static_from_git()
    except Exception as e:
        static_error = f"static 업데이트 실패: {e}"
        logger.error(static_error)
        error = f"{error} / {static_error}" if error else static_error

    _save_state(last_update_check=now, last_update_error=error or "")
    updated = backend_changed or static_changed
    if not updated:
        return {"updated": False, "error": error}

    _save_state(last_update_applied=now)
    return {"updated": True, "error": error}


def restart_process() -> None:
    """새 코드 반영을 위해 프로세스 재시작 (Run-FlightRouteDB.ps1의 while-loop가 자동으로 다시 실행)."""
    time.sleep(0.5)
    logger.info("코드 업데이트 반영을 위해 프로세스를 재시작합니다.")
    os._exit(0)
