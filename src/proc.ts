// /proc 解析器：CPU、記憶體、磁碟、網路、程序（零重型依賴）
import { readFileSync, readdirSync } from 'node:fs';
import { CFG } from './config.ts';
import type { GroupStat, ProcRow } from './types.ts';

const HOST = process.env.HOST_PROC ?? '/proc';
const SYS = process.env.HOST_SYS ?? '/sys';

// ---------- CPU ----------
interface CpuTicks { idle: number; total: number }

function readCpuTicks(): { all: CpuTicks; perCore: CpuTicks[] } {
  const lines = readFileSync(`${HOST}/stat`, 'utf8').split('\n');
  const perCore: CpuTicks[] = [];
  let all: CpuTicks = { idle: 0, total: 0 };
  for (const line of lines) {
    if (!line.startsWith('cpu')) break;
    const parts = line.trim().split(/\s+/);
    const n = parts.slice(2, 10).map(Number); // user nice system idle iowait irq softirq steal
    const idle = n[3] + n[4];
    const total = n.reduce((a, b) => a + b, 0);
    if (parts[0] === 'cpu') all = { idle, total };
    else perCore.push({ idle, total });
  }
  return { all, perCore };
}

// 大小核映射探測（gx10 實測為交錯排列：E=0-4,10-14 / P=5-9,15-19）
interface CoreMap { groups: { key: 'P' | 'E'; maxKHz: number; cores: number[] }[] }
function probeCoreMap(nCores: number): CoreMap {
  const bySpeed = new Map<number, number[]>();
  const fallback: number[] = [];
  for (let i = 0; i < nCores; i++) {
    let khz = 0;
    try { khz = Math.round(Number(readFileSync(`${SYS}/devices/system/cpu/cpu${i}/cpufreq/scaling_max_freq`, 'utf8')) / 1000); } catch { /* ignore */ }
    if (!khz) { fallback.push(i); continue; }
    const arr = bySpeed.get(khz) ?? []; arr.push(i); bySpeed.set(khz, arr);
  }
  const speeds = [...bySpeed.entries()].sort((a, b) => b[0] - a[0]); // 高→低
  const groups = speeds.map(([khz, cores], i) => ({
    key: (i === 0 ? 'P' : 'E') as 'P' | 'E',
    maxKHz: khz, cores,
  }));
  if (fallback.length) groups.push({ key: 'E', maxKHz: 0, cores: fallback });
  return { groups };
}

export interface CpuState { prev: ReturnType<typeof readCpuTicks> | null; map: CoreMap | null }

export function sampleCpu(st: CpuState): {
  totalPct: number; groups: GroupStat[]; load: [number, number, number]; uptimeS: number;
} {
  const cur = readCpuTicks();
  const loadLine = readFileSync(`${HOST}/loadavg`, 'utf8').split(' ');
  const load = [Number(loadLine[0]), Number(loadLine[1]), Number(loadLine[2])] as [number, number, number];
  const up = readFileSync(`${HOST}/uptime`, 'utf8').split(' ');
  const uptimeS = Number(up[0]);

  if (!st.map) st.map = probeCoreMap(cur.perCore.length);
  const prev = st.prev;
  st.prev = cur;
  if (!prev) return { totalPct: 0, groups: st.map.groups.map(g => ({ name: '', cores: g.cores, usagePct: 0, curMHz: 0, maxMHz: g.maxKHz / 1000 })), load, uptimeS };

  const delta = (c: CpuTicks, p: CpuTicks) => {
    const dt = c.total - p.total, di = c.idle - p.idle;
    return dt > 0 ? Math.max(0, Math.min(100, ((dt - di) / dt) * 100)) : 0;
  };
  const totalPct = delta(cur.all, prev.all);

  const groups: GroupStat[] = st.map.groups.map(g => {
    let sum = 0, curKhz = 0, known = 0;
    for (const c of g.cores) {
      sum += delta(cur.perCore[c], prev.perCore[c]);
      try {
        curKhz += Number(readFileSync(`${SYS}/devices/system/cpu/cpu${c}/cpufreq/scaling_cur_freq`, 'utf8')) / 1000;
        known++;
      } catch { /* ignore */ }
    }
    return {
      name: `${g.key}-cores ${g.maxKHz ? (g.maxKHz / 1000).toFixed(1) + 'GHz' : '?'}`,
      cores: g.cores,
      usagePct: sum / g.cores.length,
      curMHz: known ? curKhz / known : 0,
      maxMHz: g.maxKHz / 1000,
    };
  });
  return { totalPct, groups, load, uptimeS };
}

