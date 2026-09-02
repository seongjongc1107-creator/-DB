import asyncio
import difflib
import math
import random
import re
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Query
from sqlalchemy import select

from ..country_codes import airports_in_country, available_countries
from ..data_loader import store, _gc_km
from ..fpl_db import FplSessionLocal, make_fpl_upsert
from ..fpl_models import FplArchive, FplCollectionRun
from .navdata import _FIR_DATA

router = APIRouter()

FOIS_DEP_URL = "https://ubikais.fois.go.kr:8030/sysUbikais/biz/fpl/selectDep.fois"
FOIS_FPL_URL = "https://ubikais.fois.go.kr:8030/sysUbikais/biz/fpl/selectViewFpl.fois"

KST = timezone(timedelta(hours=9))


def _today_kst() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")


def _dummy() -> str:
    return str(random.randint(10_000_000, 99_999_999))


def _hhmm_to_min(t: Optional[str]) -> Optional[int]:
    if not t or len(t) != 4:
        return None
    return int(t[:2]) * 60 + int(t[2:])


def _arrival_sort_key(f: dict) -> int:
    """FOIS는 조회한 srchDate 기준 '출발일'로 편을 골라오기 때문에, 도착시각(eta/sta)이
    출발시각(etd)보다 시계상 이르면 자정을 넘겨 다음날 도착한 것 — 그 경우 24시간을
    더해야 실제 시간 순서(예: 오늘 23시대 도착 다음에 다음날 00시대 도착)로 정렬됨.
    이걸 안 해주면 자정 넘겨 도착하는 편이 되레 리스트 맨 앞으로 튀어오름."""
    eta = _hhmm_to_min(f.get("eta") or f.get("sta"))
    if eta is None:
        return 9999
    etd = _hhmm_to_min(f.get("etd") or f.get("sched_time"))
    if etd is not None and eta < etd:
        eta += 24 * 60
    return eta


async def _fetch_schedule(client: httpx.AsyncClient, dep: str, arr: str, srch_date: str) -> list[dict]:
    """하루치 스케줄을 FOIS에서 받아옴 — 실시간 조회(`/schedule`)와 이력 수집기가 공유."""
    params = {
        "downloadYn": "1",
        "srchDate": srch_date,
        "srchDatesh": srch_date.replace("-", ""),
        "srchAl": "",
        "srchFln": "",
        "srchDep": dep,
        "srchArr": arr,
        "dummy": _dummy(),
        "cmd": "get-records",
        "limit": "300",
        "offset": "0",
    }
    resp = await client.get(FOIS_DEP_URL, params=params)
    resp.raise_for_status()
    data = resp.json()
    records = data.get("records") or []
    flights = [{
        "callsign": r.get("fpId"),
        "dep": r.get("apIcao"),
        "arr": r.get("apArr"),
        "ac_type": r.get("acType"),
        "reg": r.get("acId"),
        "sched_time": r.get("schTime"),
        "etd": r.get("etd"),
        "atd": r.get("atd"),
        "dep_status": r.get("depStatus"),
        "nature": r.get("nat"),
        "sta": r.get("sta"),
        "eta": r.get("eta"),
        "ata": r.get("ata"),
        "ams_rec_pk": r.get("amsRecPk"),
    } for r in records]
    # dep으로 조회했으면(도착지 무관) 출발시각 기준, arr만으로 조회했으면(출발지 무관)
    # 도착시각 기준으로 정렬 — 프론트가 실제로 그 시각을 보여주는 쪽과 맞춰야
    # KST→UTC 환산 시 자정을 넘는 "(-1)" 편이 화면에서 엉뚱한 순서로 보이지 않음
    if dep:
        flights.sort(key=lambda f: f["etd"] or f["sched_time"] or "9999")
    else:
        flights.sort(key=_arrival_sort_key)
    return flights


@router.get("/schedule")
async def get_schedule(
    dep: Optional[str] = Query(None, description="출발 공항 ICAO (비우면 전체)"),
    arr: Optional[str] = Query(None, description="도착 공항 ICAO (비우면 전체)"),
    date: Optional[str] = Query(None, description="YYYY-MM-DD, 기본값 오늘(KST)"),
):
    """국토부 FOIS(Flight Operation Information System)에 실제로 제출된 ATC 비행계획
    기준 스케줄. 우리 항로 DB에 이 출발/도착 공항이 있는지 여부와 무관하게, 항공사
    상관없이 그날 실제 신청된 편을 그대로 보여줌.

    dep/arr 둘 다 주면 그 구간만, 한쪽만 주면(다른 쪽 공백) 그 공항의 출발편 전체
    또는 도착편 전체(다른 쪽 공항 무관)를 가져옴 — FOIS 자체가 지원하는 필터라
    국내 출발공항이 어디든 상관없이 특정 도착지행 전부를 한 번에 가져올 수 있음.
    """
    if not dep and not arr:
        return {"date": date or _today_kst(), "dep": dep, "arr": arr, "count": 0, "flights": [],
                "error": "dep 또는 arr 중 하나는 필요합니다"}

    srch_date = date or _today_kst()
    dep = (dep or "").strip().upper()
    arr = (arr or "").strip().upper()
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            flights = await _fetch_schedule(client, dep, arr, srch_date)
    except Exception as e:
        return {"date": srch_date, "dep": dep, "arr": arr, "count": 0, "flights": [], "error": str(e)}

    return {"date": srch_date, "dep": dep or None, "arr": arr or None, "count": len(flights), "flights": flights}


# ── 실제 제출 FPL 원문 → 항로 파싱 ────────────────────────────────────────

_FPL_BODY_RE = re.compile(r"\(FPL-(.*)\)", re.S)
# ICAO FPL 항로 필드는 fix 뒤에 "/N0497F400"(속도+고도 변경) 같은 접미사가 바로
# 붙는 경우가 있음 — 항로 토큰 자체는 아니라서 떼어내야 우리 파서가 fix로 인식함.
# 속도 단위는 N(knots)/M(mach)뿐 아니라 K(km/h, 중국·러시아 등 미터법 관제권에서 흔함)도
# ICAO 표준 표기라 빠지면 RPVM처럼 중국 영공을 지나는 항로에서 AGAVO/K0920S0920 같은
# fix가 통째로 "못 찾은 fix" 취급돼 항로가 끊겨버림
_FPL_LEVEL_SUFFIX_RE = re.compile(r"^([A-Z0-9]+)/[KMN]\d{3,4}[FSA]\d{3,4}$")


def _parse_fpl_route(raw_text: str) -> tuple[str, str, list[str], Optional[str]]:
    """ICAO FPL 원문에서 (출발공항, 도착공항, 항로 토큰열, EET)를 뽑아냄.

    FPL 필드는 '-'로 구분되는데, 순서대로 [콜사인, 규칙/기종, 기종/후류, 장비,
    출발공항+시각, 순항속도+항로, 도착공항+EET(+교체공항), 기타] — 5번째(index 4)가
    출발, 6번째(index 5)가 항로, 7번째(index 6)가 도착. 도착공항 필드는 ICAO 표준상
    "도착공항(4자)+총EET(4자, HHMM)"가 공백 없이 붙어있고 그 뒤에 교체공항이 옴
    (예: "RKSI0135 RKTN") — 신고된 총 비행예정시간이라 실측(atd~ata)보다 신뢰도 높음.
    """
    flat = re.sub(r"\s+", " ", raw_text).strip()
    m = _FPL_BODY_RE.search(flat)
    if not m:
        raise ValueError("FPL 필드를 찾을 수 없음")
    fields = m.group(1).split("-")
    if len(fields) < 7:
        raise ValueError("FPL 필드 형식이 예상과 다름")

    dep_icao = fields[4].strip()[:4]
    dest_field = fields[6].strip().split()[0] if fields[6].strip() else ""
    dest_icao = dest_field[:4]
    eet = dest_field[4:8] if len(dest_field) >= 8 and dest_field[4:8].isdigit() else None

    route_tokens = fields[5].strip().split()
    if route_tokens:
        route_tokens = route_tokens[1:]  # 맨 앞은 순항속도/고도(예: N0495F400) — 항로 토큰 아님

    cleaned: list[str] = []
    for t in route_tokens:
        mm = _FPL_LEVEL_SUFFIX_RE.match(t)
        cleaned.append(mm.group(1) if mm else t)
    return dep_icao, dest_icao, cleaned, eet


