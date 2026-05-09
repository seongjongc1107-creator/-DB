import xml.etree.ElementTree as ET
import httpx
from fastapi import APIRouter

router = APIRouter()

GDACS_RSS_URL = "https://www.gdacs.org/xml/rss.xml"
GDACS_NS = "http://www.gdacs.org"
GEO_NS = "http://www.w3.org/2003/01/geo/wgs84_pos#"

ALERT_COLOR = {"Green": "#FCD34D", "Orange": "#F97316", "Red": "#EF4444"}
DEFAULT_RADIUS = {"Green": 75, "Orange": 150, "Red": 250}

# 가상 태풍 트랙 — 서태평양 북상 후 한반도 접근 (6시간 간격, 13스텝)
MOCK_TRACK = [
    {"step": 0,  "time": "D+0 00Z", "lat": 14.0, "lon": 138.0, "wind_kt": 45,  "alert": "Green"},
    {"step": 1,  "time": "D+0 06Z", "lat": 15.5, "lon": 136.5, "wind_kt": 55,  "alert": "Green"},
    {"step": 2,  "time": "D+0 12Z", "lat": 17.0, "lon": 135.0, "wind_kt": 65,  "alert": "Orange"},
    {"step": 3,  "time": "D+0 18Z", "lat": 19.0, "lon": 133.5, "wind_kt": 75,  "alert": "Orange"},
    {"step": 4,  "time": "D+1 00Z", "lat": 21.0, "lon": 132.0, "wind_kt": 85,  "alert": "Orange"},
    {"step": 5,  "time": "D+1 06Z", "lat": 23.0, "lon": 130.5, "wind_kt": 92,  "alert": "Red"},
    {"step": 6,  "time": "D+1 12Z", "lat": 25.0, "lon": 129.0, "wind_kt": 100, "alert": "Red"},
    {"step": 7,  "time": "D+1 18Z", "lat": 27.0, "lon": 128.0, "wind_kt": 105, "alert": "Red"},
    {"step": 8,  "time": "D+2 00Z", "lat": 29.5, "lon": 127.0, "wind_kt": 98,  "alert": "Red"},
    {"step": 9,  "time": "D+2 06Z", "lat": 31.5, "lon": 127.5, "wind_kt": 85,  "alert": "Orange"},
    {"step": 10, "time": "D+2 12Z", "lat": 33.5, "lon": 129.0, "wind_kt": 70,  "alert": "Orange"},
    {"step": 11, "time": "D+2 18Z", "lat": 35.5, "lon": 132.0, "wind_kt": 55,  "alert": "Orange"},
    {"step": 12, "time": "D+3 00Z", "lat": 37.5, "lon": 136.0, "wind_kt": 40,  "alert": "Green"},
]


def _wind_to_radius(wind_kt: float) -> int:
    if wind_kt >= 96:
        return 260
    if wind_kt >= 64:
        return 190
    if wind_kt >= 48:
        return 120
    return 75


def _parse_item(item: ET.Element) -> dict | None:
    etype = item.findtext(f"{{{GDACS_NS}}}eventtype") or ""
    if etype != "TC":
        return None

    name = item.findtext("title") or item.findtext(f"{{{GDACS_NS}}}eventname") or "Unknown"
    alert = item.findtext(f"{{{GDACS_NS}}}alertlevel") or "Green"

    lat_str = item.findtext(f"{{{GEO_NS}}}lat") or item.findtext(f"{{{GDACS_NS}}}latitude")
    lon_str = item.findtext(f"{{{GEO_NS}}}long") or item.findtext(f"{{{GDACS_NS}}}longitude")
    if not lat_str or not lon_str:
        return None

    try:
        lat, lon = float(lat_str), float(lon_str)
    except ValueError:
        return None

    wind_kt: float | None = None
    for tag in ("severity", "wind", "maxwind"):
        raw = item.findtext(f"{{{GDACS_NS}}}{tag}")
        if raw:
            try:
                wind_kt = float(raw.split()[0])
                break
            except (ValueError, IndexError):
                pass

    radius_nm = _wind_to_radius(wind_kt) if wind_kt else DEFAULT_RADIUS.get(alert, 150)
    event_id = item.findtext(f"{{{GDACS_NS}}}eventid") or f"{lat:.2f}_{lon:.2f}"

    return {
        "id": str(event_id),
        "name": name,
        "lat": lat,
        "lon": lon,
        "alert": alert,
        "wind_kt": wind_kt,
        "radius_nm": radius_nm,
        "color": ALERT_COLOR.get(alert, "#F97316"),
    }


@router.get("/active")
async def get_active_typhoons():
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(GDACS_RSS_URL, follow_redirects=True)
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
    except Exception as e:
        return {"source": "gdacs", "count": 0, "typhoons": [], "error": str(e)}

    items = root.findall(".//item")
    typhoons = [t for item in items if (t := _parse_item(item)) is not None]
    return {"source": "gdacs", "count": len(typhoons), "typhoons": typhoons}


@router.get("/mock")
def get_mock_track():
    track = []
    for p in MOCK_TRACK:
        radius_nm = _wind_to_radius(p["wind_kt"])
        track.append({
            "step": p["step"],
            "time": p["time"],
            "id": f"mock_{p['step']}",
            "name": "MOCK-CHAN (가상)",
            "lat": p["lat"],
            "lon": p["lon"],
            "wind_kt": p["wind_kt"],
            "alert": p["alert"],
            "radius_nm": radius_nm,
            "color": ALERT_COLOR[p["alert"]],
        })
    return {"name": "MOCK-CHAN (가상)", "count": len(track), "track": track}