// ---------- MEM ----------
export function sampleMem(): { totalMB: number; usedMB: number; availMB: number; swapTotalMB: number; swapUsedMB: number } {
  const m: Record<string, number> = {};
  for (const line of readFileSync(`${HOST}/meminfo`, 'utf8').split('\n')) {
    const mm = line.match(/^(\w+):\s+(\d+)/);
    if (mm) m[mm[1]] = Number(mm[2]) / 1024; // MB
  }
  const total = m.MemTotal ?? 0;
  const avail = m.MemAvailable ?? 0;
  return {
    totalMB: total, usedMB: total - avail, availMB: avail,
    swapTotalMB: m.SwapTotal ?? 0, swapUsedMB: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
  };
}

// ---------- 溫度 ----------
export function sampleTemps(): { soc: number[]; nvmeC: number } {
  const soc: number[] = [];
  try {
    for (const z of readdirSync(`${SYS}/class/thermal`)) {
      if (!z.startsWith('thermal_zone')) continue;
      const t = Number(readFileSync(`${SYS}/class/thermal/${z}/temp`, 'utf8'));
      if (Number.isFinite(t) && t > 0) soc.push(t / 1000);
    }
  } catch { /* ignore */ }
  let nvmeC = 0;
  try {
    for (const h of readdirSync(`${SYS}/class/hwmon`)) {
      let name = '';
      try { name = readFileSync(`${SYS}/class/hwmon/${h}/name`, 'utf8').trim(); } catch { continue; }
      if (name === 'nvme') {
        const t = Number(readFileSync(`${SYS}/class/hwmon/${h}/temp1_input`, 'utf8'));
        if (Number.isFinite(t)) { nvmeC = t / 1000; break; }
      }
    }
  } catch { /* ignore */ }
  return { soc, nvmeC };
}

// ---------- 磁碟 / 網路（速率 = 差分） ----------
interface Counters { v: number[] }
function readDiskCounters(): Counters {
  for (const line of readFileSync(`${HOST}/diskstats`, 'utf8').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[2] === CFG.diskDevice) return { v: p.slice(5, 11).map(Number) }; // reads ops, merged, sectors, ms, writes ops, merged
  }
  return { v: [0, 0, 0, 0, 0, 0] };
}
/**
 * 優先 sysfs：/proc/net/dev 是網路 namespace 隔離的，容器裡掛了宿主 /proc 也只看得到
 * 自己的 lo/eth0；/sys/class/net 下的 statistics 不受 namespace 影響，讀到的才是宿主實體網卡。
 */
function readNetCounters(): Record<string, Counters> {
  const out: Record<string, Counters> = {};
  for (const k of CFG.ifaces) {
    try {
      const rx = Number(readFileSync(`${SYS}/class/net/${k}/statistics/rx_bytes`, 'utf8').trim());
      const tx = Number(readFileSync(`${SYS}/class/net/${k}/statistics/tx_bytes`, 'utf8').trim());
      if (Number.isFinite(rx) && Number.isFinite(tx)) { out[k] = { v: [rx, tx] }; continue; }
    } catch { /* sysfs 沒掛到（裸機開發模式）→ 走 /proc/net/dev */ }
  }
  if (Object.keys(out).length) return out;
  return readNetDev(HOST);
}

/** /proc/net/dev 依「閱讀者的 namespace」生成，掛了宿主 /proc 也仍是殭屍資料；
 *  改讀宿主 PID 1 的 net/dev（借 init 的 namespace 視角），數據即宿主實體網卡。 */
function readNetDev(base: string): Record<string, Counters> {
  const out: Record<string, Counters> = {};
  const paths = [`${base}/1/net/dev`, `${base}/net/dev`, '/proc/1/net/dev'];
  let text = '';
  for (const p of paths) {
    try { text = readFileSync(p, 'utf8'); if (text) break; } catch { /* try next */ }
  }
  if (!text) return out;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!name || !rest) continue;
    const key = name.trim();
    if (CFG.ifaces.includes(key)) {
      const n = rest.trim().split(/\s+/).map(Number);
      out[key] = { v: [n[0], n[8]] }; // rx bytes, tx bytes
    }
  }
  return out;
}

