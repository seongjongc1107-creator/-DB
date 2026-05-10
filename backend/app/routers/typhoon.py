import re
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
import httpx
from fastapi import APIRouter

router = APIRouter()

GDACS_RSS_URL = "https://www.gdacs.org/xml/rss.xml"
GDACS_NS = "http://www.gdacs.org"
GEO_NS = "http://www.w3.org/2003/01/geo/wgs84_pos#"
GEORSS_NS = "http://www.georss.org/georss"

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


def _intensity_to_alert(label: str) -> tuple[str, float]:
    """JTWC 강도 레이블(TD/TS/TY/STY) → (alertlevel, wind_kt)"""
    u = label.upper()
    if u in ("STY", "VSTY"):
        return "Red", 120.0
    if u == "TY":
        return "Orange", 80.0
    if u in ("TS", "STS"):
        return "Orange", 45.0
    return "Green", 25.0  # TD / LO


def _wind_to_pressure(wind_kt: float) -> int:
    """풍속(kt)으로 중심기압(hPa) 추정 — NWPac Atkinson-Holliday 관계식 기반 룩업"""
    if wind_kt <= 25:  return 1005
    if wind_kt <= 33:  return 1000
    if wind_kt <= 47:  return 993
    if wind_kt <= 63:  return 980
    if wind_kt <= 79:  return 963
    if wind_kt <= 99:  return 944
    if wind_kt <= 119: return 921
    return 898


def _parse_label_dt(label: str, year: int) -> datetime | None:
    """'DD/MM HH:MM UTC' → datetime(UTC). 연도는 컨텍스트에서 주입."""
    try:
        parts = label.split()
        d, m = parts[0].split("/")
        h, mi = parts[1].split(":")
        return datetime(year, int(m), int(d), int(h), int(mi), tzinfo=timezone.utc)
    except Exception:
        return None


def _parse_item(item: ET.Element) -> dict | None:
    etype = item.findtext(f"{{{GDACS_NS}}}eventtype") or ""
    if etype != "TC":
        return None

    name = item.findtext(f"{{{GDACS_NS}}}eventname") or item.findtext("title") or "Unknown"
    alert = item.findtext(f"{{{GDACS_NS}}}alertlevel") or "Green"

    # georss:point "lat lon" 형식 우선, 없으면 geo:lat/geo:long
    lat: float | None = None
    lon: float | None = None
    georss_point = item.findtext(f"{{{GEORSS_NS}}}point")
    if georss_point:
        parts = georss_point.split()
        if len(parts) == 2:
            try:
                lat, lon = float(parts[0]), float(parts[1])
            except ValueError:
                pass
    if lat is None:
        lat_str = item.findtext(f"{{{GEO_NS}}}lat") or item.findtext(f"{{{GDACS_NS}}}latitude")
        lon_str = item.findtext(f"{{{GEO_NS}}}long") or item.findtext(f"{{{GDACS_NS}}}longitude")
        if lat_str and lon_str:
            try:
                lat, lon = float(lat_str), float(lon_str)
            except ValueError:
                pass
    if lat is None or lon is None:
        return None

    # 풍속: "... wind speed of X km/h" 또는 숫자로 시작하는 값 파싱 → kt 변환
    wind_kt: float | None = None
    for tag in ("severity", "wind", "maxwind"):
        raw = item.findtext(f"{{{GDACS_NS}}}{tag}") or ""
        m = re.search(r"(\d+(?:\.\d+)?)\s*km/h", raw)
        if m:
            wind_kt = round(float(m.group(1)) / 1.852, 1)
            break
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


@router.get("/track/{event_id}")
async def get_typhoon_track(event_id: int):
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            ev = await client.get(
                f"https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=TC&eventid={event_id}",
                follow_redirects=True,
            )
            ev.raise_for_status()
            ev_data = ev.json()
            props = ev_data.get("properties", {})
            episode_id = props.get("episodeid")
            event_name = props.get("eventname", f"TC-{event_id}")

            geo = await client.get(
                f"https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid={event_id}&episodeid={episode_id}",
                follow_redirects=True,
            )
            geo.raise_for_status()
            geo_data = geo.json()
    except Exception as e:
        return {"error": str(e), "name": "", "track": []}

    features = geo_data.get("features", [])

    # 분석 기준 시각 (polygondate) — is_forecast 판별에 사용
    analysis_dt: datetime | None = None
    for f in features:
        pd = f.get("properties", {}).get("polygondate", "")
        if pd:
            try:
                analysis_dt = datetime.fromisoformat(pd).replace(tzinfo=timezone.utc)
                break
            except Exception:
                pass
    if analysis_dt is None:
        analysis_dt = datetime.now(timezone.utc)

    # coord → 강도 레이블 맵 (Line_Line 피처에서 추출)
    intensity_map: dict[tuple[float, float], str] = {}
    for f in features:
        if not f.get("properties", {}).get("Class", "").startswith("Line_Line"):
            continue
        label = f["properties"].get("polygonlabel", "TD")
        for c in f["geometry"]["coordinates"]:
            intensity_map[(round(c[0], 1), round(c[1], 1))] = label

    # 과거 + 예보 위치: Point_Polygon_Point_* 피처 (인덱스순 = 시간순)
    point_feats = sorted(
        [f for f in features if f.get("properties", {}).get("Class", "").startswith("Point_Polygon_Point")],
        key=lambda f: int(f["properties"]["Class"].split("_")[-1]),
    )

    track = []
    for step, f in enumerate(point_feats):
        ring = f["geometry"]["coordinates"][0]
        lons = [c[0] for c in ring]
        lats = [c[1] for c in ring]
        lon = round((min(lons) + max(lons)) / 2, 2)
        lat = round((min(lats) + max(lats)) / 2, 2)

        time_label = f["properties"].get("polygonlabel", f"Step {step}")

        # 예보 여부 판별
        pt_dt = _parse_label_dt(time_label, analysis_dt.year)
        is_forecast = pt_dt is not None and pt_dt > analysis_dt

        # 인근 Line_Line 에서 강도 룩업
        intensity = "TD"
        for (mlon, mlat), lbl in intensity_map.items():
            if abs(mlon - lon) < 0.3 and abs(mlat - lat) < 0.3:
                intensity = lbl
                break

        alert, wind_kt = _intensity_to_alert(intensity)
        radius_nm = _wind_to_radius(wind_kt)
        pressure_hpa = _wind_to_pressure(wind_kt)
        track.append({
            "step": step,
            "time": time_label,
            "id": f"{event_id}_s{step}",
            "name": event_name,
            "lat": lat,
            "lon": lon,
            "wind_kt": wind_kt,
            "alert": alert,
            "radius_nm": radius_nm,
            "pressure_hpa": pressure_hpa,
            "is_forecast": is_forecast,
            "color": ALERT_COLOR.get(alert, "#FCD34D"),
        })

    return {"name": event_name, "count": len(track), "track": track}


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
