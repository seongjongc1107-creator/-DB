"""
Weather router.
  GET  /metar                    real-time latest METAR (existing)
  GET  /metar/trend              real-time trend 1-48 h
  POST /history/collect          trigger background ASOS archive fetch
  GET  /history/status/{id}      collection progress
  GET  /history/trend            stored time-series query
  GET  /history/monthly          monthly aggregates
"""
from __future__ import annotations

import asyncio
import csv
import io
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from statistics import mean, quantiles
from typing import Optional

import httpx
from fastapi import APIRouter, BackgroundTasks, Query
from sqlalchemy import func, select, text

from app.db import AsyncSessionLocal, make_upsert
from app.models import MetarArchive
from app.wx_minima import get_seed as get_minima_seed

router = APIRouter()

AVWX_URL = "https://aviationweather.gov/api/data/metar"
AVWX_TAF_URL = "https://aviationweather.gov/api/data/taf"
ASOS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"

# aviationweather.gov "visib"·mesonet ASOS "vsby" 둘 다 단위가 statute mile —
# 예전에 해상거리 단위(nautical mile, 1852m)로 잘못 곱해서 실제보다 15% 크게
# 나오던 버그가 있었음(예: ZMUB 9999/CAVOK가 11501m로 표시됨 — 정상은 10000m)
_STATUTE_MILE_M = 1609.344

# task_id → progress dict (in-memory; cleared on restart)
_tasks: dict[str, dict] = {}


# ─── Shared parse helpers ──────────────────────────────────────────────────────

def _classify_category(vis_m: Optional[int], ceiling_ft: Optional[int]) -> str:
    vis_sm = (vis_m / _STATUTE_MILE_M) if vis_m is not None else 10.0
    ceil = ceiling_ft if ceiling_ft is not None else 99999
    if vis_sm < 1.0 or ceil < 500:
        return "LIFR"
    if vis_sm < 3.0 or ceil < 1000:
        return "IFR"
    if vis_sm < 5.0 or ceil < 3000:
        return "MVFR"
    return "VFR"


def _classify_level(flt_cat: str, wx_string: str, gust_kt: Optional[float]) -> int:
    has_ts = "TS" in (wx_string or "")
    gust = gust_kt or 0
    if flt_cat == "LIFR" or has_ts or gust > 40:
        return 3
    if flt_cat in ("MVFR", "IFR") or gust > 25:
        return 2
    return 1


