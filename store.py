"""엑셀 파일을 데이터 저장소로 사용하는 읽기/쓰기 계층.

- 첫 번째 시트만 사용, 첫 번째 비어 있지 않은 행을 헤더로 본다.
- 각 행은 (rid=시트 행 번호, h=행 내용 해시)로 식별한다.
  여러 사용자가 동시에 쓸 때, 저장 직전에 h를 비교해 다른 사람이 먼저 바꾼 행을 덮어쓰지 않는다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import threading
from collections import Counter
from copy import copy
from datetime import date, datetime

import openpyxl

EXCEL_EXTS = (".xlsx", ".xlsm")
WIDE_TEXT_LEN = 20  # 평균 길이가 이 값을 넘거나 최대 길이가 2배를 넘으면 폼에서 한 줄 전체 사용

_DATE_RE = re.compile(r"^\s*(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?\s*$")


class StoreError(Exception):
    """사용자에게 그대로 보여 줄 수 있는 오류."""

    def __init__(self, message: str, status: int = 400, errors: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.errors = errors or {}


# ───────────────────────── 값 변환 ─────────────────────────

def _is_empty(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _kind(v) -> str | None:
    if _is_empty(v):
        return None
    if isinstance(v, (datetime, date)):
        return "date"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return "number"
    return "text"


def display(v) -> str:
    """셀 값을 화면·비교용 문자열로 바꾼다."""
    if _is_empty(v):
        return ""
    if isinstance(v, datetime):
        if (v.hour, v.minute, v.second) != (0, 0, 0):
            return v.strftime("%Y-%m-%d %H:%M")
        return v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v).strip() if isinstance(v, str) else str(v)


def parse_input(text: str, col_type: str):
    """폼 입력 문자열을 셀 값으로 변환한다. 잘못된 값이면 ValueError(메시지)."""
    s = (text or "").strip()
    if s == "":
        return None
    if col_type == "date":
        m = _DATE_RE.match(s)
        if not m:
            raise ValueError("날짜는 YYYY-MM-DD 형식으로 입력해 주세요.")
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            raise ValueError("존재하지 않는 날짜입니다.") from None
    if col_type == "number":
        try:
            n = float(s.replace(",", ""))
        except ValueError:
            raise ValueError("숫자만 입력할 수 있습니다.") from None
        return int(n) if n.is_integer() else n
    return s


def norm_header(h: str) -> str:
    return re.sub(r"\s+", "", h or "")


# ───────────────────────── 시트 해석 ─────────────────────────

class Sheet:
    """워크북 첫 시트를 해석한 결과."""

    def __init__(self, ws):
        self.ws = ws
        self.header_row: int | None = None
        self.columns: list[dict] = []  # {idx(1-based 시트 열), name, type, wide, auto}
        self.rows: list[dict] = []     # {rid, h, values(raw list)}
        self._parse()

    def _parse(self):
        ws = self.ws
        raw_rows = []
        for r_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if all(_is_empty(v) for v in row):
                continue
            if self.header_row is None:
                self.header_row = r_idx
                header = list(row)
                continue
            raw_rows.append((r_idx, list(row)))
        if self.header_row is None:
            return

        col_idx = [i for i, h in enumerate(header) if not _is_empty(h)]
        names = [str(header[i]).strip() for i in col_idx]

        cols = []
        for pos, (i, name) in enumerate(zip(col_idx, names)):
            vals = [r[i] if i < len(r) else None for _, r in raw_rows]
            kinds = Counter(k for k in (_kind(v) for v in vals) if k)
            ctype = "text"
            if kinds:
                top, cnt = kinds.most_common(1)[0]
                if cnt * 2 > sum(kinds.values()):
                    ctype = top
            texts = [display(v) for v in vals if not _is_empty(v)]
            wide = False
            if ctype == "text" and texts:
                avg = sum(map(len, texts)) / len(texts)
                wide = avg > WIDE_TEXT_LEN or max(map(len, texts)) > WIDE_TEXT_LEN * 2
            auto = pos == 0 and norm_header(name).rstrip(".").lower() == "no" and ctype == "number"
            cols.append({"idx": i + 1, "name": name, "type": ctype, "wide": wide, "auto": auto})
        self.columns = cols

        for r_idx, r in raw_rows:
            values = [r[c["idx"] - 1] if c["idx"] - 1 < len(r) else None for c in cols]
            if all(_is_empty(v) for v in values):
                continue
            self.rows.append({"rid": r_idx, "values": values, "h": row_hash(values)})

    def find(self, rid: int, h: str) -> dict:
        """rid 위치의 행이 h와 같으면 그 행, 아니면 같은 h를 가진 유일한 행을 찾는다."""
        for row in self.rows:
            if row["rid"] == rid and row["h"] == h:
                return row
        same = [row for row in self.rows if row["h"] == h]
        if len(same) == 1:
            return same[0]
        raise StoreError(
            "다른 사용자가 이 행을 먼저 수정했거나 삭제했습니다. 목록을 새로 불러온 뒤 다시 시도해 주세요.",
            status=409,
        )


def row_hash(values) -> str:
    return hashlib.sha1(json.dumps([display(v) for v in values], ensure_ascii=False).encode()).hexdigest()[:16]


# ───────────────────────── 파일 저장소 ─────────────────────────

class ExcelStore:
    def __init__(self, data_dir: str):
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._cache: dict[str, tuple[str, dict]] = {}
        self._backed_up: set[str] = set()

    # ---- 파일 ----
    def list_files(self) -> list[dict]:
        out = []
        for name in sorted(os.listdir(self.data_dir)):
            p = os.path.join(self.data_dir, name)
            if os.path.isfile(p) and name.lower().endswith(EXCEL_EXTS) and not name.startswith("~$"):
                st = os.stat(p)
                out.append({"name": name, "size": st.st_size,
                            "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")})
        return out

    def path(self, name: str) -> str:
        if not name or os.path.basename(name) != name or not name.lower().endswith(EXCEL_EXTS):
            raise StoreError("잘못된 파일 이름입니다.")
        p = os.path.join(self.data_dir, name)
        if not os.path.isfile(p):
            raise StoreError(f"파일을 찾을 수 없습니다: {p}\n경로가 바뀌었거나 삭제되었습니다. 파일을 다시 선택해 주세요.",
                             status=404)
        return p

    def version(self, name: str) -> str:
        st = os.stat(self.path(name))
        return f"{st.st_mtime_ns}-{st.st_size}"

    def _lock(self, p: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(p, threading.Lock())

    @staticmethod
    def _open(p: str, read_only: bool = False):
        try:
            return openpyxl.load_workbook(p, keep_vba=p.lower().endswith(".xlsm"), read_only=read_only)
        except Exception as e:  # noqa: BLE001 - 손상 파일은 다양한 예외를 낸다
            raise StoreError(f"파일이 손상되었거나 열 수 없습니다. 다른 파일을 선택해 주세요.\n({type(e).__name__})",
                             status=422) from None

    # ---- 읽기 ----
    def load(self, name: str) -> dict:
        p = self.path(name)
        ver = self.version(name)
        cached = self._cache.get(p)
        if cached and cached[0] == ver:
            return cached[1]
        wb = self._open(p, read_only=True)
        try:
            sheet = Sheet(wb.worksheets[0])
        finally:
            wb.close()
        data = {
            "file": name,
            "version": ver,
            "columns": [{k: c[k] for k in ("name", "type", "wide", "auto")} for c in sheet.columns],
            "rows": [{"rid": r["rid"], "h": r["h"], "v": [display(v) for v in r["values"]]} for r in sheet.rows],
        }
        self._cache[p] = (ver, data)
        return data

    def validate_upload(self, p: str):
        wb = self._open(p, read_only=True)
        wb.close()

    # ---- 쓰기 ----
    def _write(self, name: str, fn):
        p = self.path(name)
        with self._lock(p):
            wb = self._open(p)
            ws = wb.worksheets[0]
            sheet = Sheet(ws)
            if sheet.header_row is None:
                raise StoreError("시트에 데이터가 없습니다.")
            result = fn(ws, sheet)
            if p not in self._backed_up:
                try:
                    shutil.copy2(p, p + ".bak")
                except OSError as e:
                    raise StoreError(f"백업 파일을 만들 수 없습니다: {e}", status=423) from None
                self._backed_up.add(p)
            fd, tmp = tempfile.mkstemp(dir=self.data_dir, suffix=os.path.splitext(p)[1])
            os.close(fd)
            try:
                wb.save(tmp)
                shutil.copymode(p, tmp)
                os.replace(tmp, p)
            except PermissionError:
                raise StoreError("파일이 다른 프로그램에서 열려 있어 저장하지 못했습니다. 파일을 닫고 다시 시도해 주세요.",
                                 status=423) from None
            finally:
                if os.path.exists(tmp):
                    os.remove(tmp)
            self._cache.pop(p, None)
            return result

    @staticmethod
    def _convert(sheet: Sheet, values: dict, current: list | None):
        """폼 값 → {열 위치: 셀 값}. 바뀌지 않은 칸은 제외한다."""
        errors, changes = {}, {}
        for pos, col in enumerate(sheet.columns):
            key = str(pos)
            if col["auto"] or key not in values:
                continue
            text = values[key] if isinstance(values[key], str) else ("" if values[key] is None else str(values[key]))
            if current is not None and text.strip() == display(current[pos]):
                continue
            try:
                changes[pos] = parse_input(text, col["type"])
            except ValueError as e:
                errors[key] = str(e)
        if errors:
            raise StoreError("입력값을 확인해 주세요.", status=422, errors=errors)
        return changes

    @staticmethod
    def _set(ws, row: int, col: dict, value):
        cell = ws.cell(row=row, column=col["idx"])
        cell.value = value
        if isinstance(value, datetime) and cell.number_format == "General":
            cell.number_format = "yyyy-mm-dd"

    def create(self, name: str, values: dict) -> dict:
        def fn(ws, sheet: Sheet):
            changes = self._convert(sheet, values, None)
            if all(v is None for v in changes.values()):
                raise StoreError("모든 칸이 비어 있어 저장하지 않았습니다.", status=422)
            last = sheet.rows[-1]["rid"] if sheet.rows else sheet.header_row
            new_r = last + 1
            if sheet.rows:
                for col in range(1, ws.max_column + 1):
                    src, dst = ws.cell(row=last, column=col), ws.cell(row=new_r, column=col)
                    if src.has_style:
                        dst._style = copy(src._style)
                if last in ws.row_dimensions and ws.row_dimensions[last].height:
                    ws.row_dimensions[new_r].height = ws.row_dimensions[last].height
            no = None
            for pos, col in enumerate(sheet.columns):
                if col["auto"]:
                    nums = [r["values"][pos] for r in sheet.rows if _kind(r["values"][pos]) == "number"]
                    no = int(max(nums)) + 1 if nums else 1
                    self._set(ws, new_r, col, no)
            for pos, v in changes.items():
                self._set(ws, new_r, sheet.columns[pos], v)
            return {"rid": new_r, "no": no}
        return self._write(name, fn)

    def update(self, name: str, rid: int, h: str, values: dict) -> dict:
        def fn(ws, sheet: Sheet):
            row = sheet.find(rid, h)
            changes = self._convert(sheet, values, row["values"])
            merged = list(row["values"])
            for pos, v in changes.items():
                merged[pos] = v
            if all(_is_empty(v) for v in merged):
                raise StoreError("모든 칸이 비어 있어 저장하지 않았습니다.", status=422)
            for pos, v in changes.items():
                self._set(ws, row["rid"], sheet.columns[pos], v)
            return {"rid": row["rid"], "changed": len(changes)}
        return self._write(name, fn)

    def delete(self, name: str, rid: int, h: str) -> dict:
        def fn(ws, sheet: Sheet):
            row = sheet.find(rid, h)
            ws.delete_rows(row["rid"], 1)
            return {"rid": row["rid"]}
        return self._write(name, fn)
