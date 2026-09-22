"""WX MINIMA CSV(접근방식별 RVR/VIS/DH) → 공항별 기상 임계값(초록/주황/빨강 판정
기준) 계산.

원본 CSV는 공항을 IATA 코드로 주는데 이 앱은 ICAO를 쓰므로, 지금 갖고 있는 96개
공항에 한해 알려진 IATA→ICAO 매핑을 하드코딩해서 씀 — 원본 CSV에 새 공항이
추가되면 이 매핑에도 수동으로 항목을 추가해야 함(원본 데이터 자체엔 ICAO
컬럼이 없어서 자동 매핑이 불가능). 매핑에 없는 IATA 코드는 조용히 건너뛰고
admin 업로드 응답의 unresolved 목록으로 보여줌.

계산 방식(기존 이 값을 처음 산출했을 때와 동일 — frontend/src/lib/airportMinimaSeed.ts
96개 공항 값 전체와 1건도 틀리지 않게 재현되는 것으로 검증함):
  - 빨강(severe) = 그 공항 착륙 접근방식(TAKE OFF 제외) 중 최선(최소) VIS/RVR ·
    최소 DH. VIS 우선, 없으면 RVR로 대체
  - 주황(caution) = 빨강 + 교체공항 대체최저치 규정 버퍼
    · 서로 다른 활주로에 항행시설 2개 이상(RNAV/RNP는 활주로 무관 1개로 묶음)
      → 운고 +200ft, 시정 +800m
    · 항행시설 1개뿐 → 운고 +400ft, 시정 +1600m
  - CIRCLING 행(RVR/TYPNM/RMK 어디에 표기돼 있든)은 빨강 계산엔 포함하되
    항행시설 개수 판정에서는 제외
  - 돌풍(gust)은 원본 데이터에 없어서 기본값(25/40kt) 그대로 사용
"""
from __future__ import annotations

import csv
import io
import math
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.data_loader import store

DATA_DIR = Path(__file__).parent.parent / "data"
WX_MINIMA_CSV = DATA_DIR / "WX_Minima.csv"

_STATUTE_MILE_M = 1609.344
_FOOT_M = 0.3048

_DEFAULT_GUST_CAUTION_KT = 25
_DEFAULT_GUST_SEVERE_KT = 40

# 96개 공항 한정 — 새 공항이 CSV에 추가되면 여기도 같이 갱신해야 함
IATA_TO_ICAO: Dict[str, str] = {
    'BKI': 'WBKK', 'BKK': 'VTBS', 'BTH': 'WIDD', 'BWN': 'WBSB', 'CAN': 'ZGGG', 'CEB': 'RPVM', 'CEI': 'VTCT',
    'CJJ': 'RKTU', 'CJU': 'RKPC', 'CKG': 'ZUCK', 'CNX': 'VTCC', 'CRK': 'RPLC', 'CSX': 'ZGHA', 'CTS': 'RJCC',
    'CXR': 'VVCR', 'DAC': 'VGHS', 'DAD': 'VVDN', 'DMK': 'VTBD', 'DPS': 'WADD', 'DSN': 'ZBDS', 'DVO': 'RPMD',
    'DYG': 'ZGDY', 'FOC': 'ZSFZ', 'FSZ': 'RJNS', 'FUK': 'RJFF', 'GMP': 'RKSS', 'GUM': 'PGUM', 'HAK': 'ZJHK',
    'HAN': 'VVNB', 'HFE': 'ZSOF', 'HIJ': 'RJOA', 'HKD': 'RJCH', 'HKG': 'VHHH', 'HKT': 'VTSP', 'HND': 'RJTT',
    'HRB': 'ZYHB', 'ICN': 'RKSI', 'IWO': 'RJAW', 'JMU': 'ZYJM', 'KCH': 'WBGG', 'KHH': 'RCKH', 'KIX': 'RJBB',
    'KKJ': 'RJFR', 'KLO': 'RPVK', 'KMJ': 'RJFT', 'KOJ': 'RJFK', 'KPO': 'RKTH', 'KUV': 'RKJK', 'KWJ': 'RKJJ',
    'KWL': 'ZGKL', 'MFM': 'VMMC', 'MNL': 'RPLL', 'MWX': 'RKJB', 'MYJ': 'RJOM', 'NGO': 'RJGG', 'NGS': 'RJFU',
    'NNG': 'ZGNN', 'NRT': 'RJAA', 'NTG': 'ZSNT', 'OKA': 'ROAH', 'PEK': 'ZBAA', 'PKX': 'ZBAD', 'PQC': 'VVPQ',
    'PUS': 'RKPK', 'PVG': 'ZSPD', 'RSU': 'RKJY', 'SGN': 'VVTS', 'SIN': 'WSSS', 'SJW': 'ZBSJ', 'SPN': 'PGSN',
    'SWA': 'ZGOW', 'SYX': 'ZJSY', 'TAE': 'RKTN', 'TAG': 'RPSP', 'TAK': 'RJOT', 'TAO': 'ZSQD', 'TFU': 'ZUTF',
    'TNA': 'ZSJN', 'TPE': 'RCTP', 'TSN': 'ZBTJ', 'UBN': 'ZMCK', 'UKB': 'RJBE', 'ULN': 'ZMUB', 'USN': 'RKPU',
    'UTP': 'VTBU', 'VTE': 'VLVT', 'VVO': 'UHWW', 'WEH': 'ZSWH', 'WNZ': 'ZSWZ', 'WUH': 'ZHHH', 'XIY': 'ZLXY',
    'XUZ': 'ZSXZ', 'YIH': 'ZHYC', 'YNJ': 'ZYYJ', 'YNT': 'ZSYT', 'YNY': 'RKNY',
}

