from fastapi import APIRouter, Query
from ..data_loader import store

router = APIRouter()


@router.get("")
def search(q: str = Query(..., min_length=1)):
    q_up = q.upper().strip()
    results = []

    # Airports
    for ap_id, ap in store.airports.items():
        if q_up in ap_id or q_up in ap.name.upper():
            results.append({
                "type": "airport",
                "id": ap_id,
                "name": f"{ap_id} {ap.name}".strip(),
                "lat": ap.lat,
                "lon": ap.lon,
                "description": f"Airport",
            })

    # Airways (exact prefix match first) — 같은 이름의 항공로가 서로 다른 대륙에
    # 동시에 존재할 수 있음(예: Y711이 한국과 유럽에 둘 다 있음, 서로 무관한 별개
    # 항로). 예전엔 이름 하나에 결과 1개만 내보내서, 골랐을 때 지도가 두 지역을
    # 합친 엉뚱한 범위로 확대되는 문제가 있었음(waypoint는 동명이인 위치별로 이미
    # 분리해서 내보내고 있었는데 airway만 빠져 있었던 것) — segment별로 나눠서
    # 사용자가 원하는 지역을 직접 고를 수 있게 함.
    aw_exact = sorted(
        [n for n in store.airway_names if n.upper().startswith(q_up)],
        key=lambda x: (x != q_up, x),
    )
    for aw_name in aw_exact[:20]:
        route_count = len(store.route_by_token.get(aw_name, []))
        segs: dict = {}
        for f in store.airways.get(aw_name, []):
            segs.setdefault(f.segment, []).append(f)
        seg_ids = sorted(segs)
        for seg_id in seg_ids:
            seg_fixes = sorted(segs[seg_id], key=lambda x: x.sequence)
            anchor = seg_fixes[0] if seg_fixes else None
            description = f"Airway · {route_count} routes using it"
            if len(seg_ids) > 1 and anchor:
                ns = 'N' if anchor.lat >= 0 else 'S'
                ew = 'E' if anchor.lon >= 0 else 'W'
                description += f" · {anchor.fix} 부근 {abs(anchor.lat):.1f}°{ns} {abs(anchor.lon):.1f}°{ew}"
            results.append({
                "type": "airway",
                "id": aw_name,
                "segment": seg_id if len(seg_ids) > 1 else None,
                "name": aw_name,
                "lat": anchor.lat if anchor else None,
                "lon": anchor.lon if anchor else None,
                "description": description,
            })

    # FIR/UIR (ICAO 코드 접두어 또는 이름 부분일치) — "이 공역을 지나는 항로"를
    # airway/waypoint와 같은 방식으로 보여주기 위함. route_count 계산(폴리곤
    # point-in-polygon)이 FIR당 한 번은 비용이 있어(이후엔 캐시) 매치를 넉넉히
    # 잡지 않고 소수만 계산함.
    fir_matches = sorted(
        [
            icao for icao, feat in store.fir_by_icao.items()
            if icao.startswith(q_up) or q_up in (feat.get("properties", {}).get("name") or "").upper()
        ],
        key=lambda x: (x != q_up, x),
    )
    for icao in fir_matches[:10]:
        feat = store.fir_by_icao[icao]
        name = (feat.get("properties", {}) or {}).get("name") or ""
        min_lon, min_lat, max_lon, max_lat = store.fir_bbox_by_icao[icao]
        route_count = len(store.get_routes_by_fir(icao))
        results.append({
            "type": "fir",
            "id": icao,
            "name": f"{icao} {name}".strip(),
            "lat": (min_lat + max_lat) / 2,
            "lon": (min_lon + max_lon) / 2,
            "description": f"FIR/UIR · {route_count} routes passing through",
        })

    # Waypoints/Navaids (prefix match, cap at 15) — fix_lookup은 waypoint(5글자
    # RNAV 지점)뿐 아니라 NDB/VOR 같은 3글자 navaid, airway에 내장된 중간 fix,
    # 절차 종점까지 다 포함하는 전체 인덱스라 여기서 찾아야 항로 리졸버가 실제로
    # 쓰는 지점과 검색 결과가 일치함 (store.waypoints만 보면 NDB/navaid가 통째로 빠짐).
    # airway 이름과 실제 navaid/fix 이름이 우연히 같을 수 있음(예: "APU"는 항공로
    # 이름이면서 동시에 그 항공로가 지나는 VOR 이름이기도 함) — 서로 다른 실체라
    # airway_names는 걸러내지 않음. 공항은 위에서 이미 별도로 다뤘으니 제외.
    wp_matches = [
        fix_id for fix_id in store.fix_lookup
        if fix_id.upper().startswith(q_up) and fix_id not in store.airports
    ]
    # 정확히 일치 > 짧은 이름 우선 — 안 그러면 "APU" 자체보다 "APUGO" 같은
    # 접두어 매칭이 먼저 채워져서 정작 찾던 짧은 navaid가 15개 제한에 밀려남.
    wp_matches.sort(key=lambda x: (x != q_up, len(x), x))
    # 같은 이름이 지구상 여러 위치에 동시에 존재하는 경우가 있음(예: "PIANO"가
    # 미국과 대만에 둘 다 있음) — fix_lookup[name]은 그 좌표들을 리스트로 다 갖고
    # 있는데, 예전엔 [0]번째 좌표만 봐서 나머지 위치가 검색에서 통째로 빠졌었음.
    # 이름당 15개 제한은 유지하되, 좌표 개수만큼 결과를 늘어놓음.
    for fix_id in wp_matches:
        if len(results) >= 50:
            break
        kind = "Waypoint" if fix_id in store.waypoints else "NDB" if fix_id in store.ndbs else "Navaid"
        coords = store.fix_lookup[fix_id]
        for lon, lat in coords[:15]:
            results.append({
                "type": "waypoint",
                "id": fix_id,
                "name": fix_id,
                "lat": lat,
                "lon": lon,
                "description": kind if len(coords) == 1 else f"{kind} · {lat:.2f}°{'N' if lat >= 0 else 'S'} {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}",
            })

    return results[:50]
