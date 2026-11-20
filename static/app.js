"use strict";
/* ───────── 설정값 (사양서 8장, 화면 쪽) ───────── */
const ACCENTS = ["#2563eb", "#e11d48", "#f59e0b", "#10b981", "#8b5cf6", "#0891b2", "#ea580c", "#64748b"];
const OTHER_COLOR = "#94a3b8";                 // '그 외' 색
const DIM_COLORS = ["#3b82f6", "#f97316", "#22c55e", "#a855f7", "#ec4899", "#94a3b8"];
const ROW_TINT = 0.13;                          // 원인별 행 배경 진하기
const CELL_TINT = 0.28;                         // 원인 칸 배경 진하기
const TOAST_MS = 4000;                          // 상태 줄 알림 시간
const POLL_MS = 5000;                           // 다른 사용자 변경 확인 주기
const EMPTY_LABEL = "(미입력)";
const OTHER_LABEL = "그 외";
const LS_KEY = "defect-manager.lastFile";

/* ───────── 상태 ───────── */
const S = {
  cfg: null,
  file: null,
  data: null,          // {file, version, columns, rows}
  causeIdx: -1, dateIdx: -1, autoIdx: -1, dimIdx: [],
  groups: [],          // [{key,label,color,members:Set}]
  groupOf: new Map(),  // 원인 값 → group key
  period: { mode: "all", base: null, start: null, end: null },
  search: "",
  causeFilter: null,   // 카드 필터 group key
  dashCause: null,     // 대시보드 선택 group key
  sort: { col: -1, dir: 0 },
  selKey: null,
  view: [],            // 현재 표에 보이는 행
  busy: false,
  tab: "list",
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => n.toLocaleString("ko-KR");
const pct = (n, t) => (t ? (n * 100) / t : 0);
const pctText = (n, t) => pct(n, t).toFixed(1) + "%";
const norm = (s) => String(s || "").replace(/\s+/g, "");
const lsGet = () => { try { return localStorage.getItem(LS_KEY); } catch { return null; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, v); } catch { /* 무시 */ } };

