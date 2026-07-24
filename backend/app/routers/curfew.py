"""
Curfew data management.
Accepts CSV or XLSX upload; persists to data/curfew.csv.

Expected columns (case-insensitive, order-free):
  icao, start, end, timezone, note
"""
from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Dict

from fastapi import APIRouter, File, HTTPException, UploadFile

router = APIRouter()

_DATA_FILE = Path(__file__).parent.parent.parent / "data" / "curfew.csv"
_curfews: Dict[str, dict] = {}


# ── parse ─────────────────────────────────────────────────────────────────

def _normalise_header(h: str) -> str:
    return h.strip().lower().replace(' ', '_').replace('-', '_')


def _parse_rows(rows: list[dict]) -> Dict[str, dict]:
    result: Dict[str, dict] = {}
    for row in rows:
        norm = {_normalise_header(k): (v or '').strip() for k, v in row.items()}
        icao = norm.get('icao', '').upper()
        if not icao:
            continue
        result[icao] = {
            'icao': icao,
            'start': norm.get('start', ''),
            'end': norm.get('end', ''),
            'timezone': norm.get('timezone', ''),
            'note': norm.get('note', ''),
        }
    return result


def _parse_csv_text(text: str) -> Dict[str, dict]:
    return _parse_rows(list(csv.DictReader(io.StringIO(text))))


def _parse_xlsx_bytes(data: bytes) -> Dict[str, dict]:
    try:
        import openpyxl
    except ImportError:
        raise HTTPException(400, "Excel 지원 불가: openpyxl이 설치되지 않았습니다")
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb.active
    rows_raw = list(ws.iter_rows(values_only=True))
    if not rows_raw:
        return {}
    header = [str(c or '').strip() for c in rows_raw[0]]
    result_rows = []
    for row in rows_raw[1:]:
        if all(c is None for c in row):
            continue
        result_rows.append(dict(zip(header, [str(c or '').strip() for c in row])))
    return _parse_rows(result_rows)


def _save_csv(data: Dict[str, dict]) -> None:
    _DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(_DATA_FILE, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['icao', 'start', 'end', 'timezone', 'note'])
        writer.writeheader()
        writer.writerows(data.values())


# ── startup ───────────────────────────────────────────────────────────────

def load_curfew_file() -> None:
    global _curfews
    if not _DATA_FILE.exists():
        return
    try:
        _curfews = _parse_csv_text(_DATA_FILE.read_text(encoding='utf-8-sig'))
        print(f"  curfew={len(_curfews)} airports loaded")
    except Exception as e:
        print(f"  [warn] curfew load failed: {e}")


# ── endpoints ─────────────────────────────────────────────────────────────

@router.get("/")
def get_curfews():
    return {'count': len(_curfews), 'curfews': list(_curfews.values())}


@router.post("/upload")
async def upload_curfew(file: UploadFile = File(...)):
    global _curfews
    content = await file.read()
    fname = (file.filename or '').lower()

    try:
        if fname.endswith('.xlsx') or fname.endswith('.xls'):
            parsed = _parse_xlsx_bytes(content)
        else:
            text = content.decode('utf-8-sig')
            parsed = _parse_csv_text(text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"파일 파싱 오류: {e}")

    if not parsed:
        raise HTTPException(400, "인식된 항목이 없습니다. 컬럼명(icao, start, end, timezone, note)을 확인하세요.")

    _curfews = parsed
    _save_csv(_curfews)
    return {'count': len(_curfews), 'curfews': list(_curfews.values())}


@router.delete("/")
def clear_curfews():
    global _curfews
    _curfews = {}
    if _DATA_FILE.exists():
        _DATA_FILE.unlink()
    return {'count': 0}