async def _fetch_fpl_raw(client: httpx.AsyncClient, ams_rec_pk: int) -> str:
    """특정 편의 FPL 원문 텍스트만 받아옴 — 지도 오버레이(`/route`)와 이력 수집기가 공유.
    수집기는 좌표 해석(store.resolve_route_tokens)까지는 필요 없어 이 부분만 재사용."""
    resp = await client.get(FOIS_FPL_URL, params={"amsRecPk": ams_rec_pk, "dummy": _dummy()})
    resp.raise_for_status()
    data = resp.json()
    records = data.get("records") or []
    if not records:
        raise ValueError("FPL 데이터를 찾을 수 없음")
    return records[0].get("amsOriginal") or ""


@router.get("/route")
async def get_fpl_route(ams_rec_pk: int = Query(...)):
    """특정 편이 실제로 신청한 ATC 비행계획(FPL) 원문을 받아 항로 좌표로 파싱 —
    지도 오버레이용. 저장된 Navblue 항로 DB와 무관하게, 그 편이 오늘 진짜 낸 항로."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            raw = await _fetch_fpl_raw(client, ams_rec_pk)
        dep_icao, dest_icao, route_tokens, eet = _parse_fpl_route(raw)
    except Exception as e:
        return {"error": str(e)}

    if not dep_icao or not dest_icao:
        return {"error": "출발/도착 공항을 못 읽음", "route_raw": raw}

    tokens = [dep_icao, *route_tokens, dest_icao]
    try:
        coords, passed_fixes, airway_gaps, legs = store.resolve_route_tokens(tokens)
    except Exception as e:
        return {"error": f"항로 해석 실패: {e}", "route_raw": raw}

    if len(coords) < 2:
        return {"error": "항로 좌표를 만들 수 없음(fix를 못 찾음)", "route_raw": raw}

    waypoints = [{"id": fix, "lon": coord[0], "lat": coord[1]} for fix, coord in sorted(passed_fixes.items())]

    return {
        "dep": dep_icao, "arr": dest_icao,
        "coordinates": coords, "legs": legs, "waypoints": waypoints, "airway_gaps": airway_gaps,
        "route": " ".join([dep_icao, *route_tokens, dest_icao]),
        "route_raw": raw, "eet": eet,
    }


# ── 항로 제출 실적 이력 수집/집계 ──────────────────────────────────────────
# FOIS는 과거 스케줄/FPL도 (실측상 최소 60일 전까지) 조회되지만 매번 라이브로
# 긁으면 느리고 국토부 서버에 부담을 줌 — 날씨 이력(weather.py)과 같은 방식으로
# 로컬 DB에 누적 수집해두고, 조회는 로컬 데이터를 집계해서 응답함.
# 스케줄 조회는 하루 1콜이지만 FPL 원문은 편당 1콜이라(N+1) 이게 병목 —
# 이미 수집된 ams_rec_pk는 건너뛰고, 신규 편만 페이싱을 두고 순차 호출함.

_fpl_tasks: dict[str, dict] = {}

_MAX_COLLECT_DAYS = 62  # 한 번에 너무 넓은 기간을 잡으면 FPL 콜이 수천~수만 건까지 늘어남


async def _bulk_insert_fpl(record: dict) -> None:
    async with FplSessionLocal() as session:
        stmt = make_fpl_upsert(FplArchive, [record])
        await session.execute(stmt)
        await session.commit()


async def _existing_fpl_pks(pks: list[int]) -> set[int]:
    if not pks:
        return set()
    async with FplSessionLocal() as session:
        q = select(FplArchive.ams_rec_pk).where(FplArchive.ams_rec_pk.in_(pks))
        result = await session.execute(q)
        return set(result.scalars().all())


# FPL 원문은 편당 1콜(N+1)이라 예전엔 완전 순차 + 0.2초 페이싱으로 돌렸는데, 편수가
# 많을수록(거점 16개 공항 등) 그만큼 느려짐 — 동시 요청 개수를 제한해서 병렬로
# 돌리면 페이싱은 유지하면서도 훨씬 빠르게 끝남. 동시 개수는 FOIS에 순간적으로
# 과도한 부담을 주지 않을 정도로 적당히 잡음(완전 무제한 병렬은 지양).
_FPL_FETCH_CONCURRENCY = 6
_FPL_FETCH_PACING = 0.05  # 요청 슬롯 하나당 최소 간격(초) — 병렬이어도 최소한의 예의


async def _fetch_fpl_batch(client: httpx.AsyncClient, pks: list[int], is_cancelled):
    """pks를 최대 _FPL_FETCH_CONCURRENCY개씩 동시에 가져와 파싱, 완료되는 대로
    {"pk", "ok", "dep_icao", "dest_icao", "route_tokens", "eet"}를 yield함(실패 시 ok=False).
    is_cancelled()가 True가 되면 아직 안 끝난 나머지는 취소하고 중단."""
    sem = asyncio.Semaphore(_FPL_FETCH_CONCURRENCY)

    async def worker(pk: int) -> dict:
        async with sem:
            try:
                raw = await _fetch_fpl_raw(client, pk)
                dep_icao, dest_icao, route_tokens, eet = _parse_fpl_route(raw)
                result = {"pk": pk, "ok": True, "dep_icao": dep_icao, "dest_icao": dest_icao,
                          "route_tokens": route_tokens, "eet": eet}
            except Exception:
                result = {"pk": pk, "ok": False}
            await asyncio.sleep(_FPL_FETCH_PACING)
            return result

    tasks = [asyncio.create_task(worker(pk)) for pk in pks]
    try:
        for coro in asyncio.as_completed(tasks):
            if is_cancelled():
                break
            yield await coro
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()


async def _run_fpl_collect(task_id: str, dep: str, arr: str, start: date, end: date) -> None:
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    _fpl_tasks[task_id].update({"total_days": len(days), "processed_days": 0, "total_flights": 0,
                                 "collected": 0, "skipped": 0, "failed": 0})

    async with httpx.AsyncClient(timeout=15) as client:
        for d in days:
            if _fpl_tasks[task_id].get("cancelled"):
                _fpl_tasks[task_id]["status"] = "cancelled"
                return
            try:
                flights = await _fetch_schedule(client, dep, arr, d.isoformat())
            except Exception as e:
                _fpl_tasks[task_id]["error"] = str(e)
                _fpl_tasks[task_id]["processed_days"] += 1
                continue

            pks = [f["ams_rec_pk"] for f in flights if f.get("ams_rec_pk")]
            have = await _existing_fpl_pks(pks)
            _fpl_tasks[task_id]["total_flights"] += len(pks)

            by_pk = {f["ams_rec_pk"]: f for f in flights if f.get("ams_rec_pk")}
            need = [pk for pk in by_pk if pk not in have]
            _fpl_tasks[task_id]["skipped"] += len(by_pk) - len(need)

            async for result in _fetch_fpl_batch(
                client, need, lambda: _fpl_tasks[task_id].get("cancelled")
            ):
                pk = result["pk"]
                if not result["ok"]:
                    _fpl_tasks[task_id]["failed"] += 1
                    continue
                f = by_pk[pk]
                dep_icao, dest_icao = result["dep_icao"], result["dest_icao"]
                route_str = (
                    " ".join([dep_icao, *result["route_tokens"], dest_icao])
                    if dep_icao and dest_icao else None
                )
                await _bulk_insert_fpl({
                    "ams_rec_pk": pk,
                    "flight_date": d.isoformat(),
                    "callsign": f["callsign"] or "",
                    "dep": f.get("dep") or dep_icao or "",
                    "arr": f.get("arr") or dest_icao or "",
                    "ac_type": f.get("ac_type"),
                    "eet_min": _hhmm_to_min(result["eet"]),
                    "route": route_str,
                    "collected_at": datetime.now(timezone.utc),
                })
                _fpl_tasks[task_id]["collected"] += 1

            if _fpl_tasks[task_id].get("cancelled"):
                _fpl_tasks[task_id]["status"] = "cancelled"
                return

            _fpl_tasks[task_id]["processed_days"] += 1

    # 중간에 에러 없이 끝까지 다 돈 경우에만 기록 — 하루라도 조회 실패한 채로
    # 넘어갔으면(예: 일시적 DNS 장애) "0편 확인됨"으로 오인되면 안 됨
    if _fpl_tasks[task_id].get("error") is None:
        async with FplSessionLocal() as session:
            session.add(FplCollectionRun(
                dep=dep or None, arr=arr or None,
                start_date=start.isoformat(), end_date=end.isoformat(),
                flights_found=_fpl_tasks[task_id]["total_flights"],
                ran_at=datetime.now(timezone.utc),
            ))
            await session.commit()

    _fpl_tasks[task_id]["status"] = "done"


@router.post("/history/collect")
async def fpl_history_collect(
    background_tasks: BackgroundTasks,
    dep: Optional[str] = Query(None, description="출발 공항 ICAO (비우면 전체)"),
    arr: Optional[str] = Query(None, description="도착 공항 ICAO (비우면 전체)"),
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
):
    """지정 기간의 dep/arr 스케줄 + 편별 FPL을 순회하며 로컬 DB에 누적 수집."""
    dep = (dep or "").strip().upper()
    arr = (arr or "").strip().upper()
    if not dep and not arr:
        return {"error": "dep 또는 arr 중 하나는 필요합니다"}
    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError:
        return {"error": "Invalid date format. Use YYYY-MM-DD."}
    if end_d < start_d:
        return {"error": "end must be >= start"}
    if (end_d - start_d).days + 1 > _MAX_COLLECT_DAYS:
        return {"error": f"한 번에 최대 {_MAX_COLLECT_DAYS}일까지 수집할 수 있습니다"}

    task_id = str(uuid.uuid4())
    _fpl_tasks[task_id] = {
        "dep": dep or None, "arr": arr or None, "start": start, "end": end,
        "status": "running", "total_days": 0, "processed_days": 0,
        "total_flights": 0, "collected": 0, "skipped": 0, "failed": 0,
        "error": None, "cancelled": False,
    }
    background_tasks.add_task(_run_fpl_collect, task_id, dep, arr, start_d, end_d)
    return {"task_id": task_id}


@router.get("/history/status/{task_id}")
async def fpl_history_status(task_id: str):
    t = _fpl_tasks.get(task_id)
    if not t:
        return {"error": "Task not found"}
    return t


def _canonicalize_route(route: str) -> str:
    """같은 항공로를 두 번 연속 타면서 중간 경유fix 표기 여부만 다른 걸 하나로 합침.
    예: 'SAKON A582 NIMOX A582 POLIO'와 'SAKON A582 POLIO'는 좌표상 완전히
    동일한 경로임(중간 fix는 그 항공로 위에 원래 있는 지점이라, 명시 여부가
    지리적으로 아무 차이도 안 만듦 — resolve_route_tokens 결과 좌표가 정확히
    같음을 확인함) — 그런데도 문자열이 다르다는 이유로 집계에서 다른 항로로
    갈라져 보이던 걸 정규화.
    (SID/STAR 절차명 — 예: BOPTA2A/BAKER1B — 은 건드리지 않음. 그건 실제로
    다른 출발/도착 절차를 탄 것이라 항로 집계에서 구분 유지하는 게 맞음.)
    """
    tokens = route.split()
    merged = True
    while merged:
        merged = False
        for i in range(len(tokens) - 3):
            awy = tokens[i + 1]
            if awy == tokens[i + 3] and awy in store.airway_names:
                tokens = tokens[:i + 1] + tokens[i + 3:]
                merged = True
                break
    return " ".join(tokens)


_PROC_TOKEN_RE = re.compile(r"^[A-Z]{2,}\d")  # SID/STAR 절차명 패턴: 2글자 이상 문자 + 숫자(+선택적 리비전 문자)
# 예: TETRA8, BOPTA2A, KARBU2E, GUKDO2H — 항공로명(A582, Y16, L512처럼 문자 1개+숫자)과
# 구분됨. fix_lookup 멤버십은 못 믿음(TETRA8처럼 절차명인데 fix_lookup에도 우연히
# 걸리는 경우가 있었음) — 그래서 airway_names 배제 + 이 패턴으로 판별함.


def _navblue_match_key(route: str) -> str:
    """NAVBLUE 항로DB와 대조할 때만 쓰는 키 — SID/STAR 절차명은 빼고 비교함.
    항공사가 SID/STAR 자리에 그냥 DCT로 파일하거나, 절차 리비전이 실제 필드
    시점과 NAVBLUE 스냅샷 사이에 달라지는 경우가 흔해서(예: GUKDO2H vs
    GUKDO2E) 절차명까지 완전히 일치해야 매칭시키면 사실상 같은 코어 항로를
    "미등록"으로 오판하는 경우가 많았음. 이 SID/STAR 자리에 한해서는 DCT도
    "절차 없음"과 동급으로 취급해 같이 뗌(NAVBLUE는 이 자리에 DCT를 안 쓰고
    항상 이름 붙은 절차를 쓰므로, 안 떼면 실제 필드가 DCT로 낸 것만으로
    매칭이 깨짐) — 화면 표시용 canonical route(SID/STAR 유지)와는 별개로
    이 매칭 용도로만 씀."""
    tokens = _canonicalize_route(route).split()

    def is_stub(t: str) -> bool:
        if t in store.airway_names:
            return False
        return t == "DCT" or bool(_PROC_TOKEN_RE.match(t))

    if len(tokens) >= 3 and is_stub(tokens[1]):
        tokens.pop(1)
    if len(tokens) >= 3 and is_stub(tokens[-2]):
        tokens.pop(-2)
    return " ".join(tokens)


def _route_distance_nm(route: str) -> Optional[int]:
    """항로 문자열을 navdata로 좌표 해석해서 대권거리 합산 — ATC 원문에도 NAVBLUE
    CSV에도 거리 값 자체가 없어서, 저장된 항로(NAVBLUE)와 동일한 방식(대권거리
    합산)으로 우리가 직접 계산해야 서로 비교 가능함."""
    tokens = route.split()
    if len(tokens) < 2:
        return None
    try:
        coords, _, _, _ = store.resolve_route_tokens(tokens)
    except Exception:
        return None
    if len(coords) < 2:
        return None
    km = sum(_gc_km(coords[i], coords[i + 1]) for i in range(len(coords) - 1))
    return round(km / 1.852)  # km → NM


def _fpl_stats(rows: list[FplArchive]) -> list[dict]:
    from collections import defaultdict

    groups: dict[tuple[str, str], list[FplArchive]] = defaultdict(list)
    for r in rows:
        groups[(r.dep, r.arr)].append(r)

    # 같은 항로 문자열이 여러 편/여러 OD 그룹에 반복 등장하므로, 좌표 해석은
    # 문자열당 한 번만(캐시) — 특히 자주 쓰는 항로일수록 반복 호출을 크게 줄여줌
    dist_cache: dict[str, Optional[int]] = {}

    def _dist(route: str) -> Optional[int]:
        if route not in dist_cache:
            dist_cache[route] = _route_distance_nm(route)
        return dist_cache[route]

    def _ac_breakdown(recs: list[FplArchive]) -> list[dict]:
        """기종별 (건수·비중·평균 비행시간) — 항로 전체 집계와 항로별 집계가
        똑같은 모양을 쓰도록 공용 함수로 뺌. 항로별로 쪼개서 봐야 '짧아서 빠른 건지
        기종이 좋아서 빠른 건지'를 구분할 수 있음(시간만 전체 평균 내면 안 섞여 보임)."""
        counts: dict[str, int] = defaultdict(int)
        eets: dict[str, list[int]] = defaultdict(list)
        for r in recs:
            if not r.ac_type:
                continue
            counts[r.ac_type] += 1
            if r.eet_min is not None:
                eets[r.ac_type].append(r.eet_min)
        total = len(recs) or 1
        return [
            {
                "ac_type": ac, "count": c, "pct": round(c / total, 3),
                "eet_avg_min": round(mean(eets[ac])) if eets.get(ac) else None,
            }
            for ac, c in sorted(counts.items(), key=lambda kv: -kv[1])
        ]

    # 원문 문자열 → canonical 캐시 — route가 OD 그룹 여러 곳에 반복 등장하므로
    canon_cache: dict[str, str] = {}

    def _canon(route: str) -> str:
        if route not in canon_cache:
            canon_cache[route] = _canonicalize_route(route)
        return canon_cache[route]

    def _by_airline_breakdown(recs: list[FplArchive]) -> list[dict]:
        """항공사별 투입 기종 현황(TAB 1용) — 항공사 코드로 한 번 더 묶고,
        그 안에서 _ac_breakdown 재사용. airline 필터가 걸려 있으면 자연히
        그 항공사 하나만 나옴."""
        by_al: dict[str, list[FplArchive]] = defaultdict(list)
        for r in recs:
            by_al[_airline_code(r.callsign)].append(r)
        return [
            {"airline": al, "count": len(al_recs), "aircraft": _ac_breakdown(al_recs)}
            for al, al_recs in sorted(by_al.items(), key=lambda kv: -len(kv[1]))
        ]

    result = []
    for (dep, arr), recs in sorted(groups.items()):
        route_recs: dict[str, list[FplArchive]] = defaultdict(list)
        route_variants: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        eets: list[int] = []
        for r in recs:
            if r.route:
                canon = _canon(r.route)
                route_recs[canon].append(r)
                route_variants[canon][r.route] += 1
            if r.eet_min is not None:
                eets.append(r.eet_min)
        total = len(recs)

        # 이 OD 쌍으로 NAVBLUE 항로DB에 등록된 항로들을 canonical 형태로 미리
        # 매핑해둠 — 우회항로 추천 기능과 같은 방식으로, 실제 제출 항로가 우리
        # 정식 DB에도 있는 항로인지 바로 대조 가능하게
        navblue_matches = store.get_routes(origin=dep, destination=arr)
        navblue_by_canon = {_navblue_match_key(rt.route_str): rt.number for rt in navblue_matches}

        routes_out = []
        for canon, rrecs in sorted(route_recs.items(), key=lambda kv: -len(kv[1])):
            r_eets = [r.eet_min for r in rrecs if r.eet_min is not None]
            routes_out.append({
                # 표시용 문자열은 그 canonical 그룹 안에서 가장 흔한 원문 표기를 그대로 씀
                "route": max(route_variants[canon].items(), key=lambda kv: kv[1])[0],
                "count": len(rrecs), "pct": round(len(rrecs) / total, 3),
                "distance_nm": _dist(canon),
                "eet_avg_min": round(mean(r_eets)) if r_eets else None,
                "last_flown": max(r.flight_date for r in rrecs),
                "aircraft": _ac_breakdown(rrecs),
                "navblue_number": navblue_by_canon.get(_navblue_match_key(canon)),
            })

        result.append({
            "dep": dep, "arr": arr, "count": total,
            "routes": routes_out,
            "aircraft": _ac_breakdown(recs),
            "by_airline": _by_airline_breakdown(recs),
            "eet_avg_min": round(mean(eets)) if eets else None,
            "eet_min_min": min(eets) if eets else None,
            "eet_max_min": max(eets) if eets else None,
        })
    return result


