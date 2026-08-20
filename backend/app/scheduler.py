"""매일 자동으로 우리 항공사 거점 공항들의 FOIS 항로 제출 이력을 수집 — 관리자가
수동으로 "수집 & 조회"를 안 눌러도 fpl_archive가 계속 최신으로 유지되게 함.

거점 공항마다 "출발=거점/도착=전체" + "도착=거점/출발=전체" 둘 다 돌려야
해외→거점 도착편까지 빠짐없이 잡힘(국내선끼리는 한쪽만 돌려도 중복으로 걸리지만
그건 dedup으로 알아서 스킵됨).
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

# 제주항공(7C/JJA) 거점 공항 16곳
BASE_AIRPORTS = [
    "RKSI", "RKSS", "RKTU", "RKNY", "RKJK", "RKNW", "RKPC", "RKPK",
    "RKTN", "RKJJ", "RKJY", "RKPU", "RKTH", "RKPS", "RKJB", "RKTL",
]

# 매일 돌리되, 그 사이 놓친 날이 있을 수 있어서 최근 며칠은 다시 훑음 —
# 이미 수집된 편은 dedup으로 스킵되니 매일 도는 한 이 여유분 때문에 느려지진 않음
_WINDOW_DAYS = 7

_status: dict = {
    "running": False, "started_at": None, "finished_at": None,
    "jobs_done": 0, "jobs_total": 0, "last_error": None,
}


def get_scheduler_status() -> dict:
    return dict(_status)


async def _run_daily_collection() -> None:
    # 지연 임포트 — main.py 로드 시점에 fois 라우터가 아직 안 만들어졌을 수 있어서,
    # 실제로 잡이 실행되는 시점(스케줄러 트리거 시)에 가져옴
    from .routers.fois import _run_fpl_collect, _fpl_tasks

    if _status["running"]:
        return  # 이미 도는 중이면 중복 실행 방지(전날 것이 아직 안 끝났을 수도 있음)

    _status.update(running=True, started_at=date.today().isoformat(), jobs_done=0, last_error=None)
    end = date.today()
    start = end - timedelta(days=_WINDOW_DAYS)

    jobs: list[tuple[str, str]] = []
    for ap in BASE_AIRPORTS:
        jobs.append((ap, ""))
        jobs.append(("", ap))
    _status["jobs_total"] = len(jobs)

    for dep, arr in jobs:
        task_id = str(uuid.uuid4())
        _fpl_tasks[task_id] = {
            "dep": dep or None, "arr": arr or None,
            "start": start.isoformat(), "end": end.isoformat(),
            "status": "running", "total_days": 0, "processed_days": 0,
            "total_flights": 0, "collected": 0, "skipped": 0, "failed": 0,
            "error": None, "cancelled": False,
        }
        try:
            await _run_fpl_collect(task_id, dep, arr, start, end)
        except Exception as e:
            _status["last_error"] = f"{dep or arr}: {e}"
        finally:
            _status["jobs_done"] += 1
            _fpl_tasks.pop(task_id, None)  # 스케줄러용 임시 항목이라 끝나면 정리

    _status.update(running=False, finished_at=date.today().isoformat())


_scheduler: Optional[AsyncIOScheduler] = None


def start_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    _scheduler = AsyncIOScheduler(timezone="Asia/Seoul")
    # 새벽 3시(KST) — 국내 항공 트래픽이 제일 적은 시간대라 FOIS 부담이 덜함
    _scheduler.add_job(_run_daily_collection, CronTrigger(hour=3, minute=0), id="daily_fpl_collect")
    _scheduler.start()
    return _scheduler
