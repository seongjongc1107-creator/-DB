# Flight Route Dashboard

FastAPI + React + MapLibre GL 기반 항로 시각화 대시보드.

## 실행

### 백엔드
```bash
cd backend
pip3 install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 프론트엔드
```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

## 기능
- 출발지/도착지 선택 → 해당 항로 지도 표시
- 항공로명(A582 등) 검색 → 사용 항로 전체 하이라이트
- 공항/Waypoint 검색 → 지도에서 위치 확인
- 레이어 토글: Routes / Airports / Waypoints / 항공로

## 확장 예정
- 태풍 API 연동 (중심좌표+반경 → 영향 항로 판정)
- NOTAM 좌표 입력 → 영향 구역 폴리곤 → 항로 교차 검출
- FIR 경계 레이어 (별도 FIR GeoJSON 데이터 필요)

## 지도 타일
기본값: OpenFreeMap (무료, API 키 불필요)
프로덕션: `frontend/src/components/MapView.tsx` 의 `MAP_STYLE` 상수를 Mapbox/MapTiler URL로 교체
