// 前端主程式：Chart.js 4 大圖版（每張全幅一列＋5m/1h/24h 時間窗）+ three.js 晶體
import {
  Chart, LineController, LineElement, PointElement, LinearScale, TimeScale,
  Filler, Tooltip, Legend, type ChartOptions, type ChartConfiguration,
} from 'chart.js';
import 'chartjs-adapter-date-fns';
import zoomPlugin from 'chartjs-plugin-zoom'; // 自我註冊時間适配器
import { Crystal } from './scene.ts';

Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Filler, Tooltip, Legend, zoomPlugin);
(window as unknown as { Chart: unknown }).Chart = Chart; // 除錯用：console 可 Chart.getChart(canvas)

Chart.defaults.color = '#5f7a78';
Chart.defaults.font.family = "'JetBrains Mono Variable', ui-monospace, monospace";
Chart.defaults.font.size = 10;
Chart.defaults.borderColor = 'rgba(45,212,191,.07)';
Chart.defaults.animation = false;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.legend.labels.boxHeight = 3;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(10,15,20,.92)';
Chart.defaults.plugins.tooltip.borderColor = 'rgba(45,212,191,.3)';
Chart.defaults.plugins.tooltip.borderWidth = 1;

declare const __BUILD_INFO__: string;   // esbuild define 注入（scripts/build-web.mjs）

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const TEAL = '#2dd4bf', AMBER = '#f59e0b', CRIT = '#ef4444', BLUE = '#38bdf8', VIOLET = '#a78bfa', PINK = '#f472b6';
const SOC_COLORS = [TEAL, BLUE, VIOLET, PINK, AMBER, '#34d399', '#fbbf24', '#94a3b8'];
const MAX_POINTS = 1800; // 即時環形上限
// 長窗滑動重載間隔：約窗寬的 1/60，曲線右緣會明顯往前推進，但請求量極小（gzip 後 1h=0.26MB/次）
const REFRESH_MS: Record<string, number> = { '1h': 30_000, '6h': 60_000, '24h': 120_000 };
// Auto-Y 自動軸重算節流：太頻繁會讓刻度上下跳、造成「資料在跳舞」的錯覺
const FIT_THROTTLE_MS = 30_000;

interface Group { name: string; cores: number[]; usagePct: number; curMHz: number; maxMHz: number }
interface Sample {
  ts: number; uptimeS: number; load: number[];
  cpu: { totalPct: number; groups: Group[] };
  mem: { totalMB: number; usedMB: number; availMB: number; swapTotalMB: number; swapUsedMB: number };
  gpu: { utilPct: number; tempC: number; powerW: number } | null;
  temps: { soc: number[]; nvmeC: number; maxC: number };
  disk: { usedPct: number; readMBs: number; writeMBs: number; readIops: number; writeIops: number };
  net: Record<string, { rxMBs: number; txMBs: number }>;
  procs: { cpu: { pid: number; comm: string; pct: number }[]; mem: { pid: number; comm: string; mb: number }[] };
}

const fmtGB = (mb: number) => (mb / 1024).toFixed(0);
const tabNum = (el: HTMLElement, v: string) => { if (el.textContent !== v) el.textContent = v; };

// ---------- 3D 主視覺（降級保護） ----------
let crystal: Crystal | null = null;
try {
  const fxOff = new URLSearchParams(location.search).get('fx') === 'off' || localStorage.getItem('fx') === '0';
  crystal = new Crystal($('fx') as HTMLCanvasElement);
  (window as unknown as { __crystal: Crystal }).__crystal = crystal;
  crystal.setOn(!fxOff);
  const fxBtn = $('fxToggle');
  fxBtn.classList.toggle('act', crystal.on);
  fxBtn.addEventListener('click', () => {
    crystal?.setOn(!crystal?.on);
    fxBtn.classList.toggle('act', !!crystal?.on);
  });

  // C：滑鼠互動（僅滑鼠裝置）——hero 視差微傾＋點擊敲擊
  if (matchMedia('(pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const hero = document.getElementById('hero')!;
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      crystal?.setPointer(((e.clientX - r.left) / r.width) * 2 - 1,
                          ((e.clientY - r.top) / r.height) * 2 - 1);
    }, { passive: true });
    hero.addEventListener('pointerleave', () => crystal?.setPointer(0, 0), { passive: true });
    $('fx').addEventListener('click', () => crystal?.poke());
  }
} catch (e) {
  console.warn('[fx] 3D degraded:', (e as Error).message);
  const hero = document.getElementById('hero');
  if (hero) hero.style.display = 'none';
}

// ---------- 曲線工廠 ----------
type Key = 'cpu' | 'gpu' | 'mem' | 'temp' | 'net' | 'disk';
type SeriesDef = { label: string; color: string; fill?: boolean; axis?: string };  // axis='y1' 掛右軸

