from typing import Optional
from fastapi import APIRouter, Query
from ..data_loader import store

router = APIRouter()


def _route_meta(r):
    return {
        "id": r.id,
        "origin": r.origin,
        "destination": r.destination,
        "number": r.number,
        "route": r.route_str,
        "distance": r.distance,
        "disabled": r.disabled,
        "aircraft": r.aircraft,
        "comments": r.comments,
    }


def _waypoints_from_fixes(passed_fixes):
    """이 항로가 실제로 지나는 named waypoint 목록 (출발/도착 공항 제외).

    passed_fixes는 {fix명: 이 항로에서 실제로 쓰인 [lon, lat]} — 동명이인 fix가
    전 세계에 여러 개 있어도 store.waypoints 사전 재조회 없이 항상 정확한 위치를 씀.
    """
    return [
        {"id": fix, "lon": coord[0], "lat": coord[1]}
        for fix, coord in sorted(passed_fixes.items())
    ]


def _route_feature(r):
    if len(r.coordinates) < 2:
        return None
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": r.coordinates},
        "properties": {**_route_meta(r), "waypoints": _waypoints_from_fixes(r.passed_fixes)},
    }


@router.get("")
def list_routes(
    origin: Optional[str] = None,
    destination: Optional[str] = None,
    fix: Optional[str] = Query(None, description="Comma-separated fix/airway names (AND)"),
):
    routes = store.get_routes(origin=origin, destination=destination, fix=fix)
    return {"count": len(routes), "routes": [_route_meta(r) for r in routes]}


@router.get("/geometry")
def route_geometry(
    origin: Optional[str] = None,
    destination: Optional[str] = None,
    fix: Optional[str] = Query(None, description="Comma-separated fix/airway names (AND)"),
    ids: Optional[str] = Query(None, description="Comma-separated route IDs"),
):
    id_list = None
    if ids:
        id_list = [int(x) for x in ids.split(",") if x.strip().isdigit()]

    routes = store.get_routes(
        origin=origin, destination=destination, fix=fix, ids=id_list
    )
    features = [f for r in routes if (f := _route_feature(r)) is not None]
    return {"type": "FeatureCollection", "features": features}


@router.get("/alternatives")
def get_alternatives(
    od_pairs: str = Query(..., description="Comma-separated ORIGIN-DEST pairs, e.g. RKSI-RCTP,RKSI-RJTT"),
    exclude_ids: Optional[str] = Query(None, description="Comma-separated route IDs to exclude"),
):
    """같은 OD 쌍의 대체 항로 GeoJSON 반환 (영향 항로 제외)"""
    excluded = set()
    if exclude_ids:
        excluded = {int(x) for x in exclude_ids.split(",") if x.strip().isdigit()}

    features = []
    for pair in od_pairs.split(","):
        parts = pair.strip().split("-", 1)
        if len(parts) != 2:
            continue
        origin, dest = parts
        for r in store.get_routes(origin=origin, destination=dest):
            if r.id not in excluded:
                if (f := _route_feature(r)) is not None:
                    features.append(f)

    return {"type": "FeatureCollection", "features": features}


@router.get("/parse")
def parse_route_string(route: str = Query(..., description="공백으로 구분된 항로 문자열, 예: RKSI Y711 GTC DCT RKSS")):
    """SkyVector처럼 직접 입력한 항로 문자열을 그 자리에서 파싱해 geometry로 반환 (저장된 항로 DB 조회 아님)."""
    tokens = route.strip().upper().split()
    coords, passed_fixes, airway_gaps = store.resolve_route_tokens(tokens)
    if len(coords) < 2:
        return {"type": "FeatureCollection", "features": [], "unresolved": tokens, "airway_gaps": []}
    resolved_names = set(passed_fixes) | {tokens[0], tokens[-1]}
    unresolved = [t for t in tokens if t not in resolved_names and t not in store.airway_names
                  and t != "DCT" and store._lookup_procedure(t) is None]
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"route": route.strip().upper(), "waypoints": _waypoints_from_fixes(passed_fixes)},
        }],
        "airway_gaps": airway_gaps,
        "unresolved": unresolved,
    }


@router.get("/origins")
def list_origins():
    return sorted(store.route_by_origin.keys())


@router.get("/destinations")
def list_destinations():
    return sorted(store.route_by_dest.keys())