/* ───────── API ───────── */
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); }
  catch { throw Object.assign(new Error("서버에 연결할 수 없습니다."), { status: 0, errors: {} }); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json.message || (Array.isArray(json.detail) ? "요청 형식이 올바르지 않습니다." : json.detail) || `오류 (${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status, errors: json.errors || {} });
  }
  return json;
}
const q = (o) => new URLSearchParams(o).toString();

/* ───────── 날짜 도우미 ───────── */
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

function periodRange() {
  const p = S.period;
  if (p.mode === "all") return null;
  if (p.mode === "custom") return [p.start, p.end];
  const b = parseIso(p.base);
  if (p.mode === "week") {
    const mon = addDays(b, -((b.getDay() + 6) % 7));
    return [iso(mon), iso(addDays(mon, 6))];
  }
  if (p.mode === "month") return [iso(new Date(b.getFullYear(), b.getMonth(), 1)), iso(new Date(b.getFullYear(), b.getMonth() + 1, 0))];
  const qs = Math.floor(b.getMonth() / 3) * 3;
  return [iso(new Date(b.getFullYear(), qs, 1)), iso(new Date(b.getFullYear(), qs + 3, 0))];
}

function periodLabel() {
  const r = periodRange();
  if (!r) return "전체 기간";
  const b = parseIso(S.period.base), rng = `(${r[0]} ~ ${r[1]})`;
  switch (S.period.mode) {
    case "week": return `주간 ${rng}`;
    case "month": return `${b.getFullYear()}년 ${b.getMonth() + 1}월 ${rng}`;
    case "quarter": return `${b.getFullYear()}년 ${Math.floor(b.getMonth() / 3) + 1}분기 ${rng}`;
    default: return `기간 설정 ${rng}`;
  }
}

function dataDateBounds() {
  let min = null, max = null;
  if (S.dateIdx < 0) return [null, null];
  for (const r of S.data.rows) {
    const v = r.v[S.dateIdx].slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    if (!min || v < min) min = v;
    if (!max || v > max) max = v;
  }
  return [min, max];
}

/* ───────── 데이터 적용 ───────── */
const causeOf = (r) => (S.causeIdx >= 0 ? (r.v[S.causeIdx].trim() || EMPTY_LABEL) : null);
const rowKey = (r) => (S.autoIdx >= 0 && r.v[S.autoIdx] ? "n" + r.v[S.autoIdx] : "r" + r.rid);

function analyze() {
  const cols = S.data.columns, cfg = S.cfg;
  S.causeIdx = cols.findIndex((c) => norm(c.name) === norm(cfg.causeHeader));
  S.dateIdx = cols.findIndex((c) => norm(c.name) === norm(cfg.dateHeader) && c.type === "date");
  if (S.dateIdx < 0) S.dateIdx = cols.findIndex((c) => c.type === "date");
  S.autoIdx = cols.findIndex((c) => c.auto);
  S.dimIdx = cfg.dimHeaders.map((h) => cols.findIndex((c) => norm(c.name) === norm(h))).filter((i) => i >= 0);

  // 카드 순서·색은 파일 전체 기준으로 고정
  S.groups = []; S.groupOf = new Map();
  if (S.causeIdx < 0) return;
  const cnt = new Map();
  for (const r of S.data.rows) { const c = causeOf(r); cnt.set(c, (cnt.get(c) || 0) + 1); }
  const sorted = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
  const max = cfg.maxCards;
  const showAll = sorted.length <= max + 1;
  const head = showAll ? sorted : sorted.slice(0, max - 1);
  head.forEach(([label], i) => S.groups.push({ key: "c:" + label, label, color: ACCENTS[i % ACCENTS.length], members: new Set([label]) }));
  if (!showAll) S.groups.push({ key: "other", label: OTHER_LABEL, color: OTHER_COLOR, members: new Set(sorted.slice(max - 1).map((x) => x[0])) });
  for (const g of S.groups) for (const m of g.members) S.groupOf.set(m, g);
}

function setData(data, { reset = false } = {}) {
  S.data = data;
  analyze();
  if (reset) {
    S.search = ""; $("search").value = "";
    S.causeFilter = null; S.dashCause = null; S.sort = { col: -1, dir: 0 }; S.selKey = null;
    const [, max] = dataDateBounds();
    const today = iso(new Date());
    S.period = { mode: "all", base: max && max < today ? max : today, start: null, end: null };
  } else {
    if (S.causeFilter && !S.groups.some((g) => g.key === S.causeFilter)) S.causeFilter = null;
    if (S.dashCause && !S.groups.some((g) => g.key === S.dashCause)) S.dashCause = null;
  }
  $("fileChip").textContent = data.file; $("fileChip").title = data.file; $("fileChip").hidden = false;
  if (!data.columns.length) {
    showEmpty("시트에 데이터가 없습니다.\n첫 번째 시트에 열 제목과 자료가 있는지 확인해 주세요.");
    return;
  }
  $("emptyView").hidden = true; $("mainView").hidden = false;
  renderHead();
  renderAll();
}

/* ───────── 필터 ───────── */
function periodRows() {
  const r = periodRange();
  if (!r || S.dateIdx < 0) return S.data.rows;
  return S.data.rows.filter((row) => { const d = row.v[S.dateIdx].slice(0, 10); return d && d >= r[0] && d <= r[1]; });
}

function computeView(pRows) {
  let rows = pRows;
  if (S.causeFilter) {
    const g = S.groups.find((x) => x.key === S.causeFilter);
    rows = rows.filter((r) => g.members.has(causeOf(r)));
  }
  const words = S.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) rows = rows.filter((r) => { const t = r.v.join("\u0001").toLowerCase(); return words.every((w) => t.includes(w)); });
  if (S.sort.dir) {
    const i = S.sort.col, type = S.data.columns[i].type, d = S.sort.dir;
    const key = (r) => { const v = r.v[i]; if (v === "") return null; if (type === "number") { const n = parseFloat(v); return isNaN(n) ? v : n; } return v; };
    rows = rows.map((r, n) => [key(r), n, r]).sort((a, b) => {
      if (a[0] === null || b[0] === null) return a[0] === b[0] ? a[1] - b[1] : a[0] === null ? 1 : -1; // 빈 값은 항상 아래
      let c = typeof a[0] === "number" && typeof b[0] === "number" ? a[0] - b[0] : String(a[0]).localeCompare(String(b[0]), "ko", { numeric: true });
      return c * d || a[1] - b[1];
    }).map((x) => x[2]);
  }
  return rows;
}

/* ───────── 렌더링 ───────── */
function renderAll() {
  renderPeriod();
  const pRows = periodRows();
  renderCards(pRows);
  renderTable(pRows);
  if (S.tab === "dash") renderDash(pRows);
}

function renderPeriod() {
  const has = S.dateIdx >= 0;
  $("periodBar").hidden = !has;
  if (!has) return;
  const m = S.period.mode;
  document.querySelectorAll("#periodModes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === m));
  $("baseNav").hidden = m === "custom";
  $("customNav").hidden = m !== "custom";
  $("baseDate").value = S.period.base || "";
  $("baseDate").disabled = $("btnPrev").disabled = $("btnNext").disabled = m === "all";
  if (m === "custom") { $("startDate").value = S.period.start; $("endDate").value = S.period.end; }
  $("periodLabel").textContent = periodLabel();
}

function renderCards(pRows) {
  const box = $("cards");
  if (S.causeIdx < 0) { box.hidden = true; return; }
  box.hidden = false;
  const total = pRows.length;
  const cnt = new Map(S.groups.map((g) => [g.key, 0]));
  for (const r of pRows) { const g = S.groupOf.get(causeOf(r)); if (g) cnt.set(g.key, cnt.get(g.key) + 1); }
  const card = (key, label, color, n) => `
    <button class="card${(S.causeFilter || "all") === key ? " active" : ""}" data-key="${esc(key)}" style="--accent:${color}" title="${esc(label)}">
      <div class="c-name">${esc(label)}</div>
      <div class="c-num">${fmt(n)}<small>건 · ${pctText(n, total)}</small></div>
      <div class="c-bar"><i style="width:${pct(n, total).toFixed(1)}%"></i></div>
    </button>`;
  box.innerHTML = card("all", "전체", "#0f172a", total) + S.groups.map((g) => card(g.key, g.label, g.color, cnt.get(g.key))).join("");
}

function renderHead() {
  $("gridHead").innerHTML = S.data.columns.map((c, i) => {
    const arrow = S.sort.col === i && S.sort.dir ? `<span class="arrow">${S.sort.dir > 0 ? "▲" : "▼"}</span>` : "";
    return `<th data-col="${i}" title="눌러서 정렬">${esc(c.name)}${arrow}</th>`;
  }).join("");
}

function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function renderTable(pRows) {
  S.view = computeView(pRows);
  const cols = S.data.columns;
  const leftCols = new Set(cols.map((c, i) => (c.wide ? i : -1)));
  const html = [];
  for (const r of S.view) {
    const key = rowKey(r);
    let style = "";
    if (S.causeIdx >= 0) {
      const g = S.groupOf.get(causeOf(r));
      if (g) style = ` style="--rt:${tint(g.color, ROW_TINT)};--ct:${tint(g.color, CELL_TINT)}"`;
    }
    html.push(`<tr data-key="${esc(key)}"${key === S.selKey ? ' class="sel"' : ""}${style}>`);
    for (let i = 0; i < cols.length; i++) {
      const cls = i === S.causeIdx ? "cause" : leftCols.has(i) ? "left" : "";
      const v = r.v[i];
      html.push(`<td${cls ? ` class="${cls}"` : ""}${v.length > 20 ? ` title="${esc(v)}"` : ""}>${esc(v)}</td>`);
    }
    html.push("</tr>");
  }
  $("gridBody").innerHTML = html.join("");
  $("noRows").hidden = S.view.length > 0;
  if (S.selKey && !S.view.some((r) => rowKey(r) === S.selKey)) S.selKey = null;
  updateButtons();
  const total = S.data.rows.length, shown = S.view.length;
  $("countText").textContent = shown === total ? `전체 ${fmt(total)}건` : `${fmt(total)}건 중 ${fmt(shown)}건 표시`;
}

function selectedRow() { return S.selKey ? S.view.find((r) => rowKey(r) === S.selKey) || null : null; }

function updateButtons() {
  const has = !!selectedRow();
  $("btnView").disabled = $("btnEdit").disabled = $("btnDelete").disabled = !has;
}

function select(key, { scroll = false } = {}) {
  S.selKey = key;
  document.querySelectorAll("#gridBody tr.sel").forEach((tr) => tr.classList.remove("sel"));
  const tr = key ? $("gridBody").querySelector(`tr[data-key="${CSS.escape(key)}"]`) : null;
  if (tr) { tr.classList.add("sel"); if (scroll) tr.scrollIntoView({ block: "nearest" }); }
  updateButtons();
}

/* ───────── 대시보드 ───────── */
function countBy(rows, fn) {
  const m = new Map();
  for (const r of rows) { const k = fn(r); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

function renderDash(pRows) {
  const total = pRows.length;
  $("dashHead").innerHTML = `조회 기간: <b>${esc(periodLabel())}</b> · 총 <b>${fmt(total)}</b>건`;

  // 원인별
  const causeBox = $("causePie"), sum = $("summaryBox");
  if (S.causeIdx < 0) {
    causeBox.innerHTML = `<div class="no-data">'${esc(S.cfg.causeHeader)}' 열이 없습니다.</div>`;
    sum.innerHTML = "";
  } else {
    const cnt = new Map(S.groups.map((g) => [g.key, 0]));
    for (const r of pRows) { const g = S.groupOf.get(causeOf(r)); if (g) cnt.set(g.key, cnt.get(g.key) + 1); }
    const items = S.groups.map((g) => ({ key: g.key, label: g.label, color: g.color, count: cnt.get(g.key) }));
    drawPie(causeBox, items, { selected: S.dashCause, onClick: (k) => { S.dashCause = S.dashCause === k ? null : k; renderDash(periodRows()); } });
    const raw = [...countBy(pRows, causeOf).entries()].sort((a, b) => b[1] - a[1]);
    sum.innerHTML = `
      <div class="s-item"><div class="s-k">총 건수</div><div class="s-v">${fmt(total)}건</div></div>
      <div class="s-item"><div class="s-k">가장 많은 원인</div><div class="s-v">${raw.length ? `${esc(raw[0][0])} <small class="muted">${pctText(raw[0][1], total)}</small>` : "-"}</div></div>
      <div class="s-item"><div class="s-k">원인 종류</div><div class="s-v">${raw.length}종</div></div>`;
  }

  // 선택한 원인의 상세
  const g = S.groups.find((x) => x.key === S.dashCause);
  const target = g ? pRows.filter((r) => g.members.has(causeOf(r))) : pRows;
  $("dimTitle").textContent = g ? `원인 '${g.label}' 상세 (${fmt(target.length)}건)` : `전체 원인 상세 (${fmt(target.length)}건)`;
  $("btnAllCause").hidden = !g;
  const box = $("dimPies");
  if (!S.dimIdx.length) { box.innerHTML = `<div class="no-data">상세 그래프에 쓸 열(${esc(S.cfg.dimHeaders.join(", "))})이 없습니다.</div>`; return; }
  box.innerHTML = "";
  for (const i of S.dimIdx) {
    const div = document.createElement("div");
    div.className = "dim-box";
    div.innerHTML = `<h3>${esc(S.data.columns[i].name)}별 비율</h3><div class="pie-area dim"></div>`;
    box.appendChild(div);
    const sorted = [...countBy(target, (r) => r.v[i].trim() || EMPTY_LABEL).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko"));
    const top = S.cfg.dimTop;
    const items = sorted.slice(0, top).map(([label, count], n) => ({ key: label, label, count, color: DIM_COLORS[n % (DIM_COLORS.length - 1)] }));
    const rest = sorted.slice(top).reduce((s, x) => s + x[1], 0);
    if (rest) items.push({ key: "__other", label: OTHER_LABEL, count: rest, color: OTHER_COLOR });
    drawPie(div.querySelector(".pie-area"), items, { size: 190 });
  }
}

function drawPie(el, items, { selected = null, onClick = null, size = 230 } = {}) {
  const total = items.reduce((s, x) => s + x.count, 0);
  if (!total) { el.innerHTML = `<div class="no-data">선택한 기간에 자료가 없습니다.</div>`; return; }
  const R = size / 2 - 4, C = size / 2, NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", size); svg.setAttribute("height", size); svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  let a0 = -Math.PI / 2;
  const labels = [];
  for (const it of items) {
    if (!it.count) continue;
    const frac = it.count / total, a1 = a0 + frac * 2 * Math.PI;
    let shape;
    if (frac >= 0.9999) {
      shape = document.createElementNS(NS, "circle");
      shape.setAttribute("cx", C); shape.setAttribute("cy", C); shape.setAttribute("r", R); shape.classList.add("slice");
    } else {
      shape = document.createElementNS(NS, "path");
      const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0), x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
      shape.setAttribute("d", `M${C},${C} L${x0},${y0} A${R},${R} 0 ${frac > 0.5 ? 1 : 0} 1 ${x1},${y1} Z`);
    }
    shape.setAttribute("fill", it.color);
    if (selected && selected !== it.key) shape.classList.add("faded");
    const tipText = `${it.label}: ${fmt(it.count)}건 (${pctText(it.count, total)})`;
    shape.addEventListener("mousemove", (e) => showTip(e, tipText));
    shape.addEventListener("mouseleave", hideTip);
    if (onClick) shape.addEventListener("click", () => { hideTip(); onClick(it.key); });
    svg.appendChild(shape);
    if (frac >= 0.06) {
      const mid = (a0 + a1) / 2, lr = frac >= 0.9999 ? 0 : R * 0.64;
      labels.push([C + lr * Math.cos(mid), C + lr * Math.sin(mid), pct(it.count, total).toFixed(frac >= 0.1 ? 0 : 1) + "%"]);
    }
    a0 = a1;
  }
  for (const [x, y, t] of labels) {
    const tx = document.createElementNS(NS, "text");
    tx.setAttribute("x", x); tx.setAttribute("y", y); tx.setAttribute("text-anchor", "middle"); tx.setAttribute("dominant-baseline", "central");
    tx.textContent = t; svg.appendChild(tx);
  }
  const ul = document.createElement("ul");
  ul.className = "legend" + (onClick ? " click" : "");
  for (const it of items) {
    const li = document.createElement("li");
    if (selected) li.classList.add(selected === it.key ? "active" : "faded");
    li.innerHTML = `<span class="sw" style="background:${it.color}"></span><span class="lb" title="${esc(it.label)}">${esc(it.label)}</span>
      <span class="ct">${fmt(it.count)}건 · ${pctText(it.count, total)}</span>`;
    if (onClick) li.addEventListener("click", () => onClick(it.key));
    ul.appendChild(li);
  }
  el.replaceChildren(svg, ul);
}

function showTip(e, text) {
  const t = $("tip"); t.textContent = text; t.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - t.offsetWidth - 8);
  t.style.left = x + "px"; t.style.top = e.clientY + 14 + "px";
}
function hideTip() { $("tip").hidden = true; }

/* ───────── 알림 ───────── */
let toastTimer = null;
function toast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), TOAST_MS);
}

/* ───────── 파일 ───────── */
function showEmpty(msg) {
  $("mainView").hidden = true; $("emptyView").hidden = false;
  $("emptyMsg").textContent = msg;
  $("countText").textContent = "";
}

async function openFile(name) {
  try {
    const data = await api("POST", "/api/open", { file: name });
    S.file = name; lsSet(name);
    setData(data, { reset: true });
    closeModal("fileModal");
    return true;
  } catch (e) {
    S.file = null; S.data = null; $("fileChip").hidden = true;
    showEmpty(e.message);
    openFileModal(e.message);
    return false;
  }
}

async function openFileModal(msg) {
  $("fileErr").hidden = true;
  $("fileMsg").hidden = !msg; $("fileMsg").textContent = msg || "";
  $("fileList").innerHTML = `<li class="none">불러오는 중…</li>`;
  showModal("fileModal");
  try {
    const { dataDir, files } = await api("GET", "/api/files");
    $("dataDir").textContent = dataDir;
    $("fileList").innerHTML = files.length
      ? files.map((f) => `<li data-name="${esc(f.name)}" class="${f.name === S.file ? "current" : ""}">
          <span class="name">📊 ${esc(f.name)}</span><span class="muted">${(f.size / 1024).toFixed(0)}KB · ${esc(f.modified)}</span></li>`).join("")
      : `<li class="none">폴더에 엑셀 파일이 없습니다. 아래에서 파일을 올려 주세요.</li>`;
  } catch (e) {
    $("fileList").innerHTML = `<li class="none">${esc(e.message)}</li>`;
  }
}

/* ───────── 새로고침 / 동시 사용 ───────── */
async function reload({ notify = false } = {}) {
  if (!S.file) return;
  try {
    const data = await api("GET", "/api/data?" + q({ file: S.file }));
    const top = $("tableWrap").scrollTop;
    setData(data);
    $("tableWrap").scrollTop = top;
    if (notify) toast("다른 사용자가 변경한 내용을 반영했습니다.", "info");
  } catch (e) {
    if (e.status === 404 || e.status === 422) { showEmpty(e.message); S.file = null; $("fileChip").hidden = true; }
    else toast(e.message, "err");
  }
}

async function poll() {
  if (S.file && S.data && !S.busy && document.visibilityState === "visible") {
    try {
      const { version } = await api("GET", "/api/version?" + q({ file: S.file }));
      if (!S.busy && S.data && version !== S.data.version) await reload({ notify: true });
    } catch (e) {
      if (e.status === 404) reload();
    }
  }
  setTimeout(poll, POLL_MS);
}

/* ───────── 모달 공통 ───────── */
let lastFocus = null;
function showModal(id) { lastFocus = document.activeElement; $(id).hidden = false; }
function closeModal(id) {
  if ($(id).hidden) return;
  $(id).hidden = true;
  if (id === "fileModal" && !S.data) return;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus(); else $("tableWrap").focus();
}
const anyModal = () => ["fileModal", "formModal", "delModal"].some((id) => !$(id).hidden);

/* ───────── 입력 / 조회 / 수정 폼 ───────── */
const F = { mode: "view", row: null };
const DATE_RE = /^\s*(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\s*\.?\s*$/;

function buildForm() {
  const cols = S.data.columns;
  const lists = cols.map((c, i) => {
    if (c.type !== "text" || c.wide) return null;
    const set = new Set(S.data.rows.map((r) => r.v[i]).filter(Boolean));
    return set.size && set.size <= 300 ? [...set].sort((a, b) => a.localeCompare(b, "ko")) : null;
  });
  $("formFields").innerHTML = cols.map((c, i) => {
    const t = { date: "YYYY-MM-DD", number: "숫자", text: "" }[c.type];
    const dl = lists[i] ? `<datalist id="dl${i}">${lists[i].map((v) => `<option value="${esc(v)}">`).join("")}</datalist>` : "";
    return `<div class="field${c.wide ? " wide" : ""}" data-i="${i}">
      <label for="f${i}">${esc(c.name)}${c.auto ? '<span class="t">자동</span>' : t ? `<span class="t">${t}</span>` : ""}</label>
      <input id="f${i}" name="${i}" autocomplete="off" ${c.type === "number" ? 'inputmode="decimal"' : ""} ${c.type === "date" ? 'placeholder="YYYY-MM-DD"' : ""} ${lists[i] ? `list="dl${i}"` : ""}>
      ${dl}<div class="err" hidden></div></div>`;
  }).join("");
}

function nextNo() {
  if (S.autoIdx < 0) return "";
  let m = 0;
  for (const r of S.data.rows) { const n = parseFloat(r.v[S.autoIdx]); if (!isNaN(n) && n > m) m = n; }
  return String(Math.floor(m) + 1);
}

function openForm(mode, row = null) {
  if (mode !== "new" && !row) return;
  hideCtx();
  F.mode = mode; F.row = row;
  buildForm();
  S.data.columns.forEach((c, i) => {
    const inp = $("f" + i);
    inp.value = mode === "new" ? (c.auto ? nextNo() : "") : row.v[i];
  });
  setFormMode(mode);
  showModal("formModal");
  const first = [...$("formFields").querySelectorAll("input")].find((x) => !x.readOnly);
  (mode === "view" ? $("formEditBtn") : first || $("formSaveBtn")).focus();
}

function setFormMode(mode) {
  F.mode = mode;
  const title = { view: "자료 조회", edit: "자료 수정", new: "새 자료 입력" }[mode];
  const no = F.row && S.autoIdx >= 0 ? ` · No. ${F.row.v[S.autoIdx]}` : "";
  $("formTitle").textContent = title + (mode === "new" ? "" : no);
  S.data.columns.forEach((c, i) => { $("f" + i).readOnly = mode === "view" || c.auto; });
  $("formEditBtn").hidden = mode !== "view";
  $("formSaveBtn").hidden = mode === "view";
  $("formCloseBtn").textContent = mode === "view" ? "닫기" : "취소";
  $("formHint").textContent = mode === "view" ? "Esc: 닫기" : "Enter: 저장 · Esc: 닫기";
  clearFormErrors();
}

function clearFormErrors() {
  $("formError").hidden = true;
  document.querySelectorAll("#formFields .field").forEach((f) => { f.classList.remove("invalid"); f.querySelector(".err").hidden = true; });
}

function showFormErrors(errors, message) {
  let first = null;
  for (const [i, msg] of Object.entries(errors)) {
    const f = document.querySelector(`#formFields .field[data-i="${i}"]`);
    if (!f) continue;
    f.classList.add("invalid");
    const e = f.querySelector(".err"); e.textContent = msg; e.hidden = false;
    first = first || f.querySelector("input");
  }
  $("formError").textContent = message; $("formError").hidden = false;
  if (first) first.focus();
}

