from contextlib import asynccontextmanager
import asyncio
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .data_loader import store
from .routers import routes, navdata, search, typhoon


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor(max_workers=1) as pool:
        await loop.run_in_executor(pool, store.load)
    yield


app = FastAPI(title="Flight Route Dashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes.router, prefix="/api/routes", tags=["routes"])
app.include_router(navdata.router, prefix="/api/navdata", tags=["navdata"])
app.include_router(search.router, prefix="/api/search", tags=["search"])
app.include_router(typhoon.router, prefix="/api/typhoon", tags=["typhoon"])


@app.get("/api/health")
def health():
    return {"status": "ok", "loaded": store.loaded,
            "routes": len(store.routes), "airports": len(store.airports)}
