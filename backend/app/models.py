"""ORM models."""
from __future__ import annotations

from sqlalchemy import Column, DateTime, Float, Index, Integer, String, UniqueConstraint

from app.db import Base


class MetarArchive(Base):
    __tablename__ = "metar_archive"
    __table_args__ = (
        UniqueConstraint("icao", "obs_time", name="uq_metar_icao_obs"),
        Index("ix_metar_icao_obs", "icao", "obs_time"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    icao = Column(String(4), nullable=False)
    obs_time = Column(DateTime, nullable=False)
    wdir = Column(Integer, nullable=True)
    wspd = Column(Float, nullable=True)
    wgst = Column(Float, nullable=True)
    vis_m = Column(Integer, nullable=True)
    ceiling_ft = Column(Integer, nullable=True)
    temp_c = Column(Float, nullable=True)
    dewpoint_c = Column(Float, nullable=True)
    qnh_hpa = Column(Integer, nullable=True)
    flight_category = Column(String(8), nullable=True)
    raw = Column(String, nullable=True)
