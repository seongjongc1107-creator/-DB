"""SQLAlchemy async engine for the FOIS 항로 제출 이력 아카이브 — 별도 파일/엔진으로
metar_archive.db와 분리. 한쪽을 손대다 실수해도 다른 쪽 데이터는 영향받지 않게 함."""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

_raw = os.environ.get("FPL_DATABASE_URL", "")
if not _raw:
    _db_path = Path(__file__).parent.parent / "fpl_archive.db"
    FPL_DATABASE_URL = f"sqlite+aiosqlite:///{_db_path}"
else:
    FPL_DATABASE_URL = _raw

_is_sqlite = "sqlite" in FPL_DATABASE_URL
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

fpl_engine = create_async_engine(FPL_DATABASE_URL, connect_args=_connect_args)
FplSessionLocal = async_sessionmaker(fpl_engine, expire_on_commit=False, class_=AsyncSession)


class FplBase(DeclarativeBase):
    pass


async def init_fpl_db() -> None:
    async with fpl_engine.begin() as conn:
        await conn.run_sync(FplBase.metadata.create_all)


def make_fpl_upsert(table, values: list[dict]):
    """INSERT with ON CONFLICT DO NOTHING — works for SQLite and PostgreSQL."""
    if _is_sqlite:
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    return insert(table).values(values).on_conflict_do_nothing()
