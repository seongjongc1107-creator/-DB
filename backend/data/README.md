# 데이터 갱신 방법

이 폴더의 `NAVDATA.csv`, `Navblue_Route.csv`는 실제 데이터 파일입니다 (심볼릭 링크 아님).
새 데이터를 받으면 **같은 파일명으로 이 위치에 덮어쓰기만 하면** 됩니다.

## 파일 설명

| 파일 | 내용 | 출처 |
|---|---|---|
| `NAVDATA.csv` | 공항/항공로/웨이포인트/절차(SID·STAR) 등 항행 데이터 | Jeppesen NDB CSV export (JJA 사이클) |
| `Navblue_Route.csv` | 항로(OD 페어별 flight-planned route) 데이터 | Navblue city-pair route export |
| `curfew.csv` | 공항별 커퓨(야간 운항 제한) 시간 | 수동 관리 |
| `backups/` | 갱신 전 자동 백업 (git에는 안 올라감, `.gitignore` 처리됨) | — |

## 갱신 절차

1. **백업** (선택이지만 권장): 새로 덮어쓰기 전에 기존 파일을 `backups/`에 복사
   ```bash
   cp NAVDATA.csv backups/NAVDATA_$(date +%Y%m%d).csv
   cp Navblue_Route.csv backups/Navblue_Route_$(date +%Y%m%d).csv
   ```
2. **교체**: 새로 받은 파일을 정확히 같은 파일명(`NAVDATA.csv`, `Navblue_Route.csv`)으로 이 폴더에 덮어쓰기
3. **로컬 반영**: 백엔드 서버 재시작 필요 — 데이터는 서버 시작 시 딱 한 번만 메모리로 읽어들이는 구조라, 코드 핫리로드(`--reload`)와 달리 파일 교체는 자동 반영되지 않음
   ```bash
   cd backend
   uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
   ```
   재시작 후 `GET /api/health`로 로드된 항로/공항 수 확인:
   ```bash
   curl http://localhost:8001/api/health
   ```
4. **배포판(Render) 반영**: Render는 git 저장소 기준으로 빌드하므로, 교체한 파일을 커밋 + push해야 반영됨
   ```bash
   git add backend/data/NAVDATA.csv backend/data/Navblue_Route.csv
   git commit -m "data: update NAVDATA/Navblue_Route to <cycle>"
   git push
   ```
   push 후 Render가 자동 재배포되며, 재배포 시 프로세스가 새로 뜨므로 새 데이터가 자동으로 로드됨.

## 포맷 주의사항

`backend/app/data_loader.py`의 파서는 NAVDATA.csv가 아래 섹션 헤더 구조를 갖는다고 가정합니다:

```
Database
Airports
Airways
NDBs
Runways
ILSs
Approaches
Company Routes
SIDs
STARs
Waypoints
```

각 섹션은 `섹션명` 줄 다음에 컬럼 헤더 줄이 오고, 그 다음부터 데이터 행이 이어지는 구조입니다.
Jeppesen NDB export 형식이 크게 바뀌지 않는 한(컬럼 이름 기준으로 읽으므로 컬럼 순서 변경은 무관) 별도 코드 수정 없이 그대로 갈아끼워집니다.

`Navblue_Route.csv`는 `Origin,Destination,Number,...,Route,Distance,...,Aircraft,...` 컬럼을
이름으로 찾아 읽습니다 (컬럼 순서/누락 컬럼은 무관, 이름만 같으면 됨).

## 갱신 후 빠른 검증

데이터를 갈아끼운 뒤, fix 이름이 airway/procedure 이름과 우연히 겹쳐서 항로가
잘못 파싱되는 사례가 없는지 아래 스크립트로 대략 훑어볼 수 있습니다
(2026-07 사이클에서 `PUD/NXD/GYA/NOB/BMT/LKH`가 airway 이름과, `TNN`이
전혀 다른 공항의 SID/STAR 이름과 겹쳐서 항로가 통째로 끊기는 버그가 실제로 있었음):

```bash
cd backend && python3 -c "
import sys; sys.path.insert(0, '.')
from app.data_loader import store
store.load()

empty = [r for r in store.routes if not r.coordinates]
print(f'좌표가 비어있는 항로: {len(empty)} / {len(store.routes)}')

# 좌표 개수가 토큰 개수보다 훨씬 적게 뽑힌 항로 = 파싱 중간에 뭔가 스킵됐을 가능성
suspicious = [r for r in store.routes if r.coordinates and len(r.coordinates) < len(r.tokens) * 0.3]
print(f'좌표가 유독 적은 항로(의심): {len(suspicious)}')
for r in suspicious[:10]:
    print(f'  {r.origin}-{r.destination} #{r.number}: 토큰 {len(r.tokens)}개 -> 좌표 {len(r.coordinates)}개')
"
```

`좌표가 유독 적은 항로`가 여러 개 뜨면, 그 항로의 route string을 하나씩 까서
어느 토큰에서 끊기는지 확인 — 대부분 fix 이름이 airway/procedure 이름과
겹치는 케이스입니다 (`_resolve_geometries`의 위치 기반 판별 로직 참고).

## 알려진 데이터 한계

- NAVDATA는 특정 사이클의 지역 한정 추출본이라, 일부 공항/지점이 아예 없을 수 있음
  (`GET /api/health` 로드는 성공해도 해당 지점을 쓰는 항로는 `coordinates`가 비어서 지도에 안 그려짐)
- 항로 geometry는 route string을 파싱해서 만드는데, 항공로(airway) 구간은 NAVDATA의 Airways
  테이블에서 실제 중간 waypoint를 찾아 확장함 — NAVDATA와 Navblue_Route의 사이클(버전)이
  크게 다르면 항로 문자열 속 fix/airway 이름이 NAVDATA에 없어서 일부 구간이 못 그려질 수 있음
