"""SQLAlchemy async engine — SQLite locally, swap DATABASE_URL for PostgreSQL in prod."""
from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

_raw = os.environ.get("DATABASE_URL", "")
if not _raw:
    _db_path = Path(__file__).parent.parent / "metar_archive.db"
    DATABASE_URL = f"sqlite+aiosqlite:///{_db_path}"
else:
    DATABASE_URL = _raw

_is_sqlite = "sqlite" in DATABASE_URL
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_async_engine(DATABASE_URL, connect_args=_connect_args)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def make_upsert(table, values: list[dict]):
    """INSERT with ON CONFLICT DO NOTHING — works for SQLite and PostgreSQL."""
    if _is_sqlite:
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    return insert(table).values(values).on_conflict_do_nothing()
