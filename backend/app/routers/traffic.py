"""
Real-time aircraft traffic via OpenSky Network (free, anonymous).
Server-side 30-second cache to stay within rate limits.
"""
from __future__ import annotations

import math
import time
from typing import Optional

import httpx
from fastapi import APIRouter

from ..data_loader import store

router = APIRouter()

# East Asia bounding box (SE Asia → Northern Japan/Korea)
_BBOX = dict(lamin=10, lamax=55, lomin=100, lomax=150)
# OpenSky 자체 상태벡터 갱신 주기도 대략 10초 안팎(수신국 밀도에 따라 5~15초)이라,
# 이보다 더 짧게 잡아도 실제로 더 새 데이터가 오진 않고 익명 API 요청량만 축남.
# 프론트 폴링 주기(MapView.tsx)도 이 값과 맞춰서 씀
_CACHE_TTL = 10  # seconds

_cache: dict = {'data': None, 'ts': 0.0}

# 사용 활주로 판정용 최근 이력 — 그 순간의 스냅샷 하나만 보면 "우연히 그 순간에
# 잡힌 게 없으면" 활주로가 아예 안 뜨는 문제가 있어서, 최근 30분치를 쌓아두고
# 그 안에서 매칭된 기체를 모아서 판정함. MapView.tsx가 지도 켜져있는 동안 이미
# 10초마다 이 엔드포인트를 폴링하고 있어서, OpenSky에 더 자주 요청을 보내는 게
# 아니라 "이미 받아오던 걸 더 오래 들고 있기만" 하면 되는 구조.
_HISTORY_WINDOW_SEC = 30 * 60
# 순항고도 항적까지 다 쌓으면 메모리만 낭비되고 활주로 매칭엔 절대 안 걸리므로
# (활주로 매칭은 AGL 1500ft 이하만 봄) 저장 단계에서 미리 크게 걸러냄 — 이
# 지역에서 가장 높은 공항(표고)을 감안해도 충분히 넉넉한 상한.
_HISTORY_ALT_CUTOFF_M = 2500
_history: list[tuple[float, list[dict]]] = []


def _record_history(ts: float, aircraft: list[dict]) -> None:
    filtered = [
        a for a in aircraft
        if a['heading'] is not None and a['altitude_m'] is not None
        and (a['on_ground'] or a['altitude_m'] < _HISTORY_ALT_CUTOFF_M)
    ]
    _history.append((ts, filtered))
    cutoff = ts - _HISTORY_WINDOW_SEC
    while _history and _history[0][0] < cutoff:
        _history.pop(0)


def _parse_states(states: list) -> list[dict]:
    result = []
    for s in states:
        lon, lat = s[5], s[6]
        if lon is None or lat is None:
            continue
        callsign = (s[1] or '').strip()
        result.append({
            'icao24':        s[0] or '',
            'callsign':      callsign,
            'lon':           lon,
            'lat':           lat,
            'altitude_m':    s[7],
            'on_ground':     bool(s[8]),
            'velocity_ms':   s[9],
            'heading':       s[10],
            'vertical_rate': s[11],
            'is_jja':        callsign.upper().startswith('JJA'),
        })
    return result


@router.get("/")
async def get_traffic():
    now = time.time()
    if _cache['data'] is not None and now - _cache['ts'] < _CACHE_TTL:
        return _cache['data']

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(
                "https://opensky-network.org/api/states/all",
                params=_BBOX,
            )
        if resp.status_code != 200:
            cached = _cache['data'] or {'aircraft': [], 'count': 0}
            return {**cached, 'error': f'OpenSky {resp.status_code}', 'cached': True}

        states = resp.json().get('states') or []
        aircraft = _parse_states(states)
        result = {
            'aircraft': aircraft,
            'count':    len(aircraft),
            'jja_count': sum(1 for a in aircraft if a['is_jja']),
            'updated':  now,
        }
        _cache['data'] = result
        _cache['ts'] = now
        _record_history(now, aircraft)
        return result

    except Exception as e:
        cached = _cache['data'] or {'aircraft': [], 'count': 0}
        return {**cached, 'error': str(e), 'cached': True}


# ── 실시간 ADS-B 기반 사용 활주로 추정 ────────────────────────────────────────
# 바람만으로 추정하면(wx_minima.py) 실제 ATC 배정(소음절차 등)과 어긋날 수 있어서,
# 이미 받아오고 있는 OpenSky 상태벡터(위치/고도/헤딩/지상여부)를 활주로 임계점
# 좌표(NAVDATA Runways 섹션의 Latitude/Longitude)와 직접 매칭 — 근처에서 활주로
# 방향과 헤딩이 맞는 항공기가 실제로 있으면 그게 지금 쓰이는 활주로.
# 순간 스냅샷 하나만 보면 "우연히 그 찰나에 아무도 안 잡히면" 활주로가 비어
# 보이는 문제가 있어서, 최근 30분 이력(_history) 전체를 훑어 판정함 — 같은
# 기체가 여러 스냅샷에 걸쳐 잡혀도 icao24 기준으로 한 번만 셈.
_NEAR_RUNWAY_KM = 6.0
_HEADING_TOLERANCE_DEG = 30.0
_MAX_AGL_FT_AIRBORNE = 1500.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _heading_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return d if d <= 180 else 360 - d


@router.get("/active-runway/{icao}")
async def get_active_runway(icao: str):
    icao = icao.upper()
    runways = [r for r in store.runways.get(icao, []) if r.lat is not None and r.lon is not None]
    if not runways:
        return {"icao": icao, "runways": [], "note": "활주로 좌표 정보 없음"}

    traffic = await get_traffic()  # 캐시 갱신 트리거 겸, _history에 최소 한 스냅샷은 보장
    ap = store.airports.get(icao)
    ap_elev_ft = (ap.elevation if ap else 0.0) or 0.0

    cutoff = time.time() - _HISTORY_WINDOW_SEC
    tally: dict[str, dict] = {}
    for ts, aircraft in _history:
        if ts < cutoff:
            continue
        for a in aircraft:
            agl_ft = a["altitude_m"] * 3.28084 - ap_elev_ft
            if not a["on_ground"] and agl_ft > _MAX_AGL_FT_AIRBORNE:
                continue

            best: Optional[tuple[str, float]] = None
            for r in runways:
                dist_km = _haversine_km(a["lat"], a["lon"], r.lat, r.lon)
                if dist_km > _NEAR_RUNWAY_KM:
                    continue
                if _heading_diff(a["heading"], r.bearing_m) > _HEADING_TOLERANCE_DEG:
                    continue
                if best is None or dist_km < best[1]:
                    best = (r.id.replace("RW", ""), dist_km)

            if not best:
                continue
            entry = tally.setdefault(best[0], {"icao24s": set(), "callsigns": [], "last_seen": 0.0})
            if a["icao24"] not in entry["icao24s"]:
                entry["icao24s"].add(a["icao24"])
                if a["callsign"]:
                    entry["callsigns"].append(a["callsign"])
            if ts > entry["last_seen"]:
                entry["last_seen"] = ts

    ranked = sorted(tally.items(), key=lambda kv: (-len(kv[1]["icao24s"]), -kv[1]["last_seen"]))
    return {
        "icao": icao,
        "runways": [
            {
                "id": k,
                "count": len(v["icao24s"]),
                "callsigns": v["callsigns"][:5],
                "last_seen": v["last_seen"],
            }
            for k, v in ranked
        ],
        "window_sec": _HISTORY_WINDOW_SEC,
        "updated": traffic.get("updated"),
    }
