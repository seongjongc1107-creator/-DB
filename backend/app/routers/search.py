import re
from fastapi import APIRouter, Query
from ..data_loader import store

router = APIRouter()

_TOKEN_SPLIT_RE = re.compile(r'[\s\-#/]+')


@router.get("")
def search(q: str = Query(..., min_length=1)):
    q_up = q.upper().strip()
    results = []

    # Route number search: "RKSI VVCR 27", "RKSI-VVCR#27", "RKSI 27", "#27" 등.
    # 토큰 단위로 쪼개서 판단 — "REBIT2H"처럼 숫자가 섞인 한 단어는 항로 번호로
    # 오인하지 않도록 독립된 순수 숫자 토큰만 번호로 인정.
    tokens = [t for t in _TOKEN_SPLIT_RE.split(q_up) if t]
    icao_tokens = [t for t in tokens if len(t) == 4 and t.isalpha() and t in store.airports]
    number_tokens = [int(t) for t in tokens if t.isdigit()]
    if number_tokens:
        number = number_tokens[0]
        candidates = [r for r in store.routes if r.number == number]
        if len(icao_tokens) >= 2:
            origin, dest = icao_tokens[0], icao_tokens[1]
            candidates = [r for r in candidates if r.origin == origin and r.destination == dest]
        elif len(icao_tokens) == 1:
            candidates = [r for r in candidates if icao_tokens[0] in (r.origin, r.destination)]
        limit = 20 if icao_tokens else 8
        for r in candidates[:limit]:
            results.append({
                "type": "route",
                "id": str(r.id),
                "name": f"{r.origin} → {r.destination} #{r.number}",
                "lat": None,
                "lon": None,
                "description": f"{r.distance} NM · {r.route_str[:70]}",
                "route": {
                    "id": r.id,
                    "origin": r.origin,
                    "destination": r.destination,
                    "number": r.number,
                    "route": r.route_str,
                    "distance": r.distance,
                    "disabled": r.disabled,
                    "aircraft": r.aircraft,
                },
            })

    # Airports
    for ap_id, ap in store.airports.items():
        if q_up in ap_id or q_up in ap.name.upper():
            results.append({
                "type": "airport",
                "id": ap_id,
                "name": f"{ap_id} {ap.name}".strip(),
                "lat": ap.lat,
                "lon": ap.lon,
                "description": f"Airport",
            })

    # Airways (exact prefix match first)
    aw_exact = sorted(
        [n for n in store.airway_names if n.upper().startswith(q_up)],
        key=lambda x: (x != q_up, x),
    )
    for aw_name in aw_exact[:20]:
        route_count = len(store.route_by_token.get(aw_name, []))
        results.append({
            "type": "airway",
            "id": aw_name,
            "name": aw_name,
            "lat": None,
            "lon": None,
            "description": f"Airway · {route_count} routes using it",
        })

    # Waypoints (prefix match, cap at 15)
    wp_hits = 0
    for wp_id, wp in store.waypoints.items():
        if wp_hits >= 15:
            break
        if wp_id.upper().startswith(q_up):
            results.append({
                "type": "waypoint",
                "id": wp_id,
                "name": wp_id,
                "lat": wp.lat,
                "lon": wp.lon,
                "description": "Waypoint",
            })
            wp_hits += 1

    return results[:50]