_AIRLINE_CODE_RE = re.compile(r"^[A-Z]{2,3}")


def _airline_code(callsign: str) -> str:
    """콜사인 앞 ICAO 항공사 코드(2~3글자) 추출 — 예: KAL283 → KAL."""
    m = _AIRLINE_CODE_RE.match(callsign or "")
    return m.group(0) if m else (callsign or "")[:3]


def _airline_breakdown(rows: list[FplArchive]) -> list[dict]:
    """필터 적용 전 전체 결과 기준 항공사별 건수 — 프론트 필터 드롭다운 채우는 용도라
    현재 선택된 항공사 필터와 무관하게 그 기간/구간에 실제로 있던 항공사만 나열함."""
    from collections import defaultdict
    counts: dict[str, int] = defaultdict(int)
    for r in rows:
        counts[_airline_code(r.callsign)] += 1
    return [{"code": code, "count": c} for code, c in sorted(counts.items(), key=lambda kv: -kv[1])]


@router.get("/history/stats")
async def fpl_history_stats(
    dep: Optional[str] = Query(None),
    arr: Optional[str] = Query(None),
    airline: Optional[str] = Query(None, description="콜사인 앞 항공사 코드로 필터(예: KAL), 비우면 전체"),
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
):
    """로컬에 수집돼 있는 항로 제출 이력을 (출발,도착) 쌍별로 집계 —
    어떤 항로를 얼마나 자주 냈는지, 기종 분포, 신고 비행시간 통계.
    airline을 주면 그 항공사가 투입한 것만으로 좁혀서 집계(= 그 항공사가 이 구간에
    어떤 기종을 투입했는지가 그대로 aircraft 배열에 나옴)."""
    dep = (dep or "").strip().upper()
    arr = (arr or "").strip().upper()
    if not dep and not arr:
        return {"error": "dep 또는 arr 중 하나는 필요합니다"}
    try:
        date.fromisoformat(start)
        date.fromisoformat(end)
    except ValueError:
        return {"error": "Invalid date format. Use YYYY-MM-DD."}

    async with FplSessionLocal() as session:
        q = select(FplArchive).where(
            FplArchive.flight_date >= start,
            FplArchive.flight_date <= end,
        )
        if dep:
            q = q.where(FplArchive.dep == dep)
        if arr:
            q = q.where(FplArchive.arr == arr)
        result = await session.execute(q)
        rows = result.scalars().all()

    airlines = _airline_breakdown(rows)

    airline = (airline or "").strip().upper()
    if airline:
        rows = [r for r in rows if _airline_code(r.callsign) == airline]

    return {"start": start, "end": end, "count": len(rows), "groups": _fpl_stats(rows), "airlines": airlines}


