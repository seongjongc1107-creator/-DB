# 시스템 아키텍처 / 기능 상세

`README.md`가 실행 방법과 기능 요약이라면, 이 문서는 **각 기능이 실제로 어떻게 동작하는지**를
다룸 — 처음 합류하는 개발자가 "이 화면 뒤에서 무슨 일이 일어나는지"를 코드 안 뒤져도 알 수
있게 하는 게 목적.

## 스택 개요

- 백엔드: FastAPI (Python), SQLite 3개(용도별 분리 — 아래 "데이터 저장소" 참고)
- 프론트엔드: React + TypeScript + Vite + MapLibre GL
- 배포: Render (`render.yaml` — Python 런타임, `bash build.sh`로 프론트 빌드 후 백엔드가
  정적 파일까지 같이 서빙)

## 데이터 저장소 3종

같은 SQLite라도 용도별로 완전히 분리된 파일 + 엔진을 씀 — 한쪽을 다루다 실수해도 다른 쪽
데이터는 영향 안 받게 하려는 의도.

| 파일 | 엔진/세션 정의 | 담는 것 |
|---|---|---|
| `backend/metar_archive.db` | `app/db.py` | METAR 이력 (공항 기상 장기 추이) |
| `backend/fpl_archive.db` | `app/fpl_db.py` | FOIS 실제 제출 ATC 비행계획 이력 |
| NAVDATA/Navblue_Route는 DB가 아니라 CSV | `app/data_loader.py`의 `NavDataStore` (인메모리) | 항공로/절차/항로DB — 서버 기동 시 전체를 메모리에 로드 |

## NAVDATA 로딩 (`data_loader.py`)

- `NAVDATA.csv`(공항·항공로·waypoint·SID/STAR)와 `Navblue_Route.csv`(항로 DB 2700여 개)를
  파싱해서 인메모리 인덱스(`fix_lookup`, `airway_names`, `route_by_origin`,
  `route_by_token` 등)를 만듦
- `store.reload()` — 관리자 페이지에서 CSV를 새로 올리면 이 메서드가 스테이징 인스턴스를
  따로 만들어서 완전히 로드한 뒤 통째로 스왑함(진행 중인 요청이 중간 상태를 읽지 않게)
- `resolve_route_tokens(tokens)` — 항로 토큰열(fix/airway 이름)을 좌표열로 풀어냄. 이때
  `passed_fixes`(명시 안 됐지만 실제로 지나는 중간 fix들)도 같이 반환 — 웨이포인트 통과
  판정, 우회 waypoint diff 등 대부분의 "이 항로가 X를 지나는가" 판단이 여기 의존함

## FOIS 서브시스템 (`routers/fois.py`)

FOIS(국토부 Flight Operation Information System)는 실제 항공사가 제출한 ATC 비행계획을
실시간으로 조회할 수 있는 정부 시스템. 자체 이력 보관 기간이 짧아서(실측 약 60일) 우리가
직접 누적 수집해서 `fpl_archive.db`에 쌓아둠.

### 라이브 조회
- `GET /schedule` — 특정 날짜의 dep/arr 스케줄
- `GET /route` — 특정 편의 FPL 원문을 받아 좌표로 파싱(`_parse_fpl_route`), 지도 오버레이용

### 이력 수집·집계
- `POST /history/collect` — 기간 지정 수집(백그라운드 task). 스케줄 조회는 하루 1콜이지만
  FPL 원문은 편당 1콜이라(N+1) 신규 편만 골라 페이싱(0.2초 간격)을 두고 순차 호출
- `ams_rec_pk`(편 단위 전역 고유값)로 dedup — 재수집해도 이미 있는 편은 자동 스킵
- `GET /history/stats` — (dep,arr) 쌍별 항로·기종·항공사 집계. `_canonicalize_route`로
  "같은 항공로를 반복 경유fix 표기만 다르게 낸 것"을 하나로 합침(SID/STAR는 안 건드림 —
  실제로 다른 절차를 탄 거라 구분 유지가 맞음)
- `GET /history/waypoint-search` — 특정 waypoint를 실제로 지나는 이력 검색. 항로 문자열엔
  연결점만 있고 중간 fix가 생략되는 경우가 많아서, 문자열 검색이 아니라
  `resolve_route_tokens`로 좌표까지 풀어서 판정. 콤마로 여러 개 주면 AND

### NAVBLUE 매칭 (`_navblue_match_key`)
실제 제출 항로가 정식 NAVBLUE 항로DB에도 등록된 항로인지 대조할 때, SID/STAR 절차명은
비교에서 제외함 — 항공사가 그 자리에 DCT로 내거나, 절차 리비전이 실제 필드 시점과
NAVBLUE 스냅샷 사이에 달라지는 경우가 흔해서, 절차명까지 완전 일치를 요구하면 사실상
같은 코어 항로를 "미등록"으로 오판하는 경우가 많았음.

## 우회입항 시나리오 조회 (`/scenario/query`)

