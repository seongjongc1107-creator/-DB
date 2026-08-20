"""ORM models for the FOIS 항로 제출 이력 아카이브 (fpl_archive.db, metar_archive.db와 분리)."""
from __future__ import annotations

from sqlalchemy import Column, DateTime, Index, Integer, String

from app.fpl_db import FplBase


class FplArchive(FplBase):
    """편당 1행, ams_rec_pk가 편 단위로 전역 고유해서 그 자체를 PK로 씀
    (재수집 시 이미 있는 건 자동 스킵 대상)."""
    __tablename__ = "fpl_archive"
    __table_args__ = (
        Index("ix_fpl_dep_arr_date", "dep", "arr", "flight_date"),
    )

    ams_rec_pk = Column(Integer, primary_key=True)
    flight_date = Column(String(10), nullable=False)  # YYYY-MM-DD, 조회 기준 출발일
    callsign = Column(String(16), nullable=False)
    dep = Column(String(4), nullable=False)
    arr = Column(String(4), nullable=False)
    ac_type = Column(String(8), nullable=True)
    eet_min = Column(Integer, nullable=True)  # FPL 신고 총 예상비행시간(분)
    route = Column(String, nullable=True)     # 고도/속도 변경값을 뗀 항로 부분만
    collected_at = Column(DateTime, nullable=False)


class FplCollectionRun(FplBase):
    """수집 시도 기록 — 결과가 0편이어도 남김. fpl_archive는 편이 있어야만 행이
    생겨서, '아직 한 번도 안 돌려봄'과 '돌렸는데 실제로 0편이었음'을 구분할
    방법이 없었음. 이 로그가 있으면 admin의 거점공항 커버리지 체크가 후자도
    "완료"로 인정할 수 있음(단, 도중 에러 없이 끝까지 돈 경우만 기록됨)."""
    __tablename__ = "fpl_collection_run"

    id = Column(Integer, primary_key=True, autoincrement=True)
    dep = Column(String(4), nullable=True)
    arr = Column(String(4), nullable=True)
    start_date = Column(String(10), nullable=False)
    end_date = Column(String(10), nullable=False)
    flights_found = Column(Integer, nullable=False)
    ran_at = Column(DateTime, nullable=False)
