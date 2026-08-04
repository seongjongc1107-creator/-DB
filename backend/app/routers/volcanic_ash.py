"""전 세계 화산재주의보센터(VAAC) 화산재 권고(VAA) 연동.

호주 기상청(BOM)이 운영하는 집계 페이지 하나에 전 세계 9개 VAAC
(Anchorage/Buenos Aires/Darwin/London/Montreal/Tokyo/Toulouse/
Washington/Wellington)의 최근 7일 권고 전문이 모두 올라옴 — 요청 1번으로
동남아(다윈 관할 — 발리 인근 스메루/르워토비 등)까지 포함한 전 지역을
커버할 수 있어 도쿄 단독 스크래핑보다 범위가 넓고 요청 수도 적음.
"""

import html
import re
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter

router = APIRouter()

BOM_URL = "https://www.bom.gov.au/products/Volc_ash_recent.shtml"
UA = {"User-Agent": "Mozilla/5.0 (compatible; FlightRouteDashboard/1.0)"}

VAAC_BLOCK_RE = re.compile(
    r"<h3>([^<]+?)\s*VAAC</h3>\s*<pre>(.*?)</pre>", re.DOTALL | re.IGNORECASE
)
ADVISORY_SPLIT_RE = re.compile(r"(?=Received\s+F\w+\d*\s+at\b)")

# ── 전문(ICAO VAA 표준 양식) 필드 파싱 ──────────────────────────────────────
# 다윈/워싱턴 등은 "OBS VA CLD" 대신 "EST VA CLD"(추정) 표현을 씀 — 도쿄 포맷과
# 동일하게 취급.
FIELD_LABELS = [
    ("dtg", r"DTG:"),
    ("vaac", r"VAAC:"),
    ("volcano", r"VOLCANO:"),
    ("psn", r"PSN:"),
    ("area", r"AREA:"),
    ("elev", r"(?:SOURCE|SUMMIT) ELEV:"),
    ("advisory_nr", r"ADVISORY NR:"),
    ("info_source", r"INFO SOURCE:"),
    ("obs_dtg", r"(?:OBS|EST) VA DTG:"),
    ("obs_cld", r"(?:OBS|EST) VA CLD:"),
    ("fcst_6", r"FCST VA CLD\s*\+6\s*HR:"),
    ("fcst_12", r"FCST VA CLD\s*\+12\s*HR:"),
    ("fcst_18", r"FCST VA CLD\s*\+18\s*HR:"),
    ("rmk", r"RMK:"),
    ("nxt", r"NXT ADVISORY:"),
]


def _parse_vaa_fields(text: str) -> dict[str, str]:
    text = text.upper()
    positions = []
    for key, pattern in FIELD_LABELS:
        m = re.search(pattern, text)
        if m:
            positions.append((m.start(), m.end(), key))
    positions.sort()
    fields: dict[str, str] = {}
    for i, (_, end, key) in enumerate(positions):
        next_start = positions[i + 1][0] if i + 1 < len(positions) else len(text)
        fields[key] = text[end:next_start].strip().rstrip("=").strip()
    return fields


# 위경도 DMS 토큰(접두형 "N5639"/접미형 "5639N" 둘 다) — SpatialSearchPanel의
# 프론트엔드 파서와 동일한 방식. VAA는 초 단위 없이 도+분(4/5자리)만 씀.
DMS_TOKEN_RE = re.compile(
    r"(?:[NS](?:\d{6}|\d{4}))|(?:[EW](?:\d{7}|\d{5}))"
    r"|(?:(?:\d{6}|\d{4})[NS])|(?:(?:\d{7}|\d{5})[EW])"
)


def _dms_token_to_value(token: str) -> tuple[str, float] | None:
    m = re.match(r"^([NS])(\d{2})(\d{2})(\d{2})?$", token)
    if m:
        d, deg, mn, sec = m.groups()
        val = int(deg) + int(mn) / 60 + (int(sec) if sec else 0) / 3600
        return ("lat", -val if d == "S" else val)
    m = re.match(r"^([EW])(\d{3})(\d{2})(\d{2})?$", token)
    if m:
        d, deg, mn, sec = m.groups()
        val = int(deg) + int(mn) / 60 + (int(sec) if sec else 0) / 3600
        return ("lon", -val if d == "W" else val)
    m = re.match(r"^(\d{2})(\d{2})(\d{2})?([NS])$", token)
    if m:
        deg, mn, sec, d = m.groups()
        val = int(deg) + int(mn) / 60 + (int(sec) if sec else 0) / 3600
        return ("lat", -val if d == "S" else val)
    m = re.match(r"^(\d{3})(\d{2})(\d{2})?([EW])$", token)
    if m:
        deg, mn, sec, d = m.groups()
        val = int(deg) + int(mn) / 60 + (int(sec) if sec else 0) / 3600
        return ("lon", -val if d == "W" else val)
    return None