_seed: Dict[str, dict] = {}


def _parse_distance_m(v: Optional[str]) -> Optional[float]:
    """'1000m' / '800M' / '4000ft' / '3/4sm' / '1 1/4sm' 등을 미터로 통일."""
    if not v or not v.strip():
        return None
    v = v.strip()
    m = re.match(r'^(\d+)\s+(\d+)/(\d+)\s*sm$', v, re.I)
    if m:
        whole, num, den = (int(x) for x in m.groups())
        return (whole + num / den) * _STATUTE_MILE_M
    m = re.match(r'^(\d+)/(\d+)\s*sm$', v, re.I)
    if m:
        num, den = (int(x) for x in m.groups())
        return (num / den) * _STATUTE_MILE_M
    m = re.match(r'^([\d.]+)\s*sm$', v, re.I)
    if m:
        return float(m.group(1)) * _STATUTE_MILE_M
    m = re.match(r'^([\d.]+)\s*ft$', v, re.I)
    if m:
        return float(m.group(1)) * _FOOT_M
    m = re.match(r'^([\d.]+)\s*m?$', v, re.I)
    if m:
        return float(m.group(1))
    return None


def _parse_ft(v: Optional[str]) -> Optional[float]:
    if not v or not v.strip():
        return None
    m = re.match(r"^([\d.]+)\s*(FT|')?$", v.strip(), re.I)
    return float(m.group(1)) if m else None


def _norm_rwy(rwy: str) -> str:
    rwy = rwy.strip().upper()
    return re.sub(r'^R[WY][WY]\s*', '', rwy)


def _is_rnav(typnm: str) -> bool:
    t = typnm.upper()
    return 'RNAV' in t or 'RNP' in t


def _is_circling(row: dict) -> bool:
    text = f"{row.get('RVR', '')} {row.get('TYPNM', '')} {row.get('RMK', '')}".upper()
    return 'CIRCL' in text


def _compute_airport(rows: List[dict]) -> Optional[dict]:
    landing = [r for r in rows if (r.get('TYPNM') or '').strip().upper() != 'TAKE OFF']
    if not landing:
        return None

    vis_candidates: List[float] = []
    dh_candidates: List[float] = []
    units: set = set()
    for r in landing:
        vis = _parse_distance_m(r.get('VIS')) or _parse_distance_m(r.get('RVR'))
        if vis is not None:
            vis_candidates.append(vis)
        dh = _parse_ft(r.get('DH'))
        if dh is not None:
            dh_candidates.append(dh)
        if not _is_circling(r):
            units.add('RNAV_RNP' if _is_rnav(r.get('TYPNM') or '') else _norm_rwy(r.get('RWYNM') or ''))

    if not vis_candidates or not dh_candidates:
        return None

    vis_severe = min(vis_candidates)
    ceil_severe = min(dh_candidates)
    small_buffer = len(units) >= 2
    vis_buf = 800 if small_buffer else 1600
    ceil_buf = 200 if small_buffer else 400

    return {
        "vis_severe_m": round(vis_severe),
        "vis_caution_m": round(vis_severe + vis_buf),
        "ceiling_severe_ft": round(ceil_severe),
        "ceiling_caution_ft": round(ceil_severe + ceil_buf),
        "gust_caution_kt": _DEFAULT_GUST_CAUTION_KT,
        "gust_severe_kt": _DEFAULT_GUST_SEVERE_KT,
    }


