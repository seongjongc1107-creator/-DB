"""
Parse NAVDATA and Navblue_Route CSVs into in-memory indexes.
"""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

DATA_DIR = Path(__file__).parent.parent / "data"
NAVDATA_CSV = DATA_DIR / "NAVDATA.csv"
ROUTES_CSV = DATA_DIR / "Navblue_Route.csv"


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class Airport:
    id: str
    lat: float
    lon: float
    name: str = ""
    elevation: float = 0.0


@dataclass
class Waypoint:
    id: str
    lat: float
    lon: float
    terminal: bool = False


@dataclass
class NDB:
    id: str
    lat: float
    lon: float
    name: str = ""


@dataclass
class AirwayFix:
    airway: str
    segment: int
    sequence: int
    fix: str
    fix_type: str
    lat: float
    lon: float


@dataclass
class Route:
    id: int
    origin: str
    destination: str
    number: int
    route_str: str
    distance: int
    disabled: bool
    aircraft: str
    comments: str
    tokens: List[str] = field(default_factory=list)
    coordinates: List[List[float]] = field(default_factory=list)  # [[lon, lat], ...]


# ---------------------------------------------------------------------------
# Coordinate parsing
# ---------------------------------------------------------------------------

_DMS_RE = re.compile(r'(\d+)[°°]\s*(\d+)[\'′’]\s*([\d.]+)')


def _parse_dms(s: str) -> Optional[float]:
    """'N 33° 26' 51.85\"' → decimal degrees."""
    if not s:
        return None
    s = s.strip()
    if not s:
        return None
    direction = s[0].upper()
    if direction not in ('N', 'S', 'E', 'W'):
        return None
    m = _DMS_RE.search(s)
    if not m:
        return None
    deg, mins, secs = float(m.group(1)), float(m.group(2)), float(m.group(3))
    val = deg + mins / 60.0 + secs / 3600.0
    if direction in ('S', 'W'):
        val = -val
    return round(val, 6)


def _sq_dist(a: List[float], b: List[float]) -> float:
    """Fast squared Euclidean distance on lon/lat (for relative comparison only)."""
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _nearest(candidates: List[List[float]], ref: List[float]) -> List[float]:
    """Return the candidate closest to ref."""
    return min(candidates, key=lambda c: _sq_dist(c, ref))


def _gc_km(a: List[float], b: List[float]) -> float:
    """Great-circle distance in km between [lon,lat] points."""
    import math
    p = math.pi / 180
    lon1, lat1 = a[0] * p, a[1] * p
    lon2, lat2 = b[0] * p, b[1] * p
    dlon, dlat = lon2 - lon1, lat2 - lat1
    x = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(min(1.0, math.sqrt(x)))


def _fix_antimeridian(coords: List[List[float]]) -> List[List[float]]:
    """Adjust longitudes for continuity across the antimeridian."""
    if len(coords) < 2:
        return coords
    result = [coords[0][:]]
    for lon, lat in coords[1:]:
        diff = lon - result[-1][0]
        if diff > 180:
            lon -= 360
        elif diff < -180:
            lon += 360
        result.append([lon, lat])
    return result


# ---------------------------------------------------------------------------
# Main data store
# ---------------------------------------------------------------------------

