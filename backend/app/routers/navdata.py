from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from ..data_loader import store

_TYPE_LABEL = {
    'I': 'ILS', 'L': 'LPV', 'R': 'RNP', 'V': 'VOR',
    'N': 'NDB', 'G': 'GLS', 'B': 'LOC BC', 'S': 'LDA', 'D': 'VOR/DME',
}

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
            # 일본은 본토 전역이 단일 FIR(후쿠오카 FIR)이며 ICAO 코드는 RJJJ.
            # "RJJF"·"Tokyo FIR"는 실존하지 않는 코드/명칭이라 하나로 합침.
            "type": "Feature",
            "properties": {"icao": "RJJJ", "name": "Fukuoka FIR"},
            "geometry": {"type": "MultiPolygon", "coordinates": [
                [[[124.0,24.0],[135.0,24.0],[148.0,28.0],[148.0,40.0],[135.0,40.0],[132.0,40.0],[135.0,37.0],[135.0,33.0],[130.0,32.0],[124.0,32.0],[124.0,24.0]]],
                [[[132.0,40.0],[148.0,40.0],[160.0,50.0],[160.0,60.0],[145.0,60.0],[135.0,50.0],[132.0,45.0],[132.0,40.0]]],
            ]},
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


@router.get("/airport/{icao}")
def get_airport_info(icao: str):
    icao = icao.upper()
    ap = store.airports.get(icao)
    if not ap:
        raise HTTPException(status_code=404, detail="Airport not found in navdata")

    runways = [
        {
            "id": r.id,
            "bearing_m": r.bearing_m,
            "length_ft": r.length_ft,
            "width_ft": r.width_ft,
            "elevation_ft": r.elevation_ft,
            "threshold_disp_ft": r.threshold_disp_ft,
        }
        for r in sorted(store.runways.get(icao, []), key=lambda r: r.id)
    ]

    # ILS lookup: runway label (e.g. "33L") → ILS info
    ils_by_rwy: dict = {}
    for ils in store.ils_by_airport.get(icao, []):
        rwy_label = ils.runway.lstrip('RW').lstrip('0') or ils.runway.lstrip('RW')
        # keep leading zero for single-digit runways (e.g. "06" not "6")
        rwy_label = ils.runway[2:] if ils.runway.startswith('RW') else ils.runway
        ils_by_rwy[rwy_label] = {
            "id": ils.id,
            "frequency": ils.frequency,
            "bearing_m": ils.bearing_m,
            "category": ils.category,
        }

    approaches = [
        {
            "procedure": a.procedure,
            "type": _TYPE_LABEL.get(a.type_code, a.type_code),
            "type_code": a.type_code,
            "runway": a.runway,
            "rnp_ar": a.rnp_ar,
            "ils": ils_by_rwy.get(a.runway),
        }
        for a in store.approaches_by_airport.get(icao, [])
    ]

    return {
        "icao": icao,
        "name": ap.name,
        "lat": ap.lat,
        "lon": ap.lon,
        "elevation_ft": ap.elevation,
        "runways": runways,
        "approaches": approaches,
    }


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
