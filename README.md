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
- 출발지/도착지 선택 → 해당 항로 지도 표시, **최대 2개 동시 선택 시 비교 패널**
  (거리차/전체 항로/FIR 통과/태풍 교차 여부, 드래그 이동 가능)
- 검색: 항공로명(A582 등) · 공항 · Waypoint · **항로 번호**(`RKSI VVCR 27`, `#27` 등)
- 지도 우클릭: 겹친 항로 목록 → 클릭해서 상세로 드릴다운
- 태풍 실시간/모의 조회 + 예보 트랙 재생, 공간 필터(반경/폴리곤)로 영향 항로 판정
- 영향 항로는 목록 최상단에 정렬+뱃지 표시 (필터에 안 걸리는 항로도 그대로 선택 가능)
- FIR 경계, 공항 METAR/TAF 실시간 모니터링 + 특보 토스트, 커퓨(야간 운항 제한) 표시
- 공항 최저치 관리, 허가 관리(permits) 서브앱

## 데이터 갱신

`backend/data/README.md` 참고 — NAVDATA/Navblue_Route를 새 사이클로 교체하는 절차와
검증 방법이 정리되어 있음. **주의**: `~/Desktop/flight_tracking` 프로젝트도 같은 종류의
NAVDATA를 쓰지만 완전히 별도 사본이라 여기서 갱신해도 자동 반영 안 됨.

## 지도 타일
기본값: OpenFreeMap (무료, API 키 불필요)
프로덕션: `frontend/src/components/MapView.tsx` 의 `MAP_STYLE` 상수를 Mapbox/MapTiler URL로 교체