interface ChartKit {
  chart: Chart;
  range: string;
  live: boolean;      // 5m 窗：SSE 逐幀追加
  nextRefresh: number; // 長窗：滑動重載的下次時間（0=不需）
  sumEl?: HTMLElement | null; // 摺態摘要列
  autoY: boolean;     // Auto-Y：自動貼合畫面內 min/max 為上下限（看細節模式）
  abs: { min?: number; max?: number };   // 關閉 Auto-Y 時的絕對軸（出廠設定）
  clamp: { min?: number; max?: number }; // 物理界線（% 圖 0–100 等），自動軸不越過
  sym: boolean;       // 網路鏡像圖：軸對稱於 0
  yFmt: (v: number) => string;
  lastFit: number;    // 上次自動重算軸的時間（30s 節流防跳動）
  ytag: HTMLElement | null; // 「Y:94–100」相對軸提示，防誤讀
}

// Auto-Y 開關記憶（每個瀏覽器各自記住自己的選擇）
const AY_KEY = 'gxmon-…ture';
function loadAutoY(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(AY_KEY) ?? '{}') as Record<string, boolean>; }
  catch { return {}; }
}
function saveAutoY(t: string, on: boolean): void {
  const m = loadAutoY(); m[t] = on;
  localStorage.setItem(AY_KEY, JSON.stringify(m));
}

// 摺疊/展開圖示（模組層級：摺鈕與全螢幕互斥邏輯都要用）
const ICON_FOLD = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg>';
const ICON_FULL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/></svg>';

// 摺疊態記憶（重開網頁維持使用者上次摺了哪幾張圖）
// 出廠預設：只有 GPU 展開，其餘全摺成摘要行；用戶動過的圖以 localStorage 為準
// 註：key 升 v2——讓新預設對舊瀏覽器記憶直接生效（v1 時代預設全展開，已無意義）
const FOLD_KEY = '***';
const FOLD_DEFAULT: Record<string, boolean> = {
  cpu: true, gpu: false, mem: true, temp: true, net: true, disk: true, proccpu: true, procmem: true,
};
const procSums: Partial<Record<'proccpu' | 'procmem', HTMLElement>> = {};
function loadFolded(): Record<string, boolean> {
  let m: Record<string, boolean> = {};
  try { m = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>; }
  catch { m = {}; }
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(FOLD_DEFAULT)) out[k] = k in m ? !!m[k] : FOLD_DEFAULT[k];
  return out;
}
function saveFolded(t: string, on: boolean): void {
  let m: Record<string, boolean> = {};
  try { m = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>; }
  catch { m = {}; }
  m[t] = on;   // 只寫使用者按過的鍵：沒碰過的圖永遠跟隨出廠預設
  localStorage.setItem(FOLD_KEY, JSON.stringify(m));
}

/** 圓整上下限：留 8% 呼吸空間，刻度落在整齊步進 → 軸不無謂跳動 */
function niceBounds(lo: number, hi: number, padFloor: number): { min: number; max: number } {
  const range = Math.max(hi - lo, 1e-9);
  const pad = Math.max(range * 0.08, padFloor);
  lo -= pad; hi += pad;
  const raw = (hi - lo) / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = 10 * pow;
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) { step = m * pow; break; }
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step };
}

/** 依目前視窗內全部序列的資料算自動上下限（含物理界線與鏡像對稱）；右軸(y1)序列不参与——它有自己的固定 0–100 軸 */
function fitY(kit: ChartKit): void {
  const ds = kit.chart.data.datasets as { data: { x: number; y: number }[]; yAxisID?: string }[];
  let lo = Infinity, hi = -Infinity, maxAbs = 0;
  for (const d of ds) { if (d.yAxisID === 'y1') continue; for (const p of d.data) {
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
    if (kit.sym) maxAbs = Math.max(maxAbs, Math.abs(p.y));
  } }
  if (!Number.isFinite(lo)) return; // 無資料不動軸
  let b = kit.sym
    ? niceBounds(-maxAbs, maxAbs, 0.2)
    : niceBounds(lo, hi, Math.abs(hi) * 0.02 + 0.5);
  if (kit.clamp.min !== undefined) b.min = Math.max(b.min, kit.clamp.min);
  if (kit.clamp.max !== undefined) b.max = Math.min(b.max, kit.clamp.max);
  if (b.min === b.max) b.max = b.min + 1; // 平線保護
  const y = kit.chart.options.scales!.y as { min?: number; max?: number };
  y.min = b.min; y.max = b.max;
  kit.lastFit = Date.now();
  if (kit.ytag) {
    kit.ytag.textContent = kit.sym ? `±${kit.yFmt(maxAbs * 1.15)}` : `${kit.yFmt(b.min)}–${kit.yFmt(b.max)}`;
    kit.ytag.style.display = '';
  }
}

