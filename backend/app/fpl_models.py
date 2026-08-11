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