def parse_wx_minima_csv(text: str) -> tuple[Dict[str, dict], List[str]]:
    """CSV 원문 → ({ICAO: thresholds}, [매핑 없어서 건너뛴 IATA 코드])."""
    by_arp: Dict[str, List[dict]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        arp = (row.get('ARP') or '').strip()
        if not arp:
            continue
        by_arp.setdefault(arp, []).append(row)

    result: Dict[str, dict] = {}
    unresolved: List[str] = []
    for iata, rows in by_arp.items():
        icao = IATA_TO_ICAO.get(iata)
        if not icao:
            unresolved.append(iata)
            continue
        computed = _compute_airport(rows)
        if computed:
            result[icao] = computed
        else:
            unresolved.append(iata)
    return result, unresolved


def load_wx_minima_file() -> None:
    global _seed
    if not WX_MINIMA_CSV.exists():
        return
    text = WX_MINIMA_CSV.read_text(encoding='utf-8-sig')
    _seed, _ = parse_wx_minima_csv(text)


def get_seed() -> Dict[str, dict]:
    return _seed


# ─── 4단계 공항 상태 판정 (DISCR FUEL 탑재 기준표 기반) ──────────────────────────
#
# 양호 / 주의I / 주의II / 경고 4단계. 표의 ATC 열(FLT CHECK/HEAVY TRAFFIC/제설작업
# 등)은 이 앱이 가진 데이터가 아니라서 WEATHER 열만 구현함. TAF(BECMG/TEMPO) 구분도
# 아직 반영 안 함 — 지금은 METAR 실측 기준으로만 판정하고, TAF 반영은 별도 작업.
#
# 판정 축(axis)마다 독립적으로 레벨을 매기고, 전체 레벨 = 모든 축의 최댓값.
#   1) 시정 — 그 공항 L/D MINIMUM(vis_severe_m, wx_minima 계산값) 대비
#        LDM 미만 → 4(경고) / LDM~LDM+800m → 3(주의II) / LDM+800~+1600m → 2(주의I)
#   2) 운고 — 기존 2단계(caution/severe) 그대로, 표에 DH 기준이 없어 경고까지는 안 올림
#   3) TS(뇌우) 또는 CB 구름 인근 → 3(주의II)
#   4) 강설 — 약(-SN) → 3(주의II), 중/강(SN, +SN) → 4(경고)
#   5) 바람 — 활주로 방향 대비 측풍 20kt 이상 또는 돌풍 35kt 이상
#        일반 공항: 3(주의II) / CJU(RKPC): 4(경고)
#      + 공항별 특례: PUS(RKPK) RWY36 배풍 10kt 이상 → 3(주의II)
#                     CJU(RKPC) RWY07/25 배풍 10kt 이상 → 4(경고) — 07/25는 사용자
#                     확인 기준. METAR 단일 풍향으로는 두 끝이 동시에 배풍일 수 없지만
#                     (항상 한쪽은 맞바람), 실제로는 AMOS 활주로별 관측이 국지적으로
#                     갈려 둘 다 배풍으로 찍히는 경우가 있어 METAR 배풍값 자체를 기준으로 씀

_GENERAL_CROSSWIND_CAUTION_KT = 20
_GENERAL_GUST_CAUTION_KT = 35
_PUS_ICAO = "RKPK"
_PUS_TAILWIND_CAUTION_KT = 10
_CJU_ICAO = "RKPC"
_CJU_RWY_PREFIXES = ("RW07", "RW25")  # 사용자 확인: CJU 배풍 특례는 07/25 활주로 기준
_CJU_TAILWIND_CAUTION_KT = 10


def _wind_components(wind_dir: float, wind_kt: float, bearing_deg: float) -> Tuple[float, float]:
    """(headwind_kt, crosswind_kt) — headwind가 음수면 배풍(tailwind)."""
    angle = math.radians(wind_dir - bearing_deg)
    return wind_kt * math.cos(angle), abs(wind_kt * math.sin(angle))


def _best_runway_wind(icao: str, wind_dir: Optional[float], wind_kt: Optional[float]) -> Tuple[float, float]:
    """(맞바람이 가장 큰 활주로의 측풍, 그 활주로의 배풍) — 실제 사용될 활주로를 가정."""
    runways = store.runways.get(icao, [])
    if not runways or wind_dir is None or wind_kt is None:
        return 0.0, 0.0
    best_headwind: Optional[float] = None
    best_cross = 0.0
    for rwy in runways:
        hw, cw = _wind_components(wind_dir, wind_kt, rwy.bearing_m)
        if best_headwind is None or hw > best_headwind:
            best_headwind, best_cross = hw, cw
    tailwind = max(0.0, -(best_headwind or 0.0))
    return best_cross, tailwind


def _tailwind_for_prefixes(
    icao: str, prefixes: Tuple[str, ...], wind_dir: Optional[float], wind_kt: Optional[float]
) -> float:
    """지정한 활주로(prefix로 매칭) 중 배풍이 가장 큰 값 — PUS RWY36, CJU 07/25처럼
    운영상 고정으로 취급되는 특정 활주로의 배풍 특례용. 반대편 끝이 같이 매칭되면
    (예: CJU 07/25) 둘 중 실제로 배풍인 쪽이 자연히 골라짐(반대쪽은 맞바람이라 0)."""
    runways = [r for r in store.runways.get(icao, []) if r.id.startswith(prefixes)]
    if not runways or wind_dir is None or wind_kt is None:
        return 0.0
    worst = 0.0
    for r in runways:
        hw, _cw = _wind_components(wind_dir, wind_kt, r.bearing_m)
        worst = max(worst, -hw)
    return worst


def _snow_tier(weather_tokens: List[str]) -> int:
    """1=없음, 3=주의II(약한 눈 -SN), 4=경고(중/강한 눈 SN·+SN)."""
    tier = 1
    for tok in weather_tokens:
        t = tok.upper()
        if "SN" not in t:
            continue
        tier = max(tier, 3 if t.startswith("-") else 4)
    return tier


_TS_TOKEN_RE = re.compile(r"^[+-]?(VC)?TS[A-Z]*$")


def classify_metar_level(
    icao: str,
    vis_m: Optional[float],
    ceiling_ft: Optional[float],
    wind_dir: Optional[float],
    wind_kt: Optional[float],
    gust_kt: Optional[float],
    weather_tokens: List[str],
    raw_text: str,
) -> Tuple[int, List[str]]:
    """4단계 판정 + 그 레벨을 유발한 근거 문구 목록."""
    thresholds = _seed.get(icao, {})
    ldm_vis = thresholds.get("vis_severe_m")
    ceil_severe = thresholds.get("ceiling_severe_ft")
    ceil_caution = thresholds.get("ceiling_caution_ft")

    triggers: List[Tuple[int, str]] = []

    if ldm_vis is not None and vis_m is not None:
        if vis_m < ldm_vis:
            triggers.append((4, f"시정 {vis_m:.0f}m (L/D MINIMUM {ldm_vis:.0f}m 미만)"))
        elif vis_m < ldm_vis + 800:
            triggers.append((3, f"시정 {vis_m:.0f}m (LDM+800m 미만)"))
        elif vis_m < ldm_vis + 1600:
            triggers.append((2, f"시정 {vis_m:.0f}m (LDM+1600m 미만)"))

    if ceiling_ft is not None:
        if ceil_severe is not None and ceiling_ft < ceil_severe:
            triggers.append((3, f"운고 {ceiling_ft:.0f}ft"))
        elif ceil_caution is not None and ceiling_ft < ceil_caution:
            triggers.append((2, f"운고 {ceiling_ft:.0f}ft"))

    has_ts = any(_TS_TOKEN_RE.match(t.upper()) for t in weather_tokens)
    if has_ts:
        triggers.append((3, "뇌우(TS) 인근"))
    elif "CB" in raw_text.upper():
        triggers.append((3, "CB 구름 인근"))

    snow_tier = _snow_tier(weather_tokens)
    if snow_tier == 3:
        triggers.append((3, "약한 눈(-SN)"))
    elif snow_tier == 4:
        triggers.append((4, "중/강한 눈(SN 이상)"))

    crosswind, _tailwind = _best_runway_wind(icao, wind_dir, wind_kt)
    gust = gust_kt or 0
    wind_level = 4 if icao == _CJU_ICAO else 3
    if crosswind >= _GENERAL_CROSSWIND_CAUTION_KT:
        triggers.append((wind_level, f"측풍 {crosswind:.0f}kt"))
    if gust >= _GENERAL_GUST_CAUTION_KT:
        triggers.append((wind_level, f"돌풍 {gust:.0f}kt"))

    if icao == _PUS_ICAO:
        tw36 = _tailwind_for_prefixes(_PUS_ICAO, ("RW36",), wind_dir, wind_kt)
        if tw36 >= _PUS_TAILWIND_CAUTION_KT:
            triggers.append((3, f"RWY36 배풍 {tw36:.0f}kt"))

    if icao == _CJU_ICAO:
        # METAR는 공항 대표 지점 한 곳의 바람이라 07/25 양끝이 기하학적으로 동시에
        # 배풍일 수 없지만(항상 한쪽은 맞바람), 실제로는 AMOS 활주로별 관측이 국지적으로
        # 갈려서 둘 다 배풍으로 찍히는 경우가 있다고 함 — METAR만으론 그 국지차를 못
        # 잡으므로, 07/25 기준 배풍이 임계치를 넘는지(둘 중 실제로 배풍인 쪽 기준)만 확인.
        tw0725 = _tailwind_for_prefixes(_CJU_ICAO, _CJU_RWY_PREFIXES, wind_dir, wind_kt)
        if tw0725 >= _CJU_TAILWIND_CAUTION_KT:
            triggers.append((4, f"RWY07/25 배풍 {tw0725:.0f}kt"))

    if not triggers:
        return 1, []
    level = max(lv for lv, _ in triggers)
    reasons = [r for lv, r in triggers if lv == level]
    return level, reasons