export interface RateState { disk: Counters | null; diskTs: number; net: Record<string, Counters> | null; netTs: number }

export function sampleRates(rs: RateState): {
  disk: { readMBs: number; writeMBs: number; readIops: number; writeIops: number };
  net: Record<string, { rxMBs: number; txMBs: number }>;
} {
  const now = Date.now();
  const diskNow = readDiskCounters();
  const netNow = readNetCounters();
  let disk = { readMBs: 0, writeMBs: 0, readIops: 0, writeIops: 0 };
  const net: Record<string, { rxMBs: number; txMBs: number }> = {};
  for (const k of CFG.ifaces) net[k] = { rxMBs: 0, txMBs: 0 };

  if (rs.disk && rs.diskTs > 0) {
    const dt = (now - rs.diskTs) / 1000;
    if (dt > 0) {
      const d = rs.disk.v;
      disk = {
        readIops: (diskNow.v[0] - d[0]) / dt,
        writeIops: (diskNow.v[4] - d[4]) / dt,
        readMBs: ((diskNow.v[2] - d[2]) * 512) / 1048576 / dt,
        writeMBs: ((diskNow.v[5] - d[5]) * 512) / 1048576 / dt,
      };
    }
  }
  if (rs.net && rs.netTs > 0) {
    const dt = (now - rs.netTs) / 1000;
    if (dt > 0) for (const k of CFG.ifaces) {
      const a = rs.net[k], b = netNow[k];
      if (a && b) net[k] = { rxMBs: (b.v[0] - a.v[0]) / 1048576 / dt, txMBs: (b.v[1] - a.v[1]) / 1048576 / dt };
    }
  }
  rs.disk = diskNow; rs.diskTs = now; rs.net = netNow; rs.netTs = now;
  return { disk, net };
}

// ---------- 磁碟用量 ----------
export function diskUsedPct(): number {
  // statfs via statvfs(2) 不好取，改呼叫 df（本機 stat 呼叫，非 nvidia-smi，開銷可忽略）
  return diskUsedPctCache.v;
}
export const diskUsedPctCache = { v: 0 };
export function refreshDiskUsedPct(execSync: (cmd: string) => string): void {
  try {
    const out = execSync(`df -B1 --output=pcent ${process.env.DISK_STAT_PATH ?? '/'}`).trim();
    diskUsedPctCache.v = Number(out.split(/\s+/).pop()?.replace('%', ''));
  } catch { /* keep last */ }
}

// ---------- Top 程序 ----------
export function sampleProcs(prevCpu: { time: Map<number, number> } | null): {
  procs: { cpu: ProcRow[]; mem: ProcRow[] }; next: { time: Map<number, number> };
} {
  const now = Date.now();
  const time = new Map<number, number>();
  const rows: { pid: number; comm: string; utime: number; rssMB: number }[] = [];
  for (const e of readdirSync(HOST)) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    try {
      const stat = readFileSync(`${HOST}/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const comm = stat.slice(stat.indexOf('(') + 1, close);
      const f = stat.slice(close + 2).trim().split(/\s+/);
      const utime = Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]); // utime stime cutime cstime
      const rssPages = Number(f[21]);
      time.set(pid, utime);
      rows.push({ pid, comm, utime, rssMB: (rssPages * 4096) / 1048576 });
    } catch { /* proc vanished */ }
  }
  const mem = [...rows].sort((a, b) => b.rssMB - a.rssMB).slice(0, CFG.procTopN)
    .map(r => ({ pid: r.pid, comm: r.comm, pct: 0, mb: r.rssMB }));
  let cpu: ProcRow[] = [];
  if (prevCpu) {
    const hz = 100; // USER_HZ
    cpu = rows.map(r => {
      const p = prevCpu.time.get(r.pid);
      const pct = p === undefined ? 0 : ((r.utime - p) / hz) * 100;
      return { pid: r.pid, comm: r.comm, pct: Math.max(0, Math.min(pct, 100 * 20)), mb: r.rssMB };
    }).sort((a, b) => b.pct - a.pct).slice(0, CFG.procTopN);
  }
  return { procs: { cpu: cpu.map(r => ({ ...r, mb: r.mb })) , mem }, next: { time } };
}