def _parse_metar(raw: dict) -> dict:
    flt_cat = raw.get("fltcat") or raw.get("flightCategory") or raw.get("fltCat") or "VFR"
    wx_string = raw.get("wxString") or ""

    def _f(key) -> Optional[float]:
        v = raw.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    gust_kt = _f("wgst")
    wind_kt = _f("wspd")
    wind_dir_raw = raw.get("wdir")
    try:
        wind_dir = int(wind_dir_raw) if wind_dir_raw is not None else None
    except (TypeError, ValueError):
        wind_dir = None

    vis = raw.get("visib")
    try:
        vis_sm = float(str(vis).replace("+", "")) if vis is not None else None
        vis_m = round(vis_sm * _STATUTE_MILE_M) if vis_sm is not None else None
    except (TypeError, ValueError):
        vis_m = None

    ceiling_ft = None
    for i in range(1, 4):
        cvg = raw.get(f"cldCvg{i}", "")
        bas = raw.get(f"cldBas{i}")
        if cvg in ("BKN", "OVC") and bas is not None:
            try:
                ft = int(bas)
                ceiling_ft = ft if ceiling_ft is None else min(ceiling_ft, ft)
            except (TypeError, ValueError):
                pass
    for cloud in (raw.get("clouds") or []):
        if isinstance(cloud, dict) and cloud.get("cover") in ("BKN", "OVC"):
            try:
                ft = int(cloud["base"])
                ceiling_ft = ft if ceiling_ft is None else min(ceiling_ft, ft)
            except (TypeError, ValueError):
                pass

    temp_c = _f("temp")
    dewp_c = _f("dewp")
    altim = _f("altim")
    qnh_hpa = round(altim) if altim and altim > 100 else (round(altim * 33.8639) if altim else None)

    obs_raw = raw.get("obsTime") or raw.get("reportTime")
    if isinstance(obs_raw, (int, float)):
        obs_time = datetime.fromtimestamp(obs_raw, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    else:
        obs_time = str(obs_raw or "")

    return {
        "icao": raw.get("icaoId") or raw.get("stationId") or "",
        "raw": raw.get("rawOb") or "",
        "taf_raw": raw.get("rawTaf") or None,
        "level": _classify_level(flt_cat, wx_string, gust_kt),
        "flight_category": flt_cat,
        "vis_m": vis_m,
        "ceiling_ft": ceiling_ft,
        "wind_kt": wind_kt,
        "wind_dir": wind_dir,
        "gust_kt": gust_kt,
        "weather": [w.strip() for w in wx_string.split() if w.strip()] if wx_string else [],
        "temp_c": temp_c,
        "dewpoint_c": dewp_c,
        "qnh_hpa": qnh_hpa,
        "obs_time": obs_time,
    }


# ─── TAF parser ───────────────────────────────────────────────────────────────

def _ddhh_to_dt(ddhh: str, ref: datetime) -> datetime:
    dd, hh = int(ddhh[:2]), int(ddhh[2:4])
    ref_utc = ref if ref.tzinfo else ref.replace(tzinfo=timezone.utc)
    # TAF는 그날 자정을 "24시"로 표기하기도 함 (다음날 00Z와 동일) — datetime엔 없는 시각이라 별도 처리
    extra_day = hh == 24
    if extra_day:
        hh = 0
    try:
        dt = ref_utc.replace(day=dd, hour=hh, minute=0, second=0, microsecond=0)
    except ValueError:
        dt = ref_utc.replace(day=1, hour=hh, minute=0, second=0, microsecond=0)
    if extra_day:
        dt += timedelta(days=1)
    if dt < ref_utc - timedelta(days=20):
        m = ref_utc.month % 12 + 1
        y = ref_utc.year + (1 if ref_utc.month == 12 else 0)
        try:
            dt = dt.replace(year=y, month=m, day=dd)
        except ValueError:
            pass
    return dt


def _iso_z(dt: datetime) -> str:
    """Return UTC ISO string ending in Z (no +00:00)."""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


_WIND_UNIT_TO_KT = {"KT": 1.0, "MPS": 1.943844, "KMH": 0.539957}


def _wind_tok(t: str) -> Optional[dict]:
    # 몽골/중국 등 일부 공항은 TAF 풍속을 KT 대신 MPS(m/s)·KMH(km/h)로 발표함
    # (예: ZMCK "VRB02MPS") — 단위를 knots로 환산해서 다른 공항과 동일하게 비교
    m = re.match(r"^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$", t, re.I)
    if not m:
        return None
    factor = _WIND_UNIT_TO_KT[m.group(4).upper()]
    return {
        "wdir": None if m.group(1).upper() == "VRB" else int(m.group(1)),
        "wspd": round(int(m.group(2)) * factor),
        "wgst": round(int(m.group(3)) * factor) if m.group(3) else None,
    }


_SM_WHOLE_RE = re.compile(r"^[PM]?(\d+)SM$", re.I)
_SM_FRAC_RE = re.compile(r"^[PM]?(\d+)/(\d+)SM$", re.I)
_SM_MERGED_RE = re.compile(r"^(\d+)_(\d+)/(\d+)SM$", re.I)


def _merge_sm_fractions(tokens: list[str]) -> list[str]:
    """미국식 TAF는 '1 1/2SM'처럼 정수부와 분수부가 공백으로 분리되어 두 토큰으로
    쪼개져 들어오는 경우가 있음 — 뒤 토큰이 분수+SM이면 하나로 합쳐서 정상 계산."""
    out: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if i + 1 < len(tokens) and re.match(r"^\d+$", t) and re.match(r"^\d+/\d+SM$", tokens[i + 1], re.I):
            out.append(f"{t}_{tokens[i + 1]}")
            i += 2
            continue
        out.append(t)
        i += 1
    return out


def _cond_from_tokens(tokens: list[str]) -> dict:
    wind = vis_m = ceiling_ft = None
    for t in _merge_sm_fractions(tokens):
        if wind is None:
            w = _wind_tok(t)
            if w:
                wind = w
                continue
        if t == "CAVOK":
            vis_m = 9999
            continue
        if vis_m is None and re.match(r"^\d{4}$", t) and 0 <= int(t) <= 9999:
            vis_m = int(t)
            continue
        if vis_m is None:
            # 미국식 SM(statute mile) 표기 — P6SM(6마일 초과), M1/4SM(1/4마일 미만),
            # 3SM, 1/2SM, "1 1/2SM"(위에서 1_1/2SM으로 합쳐짐) 전부 처리
            mm = _SM_MERGED_RE.match(t)
            if mm:
                miles = int(mm.group(1)) + int(mm.group(2)) / int(mm.group(3))
                vis_m = round(miles * _STATUTE_MILE_M)
                continue
            mf = _SM_FRAC_RE.match(t)
            if mf:
                miles = int(mf.group(1)) / int(mf.group(2))
                vis_m = round(miles * _STATUTE_MILE_M)
                continue
            mw = _SM_WHOLE_RE.match(t)
            if mw:
                vis_m = round(int(mw.group(1)) * _STATUTE_MILE_M)
                continue
        mc = re.match(r"^(BKN|OVC)(\d{3})", t, re.I)
        if mc:
            ft = int(mc.group(2)) * 100
            ceiling_ft = ft if ceiling_ft is None else min(ceiling_ft, ft)
    return {
        "wdir": wind["wdir"] if wind else None,
        "wspd": wind["wspd"] if wind else None,
        "wgst": wind["wgst"] if wind else None,
        "vis_m": vis_m,
        "ceiling_ft": ceiling_ft,
    }


def parse_taf_periods(raw_taf: str, ref_dt: datetime) -> list[dict]:
    tokens = raw_taf.upper().split()
    # skip header: TAF [AMD|COR] ICAO DDHHMM[Z]
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t in ("TAF", "AMD", "COR"):
            i += 1
        elif re.match(r"^[A-Z]{4}$", t):
            i += 1
        elif re.match(r"^\d{6}Z?$", t):
            i += 1
            break
        else:
            break

    sections: list[tuple[str, list[str]]] = []
    cur_type, cur_tok = "BASE", []

    while i < len(tokens):
        t = tokens[i]
        if t == "RMK":
            break
        if t in ("BECMG", "TEMPO"):
            sections.append((cur_type, cur_tok))
            cur_type, cur_tok = t, []
        elif re.match(r"^FM\d{6}$", t):
            sections.append((cur_type, cur_tok))
            cur_type, cur_tok = t, []
        elif re.match(r"^PROB\d{2}$", t):
            sections.append((cur_type, cur_tok))
            if i + 1 < len(tokens) and tokens[i + 1] == "TEMPO":
                cur_type = t + "_TEMPO"
                i += 1
            else:
                cur_type = t
            cur_tok = []
        elif re.match(r"^T[NX][\d-]+/\d{4}Z?$", t):
            pass  # skip min/max temp lines
        else:
            cur_tok.append(t)
        i += 1
    sections.append((cur_type, cur_tok))

    periods = []
    for sec_type, sec_tok in sections:
        if sec_type.startswith("FM"):
            raw_time = sec_type[2:]  # DDHHMM
            dd, hh, mm = int(raw_time[:2]), int(raw_time[2:4]), int(raw_time[4:6])
            fm_dt = _ddhh_to_dt(f"{dd:02d}{hh:02d}", ref_dt).replace(minute=mm)
            conds = _cond_from_tokens(sec_tok)
            periods.append({"type": "FM", "from": _iso_z(fm_dt), "to": None, **conds})
        else:
            val_tok = next((t for t in sec_tok if re.match(r"^\d{4}/\d{4}$", t)), None)
            cond_tok = [t for t in sec_tok if t != val_tok]
            if val_tok:
                fr_s, to_s = val_tok.split("/")
                conds = _cond_from_tokens(cond_tok)
                periods.append({
                    "type": sec_type,
                    "from": _iso_z(_ddhh_to_dt(fr_s, ref_dt)),
                    "to": _iso_z(_ddhh_to_dt(to_s, ref_dt)),
                    **conds,
                })
    return periods


# ─── ASOS archive helpers ─────────────────────────────────────────────────────

def _parse_asos_csv(text: str) -> list[dict]:
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("#")]
    if len(lines) < 2:
        return []
    reader = csv.DictReader(lines)
    return list(reader)


