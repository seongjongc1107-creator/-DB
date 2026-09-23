"""
Real-time aircraft traffic via OpenSky Network (free, anonymous).
Server-side 30-second cache to stay within rate limits.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Optional

import httpx
from fastapi import APIRouter

from ..data_loader import store

logger = logging.getLogger(__name__)

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
# 그 안에서 매칭된 기체를 모아서 판정함. 프론트가 지도를 켜놓고 있을 때만 쌓이는
# 구조였으면 아무도 안 보고 있는 동안은 이력에 공백이 생기므로, 서버 자체가
# start_traffic_poller()로 독립적으로 계속 채워서 항상 실제 최근 30분을 보장함.
_HISTORY_WINDOW_SEC = 30 * 60
# 지상(on_ground)에 있는 기체만 저장 — 활주로 매칭도 지상 기체만 쓰기로 했으므로
# (아래 get_active_runway 설명 참고) 공중 항적은 애초에 저장할 필요가 없음.
_history: list[tuple[float, list[dict]]] = []


def _record_history(ts: float, aircraft: list[dict]) -> None:
    # on_ground 기체는 altitude_m(기압고도)이 아예 None으로 오는 경우가 흔함
    # (지상에선 ADS-B가 기압고도를 안 보내는 기체가 많음) — 매칭엔 고도가 필요
    # 없으니 여기서 걸러내면 지상 기체 대부분이 통째로 빠지는 버그가 됨
    filtered = [
        a for a in aircraft
        if a['on_ground'] and a['heading'] is not None
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
#
# 지상(on_ground) 기체만 매칭 대상으로 씀 — 공중에 떠있는 파이널 어프로치 항적까지
# 포함시켰더니, 평행활주로(예: RJFF 16L/16R, 임계점 간 거리 210m)에서 잘못된 쪽으로
# 오배정되는 문제가 실제로 있었음. 두 활주로가 방향(heading)은 똑같고 거리도 멀리서
# 보면 6km 반경 안에서 210m 차이는 거의 무의미해서, 아직 착륙 안 한 항적으로는
# "가장 가까운 임계점" 판정이 사실상 도박에 가까움. 반면 실제로 활주로 위를 구르고
# 있는(착륙 롤아웃/이륙활주) 기체는 GPS 위치가 그 활주로 중심선 위에 정확히 찍히므로
# 210m 정도 떨어진 평행활주로와도 확실히 구분됨 — 그래서 "이미 내렸거나(롤아웃 중)
# 이륙 활주 중인" 지상 기체만 보고, 아직 안 내린 어프로치 중 항적은 아예 안 봄.
_NEAR_RUNWAY_KM = 6.0
_HEADING_TOLERANCE_DEG = 30.0


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

    cutoff = time.time() - _HISTORY_WINDOW_SEC
    tally: dict[str, dict] = {}
    for ts, aircraft in _history:
        if ts < cutoff:
            continue
        for a in aircraft:
            # _record_history가 이미 on_ground만 걸러서 저장하지만, 과거 이력엔
            # (배포 직후 등) 옛 필터로 쌓인 공중 항적이 남아있을 수 있어 한 번 더 확인
            if not a["on_ground"]:
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


# ── 백그라운드 폴러 ───────────────────────────────────────────────────────────
# 예전엔 프론트(MapView.tsx)가 지도를 켜놓은 동안 폴링하는 걸 그대로 재사용해서
# _history를 채웠는데, 그러면 아무도 안 보고 있는 시간대엔 이력에 공백이 생겨서
# "최근 30분"이 사실은 "최근 30분 중 누군가 지도를 보고 있던 시간"이 돼버림.
# 서버 기동 시 이 폴러를 띄워서 프론트 사용 여부와 무관하게 항상 채워지게 함
# (get_traffic() 자체가 _CACHE_TTL로 이미 요청 빈도를 제한하므로, 프론트도 계속
# 폴링해도 OpenSky 호출이 중복으로 늘진 않음 — 어차피 캐시를 같이 씀).
_poller_task: Optional[asyncio.Task] = None


async def _poll_loop() -> None:
    while True:
        try:
            await get_traffic()
        except Exception:
            logger.exception("백그라운드 traffic 폴링 실패")
        await asyncio.sleep(_CACHE_TTL)


def start_traffic_poller() -> None:
    global _poller_task
    if _poller_task is not None:
        return
    _poller_task = asyncio.create_task(_poll_loop())