/** 依 autoY 狀態落地 Y 軸：開＝自動貼合，關＝回復出廠絕對軸（鏡像圖回復逐幀對稱外扩） */
function applyY(kit: ChartKit): void {
  if (kit.autoY) { fitY(kit); return; }
  if (kit.sym) { fitNetMirror(kit); if (kit.ytag) kit.ytag.style.display = 'none'; return; }
  const y = kit.chart.options.scales!.y as { min?: number; max?: number; grace?: string };
  if (kit.abs.min !== undefined) y.min = kit.abs.min; else delete y.min;
  if (kit.abs.max !== undefined) y.max = kit.abs.max; else delete y.max;
  if (kit.abs.min === undefined) y.grace = '8%'; else delete y.grace;
  if (kit.ytag) kit.ytag.style.display = 'none';
}

function mkDataset(def: SeriesDef): object {
  return {
    label: def.label,
    data: [] as { x: number; y: number }[],
    borderColor: def.color,
    backgroundColor: def.fill ? def.color + '1e' : def.color,
    borderWidth: 1.6,
    pointRadius: 0,
    tension: 0.25,
    fill: def.fill ? 'origin' : false,
    decimation: { enabled: true, algorithm: 'lttb', samplesPerPoint: 4 },
    ...(def.axis ? { yAxisID: def.axis } : {}),
  };
}

function mkChart(canvasId: string, defs: SeriesDef[], yFmt: (v: number) => string, opts2: {
  abs?: { min?: number; max?: number }; clamp?: { min?: number; max?: number }; sym?: boolean; pct?: boolean;
} = {}): ChartKit {
  const ctx = ($ (canvasId) as unknown as HTMLCanvasElement).getContext('2d')!;
  const ds = defs.map(mkDataset);
  const abs = opts2.abs ?? {};
  const opts: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    normalized: true,
    interaction: { mode: 'index', intersect: false },
    scales: {
      x: {
        type: 'time',
        time: { unit: 'minute' },
        ticks: { maxTicksLimit: 8, maxRotation: 0 },
        grid: { color: 'rgba(45,212,191,.06)' },
      },
      y: {
        ...(abs.min !== undefined ? { min: abs.min } : { grace: '8%' }),
        ...(abs.max !== undefined ? { max: abs.max } : {}),
        ticks: { maxTicksLimit: 6, callback: (v) => yFmt(Number(v)) },
        grid: { color: 'rgba(45,212,191,.06)' },
      },
      ...(opts2.pct ? {
        y1: {
          position: 'right', min: 0, max: 100,
          ticks: { maxTicksLimit: 5, callback: (v) => v + '%' },
          grid: { drawOnChartArea: false },   // 右軸不疊第二層格線
        },
      } : {}),
    },
    plugins: {
      zoom: {
        zoom: { wheel: { enabled: false }, pinch: { enabled: false }, mode: 'x' },
        pan: { enabled: false, mode: 'x' },
      },
      legend: { position: 'bottom', labels: { padding: 10, usePointStyle: false } },
      tooltip: {
        callbacks: {
          title: (items) => new Date(Number(items[0].parsed.x) || 0).toLocaleTimeString('zh-TW', { hour12: false }),
          // 右軸序列（使用率%）用自己的格式，其餘走該圖 yFmt
          label: (item) => `${item.dataset.label}  ${(item.dataset as { yAxisID?: string }).yAxisID === 'y1'
            ? Number(item.parsed.y).toFixed(0) + '%' : yFmt(Number(item.parsed.y))}`,
        },
      },
    },
  };
  const chart = new Chart(ctx, { type: 'line', data: { datasets: ds }, options: opts } as ChartConfiguration<'line'>);
  return { chart, range: '5m', live: true, nextRefresh: 0, autoY: false,
    abs, clamp: opts2.clamp ?? {}, sym: opts2.sym ?? false, yFmt, lastFit: 0, ytag: null, sumEl: null };
}

// ---------- 各圖的資料映射 ----------
const kits = {} as Record<Key, ChartKit>;

