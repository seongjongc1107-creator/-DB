import truststore

# 다른 모든 import(특히 httpx를 쓰는 라우터들)보다 먼저 실행돼야 함 — 사내망처럼
# 보안 프록시가 자체 인증서로 HTTPS를 가로채는 환경에서는, Windows 자체는 그
# 인증서를 신뢰하도록 설정돼 있어도 파이썬의 기본 인증서 목록(certifi)엔 없어서
# 외부 API 호출이 전부 CERTIFICATE_VERIFY_FAILED로 실패한다. truststore는 OS
# 자체의 인증서 저장소(Windows/macOS/Linux)를 그대로 쓰게 해서 이 문제를 해결한다.
truststore.inject_into_ssl()

from contextlib import asynccontextmanager
import asyncio
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .db import init_db
from .fpl_db import init_fpl_db
from .data_loader import store
from .wx_minima import load_wx_minima_file
from .scheduler import start_scheduler
from .routers import routes, navdata, search, typhoon, weather, volcanic_ash
from .routers.curfew import load_curfew_file

STATIC_DIR = Path(__file__).parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor(max_workers=1) as pool:
        await loop.run_in_executor(pool, store.load)
    load_curfew_file()
    load_wx_minima_file()
    await init_db()
    await init_fpl_db()
    start_scheduler()
    yield


app = FastAPI(title="Flight Route Dashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# 항로 geometry(11MB급) 같은 큰 JSON 응답이 많아 전송량을 줄이기 위해 gzip 압축 추가
app.add_middleware(GZipMiddleware, minimum_size=1000)

app.include_router(routes.router, prefix="/api/routes", tags=["routes"])
app.include_router(navdata.router, prefix="/api/navdata", tags=["navdata"])
app.include_router(search.router, prefix="/api/search", tags=["search"])
app.include_router(typhoon.router, prefix="/api/typhoon", tags=["typhoon"])
app.include_router(weather.router, prefix="/api/weather", tags=["weather"])
app.include_router(volcanic_ash.router, prefix="/api/volcanic-ash", tags=["volcanic-ash"])

from .routers import curfew as curfew_module
app.include_router(curfew_module.router, prefix="/api/curfew", tags=["curfew"])

from .routers import traffic as traffic_module
app.include_router(traffic_module.router, prefix="/api/traffic", tags=["traffic"])

from .routers import fois as fois_module
app.include_router(fois_module.router, prefix="/api/fois", tags=["fois"])

from .routers import admin as admin_module
app.include_router(admin_module.router, prefix="/api/admin", tags=["admin"])


@app.get("/api/health")
def health():
    return {"status": "ok", "loaded": store.loaded,
            "routes": len(store.routes), "airports": len(store.airports)}


if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