class NavDataStore:
    def __init__(self) -> None:
        self.airports: Dict[str, Airport] = {}
        self.waypoints: Dict[str, Waypoint] = {}
        self.ndbs: Dict[str, NDB] = {}
        # airway name → sorted list of AirwayFix
        self.airways: Dict[str, List[AirwayFix]] = defaultdict(list)

        self.routes: List[Route] = []

        # Indexes
        # fix → list of [lon, lat] candidates (same name can exist at multiple locations)
        self.fix_lookup: Dict[str, List[List[float]]] = {}
        self.airway_names: set = set()
        # procedure name → ordered [[lon, lat], ...] (SID/STAR enroute waypoints)
        self.procedure_lookup: Dict[str, List[List[float]]] = {}
        self.route_by_origin: Dict[str, List[int]] = defaultdict(list)
        self.route_by_dest: Dict[str, List[int]] = defaultdict(list)
        self.route_by_token: Dict[str, List[int]] = defaultdict(list)

        self.loaded = False

    # ------------------------------------------------------------------
    # Top-level loader
    # ------------------------------------------------------------------

    def load(self) -> None:
        if self.loaded:
            return
        print("Loading NAVDATA…")
        self._load_navdata()
        print(f"  airports={len(self.airports)}  waypoints={len(self.waypoints)}"
              f"  ndbs={len(self.ndbs)}  airways={len(self.airways)}"
              f"  procedures={len(self.procedure_lookup)}")
        self._build_fix_lookup()
        print("Loading routes…")
        self._load_routes()
        self._resolve_geometries()
        self._build_route_indexes()
        print(f"  routes={len(self.routes)}  fix_lookup={len(self.fix_lookup)}")
        self.loaded = True

    # ------------------------------------------------------------------
    # NAVDATA parsing
    # ------------------------------------------------------------------

    def _load_navdata(self) -> None:
        with open(NAVDATA_CSV, encoding='utf-8-sig') as f:
            lines = f.read().splitlines()

        # Locate section column-header rows (stored as i+1 where i=section-name row)
        sections: Dict[str, int] = {}
        known = {'Airports', 'Airways', 'NDBs', 'Runways', 'Waypoints',
                 'Approaches', 'SIDs', 'STARs'}
        for i, line in enumerate(lines):
            cleaned = line.strip().rstrip(',')
            if cleaned in known:
                sections[cleaned] = i + 1  # column-header line (0-indexed)

        def section_text(name: str, next_name: Optional[str]) -> str:
            start = sections[name]
            end = sections[next_name] - 1 if next_name and next_name in sections else len(lines)
            return '\n'.join(lines[start:end])

        self._parse_airports(section_text('Airports', 'Airways'))
        self._parse_airways(section_text('Airways', 'NDBs'))
        self._parse_ndbs(section_text('NDBs', 'Runways'))
        self._parse_waypoints(section_text('Waypoints', None))
        self._parse_procedures(
            section_text('SIDs', 'STARs'),
            section_text('STARs', 'Waypoints'),
        )

    def _parse_airports(self, text: str) -> None:
        for row in csv.DictReader(io.StringIO(text)):
            aid = (row.get('Id') or '').strip()
            if not aid:
                continue
            lat = _parse_dms(row.get('Latitude', ''))
            lon = _parse_dms(row.get('Longitude', ''))
            if lat is None or lon is None:
                continue
            self.airports[aid] = Airport(
                id=aid,
                lat=lat,
                lon=lon,
                name=(row.get('Name') or '').strip(),
                elevation=float(row.get('Elevation') or 0),
            )

    def _parse_airways(self, text: str) -> None:
        for row in csv.DictReader(io.StringIO(text)):
            aw = (row.get('Airway') or '').strip()
            fix = (row.get('Fix') or '').strip()
            if not aw or not fix:
                continue
            lat = _parse_dms(row.get('Fix Latitude', ''))
            lon = _parse_dms(row.get('Fix Longitude', ''))
            if lat is None or lon is None:
                continue
            try:
                seg = int(row.get('Segment') or 1)
                seq = int(row.get('Sequence') or 0)
            except ValueError:
                seg, seq = 1, 0
            self.airways[aw].append(AirwayFix(
                airway=aw, segment=seg, sequence=seq,
                fix=fix, fix_type=(row.get('Fix Type') or '').strip(),
                lat=lat, lon=lon,
            ))

    def _parse_ndbs(self, text: str) -> None:
        for row in csv.DictReader(io.StringIO(text)):
            nid = (row.get('Id') or '').strip()
            if not nid:
                continue
            lat = _parse_dms(row.get('Latitude', ''))
            lon = _parse_dms(row.get('Longitude', ''))
            if lat is None or lon is None:
                continue
            self.ndbs[nid] = NDB(
                id=nid, lat=lat, lon=lon,
                name=(row.get('Name') or '').strip(),
            )

    def _parse_procedures(self, sid_text: str, star_text: str) -> None:
        """Build procedure_lookup: procedure_name → ordered [[lon,lat], ...]."""
        # priority: Enroute route type > Runway type (gives cleaner en-route path)
        raw: Dict[str, Dict[str, List]] = defaultdict(lambda: defaultdict(list))
        # raw[proc_name][route] = [(seq, lon, lat), ...]

        for text in (sid_text, star_text):
            for row in csv.DictReader(io.StringIO(text)):
                proc = (row.get('Procedure') or '').strip()
                route = (row.get('Route') or '').strip()
                if not proc:
                    continue
                lat = _parse_dms(row.get('Fix Latitude', ''))
                lon = _parse_dms(row.get('Fix Longitude', ''))
                if lat is None or lon is None:
                    continue
                try:
                    seq = int(row.get('Sequence') or 0)
                except ValueError:
                    seq = 0
                raw[proc][route].append((seq, lon, lat))

        for proc, routes in raw.items():
            # Prefer enroute transition; fall back to first available route
            chosen_key = next(
                (k for k in routes if k.lower() in ('enroute', 'en route', '')),
                next(iter(routes)),
            )
            pts = sorted(routes[chosen_key], key=lambda x: x[0])
            coords = [[lon, lat] for _, lon, lat in pts]
            if len(coords) >= 1:
                self.procedure_lookup[proc] = coords

    def _parse_waypoints(self, text: str) -> None:
        for row in csv.DictReader(io.StringIO(text)):
            wid = (row.get('Id') or '').strip()
            if not wid or wid == 'End of Waypoints':
                continue
            lat = _parse_dms(row.get('Latitude', ''))
            lon = _parse_dms(row.get('Longitude', ''))
            if lat is None or lon is None:
                continue
            self.waypoints[wid] = Waypoint(
                id=wid, lat=lat, lon=lon,
                terminal=(row.get('Terminal/Enroute') or '').strip().lower() == 'terminal',
            )

    # ------------------------------------------------------------------
    # Fix lookup
    # ------------------------------------------------------------------

    def _build_fix_lookup(self) -> None:
        def add(name: str, lon: float, lat: float) -> None:
            coord = [lon, lat]
            if name not in self.fix_lookup:
                self.fix_lookup[name] = [coord]
            else:
                # Deduplicate: only add if not already within ~0.01° of existing candidate
                for c in self.fix_lookup[name]:
                    if abs(c[0] - lon) < 0.01 and abs(c[1] - lat) < 0.01:
                        return
                self.fix_lookup[name].append(coord)

        # Airports have definitive coordinates → add first (highest priority)
        for ap in self.airports.values():
            add(ap.id, ap.lon, ap.lat)
        # Waypoints
        for wp in self.waypoints.values():
            add(wp.id, wp.lon, wp.lat)
        # NDBs
        for ndb in self.ndbs.values():
            add(ndb.id, ndb.lon, ndb.lat)
        # VHF navaids from airway fixes
        for fixes in self.airways.values():
            for f in fixes:
                add(f.fix, f.lon, f.lat)

        self.airway_names = set(self.airways.keys())

        # Procedure endpoints
        for proc, coords in self.procedure_lookup.items():
            if proc not in self.fix_lookup and coords:
                add(proc, coords[-1][0], coords[-1][1])

    # ------------------------------------------------------------------
    # Route loading
    # ------------------------------------------------------------------

    def _load_routes(self) -> None:
        with open(ROUTES_CSV, encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for i, row in enumerate(reader):
                origin = (row.get('Origin') or '').strip()
                dest = (row.get('Destination') or '').strip()
                route_str = (row.get('Route') or '').strip()
                if not origin or not dest or not route_str:
                    continue
                if (row.get('Disabled') or '').strip().lower() == 'yes':
                    continue
                try:
                    dist = int(float(row.get('Distance') or 0))
                except (ValueError, TypeError):
                    dist = 0
                self.routes.append(Route(
                    id=i,
                    origin=origin,
                    destination=dest,
                    number=int(row.get('Number') or 1),
                    route_str=route_str,
                    distance=dist,
                    disabled=(row.get('Disabled') or '').strip().lower() == 'yes',
                    aircraft=(row.get('Aircraft') or '').strip(),
                    comments=(row.get('Comments') or '').strip(),
                    tokens=route_str.split(),
                ))

    # Tokens that appear in route strings but are not fixes
    _NON_FIX_TOKENS = frozenset({
        'DCT',   # Direct — routing instruction
        'FREQ',  # Frequency change
        'VFR',
        'IFR',
    })

    def _resolve_geometries(self) -> None:
        for route in self.routes:
            raw: List[List[float]] = []

            # Pre-compute max allowable single-leg distance:
            # use 1.5× the direct OD distance, with a floor of 2000 km
            origin_cands = self.fix_lookup.get(route.origin)
            dest_cands = self.fix_lookup.get(route.destination)
            if origin_cands and dest_cands:
                od_km = _gc_km(origin_cands[0], dest_cands[0])
                max_leg_km = max(od_km * 1.5, 2000.0)
            else:
                max_leg_km = 5000.0

            # Seed reference point from origin airport
            ref: Optional[List[float]] = origin_cands[0][:] if origin_cands else None

            for token in route.tokens:
                if token in self.airway_names or token in self._NON_FIX_TOKENS:
                    continue

                # Expand SID/STAR procedures
                if token in self.procedure_lookup:
                    pts = self.procedure_lookup[token]
                    raw.extend(pts)
                    if pts:
                        ref = pts[-1][:]
                    continue

                candidates = self.fix_lookup.get(token)
                if not candidates:
                    continue

                # Pick candidate nearest to the current reference point
                if ref is not None and len(candidates) > 1:
                    chosen = _nearest(candidates, ref)
                else:
                    chosen = candidates[0]

                # Sanity check: skip if jump is geographically impossible
                if ref is not None and _gc_km(ref, chosen) > max_leg_km:
                    continue

                raw.append(chosen[:])
                ref = chosen

            route.coordinates = _fix_antimeridian(raw)

    def _build_route_indexes(self) -> None:
        for route in self.routes:
            self.route_by_origin[route.origin].append(route.id)
            self.route_by_dest[route.destination].append(route.id)
            for token in route.tokens:
                self.route_by_token[token].append(route.id)

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def get_routes(
        self,
        origin: Optional[str] = None,
        destination: Optional[str] = None,
        fix: Optional[str] = None,
        ids: Optional[List[int]] = None,
    ) -> List[Route]:
        if ids is not None:
            return [self.routes[i] for i in ids if i < len(self.routes)]

        if fix:
            token = fix.upper()
            id_set = set(self.route_by_token.get(token, []))
        elif origin and destination:
            id_set = set(self.route_by_origin.get(origin.upper(), [])) & \
                     set(self.route_by_dest.get(destination.upper(), []))
        elif origin:
            id_set = set(self.route_by_origin.get(origin.upper(), []))
        elif destination:
            id_set = set(self.route_by_dest.get(destination.upper(), []))
        else:
            return self.routes

        return [self.routes[i] for i in sorted(id_set) if i < len(self.routes)]

    def airway_geojson(self, name: str) -> dict:
        fixes = self.airways.get(name.upper(), [])
        if not fixes:
            return {"type": "FeatureCollection", "features": []}

        by_seg: Dict[int, List[AirwayFix]] = defaultdict(list)
        for f in fixes:
            by_seg[f.segment].append(f)

        features = []
        for seg_id, seg_fixes in sorted(by_seg.items()):
            seg_fixes.sort(key=lambda x: x.sequence)
            coords = _fix_antimeridian([[f.lon, f.lat] for f in seg_fixes])
            if len(coords) >= 2:
                features.append({
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": coords},
                    "properties": {
                        "airway": name.upper(),
                        "segment": seg_id,
                        "fixes": [f.fix for f in seg_fixes],
                    },
                })
        return {"type": "FeatureCollection", "features": features}


# Singleton
store = NavDataStore()