@router.get("/history/waypoint-search")
async def fpl_waypoint_search(
    waypoint: str = Query(..., description="검색할 waypoint/fix 이름, 쉼표로 여러 개 주면 전부 지나야 매칭(AND)"),
    airline: Optional[str] = Query(None, description="콜사인 앞 항공사 코드로 필터, 비우면 전체"),
    start: Optional[str] = Query(None, description="YYYY-MM-DD, 비우면 수집된 전체 기간"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD, 비우면 수집된 전체 기간"),
):
    """fpl_archive 전체(dep/arr 제한 없음)에서 특정 waypoint(들)를 실제로 지나간
    ATC 제출 이력을 찾음. 항로 문자열엔 항공로 연결점만 적혀있고 중간 경유 fix는
    생략된 경우가 많아서, 문자열 검색이 아니라 항로를 실제 좌표까지 풀어서
    (resolve_route_tokens) 그 지점을 지나는지 확인함 — 같은 항로 문자열은 한 번만
    풀어서 캐시. waypoint를 쉼표로 여러 개 주면 그 항로가 전부를 지나야만 매칭
    (AND) — "A도 지나고 B도 지나는 항로"처럼 좁혀 찾을 때 씀.

    다만 이건 로컬에 이미 수집돼 있는 구간/기간에서만 찾을 수 있음 — "결과 0건"이
    "한 번도 안 지나감"이 아니라 "아직 그 구간을 수집 안 함"일 수 있어서, coverage에
    지금 검색 대상이 어떤 dep/arr·기간인지를 같이 내려줌.
    """
    wps = [w.strip().upper() for w in waypoint.split(",") if w.strip()]
    if not wps:
        return {"error": "waypoint를 입력하세요"}

    async with FplSessionLocal() as session:
        q = select(FplArchive)
        if start:
            q = q.where(FplArchive.flight_date >= start)
        if end:
            q = q.where(FplArchive.flight_date <= end)
        result = await session.execute(q)
        rows = result.scalars().all()

    airline = (airline or "").strip().upper()
    if airline:
        rows = [r for r in rows if _airline_code(r.callsign) == airline]

    fix_set_cache: dict[str, set[str]] = {}

    def route_fix_set(route: str) -> set[str]:
        if route not in fix_set_cache:
            tokens = route.split()
            try:
                _, passed_fixes, _, _ = store.resolve_route_tokens(tokens)
            except Exception:
                fix_set_cache[route] = set(tokens)
            else:
                fix_set_cache[route] = set(passed_fixes) | set(tokens)
        return fix_set_cache[route]

    def passes_through_all(route: str) -> bool:
        fixes = route_fix_set(route)
        return all(wp in fixes for wp in wps)

    matches = [r for r in rows if r.route and passes_through_all(r.route)]
    matches.sort(key=lambda r: r.flight_date, reverse=True)

    od_pairs = sorted({(r.dep, r.arr) for r in rows})
    dates = [r.flight_date for r in rows]

    return {
        "waypoints": wps,
        "count": len(matches),
        "flights": [
            {
                "ams_rec_pk": r.ams_rec_pk, "flight_date": r.flight_date, "callsign": r.callsign,
                "dep": r.dep, "arr": r.arr, "ac_type": r.ac_type, "eet_min": r.eet_min, "route": r.route,
            }
            for r in matches
        ],
        "coverage": {
            "od_pairs": [{"dep": d, "arr": a} for d, a in od_pairs],
            "date_range": {"start": min(dates), "end": max(dates)} if dates else None,
            "total_archived": len(rows),
        },
    }


# ── 우회입항 시나리오 조회 ──────────────────────────────────────────────────
# ATFM 우회입항 절차 대응용 — "지금 이 순간 흐름관리가 걸리면 몇 편이나 영향권
# (제약 waypoint 필드편)에 있고, 그중 몇 편이 이미 우회 waypoint로 나가고
# 있는지"를 실시간 스냅샷으로 보여줌. fpl_archive(과거 이력)가 아니라 FOIS
# 라이브 스케줄+FPL을 그 자리에서 조회함 — "출발예정"은 정확한 시각이 필요한데
# 아카이브엔 flight_date만 있고 시:분이 없어서 과거 이력으로는 이 판단이 안 됨.

@router.get("/country/list")
async def country_list():
    """국가코드 입력창 옆 '?' 설명용 — 실제 로드된 NAVDATA 기준으로 검색 가능한
    국가만 보여줌(전세계 코드를 다 나열하면 의미 없음)."""
    return {"countries": available_countries(list(store.airports.keys()))}


_scenario_tasks: dict[str, dict] = {}


def _flight_datetime(d: date, hhmm: Optional[str]) -> Optional[datetime]:
    m = _hhmm_to_min(hhmm)
    if m is None:
        return None
    return datetime(d.year, d.month, d.day) + timedelta(minutes=m)


async def _build_reroute_recommendations(constrained_flights: list[dict], diversion_wps: list[str]) -> dict:
    """제약 waypoint로 걸린 편들의 OD페어별로, fpl_archive(전항공사 과거 이력)에서
    우회 waypoint를 실제로 지난 전례를 찾아 추천함. 전례가 없으면 지어내지 않고
    빈 리스트로 둠. 같은 OD로 낸 적 있는 항로가 NAVBLUE 항로DB에도 등록돼 있으면
    그 번호(#N)를 같이 붙임(참고용 — 없다고 못 쓰는 항로는 아님)."""
    od_pairs = sorted({(f["dep"], f["arr"]) for f in constrained_flights if f.get("dep") and f.get("arr")})
    if not od_pairs or not diversion_wps:
        return {}

    async with FplSessionLocal() as session:
        result = await session.execute(select(FplArchive))
        rows = result.scalars().all()

    fix_set_cache: dict[str, set[str]] = {}

    def route_fix_set(route: str) -> set[str]:
        if route not in fix_set_cache:
            tokens = route.split()
            try:
                _, passed_fixes, _, _ = store.resolve_route_tokens(tokens)
            except Exception:
                fix_set_cache[route] = set(tokens)
            else:
                fix_set_cache[route] = set(passed_fixes) | set(tokens)
        return fix_set_cache[route]

    recs: dict[str, list[dict]] = {}
    for dep, arr in od_pairs:
        matches = [
            r for r in rows
            if r.dep == dep and r.arr == arr and r.route
            and all(wp in route_fix_set(r.route) for wp in diversion_wps)
        ]
        # 표시용 route는 원문(raw) 대신 canonical(연결점만 남긴) 형태로 —
        # 같은 항공로를 반복 경유fix 표기해서 낸 것과 안 낸 것이 다른 항로처럼
        # 보이면 안 되니, 애초에 그룹핑 키로 쓰는 canonical 그대로를 노출함
        canon_groups: dict[str, dict] = {}
        for r in matches:
            canon = _canonicalize_route(r.route)
            g = canon_groups.setdefault(canon, {"count": 0, "last_flown": r.flight_date, "airlines": set()})
            g["count"] += 1
            g["airlines"].add(_airline_code(r.callsign))
            if r.flight_date >= g["last_flown"]:
                g["last_flown"] = r.flight_date

        navblue_matches = store.get_routes(origin=dep, destination=arr, fix=",".join(diversion_wps))
        navblue_by_canon = {_navblue_match_key(rt.route_str): rt.number for rt in navblue_matches}

        recs[f"{dep}-{arr}"] = [
            {
                "route": canon, "count": g["count"], "last_flown": g["last_flown"],
                "navblue_number": navblue_by_canon.get(_navblue_match_key(canon)),
                "airlines": sorted(g["airlines"]),
            }
            for canon, g in sorted(canon_groups.items(), key=lambda kv: -kv[1]["count"])
        ]
    return recs


async def _run_scenario_query(
    task_id: str, airports: list[str], direction: str,
    start: datetime, end: datetime, constrained: list[str], diversion: list[str],
) -> None:
    dates: list[date] = []
    d = start.date()
    while d <= end.date():
        dates.append(d)
        d += timedelta(days=1)

    candidates: dict[int, dict] = {}
    async with httpx.AsyncClient(timeout=15) as client:
        for ap in airports:
            for d in dates:
                if _scenario_tasks[task_id].get("cancelled"):
                    _scenario_tasks[task_id]["status"] = "cancelled"
                    return
                try:
                    flights = await _fetch_schedule(
                        client,
                        dep=ap if direction == "dep" else "",
                        arr=ap if direction == "arr" else "",
                        srch_date=d.isoformat(),
                    )
                except Exception:
                    continue
                for f in flights:
                    pk = f.get("ams_rec_pk")
                    if not pk or pk in candidates:
                        continue
                    if f.get("atd"):
                        continue  # 이미 출발함 — "출발예정"이 아님
                    sched_dt = _flight_datetime(d, f.get("etd") or f.get("sched_time"))
                    if sched_dt is None or not (start <= sched_dt <= end):
                        continue
                    candidates[pk] = {**f, "sched_dt": sched_dt}

        _scenario_tasks[task_id].update(total=len(candidates), processed=0)

        constrained_out: list[dict] = []
        diversion_out: list[dict] = []

        async for result in _fetch_fpl_batch(
            client, list(candidates.keys()), lambda: _scenario_tasks[task_id].get("cancelled")
        ):
            pk = result["pk"]
            _scenario_tasks[task_id]["processed"] += 1
            if not result["ok"]:
                continue
            f = candidates[pk]
            dep_icao, dest_icao = result["dep_icao"], result["dest_icao"]
            if not (dep_icao and dest_icao):
                continue
            tokens = [dep_icao, *result["route_tokens"], dest_icao]
            try:
                _, passed_fixes, _, _ = store.resolve_route_tokens(tokens)
            except Exception:
                continue
            fix_set = set(passed_fixes) | set(tokens)
            route_str = " ".join(tokens)
            row = {
                "ams_rec_pk": pk, "callsign": f.get("callsign") or "",
                "dep": f.get("dep") or dep_icao, "arr": f.get("arr") or dest_icao,
                "ac_type": f.get("ac_type"), "sched_dep": f["sched_dt"].isoformat(),
                "route": route_str,
            }
            if constrained and all(wp in fix_set for wp in constrained):
                constrained_out.append(dict(row))
            if diversion and all(wp in fix_set for wp in diversion):
                diversion_out.append(dict(row))

            # 어차피 FPL을 다 받아왔으니 부수적으로 아카이브에도 같이 저장 — 우회입항
            # 시나리오 조회를 쓸 때마다 fpl_archive가 자연히 같이 쌓이게 됨(dedup은
            # upsert가 알아서 처리하므로 이미 있는 편이어도 안전)
            await _bulk_insert_fpl({
                "ams_rec_pk": pk,
                "flight_date": f["sched_dt"].date().isoformat(),
                "callsign": f.get("callsign") or "",
                "dep": f.get("dep") or dep_icao,
                "arr": f.get("arr") or dest_icao,
                "ac_type": f.get("ac_type"),
                "eet_min": _hhmm_to_min(result["eet"]),
                "route": route_str,
                "collected_at": datetime.now(timezone.utc),
            })

        if _scenario_tasks[task_id].get("cancelled"):
            _scenario_tasks[task_id]["status"] = "cancelled"
            return

    constrained_out.sort(key=lambda r: r["sched_dep"])
    diversion_out.sort(key=lambda r: r["sched_dep"])
    recommendations = await _build_reroute_recommendations(constrained_out, diversion)

    _scenario_tasks[task_id].update(
        status="done", constrained_flights=constrained_out,
        diversion_flights=diversion_out, recommendations=recommendations,
    )


@router.post("/scenario/query")
async def scenario_query(
    background_tasks: BackgroundTasks,
    country: Optional[str] = Query(None, description="ISO 국가코드 2글자, airport와 둘 중 하나만"),
    airport: Optional[str] = Query(None, description="공항 ICAO, country와 둘 중 하나만"),
    direction: str = Query(..., description="'dep' 또는 'arr'"),
    start: str = Query(..., description="ISO datetime, 예: 2026-08-15T19:00:00"),
    end: str = Query(..., description="ISO datetime"),
    constrained: str = Query(..., description="제약 waypoint, 콤마로 여러 개면 전부 지나야 매칭"),
    diversion: Optional[str] = Query(None, description="우회 waypoint, 콤마로 여러 개면 전부 지나야 매칭. 비우면 우회통과편/추천은 생략하고 제약경로 통과편만 보여줌"),
):
    """국가 또는 공항 + 방향 + 시간범위로 아직 출발 안 한 전항공사 편을 실시간
    조회해서, 제약/우회 waypoint 통과 여부로 나눠 보여줌. 시간대별로 편수가
    꽤 될 수 있어(전항공사, FPL은 편당 1콜) 백그라운드 task + 폴링으로 처리."""
    if direction not in ("dep", "arr"):
        return {"error": "direction은 'dep' 또는 'arr'이어야 합니다"}
    if bool(country) == bool(airport):
        return {"error": "country 또는 airport 중 하나만 입력하세요"}
    try:
        start_dt = datetime.fromisoformat(start)
        end_dt = datetime.fromisoformat(end)
    except ValueError:
        return {"error": "Invalid datetime format"}
    if end_dt <= start_dt:
        return {"error": "end는 start보다 나중이어야 합니다"}
    if end_dt - start_dt > timedelta(hours=48):
        return {"error": "한 번에 최대 48시간까지 조회할 수 있습니다"}

    if airport:
        airport = airport.strip().upper()
        if airport not in store.airports:
            return {"error": f"알 수 없는 공항: {airport}"}
        airports = [airport]
    else:
        airports = airports_in_country(list(store.airports.keys()), country or "")
        if not airports:
            return {"error": f"NAVDATA에 이 국가코드에 속하는 공항이 없습니다: {country}"}

    constrained_wps = [w.strip().upper() for w in constrained.split(",") if w.strip()]
    diversion_wps = [w.strip().upper() for w in (diversion or "").split(",") if w.strip()]
    if not constrained_wps:
        return {"error": "constrained를 입력하세요"}

    task_id = str(uuid.uuid4())
    _scenario_tasks[task_id] = {
        "status": "running", "total": 0, "processed": 0, "cancelled": False,
        "constrained_flights": [], "diversion_flights": [], "recommendations": {},
    }
    background_tasks.add_task(
        _run_scenario_query, task_id, airports, direction, start_dt, end_dt, constrained_wps, diversion_wps,
    )
    return {"task_id": task_id, "airport_count": len(airports)}


@router.get("/scenario/status/{task_id}")
async def scenario_status(task_id: str):
    t = _scenario_tasks.get(task_id)
    if not t:
        return {"error": "Task not found"}
    return t


# ── 우회 waypoint 추론 ──────────────────────────────────────────────────────
# 제약 waypoint만 주어졌을 때, 우회 waypoint가 뭔지 몰라도 과거 실적으로 추천함.
# OD별로 "평시 항로"(그 OD에서 제일 많이 쓴 canonical 항로)가 이 waypoint를
# 지나는 경우를 찾고, 같은 OD의 다른(소수) 변형 항로들과 토큰 단위로 diff해서
# 실제로 그 자리에 뭘 탔는지 추출 — 자사/타사 구분 없이 전부 집계.
# 임계치·최소표본 없이 나오는 대로 다 보여줌(판단은 사용자가 함) — 다만 실제
# 우회 waypoint는 보통 FIR 경계 지점이라, 후보를 FIR 경계 근접 여부로 정렬은 함
# (숨기지는 않음 — 경계가 아닌 것도 아래에 그대로 다 보임).



def _point_seg_dist_km(plon: float, plat: float, alon: float, alat: float, blon: float, blat: float) -> float:
    """점-선분 최단거리(km) — 위경도를 로컬 평면으로 근사 투영(경도는 위도 코사인
    보정)해서 계산. 경계 근접 여부 판정용이라 이 정도 근사로 충분함."""
    lat0 = math.radians((alat + blat) / 2)
    kx, ky = 111.32 * math.cos(lat0), 110.57
    px, py = plon * kx, plat * ky
    ax, ay = alon * kx, alat * ky
    bx, by = blon * kx, blat * ky
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return math.hypot(px - cx, py - cy)


# 예전엔 인천FIR(RKRR) 하나로 하드코딩했었는데, 이 기능이 인천행 외에 다른 구간
# (예: VVDN발 BUNTA — 베트남/중국 경계) 조회에도 쓰이면서 안 맞게 됨. 지금은 "이
# 제약 waypoint 자체가 어느 나라 FIR 경계에 붙어있는지"를 먼저 찾아서 그 나라
# 기준으로 후보를 판정함 — BUNTA면 베트남(VV) 쪽 경계에 있는 후보를 찾아주는 식.
# 나라 단위 그룹은 ICAO 앞 2글자로 묶음 — 중국처럼 한 나라가 여러 FIR로 쪼개진
# 경우(ZG/ZH/ZS 등)에도 그 나라 소속 FIR이면 전부 같은 그룹으로 묶여서, 그
# 나라를 "빠져나가는" 경계 지점이면 상대편이 어느 나라건 다 잡힘(요청사항:
# 베트남-중국 경계로 한정하지 않고 베트남 쪽 경계면 충분).
def _fir_group(icao: str) -> str:
    return icao[:2]


def _nearest_fir_group(lon: float, lat: float) -> Optional[str]:
    """가장 가까운 FIR을 찾아 그 소속 나라(2글자 그룹)를 반환."""
    best_dist = float("inf")
    best_group: Optional[str] = None
    for feat in _FIR_DATA.get("features", []):
        icao = feat.get("properties", {}).get("icao")
        if not icao:
            continue
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        polys = geom.get("coordinates") or []
        if gtype == "Polygon":
            polys = [polys]
        elif gtype != "MultiPolygon":
            continue
        for poly in polys:
            for ring in poly:
                for i in range(len(ring) - 1):
                    d = _point_seg_dist_km(lon, lat, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1])
                    if d < best_dist:
                        best_dist = d
                        best_group = _fir_group(icao)
    return best_group


