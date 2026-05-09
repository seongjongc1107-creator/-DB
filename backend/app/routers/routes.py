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
    }


def _route_feature(r):
    if len(r.coordinates) < 2:
        return None
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": r.coordinates},
        "properties": _route_meta(r),
    }


@router.get("")
def list_routes(
    origin: Optional[str] = None,
    destination: Optional[str] = None,
    fix: Optional[str] = None,
):
    routes = store.get_routes(origin=origin, destination=destination, fix=fix)
    return {"count": len(routes), "routes": [_route_meta(r) for r in routes]}


@router.get("/geometry")
def route_geometry(
    origin: Optional[str] = None,
    destination: Optional[str] = None,
    fix: Optional[str] = None,
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


@router.get("/origins")
def list_origins():
    return sorted(store.route_by_origin.keys())


@router.get("/destinations")
def list_destinations():
    return sorted(store.route_by_dest.keys())
