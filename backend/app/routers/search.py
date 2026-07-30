from fastapi import APIRouter, Query
from ..data_loader import store

router = APIRouter()


@router.get("")
def search(q: str = Query(..., min_length=1)):
    q_up = q.upper().strip()
    results = []

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

    # Waypoints/Navaids (prefix match, cap at 15) — fix_lookup은 waypoint(5글자
    # RNAV 지점)뿐 아니라 NDB/VOR 같은 3글자 navaid, airway에 내장된 중간 fix,
    # 절차 종점까지 다 포함하는 전체 인덱스라 여기서 찾아야 항로 리졸버가 실제로
    # 쓰는 지점과 검색 결과가 일치함 (store.waypoints만 보면 NDB/navaid가 통째로 빠짐).
    # airway 이름과 실제 navaid/fix 이름이 우연히 같을 수 있음(예: "APU"는 항공로
    # 이름이면서 동시에 그 항공로가 지나는 VOR 이름이기도 함) — 서로 다른 실체라
    # airway_names는 걸러내지 않음. 공항은 위에서 이미 별도로 다뤘으니 제외.
    wp_matches = [
        fix_id for fix_id in store.fix_lookup
        if fix_id.upper().startswith(q_up) and fix_id not in store.airports
    ]
    # 정확히 일치 > 짧은 이름 우선 — 안 그러면 "APU" 자체보다 "APUGO" 같은
    # 접두어 매칭이 먼저 채워져서 정작 찾던 짧은 navaid가 15개 제한에 밀려남.
    wp_matches.sort(key=lambda x: (x != q_up, len(x), x))
    for fix_id in wp_matches[:15]:
        lon, lat = store.fix_lookup[fix_id][0]
        kind = "Waypoint" if fix_id in store.waypoints else "NDB" if fix_id in store.ndbs else "Navaid"
        results.append({
            "type": "waypoint",
            "id": fix_id,
            "name": fix_id,
            "lat": lat,
            "lon": lon,
            "description": kind,
        })

    return results[:50]
