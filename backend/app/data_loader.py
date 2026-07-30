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
class RunwayInfo:
    id: str
    bearing_m: float
    length_ft: int
    width_ft: int
    elevation_ft: float
    threshold_disp_ft: int = 0


@dataclass
class ILSEntry:
    id: str
    runway: str      # e.g. RW33L
    frequency: str   # e.g. 109.3
    bearing_m: float
    category: str


@dataclass
class ApproachProc:
    procedure: str   # e.g. I15LY
    type_code: str   # I / L / R / V / N / G
    runway: str      # e.g. 15L
    rnp_ar: bool


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
    # tokens에는 없지만 airway 구간을 펼치면서 실제로 지나가는 중간 fix 이름들.
    # waypoint 검색(route_by_token)이 이걸 놓치면 "W4를 타는 항로"는 찾아도
    # "W4 안의 FATAN을 지나는 항로"는 못 찾는 문제가 생김.
    passed_fixes: Dict[str, List[float]] = field(default_factory=dict)  # fix name → resolved [lon, lat]


# ---------------------------------------------------------------------------
# Coordinate parsing
# ---------------------------------------------------------------------------

_DMS_RE = re.compile(r'(\d+)[°°]\s*(\d+)[\'′’]\s*([\d.]+)')

# Route strings sometimes use raw lat/lon tokens instead of named fixes, e.g.
# "3802N12848E" = 38°02'N 128°48'E (DDMM[N|S]DDDMM[E|W], degrees+minutes only).
_COORD_TOKEN_RE = re.compile(r'^(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])$')