국토부 「ATFM 지연 최소화를 위한 우회입항 운영절차」 대응용 기능. "지금 이 순간 흐름관리가
걸리면 몇 편이나 영향받고, 우리 편 앞에 몇 대가 있는지"를 실시간으로 봄 — `fpl_archive`(과거
이력)가 아니라 FOIS 라이브 스케줄+FPL을 그 자리에서 조회(아직 출발 안 한 편만, `atd` 없는
것만 필터). **그래서 시작 시각을 과거로 돌려도 아무것도 안 나오는 게 정상** — 과거 실적이
필요하면 `/history/stats`나 아래 추천 기능을 써야 함.

- 국가(ISO 2-letter, `country_codes.py`가 ICAO 접두사→국가코드 매핑) 또는 특정 공항, 방향
  (출발/도착), 시간범위(UTC)로 조회
- 제약 waypoint 통과편을 출발시간순으로 나열, 자사(JJA)편만 강조 + "앞서 N편" 표시(지연
  예측용)
- 우회 waypoint를 같이 주면, 이미 그 waypoint로 필드된 편도 별도로 보여줌

### 우회 waypoint 자동 추천 (`/history/infer-diversion`)

제약 waypoint만 알고 우회 waypoint를 모를 때, 과거 실적(`fpl_archive`, 자사·타사 구분 없이
전체)에서 "다들 실제로 뭘로 갈아탔는지"를 역산함.

1. OD쌍별로 가장 많이 쓰인 canonical 항로를 "평시 항로"로 봄
2. 평시 항로가 제약 waypoint를 지나는 OD만 골라서, 같은 OD의 다른(소수) 변형 항로들과
   diff — **`difflib.SequenceMatcher`로 실제 최장 공통 부분열을 찾음** (예전엔 앞/뒤 토큰을
   순서대로만 비교했는데, SID 표기 차이 하나(`BOPTA2A` vs `DCT`) 때문에 그 뒤에 이어지는
   진짜 공통 구간까지 "달라진 구간"으로 오판하는 버그가 있었음 — 실측: KABAM 제약 조회 시
   MUGUS가 엉뚱하게 후보로 나온 사례로 발견)
3. 겹침율(공통 토큰 비율)은 컷오프로 자르지 않고 **가중치**로만 씀 — 완전히 자르면 태풍처럼
   크게 돌아간 진짜 이탈까지 같이 날아가서. 노이즈(그날그날 다른 항로)는 매번 다른 값이라
   흩어지고, 진짜 우회는 같은 대체 항로가 반복되니 가중치 누적으로 자연히 구분됨
4. 후보 fix는 **인천FIR(RKRR) 경계 근접 여부**로 우선순위 정렬(숨기지 않고 정렬만) — 실제
   우회 waypoint는 보통 FIR 경계 지점이라. FIR 경계 데이터는 VATSIM 것을 쓰는데, 각국
   내부 관제권역(ACC) 경계까지 개별 폴리곤으로 들어있어서 인천FIR 하나만 기준으로 좁혀야
   엉뚱한 나라 내부 경계에 가깝다는 이유로 오분류되는 걸 막을 수 있음
5. 후보별로 실제 사용 항공사 breakdown, 예시 편(콜사인·날짜) 근거까지 같이 반환
6. 범위를 공항 단위로 좁혀둔 상태(국가 단위는 공항이 여러 개라 하나의 dep/arr로 못 좁힘)면
   그 방향(출발/도착)에 맞춰 추천도 자동으로 그 노선만으로 스코프됨 — 목적지에 따라 우회
   fix가 다를 수 있어서(예: 같은 MUGUS라도 대만행과 필리핀행이 다른 fix로 우회했을 수 있음)

## 자동 수집 스케줄러 (`scheduler.py`)

- 제주항공(JJA) 거점 공항 16곳(`BASE_AIRPORTS`)을 매일 새벽 3시(KST, 국내 트래픽 가장
  적은 시간대) 자동 수집 — `AsyncIOScheduler` + `CronTrigger`
- 공항마다 "출발=거점/도착=전체" + "도착=거점/출발=전체" 둘 다 돌림(해외→거점 도착편까지
  빠짐없이 잡으려고 — 국내선끼리는 한쪽만 돌려도 dedup으로 알아서 안 겹침)
- 최근 7일 윈도우로 매일 다시 훑음(그 사이 놓친 날 대비 — dedup 때문에 느려지지 않음)
- `run_collection_now()` — 관리자 페이지 "새로고침" 버튼이 이 함수를 그대로 호출. 새벽
  스케줄과 완전히 같은 로직을 그 자리에서 즉시 트리거함(이미 도는 중이면 중복 실행 안 함)

### 거점공항 커버리지 판정 (`admin.py`의 `_base_airport_coverage`)

- 최근 30일 범위가 다 채워졌으면 "완료" — 시작/끝 며칠은 여유(tolerance 2일)를 둠
- **실제 취항이 없는 공항 구분**(`verified_empty`): `fpl_archive`는 편이 있어야만 행이
  생기므로, "0편"이 "아직 확인 안 함"인지 "실제로 0편"인지 원래 구분이 안 됐음.
  `FplCollectionRun` 로그 테이블(수집 시도 자체를 기록, 에러 없이 끝까지 돈 경우만)로
  이 둘을 구분함