function buildCharts(): void {
  kits.cpu = mkChart('chCpu', [
    { label: 'Total', color: TEAL, fill: true }, { label: 'P-cores', color: AMBER }, { label: 'E-cores', color: BLUE },
  ], v => v.toFixed(0) + '%', { abs: { min: 0, max: 100 }, clamp: { min: 0, max: 100 } });

  kits.gpu = mkChart('chGpu', [
    { label: 'util %', color: TEAL, fill: true }, { label: 'Temp °C', color: AMBER }, { label: 'Power W', color: VIOLET },
  ], v => v.toFixed(0), { abs: { min: 0 }, clamp: { min: 0 } });

  kits.mem = mkChart('chMem', [
    { label: 'used', color: TEAL, fill: true }, { label: 'swap', color: CRIT },
  ], v => fmtGB(v) + 'G', { abs: { min: 0 }, clamp: { min: 0 } });

  const tempDefs: SeriesDef[] = [0, 1, 2, 3, 4, 5, 6].map(i => ({ label: `T${i}`, color: SOC_COLORS[i] }));
  tempDefs.push({ label: 'NVMe', color: '#94a3b8' });
  kits.temp = mkChart('chTemp', tempDefs, v => v.toFixed(0) + '°', { abs: { min: 0 }, clamp: { min: 0 } });

  kits.net = mkChart('chNet', [
    { label: '↓ Down', color: TEAL, fill: true }, { label: '↑ Up', color: PINK, fill: true },
  ], v => Math.abs(v).toFixed(1) + 'M', { sym: true });

  kits.disk = mkChart('chDisk', [
    { label: 'Write MB/s', color: AMBER, fill: true }, { label: 'Read MB/s', color: BLUE, fill: true },
    { label: '/ Usage', color: TEAL, axis: 'y1' },   // 右軸 0–100%（容量是慢變量，不與 MB/s 共軸）
  ], v => v.toFixed(1) + 'M', { abs: { min: 0 }, clamp: { min: 0 }, pct: true });

  // Auto-Y 按鈕記憶恢復
  const remembered = loadAutoY();
  (Object.keys(kits) as Key[]).forEach(t => { kits[t].autoY = !!remembered[t]; });

  document.querySelectorAll<HTMLElement>('.ranges[data-t]').forEach(el => {   // 只挑曲線圖的；表卡 ranges[data-p] 不套時間窗
    const t = el.dataset.t as Key;
    for (const r of ['5m', '1h', '6h', '24h']) {
      const b = document.createElement('button');
      b.textContent = r; b.className = r === '5m' ? 'on' : '';
      b.onclick = () => {
        [...el.querySelectorAll('button:not(.ayb):not(.foldb)')].forEach(c => c.classList.remove('on'));
        b.classList.add('on');
        kits[t].range = r;
        kits[t].live = r === '5m';
        kits[t].nextRefresh = r === '5m' ? 0 : Date.now() + REFRESH_MS[r];
        void loadHistory(t); // loadHistory 內會 applyY（換窗重算自動軸）
      };
      el.appendChild(b);
    }
    const ayb = document.createElement('button');
    ayb.textContent = 'Auto-Y'; ayb.className = 'ayb' + (kits[t].autoY ? ' on' : '');
    ayb.title = 'Auto-fit Y axis to visible min/max (for detail)';
    ayb.onclick = () => {
      kits[t].autoY = !kits[t].autoY;
      ayb.classList.toggle('on', kits[t].autoY);
      saveAutoY(t, kits[t].autoY);
      applyY(kits[t]);
      kits[t].chart.update('none');
    };
    el.appendChild(ayb);
    // 摺疊鈕（右上角最後一位）：收成一條摘要列，再點展開回來
    const fb = document.createElement('button');
    fb.className = 'foldb'; fb.title = 'Collapse to summary / expand'; fb.innerHTML = ICON_FOLD;
    fb.onclick = () => {
      const card = kits[t].chart.canvas.closest<HTMLElement>('.card')!;
      if (card.classList.contains('big')) toggleExpand(t);   // 全螢幕態要先退出
      const min = card.classList.toggle('min');
      fb.innerHTML = min ? ICON_FULL : ICON_FOLD;
      fb.classList.toggle('on', min);
      if (kits[t].sumEl) kits[t].sumEl.style.display = min ? 'inline-flex' : 'none';
      refreshSummary(t);
      saveFolded(t, min);
      if (!min) requestAnimationFrame(() => kits[t].chart.resize());   // 展開回來才重繪（摺起時 canvas 隱藏，免算 0 尺寸）
    };
    el.appendChild(fb);
    // 放大鈕＝卡片左下角圖示
    const exp = document.createElement('button');
    exp.className = 'expb'; exp.title = 'Expand full screen (Esc to close)'; exp.innerHTML = ICON_FULL;
    exp.onclick = () => toggleExpand(t);
    kits[t].chart.canvas.parentElement!.appendChild(exp);
    // 摺疊摘要列：各曲線最新值一行（僅 .min 態顯示，隨即時推送更新；插在範圍鈕前）
    const sum = document.createElement('span');
    sum.className = 'sumline'; sum.style.display = 'none';
    const h3 = kits[t].chart.canvas.closest('.card')!.querySelector('h3')!;
    h3.insertBefore(sum, h3.querySelector('.ranges'));
    kits[t].sumEl = sum;
    // 回復上次離開時的摺疊態（含摘要、圖示與鈕態；不觸發 save 免互踩）
    if (loadFolded()[t]) {
      kits[t].chart.canvas.closest('.card')!.classList.add('min');
      fb.innerHTML = ICON_FULL; fb.classList.add('on');
      sum.style.display = 'inline-flex';
      refreshSummary(t);
    }
    // Y 軸範圍提示（Auto-Y 開啟時顯示於圖左上角，防相對軸誤讀）
    const chartBox = kits[t].chart.canvas.parentElement;
    const ytag = document.createElement('span');
    ytag.className = 'ytag'; ytag.style.display = 'none';
    chartBox?.appendChild(ytag);
    kits[t].ytag = ytag;
    applyY(kits[t]); // 套用記憶的 autoY 出廠態
    kits[t].chart.canvas.addEventListener('dblclick', () => {
      if (kits[t].chart.canvas.closest('.card.big')) kits[t].chart.resetZoom();
    });
  });
  // Top CPU / Top MEM 兩張表卡：同款摺疊鈕（摘要=第一名程序），記憶共用 gxmon-fold
  for (const [pid, cardId] of [['proccpu', 'pCpu'], ['procmem', 'pMem']] as const) {
    const card = $(cardId);
    const h3 = card.querySelector('h3')!;
    const sum = document.createElement('span');
    sum.className = 'sumline'; sum.style.display = 'none';
    h3.insertBefore(sum, h3.querySelector('.ranges'));
    procSums[pid] = sum;
    const fb = document.createElement('button');
    fb.className = 'foldb'; fb.title = 'Collapse to summary / expand'; fb.innerHTML = ICON_FOLD;
    fb.onclick = () => {
      const min = card.classList.toggle('min');
      fb.innerHTML = min ? ICON_FULL : ICON_FOLD;
      fb.classList.toggle('on', min);
      sum.style.display = min ? 'inline-flex' : 'none';
      saveFolded(pid, min);
      if (lastSample) procSummary(pid, sum, lastSample);
    };
    h3.querySelector('.ranges')!.appendChild(fb);
    if (loadFolded()[pid]) {
      card.classList.add('min');
      fb.innerHTML = ICON_FULL; fb.classList.add('on');
      sum.style.display = 'inline-flex';
      if (lastSample) procSummary(pid, sum, lastSample);
    }
  }
  addEventListener('keydown', e => {
    const big = document.querySelector('.card.big');
    if (e.key === 'Escape' && big) big.querySelector<HTMLElement>('.expb')?.click();
  });
}