def _parse_coord_token(token: str) -> Optional[Tuple[float, float]]:
    """'3802N12848E' → (lon, lat) in decimal degrees, or None if not this format."""
    m = _COORD_TOKEN_RE.match(token)
    if not m:
        return None
    lat_deg, lat_min, lat_dir, lon_deg, lon_min, lon_dir = m.groups()
    lat = int(lat_deg) + int(lat_min) / 60.0
    lon = int(lon_deg) + int(lon_min) / 60.0
    if lat_dir == 'S':
        lat = -lat
    if lon_dir == 'W':
        lon = -lon
    return (lon, lat)


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
        # airport ICAO → detail lists
        self.runways: Dict[str, List[RunwayInfo]] = defaultdict(list)
        self.ils_by_airport: Dict[str, List[ILSEntry]] = defaultdict(list)
        self.approaches_by_airport: Dict[str, List[ApproachProc]] = defaultdict(list)

        self.routes: List[Route] = []

        # Indexes
        # fix → list of [lon, lat] candidates (same name can exist at multiple locations)
        self.fix_lookup: Dict[str, List[List[float]]] = {}
        self.airway_names: set = set()
        # airway name → list of segments, each a sequence-sorted list of AirwayFix
        self.airway_segments: Dict[str, List[List[AirwayFix]]] = {}
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
        self._build_airway_segments()
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
                 'Approaches', 'Company Routes', 'ILSs', 'Navaids', 'SIDs', 'STARs'}
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
        self._parse_runways(section_text('Runways', 'SIDs'))
        self._parse_ils(section_text('ILSs', 'Navaids'))
        self._parse_approaches_unique(section_text('Approaches', 'Company Routes'))
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

    @staticmethod
    def _parse_bearing(s: str) -> float:
        """'83.0 M' → 83.0"""
        try:
            return float((s or '').split()[0])
        except (ValueError, IndexError):
            return 0.0

    _PROC_RE = re.compile(r'^([A-Z])(\d{2}[LRCT]?)(.*)')

    def _parse_runways(self, text: str) -> None:
        for row in csv.DictReader(io.StringIO(text)):
            airport = (row.get('Airport') or '').strip()
            rid = (row.get('Id') or '').strip()
            if not airport or not rid:
                continue
            try:
                length = int(row.get('Length') or 0)
                width = int(row.get('Width') or 0)
                elev = float(row.get('Elevation') or 0)
                disp = int(row.get('Threshold Displacement Distance') or 0)
            except (ValueError, TypeError):
                length = width = disp = 0
                elev = 0.0
            self.runways[airport].append(RunwayInfo(
                id=rid,
                bearing_m=self._parse_bearing(row.get('Bearing', '')),
                length_ft=length,
                width_ft=width,
                elevation_ft=elev,
                threshold_disp_ft=disp,
            ))

    def _parse_ils(self, text: str) -> None:
        for row in csv.DictReader(io.StringIO(text)):
            airport = (row.get('Airport') or '').strip()
            iid = (row.get('Id') or '').strip()
            runway = (row.get('Runway') or '').strip()
            if not airport or not iid or not runway:
                continue
            self.ils_by_airport[airport].append(ILSEntry(
                id=iid,
                runway=runway,
                frequency=(row.get('Frequency') or '').strip(),
                bearing_m=self._parse_bearing(row.get('Bearing', '')),
                category=(row.get('Category') or '').strip(),
            ))

    def _parse_approaches_unique(self, text: str) -> None:
        seen: set = set()
        for row in csv.DictReader(io.StringIO(text)):
            airport = (row.get('Airport') or '').strip()
            proc = (row.get('Procedure') or '').strip()
            if not airport or not proc:
                continue
            key = (airport, proc)
            if key in seen:
                continue
            seen.add(key)
            rnp_ar_val = (row.get('RNP-AR') or '').strip()
            rnp_ar = rnp_ar_val.upper() in ('YES', '1', 'TRUE')
            m = self._PROC_RE.match(proc)
            if m:
                type_code, runway = m.group(1), m.group(2)
            else:
                type_code = proc[0] if proc else ''
                runway = proc[1:] if len(proc) > 1 else ''
            self.approaches_by_airport[airport].append(ApproachProc(
                procedure=proc,
                type_code=type_code,
                runway=runway,
                rnp_ar=rnp_ar,
            ))

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

    def _build_airway_segments(self) -> None:
        """Group each airway's fixes by physical segment, sorted by sequence,
        so a route leg like "... GYA R474 NOB ..." can be expanded into the
        real chain of intermediate waypoints instead of a straight line."""
        grouped: Dict[Tuple[str, int], List[AirwayFix]] = defaultdict(list)
        for name, fixes in self.airways.items():
            for f in fixes:
                grouped[(name, f.segment)].append(f)
        for (name, _seg), flist in grouped.items():
            flist.sort(key=lambda x: x.sequence)
            self.airway_segments.setdefault(name, []).append(flist)

    def _expand_airway(self, airway: str, entry: str, exit_: str) -> Optional[List[AirwayFix]]:
        """Return the AirwayFix chain from entry to exit (inclusive) along the
        given airway, or None if that airway doesn't connect the two fixes."""
        for seg in self.airway_segments.get(airway, []):
            names = [f.fix for f in seg]
            if entry not in names or exit_ not in names:
                continue
            i, j = names.index(entry), names.index(exit_)
            return seg[i:j + 1] if i <= j else list(reversed(seg[j:i + 1]))
        return None

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

    # NAVDATA truncates SID/STAR procedure identifiers to a 4-letter name + suffix
    # (ARINC 424 computer-code length limit), e.g. real transition fix "EASTE" becomes
    # "EAST" in NAVDATA's Procedure column — so "EASTE1D" in a Navblue route string only
    # matches NAVDATA's "EAST1D". Without this fallback, every STAR/SID whose transition
    # fix name is 5+ letters silently fails to resolve and the route jumps straight from
    # the last enroute fix to the airport, skipping the whole procedure.
    _PROC_NAME_RE = re.compile(r'^([A-Z]+)(\d+[A-Z]?)$')

    def _lookup_procedure(self, token: str, near: Optional[List[float]] = None) -> Optional[List[List[float]]]:
        pts = self.procedure_lookup.get(token)
        if pts is not None:
            return pts
        m = self._PROC_NAME_RE.match(token)
        if m:
            name, suffix = m.groups()
            if len(name) > 4:
                candidate = self.procedure_lookup.get(name[:4] + suffix)
                if candidate is None:
                    return None
                # 잘린 이름만으로 찾은 매칭이라, 완전히 무관한 다른 공항의 절차와
                # 우연히 이름이 같은 경우(예: ENBAX1B→ENBA1B가 딴 나라 절차와 충돌)가
                # 있을 수 있음 — 현재 위치에서 비현실적으로 멀면 오탐으로 보고 버림.
                if near is not None and _gc_km(near, candidate[0]) > 1500:
                    return None
                return candidate
        return None

    def resolve_route_tokens(self, tokens: List[str]) -> Tuple[List[List[float]], Dict[str, List[float]], List[str]]:
        """Resolve a route-string token list (fix/airway/DCT/SID/STAR, whitespace-split)
        into a coordinate path + the set of named fixes actually passed through +
        a list of "WAYPOINT AIRWAY WAYPOINT" legs where the named airway doesn't
        actually connect those two fixes (silently falls back to a direct line).

        Shared by both stored Navblue routes (_resolve_geometries) and the ad-hoc
        "type a route string" feature — same parsing rules either way.
        """
        raw: List[List[float]] = []
        passed_fixes: Dict[str, List[float]] = {}
        airway_gaps: List[str] = []
        if not tokens:
            return raw, passed_fixes, airway_gaps

        # Pre-compute max allowable single-leg distance:
        # use 1.5× the direct OD distance, with a floor of 2000 km
        origin_cands = self.fix_lookup.get(tokens[0])
        dest_cands = self.fix_lookup.get(tokens[-1])
        if origin_cands and dest_cands:
            od_km = _gc_km(origin_cands[0], dest_cands[0])
            max_leg_km = max(od_km * 1.5, 2000.0)
        else:
            max_leg_km = 5000.0

        # Seed reference point from the first token, if it resolves to a known fix
        ref: Optional[List[float]] = origin_cands[0][:] if origin_cands else None
        ref_name: Optional[str] = tokens[0] if origin_cands else None
        if ref is not None:
            raw.append(ref[:])
            passed_fixes[tokens[0]] = ref[:]

        # ICAO route strings alternate FIX, CONNECTOR(airway/DCT), FIX, CONNECTOR, ...
        # (SID/STAR procedure names attach directly to their adjacent fix with no
        # connector). Some enroute fix identifiers collide with unrelated airway
        # names elsewhere in the dataset (e.g. PUD, NXD, GYA, NOB, BMT, LKH), so we
        # must disambiguate by *position* in the token stream, not by set membership
        # alone — otherwise a legitimate fix gets misread as an airway and silently
        # dropped, leaving a long straight "DCT-looking" gap in the route.
        #
        # Procedure names are looked up in fix_lookup too (as a fallback for search),
        # so a token can be BOTH a real fix and, coincidentally, some unrelated
        # airport's SID/STAR identifier (e.g. "TNN" is both a VOR and a procedure
        # name elsewhere). A SID can only legally appear as the token right after
        # the first fix, and a STAR only as the token right before the last —
        # anywhere else, a procedure-name match is almost certainly this kind of
        # collision, so plain-fix resolution must win there.
        expect_connector = False  # first fix already seeded above
        pending_airway: Optional[str] = None
        n_tokens = len(tokens)

        for i, token in enumerate(tokens[1:] if origin_cands else tokens):
            is_sid_pos = i == 0
            is_star_pos = i == n_tokens - 3

            if expect_connector:
                # Connector slot: airway id or DCT — unless a STAR attaches here
                # directly, in which case it behaves like a fix-slot token too.
                pts = self._lookup_procedure(token, near=ref) if is_star_pos else None
                if pts is not None:
                    raw.extend(pts)
                    if pts:
                        ref = pts[-1][:]
                        ref_name = None  # procedure endpoint isn't a named fix
                    expect_connector = False
                else:
                    # Remember a real airway so the next fix can be reached by
                    # following its actual published waypoint chain instead of
                    # a straight line.
                    pending_airway = token if token in self.airway_names else None
                    expect_connector = False
                continue

            # Fix slot: SID/STAR procedure or a plain fix
            if token in self._NON_FIX_TOKENS:
                continue

            proc_pts = self._lookup_procedure(token, near=ref) if (is_sid_pos or is_star_pos) else None
            if proc_pts is not None:
                raw.extend(proc_pts)
                ref = proc_pts[-1][:]
                ref_name = None
                pending_airway = None
                # Procedure consumed; its terminal fix still follows with no
                # connector, so stay in the fix slot.
                continue

            candidates = self.fix_lookup.get(token)
            if not candidates:
                coord = _parse_coord_token(token)
                if coord is not None:
                    candidates = [[coord[0], coord[1]]]
            if not candidates and (pts := self._lookup_procedure(token, near=ref)) is not None:
                # Not a plain fix anywhere, but does resolve as a procedure even
                # though it's not in the usual SID/STAR slot — better than dropping
                # the token entirely.
                raw.extend(pts)
                ref = pts[-1][:]
                ref_name = None
                pending_airway = None
                continue
            if not candidates:
                if token in self.airway_names and ref_name is not None and pending_airway is None:
                    # 연결어(DCT) 없이 fix 슬롯에 바로 항공로 이름이 나온 경우 — 저장된
                    # Navblue 항로 문자열엔 없는 패턴이지만, 사용자가 직접 입력하는
                    # "waypoint 항공로 waypoint" 형태에선 정상적인 표현이라 커넥터로 취급.
                    pending_airway = token
                continue

            # Pick candidate nearest to the current reference point
            if ref is not None and len(candidates) > 1:
                chosen = _nearest(candidates, ref)
            else:
                chosen = candidates[0]

            # Sanity check: skip if jump is geographically impossible
            if ref is not None and _gc_km(ref, chosen) > max_leg_km:
                pending_airway = None
                continue

            expanded = (
                self._expand_airway(pending_airway, ref_name, token)
                if pending_airway and ref_name else None
            )
            if expanded and len(expanded) > 2:
                raw.extend([[f.lon, f.lat] for f in expanded[1:]])
                ref = [expanded[-1].lon, expanded[-1].lat]
                passed_fixes.update({f.fix: [f.lon, f.lat] for f in expanded})
            else:
                if pending_airway and ref_name and expanded is None:
                    # 항공로 이름은 유효하지만 이 두 fix를 실제로 잇지는 않음 — 직선으로 대체됨
                    airway_gaps.append(f"{ref_name} {pending_airway} {token}")
                raw.append(chosen[:])
                ref = chosen
                passed_fixes[token] = chosen[:]
            ref_name = token
            pending_airway = None
            expect_connector = True

        return _fix_antimeridian(raw), passed_fixes, airway_gaps

    def _resolve_geometries(self) -> None:
        for route in self.routes:
            route.coordinates, route.passed_fixes, _ = self.resolve_route_tokens(route.tokens)

    def _build_route_indexes(self) -> None:
        for route in self.routes:
            self.route_by_origin[route.origin].append(route.id)
            self.route_by_dest[route.destination].append(route.id)
            # route.tokens: 문자열에 그대로 적힌 토큰(항공로 이름 포함).
            # route.passed_fixes: 항공로를 펼치면서 실제로 지나가는 중간 fix까지 포함.
            # 검색은 이 둘의 합집합으로 색인해야 "W4 안의 FATAN을 지나는 항로" 같은
            # 걸 놓치지 않음 — get_routes()에서 set()으로 중복은 알아서 제거됨.
            for token in route.tokens:
                self.route_by_token[token].append(route.id)
            for fix in route.passed_fixes:
                self.route_by_token[fix].append(route.id)

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

        # origin/destination/fix가 여러 개 동시에 오면 전부 만족하는 교집합이어야
        # 함(예: "N892 지나는 RKSI→VVPQ 항로") — 예전엔 fix가 있으면 origin/
        # destination을 아예 무시하는 버그가 있었음
        id_set: Optional[set] = None

        def _intersect(new_ids: set) -> None:
            nonlocal id_set
            id_set = new_ids if id_set is None else (id_set & new_ids)

        if fix:
            _intersect(set(self.route_by_token.get(fix.upper(), [])))
        if origin:
            _intersect(set(self.route_by_origin.get(origin.upper(), [])))
        if destination:
            _intersect(set(self.route_by_dest.get(destination.upper(), [])))

        if id_set is None:
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

    def all_airways_geojson(self) -> dict:
        features = []
        for name in self.airways:
            features.extend(self.airway_geojson(name)["features"])
        return {"type": "FeatureCollection", "features": features}


# Singleton
store = NavDataStore()
