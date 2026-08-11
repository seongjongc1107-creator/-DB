"""관리자 비밀번호 확인 — admin.py와 curfew.py가 공유(순환 임포트 방지용으로 분리).
세션/토큰 없이 공유 비밀번호 하나만 확인하는 최소 구현. 나중에 다른 시스템에
병합되면 그쪽 사용자 권한 체계를 따를 예정이라, 그때까지 임시로 막아두는 용도."""
from __future__ import annotations

import os

from fastapi import HTTPException


def check_password(password: str) -> None:
    expected = os.environ.get("ADMIN_PASSWORD")
    if not expected:
        raise HTTPException(500, "ADMIN_PASSWORD 환경변수가 설정되지 않았습니다 — 관리자 기능이 비활성화된 상태입니다")
    if password != expected:
        raise HTTPException(403, "비밀번호가 올바르지 않습니다")