def _point_dist_km(alon: float, alat: float, blon: float, blat: float) -> float:
    lat0 = math.radians((alat + blat) / 2)
    kx, ky = 111.32 * math.cos(lat0), 110.57
    return math.hypot((blon - alon) * kx, (blat - alat) * ky)


# 거리 임계치로 "경계 근처인가"를 추측하는 대신, 실제 이탈 항로의 좌표 경로를
# 항공로까지 다 풀어서(store.resolve_route_tokens) 그 나라 공역을 진짜로
# 벗어나는 지점을 직접 찾음 — 그러면 그 지점에 제일 가까운 이름 붙은 fix가
# 자동으로 골라짐(NAKHA/TEBAK처럼 둘 다 국경 근처인 경우 더 정밀한 쪽이 이김,
# VIDEN/PHULU 같은 출발 SID fix는애초에 실제 통과 지점 근처가 아니라서 안 잡힘).
# canonicalize_route가 "NAKHA R474 TEBAK R474 WUY"를 "NAKHA R474 WUY"로
# 합쳐버려도 resolve_route_tokens은 R474 항공로 전체를 다시 펼치므로 TEBAK이
# 좌표까지 그대로 복원됨 — 문자열 레벨에서 사라진 것과 무관하게 동작함.
def _point_in_ring(lon: float, lat: float, ring: list) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat):
            x_at_lat = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x_at_lat:
                inside = not inside
        j = i
    return inside


