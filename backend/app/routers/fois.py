import asyncio
import random
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from statistics import mean
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Query
from sqlalchemy import select

from ..data_loader import store, _gc_km
from ..fpl_db import FplSessionLocal, make_fpl_upsert
from ..fpl_models import FplArchive

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

            for f in flights:
                pk = f.get("ams_rec_pk")
                if not pk:
                    continue
                if pk in have:
                    _fpl_tasks[task_id]["skipped"] += 1
                    continue
                if _fpl_tasks[task_id].get("cancelled"):
                    _fpl_tasks[task_id]["status"] = "cancelled"
                    return
                try:
                    raw = await _fetch_fpl_raw(client, pk)
                    dep_icao, dest_icao, route_tokens, eet = _parse_fpl_route(raw)
                    route_str = " ".join([dep_icao, *route_tokens, dest_icao]) if dep_icao and dest_icao else None
                    await _bulk_insert_fpl({
                        "ams_rec_pk": pk,
                        "flight_date": d.isoformat(),
                        "callsign": f["callsign"] or "",
                        "dep": f.get("dep") or dep_icao or "",
                        "arr": f.get("arr") or dest_icao or "",
                        "ac_type": f.get("ac_type"),
                        "eet_min": _hhmm_to_min(eet),
                        "route": route_str,
                        "collected_at": datetime.now(timezone.utc),
                    })
                    _fpl_tasks[task_id]["collected"] += 1
                except Exception:
                    _fpl_tasks[task_id]["failed"] += 1
                # FPL은 편당 1콜이라(N+1) 짧게라도 페이싱을 둬야 FOIS에 부담이 안 감
                await asyncio.sleep(0.2)

            _fpl_tasks[task_id]["processed_days"] += 1

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

        routes_out = [
            {
                # 표시용 문자열은 그 canonical 그룹 안에서 가장 흔한 원문 표기를 그대로 씀
                "route": max(route_variants[canon].items(), key=lambda kv: kv[1])[0],
                "count": len(rrecs), "pct": round(len(rrecs) / total, 3),
                "distance_nm": _dist(canon),
                "aircraft": _ac_breakdown(rrecs),
            }
            for canon, rrecs in sorted(route_recs.items(), key=lambda kv: -len(kv[1]))
        ]

        result.append({
            "dep": dep, "arr": arr, "count": total,
            "routes": routes_out,
            "aircraft": _ac_breakdown(recs),
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
