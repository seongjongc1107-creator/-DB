import random
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Query

from ..data_loader import store

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
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(FOIS_DEP_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
    except Exception as e:
        return {"date": srch_date, "dep": dep, "arr": arr, "count": 0, "flights": [], "error": str(e)}

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

    return {"date": srch_date, "dep": dep or None, "arr": arr or None, "count": len(flights), "flights": flights}


# ── 실제 제출 FPL 원문 → 항로 파싱 ────────────────────────────────────────

_FPL_BODY_RE = re.compile(r"\(FPL-(.*)\)", re.S)
# ICAO FPL 항로 필드는 fix 뒤에 "/N0497F400"(속도+고도 변경) 같은 접미사가 바로
# 붙는 경우가 있음 — 항로 토큰 자체는 아니라서 떼어내야 우리 파서가 fix로 인식함
_FPL_LEVEL_SUFFIX_RE = re.compile(r"^([A-Z0-9]+)/[MN]\d{3,4}[FSA]\d{3,4}$")


def _parse_fpl_route(raw_text: str) -> tuple[str, str, list[str]]:
    """ICAO FPL 원문에서 (출발공항, 도착공항, 항로 토큰열)을 뽑아냄.

    FPL 필드는 '-'로 구분되는데, 순서대로 [콜사인, 규칙/기종, 기종/후류, 장비,
    출발공항+시각, 순항속도+항로, 도착공항+EET(+교체공항), 기타] — 5번째(index 4)가
    출발, 6번째(index 5)가 항로, 7번째(index 6)가 도착.
    """
    flat = re.sub(r"\s+", " ", raw_text).strip()
    m = _FPL_BODY_RE.search(flat)
    if not m:
        raise ValueError("FPL 필드를 찾을 수 없음")
    fields = m.group(1).split("-")
    if len(fields) < 7:
        raise ValueError("FPL 필드 형식이 예상과 다름")

    dep_icao = fields[4].strip()[:4]
    dest_icao = fields[6].strip().split()[0][:4] if fields[6].strip() else ""

    route_tokens = fields[5].strip().split()
    if route_tokens:
        route_tokens = route_tokens[1:]  # 맨 앞은 순항속도/고도(예: N0495F400) — 항로 토큰 아님

    cleaned: list[str] = []
    for t in route_tokens:
        mm = _FPL_LEVEL_SUFFIX_RE.match(t)
        cleaned.append(mm.group(1) if mm else t)
    return dep_icao, dest_icao, cleaned


@router.get("/route")
async def get_fpl_route(ams_rec_pk: int = Query(...)):
    """특정 편이 실제로 신청한 ATC 비행계획(FPL) 원문을 받아 항로 좌표로 파싱 —
    지도 오버레이용. 저장된 Navblue 항로 DB와 무관하게, 그 편이 오늘 진짜 낸 항로."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(FOIS_FPL_URL, params={"amsRecPk": ams_rec_pk, "dummy": _dummy()})
            resp.raise_for_status()
            data = resp.json()
        records = data.get("records") or []
        if not records:
            return {"error": "FPL 데이터를 찾을 수 없음"}
        raw = records[0].get("amsOriginal") or ""
        dep_icao, dest_icao, route_tokens = _parse_fpl_route(raw)
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
        "route_raw": raw,
    }