def _point_in_fir_group(lon: float, lat: float, group: str) -> bool:
    for feat in _FIR_DATA.get("features", []):
        icao = feat.get("properties", {}).get("icao") or ""
        if _fir_group(icao) != group:
            continue
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        polys = geom.get("coordinates") or []
        if gtype == "Polygon":
            polys = [polys]
        elif gtype != "MultiPolygon":
            continue
        for poly in polys:
            if not poly:
                continue
            if _point_in_ring(lon, lat, poly[0]) and not any(
                _point_in_ring(lon, lat, hole) for hole in poly[1:]
            ):
                return True
    return False


def _segment_intersection(
    ax: float, ay: float, bx: float, by: float,
    cx: float, cy: float, dx: float, dy: float,
) -> Optional[tuple[float, float]]:
    """두 선분(a-b, c-d)의 교차점. 평행/비교차면 None."""
    denom = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx)
    if abs(denom) < 1e-12:
        return None
    t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / denom
    u = ((ax - cx) * (ay - by) - (ay - cy) * (ax - bx)) / denom
    if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
        return (ax + t * (bx - ax), ay + t * (by - ay))
    return None


def _group_boundary_crossing(
    ax: float, ay: float, bx: float, by: float, group: str,
) -> Optional[tuple[float, float]]:
    """세그먼트(a->b)가 group 소속 FIR 경계선과 실제로 만나는 첫 교차점을 반환."""
    for feat in _FIR_DATA.get("features", []):
        icao = feat.get("properties", {}).get("icao") or ""
        if _fir_group(icao) != group:
            continue
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")
        polys = geom.get("coordinates") or []
        if gtype == "Polygon":
            polys = [polys]
        elif gtype != "MultiPolygon":
            continue
        for poly in polys:
            for ring in poly:
                for i in range(len(ring) - 1):
                    pt = _segment_intersection(
                        ax, ay, bx, by, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1],
                    )
                    if pt is not None:
                        return pt
    return None


