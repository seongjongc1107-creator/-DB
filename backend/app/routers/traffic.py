"""
Real-time aircraft traffic via OpenSky Network (free, anonymous).
Server-side 30-second cache to stay within rate limits.
"""
from __future__ import annotations

import time
from typing import Optional

import httpx
from fastapi import APIRouter

router = APIRouter()

# East Asia bounding box (SE Asia → Northern Japan/Korea)
_BBOX = dict(lamin=10, lamax=55, lomin=100, lomax=150)
_CACHE_TTL = 30  # seconds

_cache: dict = {'data': None, 'ts': 0.0}


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
        return result

    except Exception as e:
        cached = _cache['data'] or {'aircraft': [], 'count': 0}
        return {**cached, 'error': str(e), 'cached': True}
