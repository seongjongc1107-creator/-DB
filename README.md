# Flight Route Dashboard

FastAPI + React + MapLibre GL 기반 항로 시각화 대시보드.

## 실행

### 백엔드
```bash
cd backend
pip3 install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload
```

### 프론트엔드
```bash
cd frontend
npm install
npm run dev
# → http://localhost:5174 (vite.config.ts에서 8001 백엔드로 프록시)
```

## 폴더 구조

```
backend/                FastAPI 서버
  app/data_loader.py      NAVDATA/Navblue_Route CSV 파싱 — 항로 geometry 계산의 핵심
  app/routers/             API 라우터 (routes, navdata, typhoon, weather, curfew, traffic, search)
  data/                    실데이터 (NAVDATA.csv, Navblue_Route.csv 등) — data/README.md 참고
frontend/                React + Vite + MapLibre GL
  src/components/          지도, 사이드바, 각종 패널(항로 비교, 날씨, 태풍, 커퓨 등)
  src/permits/              허가 관리 서브앱
legacy/                  더는 안 쓰는 파일 (frontend/index.html의 미사용 중복 등)
render.yaml, build.sh    Render 배포 설정
```

## 기능
- 출발지/도착지 선택 → 해당 항로 지도 표시, **최대 10개까지 다중 선택**
  (기본은 클릭 시 단일 선택/교체, Ctrl(⌘)+클릭으로 추가/제거 — 지도 클릭·겹친 항로
  드릴다운 메뉴 둘 다 동일)
- 검색: 항공로명(A582 등) · 공항 · Waypoint — 사이드바 목록 안에서 **항로 번호로
  추가 필터**(공백으로 여러 개 나열 가능, 예: `27 96 11`), **출발지/도착지/airway를
  동시에 교집합으로 좁힐 수 있음**(예: airway 검색 후 출발지·도착지 선택)
- 지도 우클릭(트랙패드 Control+클릭): 겹친 항로 목록 → 클릭해서 상세로 드릴다운,
  ⌘(Cmd)+클릭으로 기존 선택에 추가
- 2개 이상 선택 시 비교 패널 표출(거리차/전체 항로/FIR 통과/태풍 교차 여부·comments,
  드래그 이동 가능, 기본 접힘)
- 태풍 실시간/모의 조회 + 예보 트랙 재생, 공간 필터(반경/폴리곤)로 영향 항로 판정
  — 폴리곤 좌표는 십진수·항공용 DMS 아무 형식이나 붙여넣기 가능(국가마다 다른 표기
  방식·구분자를 자동 인식)
- 영향 항로는 목록 최상단에 정렬+뱃지 표시 (필터에 안 걸리는 항로도 그대로 선택 가능)
- FIR 경계, 공항 METAR/TAF 실시간 모니터링 + 특보 토스트(레이어에서 on/off, 태풍 구역
  겹치는 공항만 보기 필터 가능), 커퓨(야간 운항 제한) 표시
- **기상 추이 패널**: 실측 METAR ↔ TAF 예보 비교 차트(풍속/시정/운고/기온·이슬점/QNH),
  과거 시점별로 그때 실제 유효했던 TAF 이력을 재구성해서 비교, "지금" 이후는 TAF
  예보만 이어서 표시, TEMPO 구간 별도 표기, 5분마다 자동 갱신
- 공항 최저치 관리, 허가 관리(permits) 서브앱

## 데이터 갱신

`backend/data/README.md` 참고 — NAVDATA/Navblue_Route를 새 사이클로 교체하는 절차와
검증 방법이 정리되어 있음. **주의**: `~/Desktop/flight_tracking` 프로젝트도 같은 종류의
NAVDATA를 쓰지만 완전히 별도 사본이라 여기서 갱신해도 자동 반영 안 됨.

## 지도 타일
기본값: OpenFreeMap (무료, API 키 불필요)
프로덕션: `frontend/src/components/MapView.tsx` 의 `MAP_STYLE` 상수를 Mapbox/MapTiler URL로 교체