def _find_crossing_fix(
    path: list,
    passed_fixes: dict,
    home_group: str,
) -> Optional[tuple[str, float]]:
    """path(좌표 시퀀스)를 따라가며 home_group 공역을 처음 벗어나는 구간을 찾고,
    그 구간이 실제 경계선과 만나는 정확한 지점(선분 교차)에 제일 가까운 이름
    붙은 fix와 그 거리(km)를 반환. 못 찾으면 None.
    (구간의 끝점을 그냥 "경계"로 쓰면, 그 끝점이 우연히 어느 fix와 좌표가 같다는
    이유만으로 실제로는 더 가까운 다른 fix를 제치고 잘못 뽑히는 문제가 있었음 —
    실측: TEBAK이 실제 경계선에서 3km인데, 구간 끝점과 좌표가 정확히 같다는
    이유만으로 25km 떨어진 LON이 대신 뽑힌 사례.)
    """
    if len(path) < 2:
        return None
    was_inside = _point_in_fir_group(path[0][0], path[0][1], home_group)
    crossing = None
    for i in range(1, len(path)):
        now_inside = _point_in_fir_group(path[i][0], path[i][1], home_group)
        if was_inside and not now_inside:
            a, b = path[i - 1], path[i]
            crossing = _group_boundary_crossing(a[0], a[1], b[0], b[1], home_group) or (b[0], b[1])
            break
        was_inside = now_inside
    if crossing is None:
        return None
    best_fix, best_dist = None, float("inf")
    for name, coord in passed_fixes.items():
        if not coord:
            continue
        d = _point_dist_km(coord[0], coord[1], crossing[0], crossing[1])
        if d < best_dist:
            best_dist, best_fix = d, name
    if best_fix is None:
        return None
    return best_fix, round(best_dist, 1)


def _fix_coord(name: str) -> Optional[tuple[float, float]]:
    cands = store.fix_lookup.get(name)
    if not cands:
        return None
    lon, lat = cands[0][0], cands[0][1]
    return lon, lat


