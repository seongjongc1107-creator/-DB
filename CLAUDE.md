# 비행계획 항로 DB (Route DB) — Claude 작업 컨텍스트

Python + FastAPI + 지도 기반 항로 검색/기상 대시보드. 백엔드는 Supabase가 아니라
로컬 CSV(`backend/data/*.csv`)를 읽어서 서빙하는 자체 FastAPI 서버.

## 실행

```bash
# 백엔드 (backend/ 디렉토리에서) — 사내 서버(JFPS PC)는 uv 사용
uv run uvicorn app.main:app --port 8001
# uv가 없는 환경(예: 이 맥)에서는 시스템 python으로도 됨
python3 -m uvicorn app.main:app --port 8001

# 프론트엔드 (frontend/ 디렉토리에서)
npm run dev   # http://localhost:5174, /api는 vite.config.ts가 :8001로 프록시
```

타입체크: `cd frontend && npx tsc --noEmit`

## 배포 — 백엔드/프론트 경로가 다름

사내 물리 서버(JFPS PC, 포트 8001)가 이 저장소를 git으로 pull해서 코드를 갱신함
(`backend/app/services/deploy.py`). **백엔드/프론트는 배포 경로가 다르다:**

- **백엔드**(`backend/app/**`) 수정 → `git push`만 하면 됨. 서버가 `main`을
  `git pull` + `uv pip install -r requirements.txt`, import 프리플라이트 실패 시
  자동 롤백.
- **프론트엔드**(`frontend/src/**`) 수정 → `git push`뿐 아니라
  **`./scripts/release.sh` 반드시 실행**해야 함 (`npm run build` → 산출물을
  history 누적 없이 `deploy-static` 브랜치로 force-push. 서버는 `main`과
  별개로 이 브랜치를 pull해서 `frontend/dist/`에 풀어씀).
- 서버 쪽 반영은 ROUTE 설정(관리자) 페이지의 "지금 업데이트" 버튼이 트리거함
  (`/admin/update-now`) — `main`(백엔드)과 `deploy-static`(프론트 정적파일)을
  각각 독립적으로 확인·적용.
- `release.sh`는 **워킹 디렉토리를 그대로 빌드**한다 — 커밋 안 된 변경사항이
  섞여 있으면 그것까지 같이 배포됨. 미완성 작업이 있으면 `git stash`로 빼두고
  빌드할 것.

## ⚠️ JOIN(GYSJ)에도 프론트엔드 복사본이 있음 — 항상 같이 확인할 것

`~/Downloads/GYSJ`(사내 "JOIN" 연료관리 KPI 대시보드)가 이 저장소의
`frontend/src/` 전체를 **자기 저장소 안에 통째로 복사**해서
`frontend/src/route-dashboard/`로 쓰고 있음 ("ROUTE 설정" 탭). 백엔드/데이터는
공유 안 하고(JOIN은 자기 백엔드 8000번, Route DB는 8001번을 그대로 씀)
**프론트엔드 소스만 별도 복사본**이라, git으로 연결돼 있지 않음 —
**이 저장소에서 `frontend/src/**`를 고쳐도 JOIN 쪽엔 자동으로 반영되지 않는다.**

실제로 이 문제로 재현 안 되는 버그를 오래 헤맨 적이 있음(2026-09-22): 항로
재클릭 시 선택 해제되는 버그를 이 저장소에서 고치고 배포했는데, JOIN에서는
여전히 재현됨 — 원인은 JOIN의 `route-dashboard/` 복사본이 옛날 버전 그대로
남아있었기 때문.

**그래서 `frontend/src/**` 관련 수정을 할 때는:**
1. 이 저장소에서 고치고 커밋 + `./scripts/release.sh`로 배포
2. **`~/Downloads/GYSJ/frontend/src/route-dashboard/`에 같은 이름의 파일이
   있는지 확인**하고, 있으면 동일한 수정을 그대로 적용
3. GYSJ 쪽도 커밋 + `./scripts/release.sh` 실행 (GYSJ는 팀 전체가 쓰는 공유
   저장소라 push 전에 사용자 확인 받을 것 — `git fetch`로 다른 사람 커밋과
   충돌 없는지 먼저 확인, 필요하면 rebase)

두 저장소가 거의 1:1로 파일명이 같으므로(`RoutePanel.tsx`, `MapView.tsx`,
`SearchBar.tsx`, `AppContext.tsx` 등 — `RouteDashboardPage.tsx`/`config.ts`/
`hooks/useIsDark.ts`만 JOIN 쪽에 추가로 있음) `diff`로 비교하면 빠르게 확인
가능.

## 관련 프로젝트
- `~/Downloads/GYSJ` — JOIN. 자세한 배포 규칙은 그쪽 `docs/deploy.md` 참고.
