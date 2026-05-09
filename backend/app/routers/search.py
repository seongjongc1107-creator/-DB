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