function validateForm() {
  const errors = {}, values = {};
  let anyValue = false;
  S.data.columns.forEach((c, i) => {
    if (c.auto) return;
    const v = $("f" + i).value.trim();
    values[i] = v;
    if (v) anyValue = true;
    if (!v) return;
    if (c.type === "date") {
      const m = v.match(DATE_RE);
      const d = m && new Date(+m[1], +m[2] - 1, +m[3]);
      if (!m) errors[i] = "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.";
      else if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) errors[i] = "존재하지 않는 날짜입니다.";
    } else if (c.type === "number" && !/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(v)) {
      errors[i] = "숫자만 입력할 수 있습니다.";
    }
  });
  return { errors, values, anyValue };
}

async function saveForm() {
  if (F.mode === "view" || S.busy) return;
  clearFormErrors();
  const { errors, values, anyValue } = validateForm();
  if (Object.keys(errors).length) return showFormErrors(errors, "입력값을 확인해 주세요.");
  if (!anyValue) return showFormErrors({}, "모든 칸이 비어 있어 저장하지 않았습니다.");
  S.busy = true; $("formSaveBtn").disabled = true;
  try {
    if (F.mode === "new") {
      const res = await api("POST", "/api/rows", { file: S.file, values });
      S.selKey = res.no != null ? "n" + res.no : "r" + res.rid;
      await reload();
      closeModal("formModal");
      select(S.selKey, { scroll: true });
      toast(`새 자료를 저장했습니다${res.no != null ? ` (No. ${res.no})` : ""}.`);
    } else {
      const res = await api("PUT", `/api/rows/${F.row.rid}`, { file: S.file, h: F.row.h, values });
      await reload();
      closeModal("formModal");
      select(S.selKey, { scroll: true });
      toast(res.changed ? "수정 내용을 저장했습니다." : "바뀐 내용이 없습니다.", res.changed ? "ok" : "info");
    }
  } catch (e) {
    showFormErrors(e.errors || {}, e.message);
    if (e.status === 409) reload();
  } finally {
    S.busy = false; $("formSaveBtn").disabled = false;
  }
}

