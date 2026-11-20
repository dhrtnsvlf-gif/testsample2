"""오리엔트 공정불량 Manager (웹 버전) - FastAPI 서버."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from store import EXCEL_EXTS, ExcelStore, StoreError

# ───────────── 설정값 (사양서 8장) ─────────────
CAUSE_HEADER = "원인"                          # 요약 카드·행 색상·대시보드의 기준 열
DATE_HEADER = "접수일자"                        # 기간 조회의 기준 열
DIM_HEADERS = ("불량내용", "모델", "비고")       # 대시보드 상세 원그래프 열 (공백 무시)
MAX_CARDS = 6                                  # 원인 카드 최대 개수 (초과분은 '그 외')
DIM_TOP = 5                                    # 상세 원그래프 상위 표시 개수
# 색상(ACCENTS, ROW_TINT, CELL_TINT)과 스타일은 static/app.js, static/style.css 상단에 있다.

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
CONFIG_PATH = BASE_DIR / "config.json"
MAX_UPLOAD = 20 * 1024 * 1024

store = ExcelStore(str(DATA_DIR))
_config_lock = threading.Lock()

app = FastAPI(title="오리엔트 공정불량 Manager")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.exception_handler(StoreError)
def _store_error(_: Request, e: StoreError):
    return JSONResponse({"message": e.message, "errors": e.errors}, status_code=e.status)


def _read_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _remember(name: str):
    with _config_lock:
        cfg = _read_config()
        cfg["last_file"] = name
        CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ───────────── 화면 ─────────────
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/api/config")
def get_config():
    return {"causeHeader": CAUSE_HEADER, "dateHeader": DATE_HEADER, "dimHeaders": list(DIM_HEADERS),
            "maxCards": MAX_CARDS, "dimTop": DIM_TOP, "dataDir": str(DATA_DIR)}


# ───────────── 파일 ─────────────
@app.get("/api/files")
def list_files():
    return {"dataDir": str(DATA_DIR), "files": store.list_files()}


@app.get("/api/start")
def start(preferred: str | None = None):
    """처음 열 파일을 정한다: 브라우저가 기억한 파일 → config.json → data 폴더에 하나뿐인 파일."""
    files = [f["name"] for f in store.list_files()]
    last = preferred or _read_config().get("last_file")
    if last:
        if last in files:
            return {"file": last}
        return {"file": None, "message": f"이전에 연 파일을 찾을 수 없습니다.\n{DATA_DIR / last}\n"
                                          "경로가 바뀌었거나 삭제되었습니다. 파일을 다시 선택해 주세요."}
    if len(files) == 1:
        return {"file": files[0]}
    return {"file": None, "message": "엑셀 파일을 선택해 주세요."}


class OpenReq(BaseModel):
    file: str


@app.post("/api/open")
def open_file(req: OpenReq):
    data = store.load(req.file)
    _remember(req.file)
    return data


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    name = os.path.basename(file.filename or "")
    if not name.lower().endswith(EXCEL_EXTS):
        raise StoreError("엑셀 파일(.xlsx, .xlsm)만 올릴 수 있습니다.")
    content = await file.read(MAX_UPLOAD + 1)
    if len(content) > MAX_UPLOAD:
        raise StoreError("파일이 너무 큽니다(최대 20MB).")
    stem, ext = os.path.splitext(name)
    target, n = DATA_DIR / name, 1
    while target.exists():
        target = DATA_DIR / f"{stem} ({n}){ext}"
        n += 1
    target.write_bytes(content)
    try:
        store.validate_upload(str(target))
    except StoreError:
        target.unlink(missing_ok=True)
        raise
    return {"file": target.name}


# ───────────── 데이터 ─────────────
@app.get("/api/data")
def get_data(file: str):
    return store.load(file)


@app.get("/api/version")
def get_version(file: str):
    return {"version": store.version(file)}


class RowReq(BaseModel):
    file: str
    values: dict[str, str | None] = {}
    h: str | None = None


@app.post("/api/rows")
def create_row(req: RowReq):
    return store.create(req.file, req.values)


@app.put("/api/rows/{rid}")
def update_row(rid: int, req: RowReq):
    if not req.h:
        raise StoreError("행 정보가 없습니다.")
    return store.update(req.file, rid, req.h, req.values)


@app.delete("/api/rows/{rid}")
def delete_row(rid: int, file: str, h: str):
    return store.delete(file, rid, h)
