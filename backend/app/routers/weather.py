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

router = APIRouter()

AVWX_URL = "https://aviationweather.gov/api/data/metar"
ASOS_URL = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"

# task_id → progress dict (in-memory; cleared on restart)
_tasks: dict[str, dict] = {}


# ─── Shared parse helpers ──────────────────────────────────────────────────────

def _classify_category(vis_m: Optional[int], ceiling_ft: Optional[int]) -> str:
    vis_sm = (vis_m / 1852) if vis_m is not None else 10.0
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
        vis_m = round(vis_sm * 1852) if vis_sm is not None else None
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


def _wind_tok(t: str) -> Optional[dict]:
    m = re.match(r"^(VRB|\d{3})(\d{2,3})(?:G(\d{2,3}))?KT$", t, re.I)
    if not m:
        return None
    return {
        "wdir": None if m.group(1).upper() == "VRB" else int(m.group(1)),
        "wspd": int(m.group(2)),
        "wgst": int(m.group(3)) if m.group(3) else None,
    }


def _cond_from_tokens(tokens: list[str]) -> dict:
    wind = vis_m = ceiling_ft = None
    for t in tokens:
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
        if vis_m is None and re.match(r"^\d+(?:\.\d+)?SM$", t, re.I):
            vis_m = round(float(t[:-2]) * 1852)
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
    vis_m = round(vsby * 1852) if vsby is not None else None

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
    resp = await client.get(ASOS_URL, params=params, timeout=60)
    resp.raise_for_status()
    rows = _parse_asos_csv(resp.text)
    records = [r for row in rows if (r := _asos_row_to_record(row)) and r["icao"] == icao]
    return records


async def _bulk_insert(records: list[dict]) -> int:
    if not records:
        return 0
    async with AsyncSessionLocal() as session:
        stmt = make_upsert(MetarArchive, records)
        result = await session.execute(stmt)
        await session.commit()
        return result.rowcount or 0


async def _run_collect(task_id: str, icao: str, start: date, end: date) -> None:
    # Build list of month chunks
    months: list[tuple[date, date]] = []
    cur = start.replace(day=1)
    while cur <= end:
        next_m = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        chunk_end = min(next_m - timedelta(days=1), end)
        months.append((cur, chunk_end))
        cur = next_m

    _tasks[task_id].update({"total_months": len(months), "processed": 0, "inserted": 0})

    async with httpx.AsyncClient(timeout=90) as client:
        for i, (m_start, m_end) in enumerate(months):
            if _tasks[task_id].get("cancelled"):
                _tasks[task_id]["status"] = "cancelled"
                return
            try:
                records = await _fetch_asos(client, icao, m_start, m_end)
                n = await _bulk_insert(records)
                _tasks[task_id]["inserted"] += n
            except Exception as e:
                _tasks[task_id]["error"] = str(e)
            _tasks[task_id]["processed"] = i + 1
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
            return {"icao": icao, "metar": [], "taf_periods": [], "error": str(e)}

    if not isinstance(raw_list, list) or not raw_list:
        return {"icao": icao, "metar": [], "taf_periods": []}

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

    return {"icao": icao, "metar": metar_points, "taf_periods": taf_periods, "taf_raw": taf_raw}


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
        "status": "running", "total_months": 0, "processed": 0, "inserted": 0,
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
):
    """Return stored METAR time-series. Auto-downsamples for large ranges."""
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

    # Downsample for long ranges
    if delta_days > 30 and len(rows) > 1000:
        step = max(1, len(rows) // 1000)
        rows = rows[::step]

    points = [{
        "obs_time": r.obs_time.__class__.__name__ + "_REPLACE",
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
