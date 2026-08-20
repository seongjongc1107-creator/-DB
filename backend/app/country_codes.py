"""ICAO 지역 접두사(공항 코드 앞 2글자) → ISO 3166-1 alpha-2 국가코드 매핑.

NAVDATA에 로드된 공항 커버리지(동아시아 중심 285개, 2026.08 기준)를 실제로
훑어서 등장하는 접두사를 전수 매핑함. FIR 명이 아니라 실제 영토 기준 국가로
매핑하며, 홍콩(HK)·마카오(MO)는 중국(CN)과 분리함.

NAVDATA에 새 지역 공항이 추가되면 여기도 같이 갱신해야 함 — country_of()가
모르는 접두사는 None을 돌려주므로, 새 접두사가 생기면 매핑 없이도 에러 없이
"국가 미상"으로 조용히 빠질 뿐이라 즉시 알아채기 어려움. 국가코드 검색 기능을
쓰다가 특정 공항이 검색에 안 걸리면 이 파일부터 의심할 것.
"""
from __future__ import annotations

from typing import Optional

# 접두사(2글자) -> (ISO 국가코드, 한글 국가명)
_PREFIX_TO_COUNTRY: dict[str, tuple[str, str]] = {
    "RK": ("KR", "대한민국"),
    "RJ": ("JP", "일본"), "RO": ("JP", "일본"),
    "RC": ("TW", "대만"),
    "VH": ("HK", "홍콩"),
    "VM": ("MO", "마카오"),
    "RP": ("PH", "필리핀"),
    "VT": ("TH", "태국"),
    "VV": ("VN", "베트남"),
    "WS": ("SG", "싱가포르"),
    "WM": ("MY", "말레이시아"), "WB": ("MY", "말레이시아"),
    "WI": ("ID", "인도네시아"), "WA": ("ID", "인도네시아"),
    "VD": ("KH", "캄보디아"),
    "VL": ("LA", "라오스"),
    "VY": ("MM", "미얀마"),
    "VG": ("BD", "방글라데시"),
    "VE": ("IN", "인도"),
    "ZK": ("KP", "북한"),
    "ZM": ("MN", "몽골"),
    "ZB": ("CN", "중국"), "ZG": ("CN", "중국"), "ZH": ("CN", "중국"),
    "ZJ": ("CN", "중국"), "ZL": ("CN", "중국"), "ZP": ("CN", "중국"),
    "ZS": ("CN", "중국"), "ZU": ("CN", "중국"), "ZW": ("CN", "중국"),
    "ZY": ("CN", "중국"),
    "UH": ("RU", "러시아"), "UN": ("RU", "러시아"),
    "UA": ("KZ", "카자흐스탄"), "UB": ("AZ", "아제르바이잔"),
    "UC": ("KG", "키르기스스탄"), "UD": ("AM", "아르메니아"),
    "UG": ("GE", "조지아"), "UZ": ("UZ", "우즈베키스탄"),
    "CY": ("CA", "캐나다"),
    "ED": ("DE", "독일"), "EG": ("GB", "영국"),
    "LB": ("BG", "불가리아"), "LT": ("TR", "튀르키예"),
    "PT": ("FM", "미크로네시아·팔라우"),
}


def country_of(icao: str) -> Optional[tuple[str, str]]:
    """공항 ICAO 코드 -> (국가코드, 한글국가명). 모르는 접두사면 None."""
    icao = (icao or "").strip().upper()
    if not icao:
        return None
    # K로 시작하는 4글자 코드(KLAX, KSEA 등)는 전부 미국 본토 — 접두사가
    # 워낙 다양해서(주별로 다름) 개별 나열 대신 첫 글자로 판단
    if icao[0] == "K":
        return ("US", "미국")
    prefix2 = icao[:2]
    if prefix2 in ("PA", "PG"):  # 알래스카·괌 등 미국령 태평양
        return ("US", "미국")
    return _PREFIX_TO_COUNTRY.get(prefix2)


def airports_in_country(all_airport_ids: list[str], country_code: str) -> list[str]:
    """로드된 공항 id 목록 중 해당 국가코드에 속하는 것만 필터."""
    cc = (country_code or "").strip().upper()
    if not cc:
        return []
    return sorted(ap for ap in all_airport_ids if (country_of(ap) or (None, None))[0] == cc)


def available_countries(all_airport_ids: list[str]) -> list[dict]:
    """지금 실제로 로드된 공항들 기준 등장하는 국가 목록 — '?' 설명 팝업용.
    전세계 코드를 다 나열하지 않고 실제 검색 가능한 것만 보여줌."""
    seen: dict[str, str] = {}
    for ap in all_airport_ids:
        c = country_of(ap)
        if c:
            seen[c[0]] = c[1]
    return [{"code": code, "name": name} for code, name in sorted(seen.items())]