/** 表卡摺態摘要：第一名程序（CPU 取 %、MEM 取 MB） */
function procSummary(pid: 'proccpu' | 'procmem', el: HTMLElement, s: Sample): void {
  if (el.style.display === 'none') return;
  if (pid === 'proccpu') {
    const p = s.procs.cpu[0];
    el.innerHTML = p ? `<i style="background:#2dd4bf"></i><em>No.1</em>${p.comm} ${p.pct.toFixed(0)}%` : '—';
  } else {
    const p = s.procs.mem[0];
    el.innerHTML = p ? `<i style="background:#f472b6"></i><em>No.1</em>${p.comm} ${(p.mb / 1024).toFixed(1)}G` : '—';
  }
}

function seriesVals(t: Key, s: Sample): number[] {
  switch (t) {
    case 'cpu': return [s.cpu.totalPct, s.cpu.groups[0]?.usagePct ?? 0, s.cpu.groups[1]?.usagePct ?? 0];
    case 'gpu': return [s.gpu?.utilPct ?? 0, s.gpu?.tempC ?? 0, s.gpu?.powerW ?? 0];
    case 'mem': return [s.mem.usedMB, s.mem.swapUsedMB];
    case 'temp': return [...s.temps.soc, s.temps.nvmeC];
    case 'net': {
      const vals = Object.values(s.net);
      return [vals.reduce((a, v) => a + v.rxMBs, 0), -vals.reduce((a, v) => a + v.txMBs, 0)];
    }
    case 'disk': return [s.disk.writeMBs, s.disk.readMBs, s.disk.usedPct];
  }
}

async function loadHistory(t: Key): Promise<void> {
  const kit = kits[t];
  const res = await fetch(`/api/history?range=${kit.range}`);
  const hist: Sample[] = await res.json();
  const ds = kit.chart.data.datasets as { data: { x: number; y: number }[] }[];
  ds.forEach(d => { d.data = []; });
  for (const s of hist) {
    const vals = seriesVals(t, s);
    ds.forEach((d, i) => d.data.push({ x: s.ts, y: vals[i] ?? 0 }));
  }
  (kit.chart.options.scales!.x as { time?: object }).time = kit.range === '24h' || kit.range === '6h' ? { unit: 'hour' } : { unit: 'minute' };
  applyY(kit); // 換窗／重載後重新落地 Y 軸（Auto-Y 開著就重算貼合）
  kit.chart.update();
  refreshSummary(t);
}