## 관리자 페이지 (`AdminPage.tsx` + `routers/admin.py`)

- **인증**: 공유 비밀번호 하나(`ADMIN_PASSWORD` 환경변수)만 확인, 세션/토큰 없음 — 임시
  방편(나중에 다른 시스템 병합 시 그쪽 권한 체계 따를 예정)
- **근간 데이터 업로드**: NAVDATA.csv / Navblue_Route.csv / WX_Minima.csv — 업로드 시
  기존 파일 자동 백업 후 교체, `store.reload()`로 서버 재시작 없이 즉시 반영
- **항로 실적 아카이브 새로고침**: DB 재집계가 아니라 **실제로 FOIS에서 거점 16개 공항을
  다시 긁어옴**(스케줄러와 동일 로직) — 진행상황을 폴링하며 화면에 반영
- **외부 실시간 데이터 소스 상태**: METAR/TAF(aviationweather.gov)·태풍(GDACS)·화산재
  (BOM VAAC 집계) 살아있는지/최신인지 헬스체크, 읽기 전용(비밀번호 불필요)

## 실시간 트래픽 (`routers/traffic.py`)

- **OpenSky Network**(무료, 익명 API)에서 동아시아 권역(위도 10~55°, 경도 100~150°) 항공기
  위치를 가져옴
- 프론트가 **30초마다** 폴링, 백엔드도 **30초 서버 캐시**를 둬서 사용자가 몇 명이든 OpenSky엔
  30초에 한 번만 실제 요청 나감(레이트리밋 방지)
- 콜사인이 `JJA`로 시작하는 편은 `is_jja` 플래그로 구분

## 날씨 이력 (`routers/weather.py`)

- Iowa State Mesonet(ASOS) 소스에서 공항별 METAR 이력을 월 단위로 수집, `metar_archive.db`에
  누적
- 이미 촘촘히 수집된 달(하루 평균 18건 이상)은 재수집 건너뜀
- **청크 삽입**: 오래 안 모은 공항을 몇 년치 몰아 수집하면 레코드 수 × 컬럼 수가 SQLite
  바인드 파라미터 상한을 넘어 "too many SQL variables"로 통째 실패하던 버그가 있었음 —
  `_bulk_insert`가 약 75건씩 청크로 나눠 넣도록 수정됨(`_SQLITE_MAX_VARS`)

## 국가코드 매핑 (`country_codes.py`)

ICAO 공항 코드 2글자 접두사 → ISO 3166-1 alpha-2 국가코드. 홍콩(HK)·마카오(MO)는 중국(CN)과
분리. FIR 명이 아니라 실제 영토 기준. 새 지역 공항이 NAVDATA에 추가되면 이 파일도 같이
갱신해야 함 — 모르는 접두사는 조용히 "국가 미상"으로 빠지므로 검색이 안 걸리면 이 파일부터
의심할 것.

## 배포 (Render)

- `render.yaml`: Python 런타임, `bash build.sh`(프론트 빌드) → `uvicorn app.main:app`
- **의존성 관리 주의**: 로컬에서 `pip install`만 하고 `backend/requirements.txt` 반영을
  빠뜨리면, Render 빌드가 `ModuleNotFoundError`로 조용히 실패하고 **직전 성공 빌드에
  멈춰있음** — auto-deploy가 켜져 있어도 "배포가 안 되는" 것처럼 보이는 가장 흔한 원인.
  실제로 `apscheduler`/`tzlocal`을 requirements.txt에 반영 안 해서 몇 주간 배포가 막혀있던
  적이 있었음(→ `backend/requirements.txt` 커밋 확인 습관화 권장)
- 새 패키지를 쓰게 되면 `pip install` 직후 반드시 `requirements.txt`에도 추가할 것

## API 엔드포인트 요약

| 라우터 | 베이스 경로 | 주요 엔드포인트 |
|---|---|---|
| routes | `/api/routes` | 목록/geometry/대체항로/파싱/출발지·도착지 목록 |
| navdata | `/api/navdata` | 공항 상세/FIR/항공로/waypoint |
| search | `/api/search` | airway·airport·waypoint 통합 검색 |
| fois | `/api/fois` | 스케줄/항로 조회, 이력 수집·집계·웨이포인트검색, 국가목록, 우회입항 시나리오, 우회 waypoint 추천 |
| admin | `/api/admin` | 데이터 현황·업로드·아카이브 새로고침 |
| weather | `/api/weather` | METAR 실시간/트렌드, 이력 수집·집계, 최저치 시드 |
| typhoon | `/api/typhoon` | 실시간/모의/트랙 |
| volcanic_ash | `/api/volcanic-ash` | 활성 화산재 구역 |
| curfew | `/api/curfew` | 커퓨 조회/업로드 |
| traffic | `/api/traffic` | 실시간 항공기 위치(OpenSky) |