def _extract_polygon(text: str) -> list[list[float]] | None:
    """텍스트에서 위경도 토큰을 순서대로 뽑아 [lon, lat] 폴리곤으로 짝지음.
    "NO VA EXP"/"NOT AVBL"처럼 좌표가 아예 없으면 None."""
    tokens = DMS_TOKEN_RE.findall(text)
    values = [v for t in tokens if (v := _dms_token_to_value(t)) is not None]
    pairs: list[list[float]] = []
    i = 0
    while i + 1 < len(values):
        a, b = values[i], values[i + 1]
        if a[0] == "lat" and b[0] == "lon":
            pairs.append([b[1], a[1]])
        elif a[0] == "lon" and b[0] == "lat":
            pairs.append([a[1], b[1]])
        else:
            return None
        i += 2
    if len(pairs) < 3:
        return None
    pairs = _unwrap_antimeridian(pairs)
    # VAA 전문의 좌표 목록은 마지막 점이 첫 점으로 되돌아오는 걸 명시하지 않는 경우가
    # 많음 — GeoJSON/turf는 닫힌 링을 요구하므로(첫 점=끝 점) 안 닫혀 있으면 닫아줌.
    # 이게 안 닫혀 있으면 turf.polygon()이 예외를 던져서(항로 교차 판정에서 조용히
    # 무시됨) 화산재 구역이 지도엔 보여도 "영향 항로" 판정에는 전혀 안 잡히는 버그가 있었음.
    if pairs[0] != pairs[-1]:
        pairs = pairs + [pairs[0]]
    return pairs


def _unwrap_antimeridian(pairs: list[list[float]]) -> list[list[float]]:
    """캄차카·알류샨 근처 화산재 구역은 종종 180도선을 넘나드는데, 그대로 두면
    지도가 반대쪽(유럽·아프리카 방향)으로 쭉 이어 그려서 폴리곤이 지구 반 바퀴를
    도는 것처럼 잘못 표시됨. 음수 경도를 +360 시프트해서 하나의 연속된 범위로
    펴줌(예: 177°E ~ -171°W → 177°E ~ 189°E)."""
    lons = [p[0] for p in pairs]
    if max(lons) - min(lons) <= 180:
        return pairs
    return [[(lon + 360) if lon < 0 else lon, lat] for lon, lat in pairs]


def _extract_fl_range(text: str) -> tuple[int | None, int | None]:
    m = re.search(r"FL(\d+)/FL(\d+)", text)
    if m:
        return int(m.group(1)) * 100, int(m.group(2)) * 100
    m = re.search(r"SFC/FL(\d+)", text)
    if m:
        return 0, int(m.group(1)) * 100
    m = re.search(r"FL(\d+)/SFC", text)
    if m:
        return 0, int(m.group(1)) * 100
    return None, None


def _extract_step_dtg(text: str) -> str | None:
    m = re.match(r"^(\d{2}/\d{4}Z)", text.strip())
    return m.group(1) if m else None


FULL_DTG_RE = re.compile(r"(\d{8}/\d{4}Z)")


def _parse_next_advisory_dtg(nxt_text: str) -> datetime | None:
    """NXT ADVISORY 필드는 "20260803/0000Z"처럼 절대시각 그대로 오거나
    "WILL BE ISSUED BY 20260804/0300Z"/"NO LATER THAN ..." 처럼 문구가 붙기도 함 —
    어느 위치에 있든 DTG 패턴만 뽑아냄."""
    m = FULL_DTG_RE.search(nxt_text)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%d/%H%MZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _parse_psn(psn: str) -> tuple[float, float] | None:
    tokens = DMS_TOKEN_RE.findall(psn)
    values = [v for t in tokens if (v := _dms_token_to_value(t)) is not None]
    lat = next((v for k, v in values if k == "lat"), None)
    lon = next((v for k, v in values if k == "lon"), None)
    if lat is None or lon is None:
        return None
    return lat, lon


def _build_step(label: str, field_text: str | None) -> dict | None:
    if not field_text:
        return None
    if "NO VA EXP" in field_text or "NOT AVBL" in field_text:
        return {"label": label, "time": _extract_step_dtg(field_text), "polygon": None,
                "fl_min": None, "fl_max": None, "status": "no_ash"}
    polygon = _extract_polygon(field_text)
    fl_min, fl_max = _extract_fl_range(field_text) if polygon else (None, None)
    return {
        "label": label,
        "time": _extract_step_dtg(field_text),
        "polygon": polygon,
        "fl_min": fl_min,
        "fl_max": fl_max,
        "status": "ash" if polygon else "unknown",
    }


RAW_TEXT_BREAK_RE = re.compile(
    r"\s*(?=(?:(?<!VA )DTG:|VAAC:|VOLCANO:|PSN:|AREA:|SOURCE ELEV:|ADVISORY NR:|INFO SOURCE:"
    r"|ERUPTION DETAILS:|(?:OBS|EST) VA DTG:|(?:OBS|EST) VA CLD:|FCST VA CLD|RMK:|NXT ADVISORY:))",
    re.IGNORECASE,
)