/** 摺態摘要列：每圖挑「最會瞄的一兩個數」，短標籤＋帶單位，六行版面一致 */
function refreshSummary(t: Key): void {
  const kit = kits[t];
  if (!kit.sumEl || kit.sumEl.style.display === 'none') return;
  const ds = kit.chart.data.datasets as { data: { x: number; y: number }[]; label: string; borderColor: string }[];
  const last = (i: number) => ds[i]?.data[ds[i].data.length - 1]?.y;
  const seg = (label: string, color: string, txt: string) =>
    `<i style="background:${color}"></i><em>${label}</em>${txt}`;
  const f = (v: number | undefined) => v === undefined ? '—' : kit.yFmt(v);   // 該圖出廠格式
  const S = '<s></s>';
  let html = '';
  if (t === 'cpu') {                                  // 只留整體 loading%（大小核看展開圖）
    html = seg('Load', ds[0].borderColor, f(last(0)));
  } else if (t === 'gpu') {                           // util＋溫度（yFmt 無單位，這裡補上）
    const u = last(0), tp = last(1);
    html = seg('util', ds[0].borderColor, u === undefined ? '—' : u.toFixed(0) + '%')
      + S + seg('Temp', ds[1].borderColor, tp === undefined ? '—' : tp.toFixed(0) + '°');
  } else if (t === 'temp') {                          // 彙整：SoC 七區最高＋SSD
    let mx: number | undefined;
    for (let i = 0; i < 7; i++) { const v = last(i); if (v !== undefined) mx = mx === undefined ? v : Math.max(mx, v); }
    html = seg('SoC max', '#2dd4bf', f(mx)) + S + seg('SSD', '#94a3b8', f(last(7)));
  } else if (t === 'mem') {                           // 使用＋Swap（統一記憶體兩隻腳）
    html = seg('Used', ds[0].borderColor, f(last(0))) + S + seg('Swap', ds[1].borderColor, f(last(1)));
  } else {                                            // 網路/磁碟：多曲線縮短標籤（↓下 0.4M／寫 2.1M）；右軸序列(使用率)走 % 格式
    const short: Record<string, string> = { '↓ Down': '↓Dn', '↑ Up': '↑Up', 'Write MB/s': 'Wr', 'Read MB/s': 'Rd', '/ Usage': 'Use' };
    html = (ds as { label: string; borderColor: string; yAxisID?: string }[]).map((d, i) => {
      const v = last(i);
      const txt = v === undefined ? '—' : d.yAxisID === 'y1' ? v.toFixed(0) + '%' : f(v);
      return seg(short[d.label] ?? d.label, d.borderColor, txt);
    }).join(S);
  }
  kit.sumEl.innerHTML = html;
}

/** 網路鏡像圖：y 軸依資料動態對稱外扩（上行為負值區）；zoom 中不動它 */
function fitNetMirror(kit: ChartKit): void {
  if (kit !== kits.net) return;
  const ds = kit.chart.data.datasets as { data: { x: number; y: number }[] }[];
  let maxAbs = 0.2;
  for (const d of ds) for (const p of d.data) maxAbs = Math.max(maxAbs, Math.abs(p.y));
  const bound = maxAbs * 1.15;
  (kit.chart.options.scales!.y as { min?: number; max?: number }).min = -bound;
  (kit.chart.options.scales!.y as { min?: number; max?: number }).max = bound;
}