@router.get("/history/infer-diversion")
async def infer_diversion(
    waypoint: str = Query(..., description="제약 waypoint — 이 자리에 실제로 뭘 대신 탔는지 과거 이력에서 추론"),
    dep: Optional[str] = Query(None, description="출발공항 ICAO로 좁히기(선택) — 같은 constrained fix라도 목적지 방면에 따라 우회 fix가 다를 수 있어서"),
    arr: Optional[str] = Query(None, description="도착공항 ICAO로 좁히기(선택)"),
):
    wp = waypoint.strip().upper()
    if not wp:
        return {"error": "waypoint를 입력하세요"}
    dep = (dep or "").strip().upper()
    arr = (arr or "").strip().upper()

    async with FplSessionLocal() as session:
        q = select(FplArchive)
        if dep:
            q = q.where(FplArchive.dep == dep)
        if arr:
            q = q.where(FplArchive.arr == arr)
        rows = (await session.execute(q)).scalars().all()

    by_od: dict[tuple[str, str], dict[str, list[FplArchive]]] = defaultdict(lambda: defaultdict(list))
    for r in rows:
        if not r.route:
            continue
        canon = _canonicalize_route(r.route)
        canon_tokens = canon.split()
        if len(canon_tokens) < 2:
            continue
        # r.dep/r.arr(FOIS 스케줄 메타데이터)이 아니라 항로 문자열 자체의
        # 첫/끝 토큰으로 묶음 — 하나의 편명으로 여러 구간을 도는 화물기 등은
        # 스케줄상 dep이 그 편의 "원래" 출발지로 찍혀서(FplArchive.dep) 실제
        # 이 FPL이 필드된 구간(항로 원문의 실제 출발지)과 다른 경우가 있음.
        # 그대로 두면 전혀 무관한 두 항로가 같은 OD로 묶여 diff가 무의미해짐
        # (실측: LAMEN이 SAPRA 후보로 잘못 나온 사례 — KORD/PANC 라벨인데
        # 항로 원문은 VVNB/ZGGG로 시작).
        route_dep, route_arr = canon_tokens[0], canon_tokens[-1]
        by_od[(route_dep, route_arr)][canon].append(r)

    resolve_cache: dict[str, tuple[list, dict]] = {}

    def resolve_route(route: str) -> tuple[list, dict]:
        if route not in resolve_cache:
            tokens = route.split()
            try:
                raw, passed_fixes, _, _ = store.resolve_route_tokens(tokens)
            except Exception:
                raw, passed_fixes = [], {}
            resolve_cache[route] = (raw, passed_fixes)
        return resolve_cache[route]

    def route_fix_set(route: str) -> set[str]:
        _, passed_fixes = resolve_route(route)
        return set(passed_fixes) | set(route.split())

    # 국경 판정 기준 나라 — 제약 waypoint(wp) 자신이 어느 FIR에 붙어있는지로 정함
    # (예: BUNTA면 베트남(VV) — 인천행 외 다른 구간 조회에도 맞게 하드코딩 대신 동적으로).
    wp_coord = _fix_coord(wp)
    target_group = _nearest_fir_group(wp_coord[0], wp_coord[1]) if wp_coord else None

    candidate_counter: dict[str, int] = defaultdict(int)  # 실제 편수 — 화면 표시용, 컷 없이 그대로
    candidate_weight: dict[str, float] = defaultdict(float)  # 정렬용 가중치(겹침율 반영) — 아래 참고
    candidate_examples: dict[str, list[dict]] = defaultdict(list)
    candidate_airlines: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))  # 후보 전체 기준(예시 5개 제한 없이) 항공사별 건수
    precise_boundary_fixes: set[str] = set()  # 실제 경로가 국경을 넘는 지점에 제일 가까웠던 fix들
    crossing_dist_by_fix: dict[str, float] = {}

    for (od_dep, od_arr), canon_groups in by_od.items():
        # 정상 항로 = 이 OD에서 제일 많이 쓴 canonical 항로
        normal_canon, normal_recs = max(canon_groups.items(), key=lambda kv: len(kv[1]))
        if wp not in route_fix_set(normal_canon):
            continue  # 이 OD는 애초에 평시 항로가 이 waypoint를 안 씀

        normal_tokens = normal_canon.split()
        for other_canon, other_recs in canon_groups.items():
            if other_canon == normal_canon or wp in route_fix_set(other_canon):
                continue  # 평시 항로 그 자체이거나, 여전히 그 waypoint를 지남(이탈 아님)

            other_tokens = other_canon.split()
            # 앞/뒤 토큰만 순서대로 비교하던 예전 방식은, 중간에 SID/STAR 표기
            # 차이 하나(예: BOPTA2A vs DCT)만 있어도 그 지점에서 비교가 멈춰버려
            # 그 뒤에 이어지는 진짜 공통 구간(예: MUGUS)까지 "달라진 구간"으로
            # 잘못 묶여 후보로 오염되는 문제가 있었음(실측: KABAM 제약 조회 시
            # MUGUS가 후보로 잘못 나온 사례 — 두 항로 다 MUGUS를 그대로 지나가는데
            # 그 앞의 SID 표기차 때문에 정렬이 어긋나서 발생). SequenceMatcher로
            # 실제 최장 공통 부분열을 찾아 진짜 달라진 구간만 뽑아냄.
            sm = difflib.SequenceMatcher(None, normal_tokens, other_tokens, autojunk=False)
            common = sum(block.size for block in sm.get_matching_blocks())
            # 컷오프로 자르지 않고 가중치로만 씀 — 완전히 자르면 태풍처럼 크게
            # 돌아간 진짜 이탈(겹침율이 낮게 나옴)까지 같이 날아가 버림. 노이즈는
            # 매번 다른 항로라 흩어지고, 진짜 우회는 같은 대체 항로가 반복되니
            # 가중치 누적으로 자연스럽게 구분되게 함.
            ratio = common / max(len(normal_tokens), len(other_tokens))

            detour: list[str] = []
            for tag, _, _, j1, j2 in sm.get_opcodes():
                if tag != "equal":
                    detour.extend(other_tokens[j1:j2])
            # 항공로명/DCT는 빼고 실제 fix만 후보로
            detour_fixes = [t for t in detour if t not in store.airway_names and t != "DCT"]

            # 이 이탈 항로가 실제로 국경을 넘는 지점을 좌표로 직접 찾음 — canonicalize가
            # 문자열에서 지워버린 fix(예: TEBAK)라도 항공로를 다시 펼치면 복원되므로
            # detour_fixes에 없어도 여기서 후보로 추가될 수 있음.
            crossing_fix_info = None
            if target_group:
                raw_path, passed_fixes_coords = resolve_route(other_canon)
                crossing_fix_info = _find_crossing_fix(raw_path, passed_fixes_coords, target_group)
            if crossing_fix_info:
                crossing_fix, crossing_dist = crossing_fix_info
                precise_boundary_fixes.add(crossing_fix)
                crossing_dist_by_fix[crossing_fix] = min(crossing_dist, crossing_dist_by_fix.get(crossing_fix, crossing_dist))
                if crossing_fix not in detour_fixes:
                    detour_fixes = detour_fixes + [crossing_fix]

            # 이 이탈 항로를 실제로 낸 편들 — "어느 항공사가 언제 어느 구간에서
            # 탔는지"가 없으면 후보 fix가 왜 나왔는지 검증할 방법이 없어서 추가함
            example_airlines: dict[str, int] = defaultdict(int)
            for r in other_recs:
                example_airlines[_airline_code(r.callsign)] += 1
            sample_flights = [
                {"callsign": r.callsign, "flight_date": r.flight_date}
                for r in sorted(other_recs, key=lambda r: r.flight_date, reverse=True)[:5]
            ]

            for f in detour_fixes:
                candidate_counter[f] += len(other_recs)
                candidate_weight[f] += len(other_recs) * ratio
                for al, c in example_airlines.items():
                    candidate_airlines[f][al] += c
                if len(candidate_examples[f]) < 5:
                    candidate_examples[f].append({
                        "dep": od_dep, "arr": od_arr, "count": len(other_recs),
                        "normal_route": normal_canon, "diverted_route": other_canon,
                        "common_ratio": round(ratio, 2),
                        "airlines": [{"code": al, "count": c} for al, c in sorted(example_airlines.items(), key=lambda kv: -kv[1])],
                        "flights": sample_flights,
                    })

    # precise_boundary_fixes = 위 루프에서 실제 경로 좌표로 국경 통과 지점을 찾아
    # 그 지점에 제일 가까웠던 fix들 — 이것만 초록색으로 표시(숨기지는 않음, 정렬만).
    ranked = sorted(
        candidate_counter.items(),
        key=lambda kv: (kv[0] not in precise_boundary_fixes, -candidate_weight[kv[0]]),
    )
    return {
        "waypoint": wp,
        "dep": dep or None,
        "arr": arr or None,
        "candidates": [
            {
                "waypoint": f, "count": c, "examples": candidate_examples[f],
                "fir_boundary": f in precise_boundary_fixes,
                "boundary_dist_km": crossing_dist_by_fix.get(f),
                "airlines": [
                    {"code": al, "count": ac}
                    for al, ac in sorted(candidate_airlines[f].items(), key=lambda kv: -kv[1])
                ],
            }
            for f, c in ranked
        ],
    }
