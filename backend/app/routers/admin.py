"""
관리자 전용: 근간 데이터(NAVDATA.csv, Navblue_Route.csv, WX_Minima.csv) 업로드.

인증은 최소한만 — 공유 비밀번호 하나(ADMIN_PASSWORD 환경변수) 확인뿐,
세션/토큰 없음. 나중에 다른 시스템에 병합되면 그쪽의 사용자 권한 체계를
따를 예정이라, 그때까지 임시로 막아두는 용도.
"""
from __future__ import annotations

import shutil
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Form, HTTPException, UploadFile
from sqlalchemy import func, select
from starlette.concurrency import run_in_threadpool

from ..admin_auth import check_password
from ..data_loader import store, DATA_DIR, NAVDATA_CSV, ROUTES_CSV
from ..fpl_db import FplSessionLocal
from ..fpl_models import FplArchive, FplCollectionRun
from ..scheduler import BASE_AIRPORTS, get_scheduler_status, run_collection_now
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


async def _fpl_archive_status() -> dict:
    """항로 실적(fpl_archive)에 지금 얼마나 쌓여있는지 — 관리자가 주기적으로
    수집을 돌려야 하는지 판단할 수 있게 총 건수·기간·구간 다양성·가장 최근
    수집 시각을 보여줌."""
    async with FplSessionLocal() as session:
        total = (await session.execute(select(func.count()).select_from(FplArchive))).scalar_one()
        if total == 0:
            return {"total_flights": 0, "od_pair_count": 0, "date_range": None, "last_collected_at": None,
                    "top_od_pairs": []}

        date_min, date_max = (await session.execute(
            select(func.min(FplArchive.flight_date), func.max(FplArchive.flight_date))
        )).one()
        last_collected = (await session.execute(select(func.max(FplArchive.collected_at)))).scalar_one()
        # collected_at은 UTC로 저장하지만 SQLite는 타임존 정보를 안 갖고 있어서
        # (naive datetime) 그냥 isoformat()하면 프론트가 로컬시각으로 오해함 —
        # 명시적으로 Z를 붙여줘야 "9시간 전" 같은 오차가 안 남
        last_collected_iso = last_collected.isoformat() + "Z" if last_collected else None

        od_counts = (await session.execute(
            select(FplArchive.dep, FplArchive.arr, func.count())
            .group_by(FplArchive.dep, FplArchive.arr)
            .order_by(func.count().desc())
        )).all()

    return {
        "total_flights": total,
        "od_pair_count": len(od_counts),
        "date_range": {"start": date_min, "end": date_max},
        "last_collected_at": last_collected_iso,
        "top_od_pairs": [{"dep": d, "arr": a, "count": c} for d, a, c in od_counts[:10]],
    }


_COVERAGE_WINDOW_DAYS = 30  # "최근 한 달" 기준 — 이 범위가 다 채워졌는지로 완료 판정
_COVERAGE_TOLERANCE_DAYS = 2  # 오늘/어제는 아직 FOIS에 다 안 올라왔을 수 있어 약간 여유를 둠


async def _base_airport_coverage() -> list[dict]:
    """거점 공항(BASE_AIRPORTS) 하나하나가 최근 한 달 범위를 실제로 다 수집했는지 —
    출발/도착 어느 쪽으로든 그 공항이 걸린 편을 대상으로, 수집된 flight_date가
    범위 시작까지 닿아 있고 최근까지도 이어져 있으면 '완료'로 판정함.

    실제 트래픽이 0편인 공항(RKJB, RKTL 등)은 fpl_archive에 행 자체가 안 생기므로
    위 조건만으로는 절대 '완료'가 안 됨 — fpl_collection_run 로그에 해당 공항의
    출발·도착 양방향이 에러 없이 끝까지 수집됐다는 기록이 있으면(0편 확인됨) 그것도
    '완료'로 인정함."""
    target_end = date.today()
    target_start = target_end - timedelta(days=_COVERAGE_WINDOW_DAYS)
    start_ok_by = (target_start + timedelta(days=_COVERAGE_TOLERANCE_DAYS)).isoformat()
    end_ok_by = (target_end - timedelta(days=_COVERAGE_TOLERANCE_DAYS)).isoformat()

    async with FplSessionLocal() as session:
        runs = (await session.execute(
            select(FplCollectionRun.dep, FplCollectionRun.arr)
            .where(FplCollectionRun.start_date <= start_ok_by, FplCollectionRun.end_date >= end_ok_by)
        )).all()
    dep_checked = {d for d, a in runs if d}
    arr_checked = {a for d, a in runs if a}
    verified_empty_airports = dep_checked & arr_checked  # 양방향 다 확인된 공항만 인정

    result = []
    async with FplSessionLocal() as session:
        for ap in BASE_AIRPORTS:
            row = (await session.execute(
                select(func.count(), func.min(FplArchive.flight_date), func.max(FplArchive.flight_date))
                .where(
                    (FplArchive.dep == ap) | (FplArchive.arr == ap),
                    FplArchive.flight_date >= target_start.isoformat(),
                )
            )).one()
            count, dmin, dmax = row
            covered = bool(count) and dmin is not None and dmin <= start_ok_by and dmax is not None and dmax >= end_ok_by
            verified_empty = False
            if not covered and ap in verified_empty_airports:
                covered = True
                verified_empty = True
            result.append({
                "airport": ap, "count": count or 0,
                "date_range": {"start": dmin, "end": dmax} if dmin else None,
                "covered": covered,
                "verified_empty": verified_empty,
            })
    return result


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
    return {
        **_validate_navdata(),
        "minima_airports": len(get_minima_seed()),
        "backups": backups[:20],
        "fpl_archive": await _fpl_archive_status(),
        "scheduler": get_scheduler_status(),
        "base_airport_coverage": await _base_airport_coverage(),
    }


@router.post("/data/refresh-archive")
async def refresh_archive(background_tasks: BackgroundTasks):
    """관리자 페이지의 '항로 실적 아카이브' 새로고침 — 로컬 집계만 다시 하는 게
    아니라, 매일 새벽 3시 스케줄러가 하는 것과 똑같이 거점 16개 공항을 FOIS에서
    실제로 다시 긁어옴(최근 7일 윈도우, dedup으로 중복 스킵). 비밀번호 없이도
    누를 수 있게 둠 — 읽기 전용 조회를 다시 트리거하는 것뿐이라 무해함."""
    if get_scheduler_status()["running"]:
        return {"started": False, "reason": "이미 수집이 진행 중입니다"}
    background_tasks.add_task(run_collection_now)
    return {"started": True}


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
