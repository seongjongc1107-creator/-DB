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
import re
from pathlib import Path
from typing import Dict, List, Optional

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
