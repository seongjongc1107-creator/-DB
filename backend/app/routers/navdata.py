from typing import Optional
from fastapi import APIRouter, Query
from ..data_loader import store

# 동아시아 주요 FIR 경계 (ICAO 기반 근사치, 시각화 목적)
_FIR_DATA = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"icao": "RKRR", "name": "Incheon FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[122.0,40.0],[132.0,40.0],[135.0,37.0],[135.0,33.0],[130.0,32.0],[124.0,32.0],[122.0,34.0],[122.0,40.0]]]},
        },
        {
            "type": "Feature",
            "properties": {"icao": "RJJF", "name": "Fukuoka FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[124.0,24.0],[135.0,24.0],[148.0,28.0],[148.0,40.0],[135.0,40.0],[132.0,40.0],[135.0,37.0],[135.0,33.0],[130.0,32.0],[124.0,32.0],[124.0,24.0]]]},
        },
        {
            "type": "Feature",
            "properties": {"icao": "RJJJ", "name": "Tokyo FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[132.0,40.0],[148.0,40.0],[160.0,50.0],[160.0,60.0],[145.0,60.0],[135.0,50.0],[132.0,45.0],[132.0,40.0]]]},
        },
        {
            "type": "Feature",
            "properties": {"icao": "ZSHA", "name": "Shanghai FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[110.0,26.0],[122.0,26.0],[124.0,32.0],[122.0,34.0],[122.0,40.0],[110.0,40.0],[110.0,26.0]]]},
        },
        {
            "type": "Feature",
            "properties": {"icao": "ZJSA", "name": "Sanya FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[107.0,10.0],[122.0,10.0],[122.0,26.0],[110.0,26.0],[107.0,22.0],[107.0,10.0]]]},
        },
        {
            "type": "Feature",
            "properties": {"icao": "RPHI", "name": "Manila FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[116.0,4.0],[130.0,4.0],[136.0,10.0],[136.0,22.0],[124.0,24.0],[122.0,18.0],[122.0,10.0],[116.0,4.0]]]},
        },
        {
            "type": "Feature",
            "properties": {"icao": "VHHK", "name": "Hongkong FIR"},
            "geometry": {"type": "Polygon", "coordinates": [[[107.0,10.0],[116.0,10.0],[116.0,22.0],[107.0,22.0],[107.0,10.0]]]},
        },
    ],
}

router = APIRouter()


@router.get("/fir")
def get_fir():
    return _FIR_DATA


@router.get("/airports")
def get_airports():
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [ap.lon, ap.lat]},
            "properties": {"id": ap.id, "name": ap.name, "elevation": ap.elevation},
        }
        for ap in store.airports.values()
    ]
    return {"type": "FeatureCollection", "features": features}


@router.get("/airways/{name}")
def get_airway(name: str):
    return store.airway_geojson(name)


@router.get("/airways/{name}/routes")
def get_airway_routes(name: str):
    """Routes that use this airway."""
    routes = store.get_routes(fix=name)
    return {
        "count": len(routes),
        "routes": [
            {
                "id": r.id,
                "origin": r.origin,
                "destination": r.destination,
                "number": r.number,
                "route": r.route_str,
                "distance": r.distance,
            }
            for r in routes
        ],
    }


@router.get("/waypoints")
def get_waypoints(
    minLat: Optional[float] = None,
    maxLat: Optional[float] = None,
    minLon: Optional[float] = None,
    maxLon: Optional[float] = None,
    limit: int = Query(500, le=2000),
):
    wps = list(store.waypoints.values())
    if all(x is not None for x in [minLat, maxLat, minLon, maxLon]):
        wps = [w for w in wps if minLat <= w.lat <= maxLat and minLon <= w.lon <= maxLon]
    wps = wps[:limit]
    features = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [w.lon, w.lat]},
            "properties": {"id": w.id, "terminal": w.terminal},
        }
        for w in wps
    ]
    return {"type": "FeatureCollection", "features": features}