/** 整張圖放大／縮小：把卡片展開為全螢幕（視野更大、解析度更高），同時只允許一張 */
function toggleExpand(t: Key): void {
  const card = kits[t].chart.canvas.closest<HTMLElement>('.card')!;
  const isOpen = card.classList.contains('big');
  const cardWasMin = card.classList.contains('min');
  document.querySelectorAll('.card.big').forEach(c => c.classList.remove('big'));
  document.querySelectorAll<HTMLElement>('.expb').forEach(b => b.classList.remove('on'));
  const zoomOpts = kits[t].chart.options.plugins!.zoom as
    { zoom: { wheel: { enabled: boolean }; pinch: { enabled: boolean } }; pan: { enabled: boolean } };
  if (!isOpen) {
    card.classList.remove('min');           // 全螢幕與摺態互斥
    card.classList.add('big');
    card.querySelector<HTMLElement>('.expb')?.classList.add('on');
    const fbEl = card.querySelector<HTMLElement>('.foldb');
    if (fbEl) { fbEl.classList.remove('on'); fbEl.innerHTML = ICON_FOLD; }
    if (cardWasMin) saveFolded(t, false);   // 展開全螢幕視為放棄摺疊，記憶同步
    const sum = kits[t].sumEl; if (sum) sum.style.display = 'none';
    zoomOpts.zoom.wheel.enabled = true; zoomOpts.zoom.pinch.enabled = true; zoomOpts.pan.enabled = true;
  } else {
    zoomOpts.zoom.wheel.enabled = false; zoomOpts.zoom.pinch.enabled = false; zoomOpts.pan.enabled = false;
    kits[t].chart.resetZoom('none');
  }
  document.body.classList.toggle('hasBig', !isOpen);
  // Chart.js responsive 會跟著容器尺寸重繪，補一發確保
  const target = kits[t];
  requestAnimationFrame(() => target.chart.resize());
  requestAnimationFrame(() => { document.querySelectorAll<HTMLCanvasElement>('.card.big .chart canvas').forEach(cv => {
    const c = Chart.getChart(cv); c?.resize();
  }); });
}

function livePush(t: Key, s: Sample): void {
  const kit = kits[t];
  if (!kit.live) return;
  const vals = seriesVals(t, s);
  const ds = kit.chart.data.datasets as { data: { x: number; y: number }[] }[];
  ds.forEach((d, i) => {
    d.data.push({ x: s.ts, y: vals[i] ?? 0 });
    if (d.data.length > MAX_POINTS) d.data.shift();
  });
  refreshSummary(t);   // 摺態摘要列即時跟著跳（未摺時函式內部直接跳過）
  if (kit.autoY) {
    // 自動軸防跳動：5m 逐幀追加但不每幀重算軸，30 秒才挪一次刻度
    if (Date.now() - kit.lastFit > FIT_THROTTLE_MS) applyY(kit);
  } else if (kit.sym) fitNetMirror(kit);
  kit.chart.update('none');
}

// ---------- 膠囊/表格/晶體渲染 ----------
function renderChrome(s: Sample): void {
  $('connDot').classList.remove('off');
  $('up').textContent = `up ${fmtUptime(s.uptimeS)}`;
  tabNum($('load'), s.load[0].toFixed(2));
  $('cpuPctl').textContent = s.cpu.totalPct.toFixed(0) + '%';

  if (s.gpu) {
    $('gpuPctl').textContent = s.gpu.utilPct + '%';
    tabNum($('gTemp'), `Temp ${s.gpu.tempC}°C`);
    tabNum($('gPow'), `Power ${s.gpu.powerW.toFixed(0)}W`);
  }
  $('memPctl').textContent = `${fmtGB(s.mem.usedMB)}/${fmtGB(s.mem.totalMB)}G`;
  tabNum($('mSwap'), `Swap ${(s.mem.swapUsedMB / 1024).toFixed(1)}G / ${(s.mem.swapTotalMB / 1024).toFixed(0)}G`);

  tabNum($('hGpu'), s.gpu ? `${s.gpu.utilPct}%` : '—');
  tabNum($('hTemp'), `${s.temps.maxC.toFixed(1)}°C`);
  tabNum($('hMem'), `${(100 * s.mem.usedMB / s.mem.totalMB).toFixed(0)}%`);

  const bad = (window as any).__alerts ?? [];
  const badge = $('alertBadge');
  if (bad.length) { badge.textContent = `ALERT ${bad.length}`; badge.classList.add('alarm'); $('alertWave').classList.add('on'); }
  else { badge.textContent = 'OK'; badge.classList.remove('alarm'); $('alertWave').classList.remove('on'); }

  fillTable($('tCpu'), s.procs.cpu.map(p => [String(p.pid), p.comm, p.pct.toFixed(0)]));
  fillTable($('tMem'), s.procs.mem.map(p => [String(p.pid), p.comm, p.mb.toFixed(0)]));
  procSummary('proccpu', procSums.proccpu!, s);   // 摺態時摘要跟著即時跳
  procSummary('procmem', procSums.procmem!, s);

  const nvals = Object.values(s.net);
  try {
    crystal?.setData({
      gpuUtil: s.gpu?.utilPct ?? 0,
      maxTempC: s.temps.maxC,
      ramPct: 100 * s.mem.usedMB / s.mem.totalMB,
      netMBs: nvals.reduce((a, v) => a + v.rxMBs + v.txMBs, 0),
      alarmed: bad.length > 0,
    });
  } catch { /* 3D 崩潰不拖垮整頁 */ }
}