def _asos_row_to_record(row: dict) -> Optional[dict]:
    valid_str = row.get("valid", "").strip()
    if not valid_str or valid_str == "M":
        return None
    try:
        obs_time = datetime.strptime(valid_str, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None

    def _fv(key) -> Optional[float]:
        v = row.get(key, "M").strip()
        if v in ("M", "", "T"):
            return None
        try:
            return float(v)
        except ValueError:
            return None

    tmpf, dwpf = _fv("tmpf"), _fv("dwpf")
    temp_c = round((tmpf - 32) * 5 / 9, 1) if tmpf is not None else None
    dewp_c = round((dwpf - 32) * 5 / 9, 1) if dwpf is not None else None

    drct = _fv("drct")
    sknt = _fv("sknt")
    gust = _fv("gust")

    alti = _fv("alti")
    qnh_hpa = round(alti * 33.8639) if alti is not None else None

    vsby = _fv("vsby")
    vis_m = round(vsby * _STATUTE_MILE_M) if vsby is not None else None

    ceiling_ft = None
    for i in range(1, 5):
        cov = row.get(f"skyc{i}", "M").strip()
        h = _fv(f"skyl{i}")
        if cov in ("BKN", "OVC") and h is not None:
            ceiling_ft = int(h) if ceiling_ft is None else min(ceiling_ft, int(h))

    icao = row.get("station", "").strip().upper()
    flt_cat = _classify_category(vis_m, ceiling_ft)

    return {
        "icao": icao,
        "obs_time": obs_time,
        "wdir": int(drct) if drct is not None else None,
        "wspd": sknt,
        "wgst": gust,
        "vis_m": vis_m,
        "ceiling_ft": ceiling_ft,
        "temp_c": temp_c,
        "dewpoint_c": dewp_c,
        "qnh_hpa": qnh_hpa,
        "flight_category": flt_cat,
        "raw": row.get("metar", "").strip(),
    }


async def _fetch_asos(client: httpx.AsyncClient, icao: str, start: date, end: date) -> list[dict]:
    params = {
        "station": icao,
        "data": "all",
        "year1": str(start.year), "month1": str(start.month), "day1": str(start.day),
        "year2": str(end.year), "month2": str(end.month), "day2": str(end.day),
        "tz": "UTC",
        "format": "comma",
        "latlon": "no",
        "direct": "yes",
        "report_type": "3,1",
    }
    # mesonet은 짧은 시간에 요청이 몰리면 429를 던지는데, 여기서 바로 포기하면
    # 그 구간만 통째로 비어버려서(원래 문의였던 "듬성듬성 빈 데이터"가 재발함)
    # 잠깐 쉬었다가 몇 번 재시도함
    for attempt in range(4):
        resp = await client.get(ASOS_URL, params=params, timeout=180)
        if resp.status_code == 429:
            await asyncio.sleep(5 * (attempt + 1))
            continue
        resp.raise_for_status()
        rows = _parse_asos_csv(resp.text)
        return [r for row in rows if (r := _asos_row_to_record(row)) and r["icao"] == icao]
    resp.raise_for_status()
    return []


_METAR_COLS = 12  # MetarArchive 컬럼 수 — 청크 크기 계산용
_SQLITE_MAX_VARS = 900  # SQLite 바인드 파라미터 상한(구버전 999)보다 여유 있게 낮춰서 안전하게

async def _bulk_insert(records: list[dict]) -> int:
    """한 번에 다 INSERT하면(예: ZMCK처럼 오래 안 모은 공항을 몇 년치 몰아서
    수집할 때) 레코드 수 × 컬럼 수가 SQLite 바인드 파라미터 상한을 넘어서
    "too many SQL variables"로 통째로 실패함 — 청크로 쪼개서 나눠 넣음."""
    if not records:
        return 0
    chunk_size = max(1, _SQLITE_MAX_VARS // _METAR_COLS)
    total = 0
    async with AsyncSessionLocal() as session:
        for i in range(0, len(records), chunk_size):
            stmt = make_upsert(MetarArchive, records[i:i + chunk_size])
            result = await session.execute(stmt)
            total += result.rowcount or 0
        await session.commit()
    return total


# 한 달치를 이미 촘촘하게 갖고 있으면(하루 평균 18건 이상 — ASOS는 보통 시간당
# 1건, 결측 며칠 정도는 허용) 재수집을 건너뜀. 이게 없으면 "조회"할 때마다 이미
# 수집된 달까지 매번 외부 API를 다시 긁어와서 느려지고, mesonet에도 불필요한
# 부하를 줌.
_MIN_ROWS_PER_DAY = 18


async def _month_has_data(icao: str, m_start: date, m_end: date) -> bool:
    async with AsyncSessionLocal() as session:
        q = select(func.count()).select_from(MetarArchive).where(
            MetarArchive.icao == icao,
            MetarArchive.obs_time >= datetime.combine(m_start, datetime.min.time()),
            MetarArchive.obs_time <= datetime.combine(m_end, datetime.max.time()),
        )
        result = await session.execute(q)
        count = result.scalar_one()
    days = (m_end - m_start).days + 1
    return count >= days * _MIN_ROWS_PER_DAY


async def _run_collect(task_id: str, icao: str, start: date, end: date) -> None:
    # Build list of month chunks
    months: list[tuple[date, date]] = []
    cur = start.replace(day=1)
    while cur <= end:
        next_m = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        chunk_end = min(next_m - timedelta(days=1), end)
        months.append((cur, chunk_end))
        cur = next_m

    _tasks[task_id].update({"total_months": len(months), "processed": 0, "inserted": 0, "skipped": 0})

    # 이미 촘촘히 수집된 달은 건너뛰고(스킵), 수집이 필요한 달만 골라 서로 연속된
    # 구간끼리 하나의 요청으로 묶어서 보냄 — mesonet은 요청 1건당 자체 지연이 커서
    # (달 하나만 요청해도 3~4초) 여러 해를 달 단위로 쪼개 순차 요청하면 수백 초씩
    # 걸리고 요청 수가 많아질수록 429(rate limit)에도 잘 걸림. 반대로 같은 기간을
    # 통째로 한 번에 요청하면(예: 5년치) 40초 안팎에 끝남 — 실측 확인함.
    needed: list[tuple[date, date]] = []
    for m_start, m_end in months:
        if _tasks[task_id].get("cancelled"):
            _tasks[task_id]["status"] = "cancelled"
            return
        if await _month_has_data(icao, m_start, m_end):
            _tasks[task_id]["skipped"] += 1
            _tasks[task_id]["processed"] += 1
        else:
            needed.append((m_start, m_end))

    windows: list[tuple[date, date]] = []
    for m_start, m_end in needed:
        if windows and windows[-1][1] + timedelta(days=1) == m_start:
            windows[-1] = (windows[-1][0], m_end)
        else:
            windows.append((m_start, m_end))

    async with httpx.AsyncClient(timeout=180) as client:
        for w_start, w_end in windows:
            if _tasks[task_id].get("cancelled"):
                _tasks[task_id]["status"] = "cancelled"
                return
            try:
                records = await _fetch_asos(client, icao, w_start, w_end)
                n = await _bulk_insert(records)
                _tasks[task_id]["inserted"] += n
            except Exception as e:
                _tasks[task_id]["error"] = str(e)
            _tasks[task_id]["processed"] += sum(1 for m_start, _ in needed if w_start <= m_start <= w_end)
            await asyncio.sleep(0.3)

    _tasks[task_id]["status"] = "done"


# ─── Monthly aggregation ──────────────────────────────────────────────────────

def _monthly_stats(rows: list[MetarArchive]) -> list[dict]:
    from collections import defaultdict
    buckets: dict[str, list] = defaultdict(list)
    for r in rows:
        key = r.obs_time.strftime("%Y-%m")
        buckets[key].append(r)

    result = []
    for month in sorted(buckets):
        recs = buckets[month]
        def _vals(attr):
            return [getattr(r, attr) for r in recs if getattr(r, attr) is not None]

        def _pct(vals, p):
            if not vals:
                return None
            s = sorted(vals)
            idx = max(0, round(p / 100 * len(s)) - 1)
            return round(s[idx], 1)

        wspds = _vals("wspd")
        vis_ms = _vals("vis_m")
        ceils = _vals("ceiling_ft")
        temps = _vals("temp_c")
        qnhs = _vals("qnh_hpa")

        cats = [r.flight_category for r in recs if r.flight_category]
        total = len(cats) or 1

        result.append({
            "month": month,
            "count": len(recs),
            "avg_wspd": round(mean(wspds), 1) if wspds else None,
            "p10_wspd": _pct(wspds, 10),
            "p90_wspd": _pct(wspds, 90),
            "avg_vis_m": round(mean(vis_ms)) if vis_ms else None,
            "p10_vis_m": _pct(vis_ms, 10),
            "avg_ceiling_ft": round(mean(ceils)) if ceils else None,
            "avg_temp_c": round(mean(temps), 1) if temps else None,
            "avg_qnh_hpa": round(mean(qnhs)) if qnhs else None,
            "cat_vfr": round(cats.count("VFR") / total, 3),
            "cat_mvfr": round(cats.count("MVFR") / total, 3),
            "cat_ifr": round(cats.count("IFR") / total, 3),
            "cat_lifr": round(cats.count("LIFR") / total, 3),
        })
    return result


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/metar")
async def get_metar(icaos: str = Query(...)):
    ids = [i.strip().upper() for i in icaos.split(",") if i.strip()]
    if not ids:
        return {"data": []}
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(AVWX_URL, params={
                "ids": ",".join(ids), "format": "json", "taf": "true", "hours": "2",
            })
            resp.raise_for_status()
            raw_list = resp.json()
        except Exception as e:
            return {"data": [], "error": str(e)}
    if not isinstance(raw_list, list):
        return {"data": [], "error": "Unexpected response"}
    return {"data": [_parse_metar(r) for r in raw_list]}


async def _fetch_taf_history(icao: str, hours: int) -> list[dict]:
    """과거 시점별로 '그때 실제 유효했던 최신 TAF'를 재구성.

    aviationweather.gov의 /metar 엔드포인트는 taf=true를 줘도 매 관측치에 항상
    현재(최신) TAF 텍스트 하나만 붙여주기 때문에, 그걸로 과거를 평가하면 BASE
    구간(발표 시각 이전 전체)이 일직선으로 깔려버림. 대신 /taf 엔드포인트가 지원하는
    date= 파라미터로 "그 시각 기준 가장 최근 TAF"를 골라올 수 있어, TAF 정규 발표
    주기(6시간)에 맞춰 과거 구간을 샘플링해서 실제 발표 이력에 가깝게 재구성함.
    """
    now = datetime.now(timezone.utc)
    sample_times: list[datetime] = []
    t = now - timedelta(hours=hours)
    while t <= now:
        sample_times.append(t)
        t += timedelta(hours=6)
    if not sample_times or sample_times[-1] != now:
        sample_times.append(now)

    async def fetch_at(client: httpx.AsyncClient, dt: datetime) -> Optional[tuple[str, str]]:
        try:
            r = await client.get(AVWX_TAF_URL, params={
                "ids": icao, "format": "json", "date": dt.strftime("%Y%m%d_%H%M"),
            })
            r.raise_for_status()
            arr = r.json()
            if not arr:
                return None
            item = arr[0]
            raw = item.get("rawTAF")
            issue = item.get("issueTime")
            if not raw or not issue:
                return None
            return issue, raw
        except Exception:
            return None

    async with httpx.AsyncClient(timeout=15) as client:
        results = await asyncio.gather(*[fetch_at(client, t) for t in sample_times])

    seen_raw: set[str] = set()
    history: list[dict] = []
    for r in results:
        if r is None or r[1] in seen_raw:
            continue
        seen_raw.add(r[1])
        issue_str, raw = r
        try:
            issue_dt = datetime.fromisoformat(issue_str.rstrip("Z")).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        history.append({
            "issue_time": issue_dt.isoformat().replace("+00:00", "Z"),
            "raw": raw,
            "periods": parse_taf_periods(raw, issue_dt),
        })
    history.sort(key=lambda h: h["issue_time"])
    return history


@router.get("/metar/trend")
async def get_metar_trend(
    icao: str = Query(...),
    hours: int = Query(24, ge=1, le=48),
):
    """Real-time METAR time-series + parsed TAF (up to 48 h)."""
    icao = icao.strip().upper()
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(AVWX_URL, params={
                "ids": icao, "format": "json", "taf": "true", "hours": str(hours),
            })
            resp.raise_for_status()
            raw_list = resp.json()
        except Exception as e:
            return {"icao": icao, "metar": [], "taf_periods": [], "taf_history": [], "error": str(e)}

    if not isinstance(raw_list, list) or not raw_list:
        return {"icao": icao, "metar": [], "taf_periods": [], "taf_history": []}

    raw_list.sort(key=lambda r: r.get("obsTime") or r.get("reportTime") or 0)
    parsed = [_parse_metar(r) for r in raw_list]

    metar_points = [{
        "obs_time": p["obs_time"],
        "wdir": p["wind_dir"],
        "wspd": p["wind_kt"],
        "wgst": p["gust_kt"],
        "vis_m": p["vis_m"],
        "ceiling_ft": p["ceiling_ft"],
        "temp_c": p["temp_c"],
        "dewpoint_c": p["dewpoint_c"],
        "qnh_hpa": p["qnh_hpa"],
        "flight_category": p["flight_category"],
        "raw": p["raw"],
    } for p in parsed]

    taf_raw = next((r.get("rawTaf") for r in reversed(raw_list) if r.get("rawTaf")), None)
    taf_periods = []
    if taf_raw:
        try:
            latest = raw_list[-1]
            ref_str = latest.get("reportTime") or latest.get("receiptTime") or ""
            ref_dt = datetime.fromisoformat(ref_str.rstrip("Z")).replace(tzinfo=timezone.utc)
        except Exception:
            ref_dt = datetime.now(timezone.utc)
        taf_periods = parse_taf_periods(taf_raw, ref_dt)

    taf_history = await _fetch_taf_history(icao, hours)

    return {
        "icao": icao, "metar": metar_points,
        "taf_periods": taf_periods, "taf_raw": taf_raw,
        "taf_history": taf_history,
    }


@router.post("/history/collect")
async def history_collect(
    background_tasks: BackgroundTasks,
    icao: str = Query(...),
    start: str = Query(..., description="YYYY-MM-DD"),
    end: str = Query(..., description="YYYY-MM-DD"),
):
    """Trigger background ASOS data collection for the given period."""
    icao = icao.strip().upper()
    try:
        start_d = date.fromisoformat(start)
        end_d = date.fromisoformat(end)
    except ValueError:
        return {"error": "Invalid date format. Use YYYY-MM-DD."}
    if end_d < start_d:
        return {"error": "end must be >= start"}

    task_id = str(uuid.uuid4())
    _tasks[task_id] = {
        "icao": icao, "start": start, "end": end,
        "status": "running", "total_months": 0, "processed": 0, "inserted": 0, "skipped": 0,
        "error": None, "cancelled": False,
    }
    background_tasks.add_task(_run_collect, task_id, icao, start_d, end_d)
    return {"task_id": task_id}


@router.get("/history/status/{task_id}")
async def history_status(task_id: str):
    t = _tasks.get(task_id)
    if not t:
        return {"error": "Task not found"}
    return t


@router.get("/history/trend")
async def history_trend(
    icao: str = Query(...),
    start: str = Query(...),
    end: str = Query(...),
    raw: bool = Query(False, description="true면 다운샘플링 없이 원본 그대로 반환 (CSV 내보내기용)"),
):
    """Return stored METAR time-series. Auto-downsamples for large ranges (unless raw=true)."""
    icao = icao.strip().upper()
    try:
        start_dt = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
        end_dt = datetime.fromisoformat(end).replace(tzinfo=timezone.utc) + timedelta(days=1)
    except ValueError:
        return {"error": "Invalid date"}

    delta_days = (end_dt - start_dt).days

    async with AsyncSessionLocal() as session:
        q = (
            select(MetarArchive)
            .where(MetarArchive.icao == icao)
            .where(MetarArchive.obs_time >= start_dt.replace(tzinfo=None))
            .where(MetarArchive.obs_time < end_dt.replace(tzinfo=None))
            .order_by(MetarArchive.obs_time)
        )
        result = await session.execute(q)
        rows = result.scalars().all()

    # 장기 구간 다운샘플링 — 예전엔 "N번째 행마다 하나씩" 뽑았는데, 이러면 안개나
    # 돌풍처럼 몇 시간만 지속되는 실제 기상 이벤트가 표본 지점에 우연히 걸리지
    # 않는 한 통째로 사라져서, 차트가 "평평하다가 가끔 뾰족하게 튀는" 부자연스러운
    # 모습이 됨(듬성듬성 비어 보이는 원인). 대신 구간(버킷)마다 최악값(최저 시정·
    # 최저 운고·최대 풍속/돌풍)을 골라 대표점으로 삼아, 다운샘플링을 하더라도
    # 실제 있었던 악기상 이벤트가 묻히지 않게 함.
    # CSV 내보내기(raw=true)는 화면 차트와 달리 렌더링 부담이 없으니 다운샘플링을
    # 아예 건너뛰고 원본 시간당 데이터를 그대로 내보냄.
    if not raw and delta_days > 30 and len(rows) > 1000:
        bucket_size = max(1, len(rows) // 1000)
        bucketed = []
        for i in range(0, len(rows), bucket_size):
            chunk = rows[i:i + bucket_size]
            mid = chunk[len(chunk) // 2]

            def _extreme(attr: str, fn):
                vals = [getattr(r, attr) for r in chunk if getattr(r, attr) is not None]
                return fn(vals) if vals else None

            vis_m = _extreme("vis_m", min)
            ceiling_ft = _extreme("ceiling_ft", min)
            bucketed.append({
                "obs_time": mid.obs_time.isoformat() + "Z",
                "wdir": mid.wdir,
                "wspd": _extreme("wspd", max),
                "wgst": _extreme("wgst", max),
                "vis_m": vis_m,
                "ceiling_ft": ceiling_ft,
                "temp_c": mid.temp_c,
                "dewpoint_c": mid.dewpoint_c,
                "qnh_hpa": mid.qnh_hpa,
                "flight_category": _classify_category(vis_m, ceiling_ft),
                "raw": mid.raw,
            })
        points = bucketed
    else:
        points = [{
            "obs_time": r.obs_time.isoformat() + "Z",
            "wdir": r.wdir,
            "wspd": r.wspd,
            "wgst": r.wgst,
            "vis_m": r.vis_m,
            "ceiling_ft": r.ceiling_ft,
            "temp_c": r.temp_c,
            "dewpoint_c": r.dewpoint_c,
            "qnh_hpa": r.qnh_hpa,
            "flight_category": r.flight_category,
            "raw": r.raw,
        } for r in rows]

    return {"icao": icao, "count": len(points), "points": points}


@router.get("/history/monthly")
async def history_monthly(
    icao: str = Query(...),
    start: str = Query(...),
    end: str = Query(...),
):
    """Monthly aggregated statistics for seasonal analysis."""
    icao = icao.strip().upper()
    try:
        start_dt = datetime.fromisoformat(start).replace(tzinfo=timezone.utc)
        end_dt = datetime.fromisoformat(end).replace(tzinfo=timezone.utc) + timedelta(days=1)
    except ValueError:
        return {"error": "Invalid date"}

    async with AsyncSessionLocal() as session:
        q = (
            select(MetarArchive)
            .where(MetarArchive.icao == icao)
            .where(MetarArchive.obs_time >= start_dt.replace(tzinfo=None))
            .where(MetarArchive.obs_time < end_dt.replace(tzinfo=None))
            .order_by(MetarArchive.obs_time)
        )
        result = await session.execute(q)
        rows = result.scalars().all()

    months = _monthly_stats(rows)
    return {"icao": icao, "months": months}


@router.get("/minima-seed")
async def minima_seed():
    """WX MINIMA CSV(접근방식별 RVR/VIS/DH)에서 산출한 공항별 기상 임계값 기본값 —
    사용자가 개별로 임계값을 설정하지 않은 공항에 폴백으로 쓰임(app/wx_minima.py)."""
    return get_minima_seed()