/* ───────── 삭제 ───────── */
let delRow = null;
function openDelete(row) {
  if (!row) return;
  hideCtx();
  delRow = row;
  $("delInfo").innerHTML = S.data.columns.map((c, i) => `<tr><th>${esc(c.name)}</th><td>${esc(row.v[i]) || '<span class="muted">-</span>'}</td></tr>`).join("");
  $("delError").hidden = true;
  showModal("delModal");
  $("delCancel").focus();   // 기본 선택은 '취소'
}

async function doDelete() {
  if (!delRow || S.busy) return;
  const idx = S.view.findIndex((r) => rowKey(r) === rowKey(delRow));
  S.busy = true; $("delOk").disabled = true;
  try {
    await api("DELETE", `/api/rows/${delRow.rid}?` + q({ file: S.file, h: delRow.h }));
    const label = S.autoIdx >= 0 ? ` (No. ${delRow.v[S.autoIdx]})` : "";
    S.selKey = null;
    await reload();
    closeModal("delModal");
    const next = S.view[Math.min(idx, S.view.length - 1)];
    if (next && idx >= 0) select(rowKey(next), { scroll: true });
    $("tableWrap").focus();
    delRow = null;
    toast(`삭제했습니다${label}.`);
  } catch (e) {
    $("delError").textContent = e.message; $("delError").hidden = false;
    if (e.status === 409) reload();
  } finally {
    S.busy = false; $("delOk").disabled = false;
  }
}

