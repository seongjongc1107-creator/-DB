#!/usr/bin/env bash
# 프론트엔드를 빌드해서 deploy-static 브랜치에 force-push합니다.
# 사내 서버(JFPS PC)는 이 브랜치만 별도로 clone해서 frontend/dist/에 풀어씁니다 (main 브랜치는 안 건드림).
#
# 사용법:
#   ./scripts/release.sh          정상 실행 (빌드 → 커밋 → push)
#   ./scripts/release.sh --dry-run   push 없이 커밋 내용만 확인 (테스트용)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BRANCH="deploy-static"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

cleanup() {
  if [[ -n "${TMP_WORKTREE:-}" && -d "$TMP_WORKTREE" ]]; then
    git -C "$ROOT_DIR" worktree remove --force "$TMP_WORKTREE" >/dev/null 2>&1 || true
  fi
  git -C "$ROOT_DIR" branch -D "${BRANCH}-tmp" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/4] 프론트엔드 빌드 중..."
(cd "$FRONTEND_DIR" && npm install && npm run build)

if [[ ! -d "$FRONTEND_DIR/dist" ]]; then
  echo "빌드 실패: $FRONTEND_DIR/dist 가 없습니다." >&2
  exit 1
fi

echo "[2/4] 임시 워크트리 준비 중..."
cd "$ROOT_DIR"
git fetch origin "$BRANCH" >/dev/null 2>&1 || true
git branch -D "${BRANCH}-tmp" >/dev/null 2>&1 || true
TMP_WORKTREE="$(mktemp -d)"
git worktree add --detach "$TMP_WORKTREE" >/dev/null
cd "$TMP_WORKTREE"
git checkout --orphan "${BRANCH}-tmp"
git rm -rf . >/dev/null 2>&1 || true

echo "[3/4] 빌드 산출물 복사 및 커밋 중..."
cp -R "$FRONTEND_DIR/dist/." .
git add -A
git commit -m "release: $(date '+%Y-%m-%d %H:%M:%S')" --quiet

echo "커밋 내용:"
git show --stat HEAD | head -20

if $DRY_RUN; then
  echo "(--dry-run) push는 생략합니다."
  exit 0
fi

echo "[4/4] ${BRANCH} 브랜치로 push 중..."
git push origin "${BRANCH}-tmp:${BRANCH}" --force

echo "완료! 사내 서버는 다음 업데이트 체크(자동/수동) 시 이 브랜치를 받아 반영합니다."