def _format_raw_text(text: str) -> str:
    """전문을 원래 텔레그램처럼 필드마다 줄바꿈해서 보기 좋게 — 팝업에 그대로 표시."""
    collapsed = re.sub(r"\s+", " ", text).strip().rstrip("=").strip()
    return RAW_TEXT_BREAK_RE.sub("\n", collapsed).strip()


def _parse_advisory(vaac_name: str, chunk: str) -> dict | None:
    fields = _parse_vaa_fields(chunk)
    if "volcano" not in fields or "dtg" not in fields:
        return None  # 헤더/타이틀 조각(첫 "Received" 이전) 등 실제 권고가 아님

    if "NO FURTHER ADVISORIES" in fields.get("nxt", ""):
        return {
            "terminal": True,
            "volcano": fields.get("volcano", "").split()[0] if fields.get("volcano") else "UNKNOWN",
            "dtg": fields.get("dtg", ""),
        }

    end = chunk.find("=")
    raw_text = _format_raw_text(chunk[: end + 1] if end != -1 else chunk)

    psn = _parse_psn(fields.get("psn", ""))
    steps = [
        _build_step("OBS", fields.get("obs_cld")),
        _build_step("+6HR", fields.get("fcst_6")),
        _build_step("+12HR", fields.get("fcst_12")),
        _build_step("+18HR", fields.get("fcst_18")),
    ]
    steps = [s for s in steps if s is not None]

    return {
        "terminal": False,
        "volcano": fields.get("volcano", "").split()[0] if fields.get("volcano") else "UNKNOWN",
        "area": fields.get("area", ""),
        "lat": psn[0] if psn else None,
        "lon": psn[1] if psn else None,
        "advisory_nr": fields.get("advisory_nr", ""),
        "dtg": fields.get("dtg", ""),
        "vaac": fields.get("vaac", "").strip() or vaac_name.upper(),
        "steps": steps,
        "raw_text": raw_text,
        "_next_advisory_utc": _parse_next_advisory_dtg(fields.get("nxt", "")),
    }


@router.get("/active")
async def get_active_volcanic_ash():
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(BOM_URL, headers=UA, timeout=20)
            resp.raise_for_status()
            page_html = resp.text
    except Exception as e:
        return {"source": "bom_aggregator", "count": 0, "advisories": [], "error": str(e)}

    blocks = VAAC_BLOCK_RE.findall(page_html)
    vaacs_covered = [name.strip() for name, _ in blocks]

    # 화산 이름별로 가장 최근 권고 하나만 유지(같은 화산에 대해 여러 건이 쌓여있음).
    # DTG가 "YYYYMMDD/HHMMZ" 형식이라 문자열 비교만으로도 최신순 정렬 가능.
    latest_by_volcano: dict[str, dict] = {}
    for vaac_name, pre_content in blocks:
        content = html.unescape(pre_content)
        chunks = ADVISORY_SPLIT_RE.split(content)
        for chunk in chunks:
            parsed = _parse_advisory(vaac_name, chunk)
            if not parsed:
                continue
            key = parsed["volcano"]
            prev = latest_by_volcano.get(key)
            if parsed.get("terminal"):
                # "NO FURTHER ADVISORIES"가 현재 들고 있는 마지막 권고보다 같거나
                # 최신이면 화산재 구역이 이미 종료된 것 — 목록에서 제거해서 지도에
                # 안 남게 함. (예전엔 이 종료 신호를 그냥 건너뛰어서 마지막 권고가
                # 영원히 표시되는 버그가 있었음)
                if prev is None or parsed["dtg"] >= prev["dtg"]:
                    latest_by_volcano.pop(key, None)
                continue
            if prev is None or parsed["dtg"] > prev["dtg"]:
                latest_by_volcano[key] = parsed

    # "NXT ADVISORY"로 예고한 다음 권고 예정 시각을 이미 한참(유예 3시간) 넘겼는데도
    # 새 권고가 안 올라왔으면 — VAAC가 "NO FURTHER ADVISORIES" 같은 명시적 종료
    # 신호 없이 그냥 갱신을 멈춘 경우 — 낡은 예보를 현재 유효한 것처럼 계속 띄우게
    # 됨(사쿠라지마에서 실제로 발생: 다음 권고 예정을 26시간 넘게 지나서도 8/2
    # 권고가 그대로 남아있었음). 다음 권고 예정 시각을 못 읽은 경우엔 판단 근거가
    # 없으니 안전하게 그대로 유지.
    now = datetime.now(timezone.utc)
    GRACE = timedelta(hours=3)
    advisories = []
    for adv in latest_by_volcano.values():
        next_due = adv.pop("_next_advisory_utc", None)
        if next_due is not None and now > next_due + GRACE:
            continue
        advisories.append(adv)

    return {
        "source": "bom_aggregator",
        "count": len(advisories),
        "advisories": advisories,
        "vaacs_covered": vaacs_covered,
    }