/* ───────── 우클릭 메뉴 ───────── */
function showCtx(x, y) {
  const m = $("ctxMenu"); m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 4) + "px";
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 4) + "px";
}
function hideCtx() { $("ctxMenu").hidden = true; }

/* ───────── 탭 ───────── */
function setTab(tab) {
  S.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("tabList").hidden = tab !== "list";
  $("tabDash").hidden = tab !== "dash";
  if (tab === "dash" && S.data) renderDash(periodRows());
}

/* ───────── 이벤트 ───────── */
function bind() {
  $("btnFile").onclick = () => openFileModal();
  $("btnEmptyFile").onclick = () => openFileModal();
  $("fileList").onclick = (e) => { const li = e.target.closest("li[data-name]"); if (li) openFile(li.dataset.name); };
  $("uploadInput").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    $("fileErr").hidden = true;
    try {
      const { file } = await api("POST", "/api/upload", fd);
      if (await openFile(file)) toast(`'${file}' 파일을 올리고 열었습니다.`);
    } catch (err) { $("fileErr").textContent = err.message; $("fileErr").hidden = false; }
  };

  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  // 기간
  $("periodModes").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const mode = b.dataset.mode, p = S.period;
    if (mode === "custom" && p.mode !== "custom") {
      const r = periodRange() || dataDateBounds();
      p.start = r[0] || p.base; p.end = r[1] || p.base;
    }
    p.mode = mode;
    renderAll();
  };
  const step = (dir) => {
    const p = S.period, b = parseIso(p.base);
    if (p.mode === "week") p.base = iso(addDays(b, 7 * dir));
    else if (p.mode === "month") p.base = iso(new Date(b.getFullYear(), b.getMonth() + dir, 1));
    else if (p.mode === "quarter") p.base = iso(new Date(b.getFullYear(), b.getMonth() + 3 * dir, 1));
    renderAll();
  };
  $("btnPrev").onclick = () => step(-1);
  $("btnNext").onclick = () => step(1);
  $("baseDate").onchange = (e) => { if (e.target.value) { S.period.base = e.target.value; renderAll(); } };
  $("startDate").onchange = (e) => {
    const v = e.target.value; if (!v) return;
    S.period.start = v; if (S.period.end < v) S.period.end = v; renderAll();
  };
  $("endDate").onchange = (e) => {
    const v = e.target.value; if (!v) return;
    S.period.end = v; if (S.period.start > v) S.period.start = v; renderAll();
  };

  // 카드
  $("cards").onclick = (e) => {
    const c = e.target.closest(".card"); if (!c) return;
    const k = c.dataset.key;
    S.causeFilter = k === "all" || S.causeFilter === k ? null : k;
    renderAll();
  };

  // 검색
  let st = null;
  $("search").oninput = (e) => { clearTimeout(st); st = setTimeout(() => { S.search = e.target.value; renderTable(periodRows()); renderCards(periodRows()); }, 120); };

  // 표
  $("gridHead").onclick = (e) => {
    const th = e.target.closest("th"); if (!th) return;
    const i = +th.dataset.col, s = S.sort;
    if (s.col !== i) { s.col = i; s.dir = 1; } else s.dir = s.dir === 1 ? -1 : s.dir === -1 ? 0 : 1;
    renderHead(); renderTable(periodRows());
    if (S.selKey) select(S.selKey, { scroll: true });
  };
  const rowFromEvent = (e) => { const tr = e.target.closest("tbody tr"); return tr ? tr.dataset.key : null; };
  $("gridBody").onclick = (e) => { const k = rowFromEvent(e); if (k) select(k); };
  $("gridBody").ondblclick = (e) => { const k = rowFromEvent(e); if (k) { select(k); openForm("view", selectedRow()); } };
  $("gridBody").oncontextmenu = (e) => {
    const k = rowFromEvent(e); if (!k) return;
    e.preventDefault(); select(k); $("tableWrap").focus(); showCtx(e.clientX, e.clientY);
  };
  $("ctxMenu").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const row = selectedRow(); hideCtx();
    if (b.dataset.act === "view") openForm("view", row);
    if (b.dataset.act === "edit") openForm("edit", row);
    if (b.dataset.act === "delete") openDelete(row);
  };
  document.addEventListener("click", (e) => { if (!e.target.closest("#ctxMenu")) hideCtx(); });
  $("tableWrap").addEventListener("scroll", hideCtx);
  $("tableWrap").onkeydown = (e) => {
    const row = selectedRow();
    if (e.key === "Enter") { e.preventDefault(); openForm("view", row); }
    else if (e.key === "F2") { e.preventDefault(); openForm("edit", row); }
    else if (e.key === "Delete") { e.preventDefault(); openDelete(row); }
    else if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(e.key) && S.view.length) {
      e.preventDefault();
      let i = S.view.findIndex((r) => rowKey(r) === S.selKey);
      const page = Math.max(1, Math.floor($("tableWrap").clientHeight / 30) - 1);
      const d = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 }[e.key];
      i = i < 0 ? (d > 0 ? 0 : S.view.length - 1) : Math.max(0, Math.min(S.view.length - 1, i + d));
      select(rowKey(S.view[i]), { scroll: true });
    }
  };

  $("btnView").onclick = () => openForm("view", selectedRow());
  $("btnEdit").onclick = () => openForm("edit", selectedRow());
  $("btnDelete").onclick = () => openDelete(selectedRow());
  $("btnNew").onclick = () => openForm("new");

  // 폼
  $("rowForm").onsubmit = (e) => { e.preventDefault(); saveForm(); };
  $("formEditBtn").onclick = () => {
    setFormMode("edit");
    const first = [...$("formFields").querySelectorAll("input")].find((x) => !x.readOnly);
    if (first) first.focus();
  };
  $("formFields").addEventListener("input", (e) => {
    const f = e.target.closest(".field"); if (f) { f.classList.remove("invalid"); f.querySelector(".err").hidden = true; }
  });

  // 삭제
  $("delOk").onclick = doDelete;

  // 닫기 버튼 / 바깥 클릭
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.closest(".modal").id)));
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("mousedown", (e) => {
    if (e.target === m && !(m.id === "fileModal" && !S.data)) closeModal(m.id);
  }));

  $("btnAllCause").onclick = () => { S.dashCause = null; renderDash(periodRows()); };

  // 전역 단축키
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      hideCtx();
      for (const id of ["delModal", "formModal", "fileModal"]) if (!$(id).hidden) { if (id === "fileModal" && !S.data) return; closeModal(id); return; }
      return;
    }
    if (ctrl && e.key.toLowerCase() === "o") { e.preventDefault(); if (!anyModal()) openFileModal(); return; }
    if (anyModal() || !S.data) return;
    if (ctrl && e.key.toLowerCase() === "n") { e.preventDefault(); openForm("new"); }
    else if (ctrl && e.key.toLowerCase() === "f") { e.preventDefault(); setTab("list"); $("search").focus(); $("search").select(); }
  });
}

/* ───────── 시작 ───────── */
async function init() {
  bind();
  try {
    S.cfg = await api("GET", "/api/config");
    const st = await api("GET", "/api/start?" + q(lsGet() ? { preferred: lsGet() } : {}));
    if (st.file) await openFile(st.file);
    else { showEmpty(st.message); openFileModal(st.message); }
  } catch (e) {
    showEmpty(e.message);
  }
  setTimeout(poll, POLL_MS);
}
init();