function fillTable(t: HTMLElement, rows: string[][]): void {
  const tb = t.querySelector('tbody')!;
  tb.innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="num">${r[2]}</td></tr>`).join('');
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
}

// ---------- SSE ----------
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let currentEs: EventSource | null = null;
let lastRx = 0;
let lastSample: Sample | null = null;
function connect(): void {
  const es = new EventSource('/api/stream');
  currentEs = es;
  es.onmessage = e => {
    const s = JSON.parse(e.data) as Sample & { alerts?: string[] };
    if (Array.isArray(s.alerts)) (window as any).__alerts = s.alerts; // 即時告警：跟幀同步到達
    lastRx = Date.now(); lastSample = s;
    renderChrome(s);
    (Object.keys(kits) as Key[]).forEach(t => livePush(t, s));
  };
  es.onerror = () => {
    $('connDot').classList.add('off');
    es.close();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 5000);
  };
}

async function refreshAlerts(): Promise<void> {
  // SSE 斷線時的備援同步：snapshot 帶的是即時 live 清單，與幀內 alerts 同源同語義
  try {
    const snap = await (await fetch('/api/snapshot')).json();
    if (Array.isArray(snap.alerts)) (window as any).__alerts = snap.alerts;
  } catch { /* ignore */ }
}

// ---------- 滑鼠互動（A 卡片聚光跟隨／B 按鈕按壓漣漪；純 CSS 合成器屬性，不碰 canvas） ----------
function initPointerFx(): void {
  if (!matchMedia('(pointer: fine)').matches) return;             // 觸控裝置無滑鼠，不啟
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // A：聚光——每張卡片記一個 CSS 變數座標，radial-gradient 跟隨；rAF 節流
  const tracked = new Map<HTMLElement, { x: number; y: number }>();
  let raf = 0;
  const flush = () => {
    raf = 0;
    tracked.forEach((p, el) => {
      el.style.setProperty('--mx', p.x + 'px');
      el.style.setProperty('--my', p.y + 'px');
    });
  };
  document.addEventListener('pointermove', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card, #hero');
    if (!card) return;
    const r = card.getBoundingClientRect();
    tracked.set(card, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (!raf) raf = requestAnimationFrame(flush);
  }, { passive: true });
  document.addEventListener('pointerout', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.card, #hero');
    if (card && !card.contains(e.relatedTarget as Node)) {
      tracked.delete(card);                     // 必須移出追蹤清單：否則下次 flush 會把舊座標回填、光復活
      card.style.setProperty('--mx', '-9999px');
    }
  }, { passive: true });

  // B：漣漪——按鈕點擊從觸點擴散一圈細光環（一段動畫後自清）
  document.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const rip = document.createElement('span');
    rip.className = 'ripple';
    rip.style.left = (e.clientX - r.left) + 'px';
    rip.style.top = (e.clientY - r.top) + 'px';
    btn.appendChild(rip);
    rip.addEventListener('animationend', () => rip.remove(), { once: true });
  }, { passive: true });
}

async function boot(): Promise<void> {
  buildCharts();
  initPointerFx();
  // 從背景喚回：SSE 可能剛重連、手機可能轉了屏——圖表全部重繪一遍
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // 背景太久 SSE 可能已成殭屍連線：10 秒沒收訊就主動重連
    if (Date.now() - lastRx > 10_000) {
      currentEs?.close();
      if (retryTimer) clearTimeout(retryTimer);
      connect();
    }
    if (lastSample) renderChrome(lastSample); // HUD 數值立即回血
    requestAnimationFrame(() => {
      (Object.keys(kits) as Key[]).forEach(t => { kits[t].chart.resize(); });
      void Promise.all(['cpu','gpu','mem','temp','net','disk'].map(t => loadHistory(t as Key)));
    });
  });
  await Promise.all(['cpu', 'gpu', 'mem', 'temp', 'net', 'disk'].map(t => loadHistory(t as Key)));
  await refreshAlerts();
  connect();
  setInterval(() => void refreshAlerts(), 15_000);
  // 長窗滑動重載節流器：修「切 1h/24h 放著就不更新」——到點自動重抓該圖 history（5m 由 SSE 逐幀驅動，跳過）
  setInterval(() => {
    if (document.hidden) return; // 背景時不刷，喚回時 visibilitychange 已會全數重載
    const now = Date.now();
    (Object.keys(kits) as Key[]).forEach(t => {
      const kit = kits[t];
      if (kit.live || !kit.nextRefresh || now < kit.nextRefresh) return;
      kit.nextRefresh = now + REFRESH_MS[kit.range];
      void loadHistory(t);
    });
  }, 5_000);
}
// 建置標籤：頁角小字，一眼辨識分頁跑的是哪一版（時光機分頁偵測器）
{
  const tag = document.createElement('div');
  tag.id = 'buildTag';
  tag.textContent = __BUILD_INFO__;
  document.body.appendChild(tag);
}
void boot();
