"""
관리자 전용: 근간 데이터(NAVDATA.csv, Navblue_Route.csv, WX_Minima.csv) 업로드.

인증은 최소한만 — 공유 비밀번호 하나(ADMIN_PASSWORD 환경변수) 확인뿐,
세션/토큰 없음. 나중에 다른 시스템에 병합되면 그쪽의 사용자 권한 체계를
따를 예정이라, 그때까지 임시로 막아두는 용도.
"""
from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Form, HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

from ..admin_auth import check_password
from ..data_loader import store, DATA_DIR, NAVDATA_CSV, ROUTES_CSV
from ..wx_minima import WX_MINIMA_CSV, load_wx_minima_file, get_seed as get_minima_seed, parse_wx_minima_csv

router = APIRouter()

BACKUP_DIR = DATA_DIR / "backups"

# navdata/routes는 store.reload()로 반영, minima는 별도 로직 — 업로드 핸들러에서 분기
_NAVDATA_TARGETS = {"navdata": NAVDATA_CSV, "routes": ROUTES_CSV}
_TARGETS = {**_NAVDATA_TARGETS, "minima": WX_MINIMA_CSV}


def _backup(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"{path.stem}_{ts}{path.suffix}"
    shutil.copy2(path, dest)
    return dest.name


def _validate_navdata() -> dict:
    """data/README.md에 문서화된 것과 같은 검증 — fix 이름이 airway/procedure
    이름과 우연히 겹쳐서 항로 좌표가 통째로 비거나 중간에 끊기는 사례가
    없는지 대략 훑어서, 갈아끼운 데이터에 문제가 있으면 업로드 직후 바로
    알 수 있게 함."""
    empty = [r for r in store.routes if not r.coordinates]
    suspicious = [r for r in store.routes if r.coordinates and len(r.coordinates) < len(r.tokens) * 0.3]
    return {
        "airports": len(store.airports),
        "waypoints": len(store.waypoints),
        "airways": len(store.airways),
        "routes": len(store.routes),
        "empty_routes": len(empty),
        "suspicious_routes": len(suspicious),
        "suspicious_sample": [
            f"{r.origin}-{r.destination} #{r.number}" for r in suspicious[:10]
        ],
    }


@router.get("/data/status")
async def data_status():
    """현재 로드된 데이터 현황 — 비밀번호 없이도 조회는 가능(읽기 전용이라 무해).
    backups/ 폴더는 metar_archive.db 백업 등 다른 용도로도 쓰이므로, 여기선
    이 세 파일(NAVDATA/항로DB/WX최저치) 백업만 걸러서 보여줌."""
    stems = tuple(p.stem for p in _TARGETS.values())
    backups = sorted(
        (p.name for p in BACKUP_DIR.glob("*") if p.stem.startswith(stems)) if BACKUP_DIR.exists() else [],
        reverse=True,
    )
    return {**_validate_navdata(), "minima_airports": len(get_minima_seed()), "backups": backups[:20]}


@router.post("/data/{target}")
async def upload_data(target: str, file: UploadFile, password: str = Form(...)):
    """NAVDATA.csv / Navblue_Route.csv / WX_Minima.csv를 새로 업로드 — 기존 파일은
    backups/에 타임스탬프 붙여 자동 백업 후 교체, 서버 재시작 없이 즉시 반영."""
    if target not in _TARGETS:
        raise HTTPException(404, f"알 수 없는 대상: {target} (navdata, routes, minima만 가능)")
    check_password(password)

    dest_path = _TARGETS[target]
    content = await file.read()
    if not content:
        raise HTTPException(400, "빈 파일입니다")

    backup_name = _backup(dest_path)
    dest_path.write_bytes(content)

    if target in _NAVDATA_TARGETS:
        try:
            await run_in_threadpool(store.reload)
        except Exception as e:
            raise HTTPException(500, f"업로드된 파일을 반영하는 중 오류가 발생했습니다: {e}")
        return {"ok": True, "target": target, "backup": backup_name, **_validate_navdata()}

    # target == "minima"
    try:
        load_wx_minima_file()
    except Exception as e:
        raise HTTPException(500, f"업로드된 파일을 반영하는 중 오류가 발생했습니다: {e}")
    _, unresolved = parse_wx_minima_csv(dest_path.read_text(encoding="utf-8-sig"))
    return {
        "ok": True, "target": target, "backup": backup_name,
        "resolved": len(get_minima_seed()), "unresolved_iata": unresolved,
    }
