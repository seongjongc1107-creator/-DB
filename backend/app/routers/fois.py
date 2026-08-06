import random
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Query

router = APIRouter()

FOIS_DEP_URL = "https://ubikais.fois.go.kr:8030/sysUbikais/biz/fpl/selectDep.fois"

KST = timezone(timedelta(hours=9))


def _today_kst() -> str:
    return datetime.now(KST).strftime("%Y-%m-%d")


@router.get("/schedule")
async def get_schedule(
    dep: str = Query(..., description="출발 공항 ICAO"),
    arr: str = Query(..., description="도착 공항 ICAO"),
    date: Optional[str] = Query(None, description="YYYY-MM-DD, 기본값 오늘(KST)"),
):
    """국토부 FOIS(Flight Operation Information System)에 실제로 제출된 ATC 비행계획
    기준 출발 스케줄. 우리 항로 DB에 이 출발/도착 공항 쌍이 있는지 여부와 무관하게,
    항공사 상관없이 그날 그 구간으로 실제 신청된 편을 그대로 보여줌."""
    srch_date = date or _today_kst()
    srch_datesh = srch_date.replace("-", "")
    dep = dep.strip().upper()
    arr = arr.strip().upper()
    params = {
        "downloadYn": "1",
        "srchDate": srch_date,
        "srchDatesh": srch_datesh,
        "srchAl": "",
        "srchFln": "",
        "srchDep": dep,
        "srchArr": arr,
        "dummy": str(random.randint(10_000_000, 99_999_999)),
        "cmd": "get-records",
        "limit": "200",
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
    flights.sort(key=lambda f: f["etd"] or f["sched_time"] or "9999")

    return {"date": srch_date, "dep": dep, "arr": arr, "count": len(flights), "flights": flights}
