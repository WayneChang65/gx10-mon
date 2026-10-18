// 採樣主迴路：每輪合成 Sample、寫 DB、推 SSE、跑告警
import { execSync } from 'node:child_process';
import { CFG } from './config.ts';
import { sampleCpu, sampleMem, sampleTemps, sampleRates, sampleProcs, refreshDiskUsedPct, diskUsedPct, type CpuState, type RateState } from './proc.ts';
import { queryGpu } from './gpu.ts';
import type { Sample } from './types.ts';
import type { Store } from './db.ts';
import { evaluateAlerts, activeAlerts } from './alerts.ts';

type Listener = (s: Sample) => void;

export class Sampler {
  private cpuState: CpuState = { prev: null, map: null };
  private rateState: RateState = { disk: null, diskTs: 0, net: null, netTs: 0 };
  private procPrev: { time: Map<number, number> } | null = null;
  private lastGpu: Sample['gpu'] = null;
  private last: Sample | null = null;
  private listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private n = 0;
  private store: Store;

  constructor(store: Store) { this.store = store; }

  start(): void {
    this.timer = setInterval(() => void this.tick(), CFG.sampleMs);
    void this.tick();
    setInterval(() => refreshDiskUsedPct(cmd => execSync(cmd, { encoding: 'utf8', timeout: 2000 })), 60_000);
    refreshDiskUsedPct(cmd => execSync(cmd, { encoding: 'utf8', timeout: 2000 }));
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  get latest(): Sample | null { return this.last; }
  get alerts(): string[] { return activeAlerts(); }
  get intervalMs(): number { return CFG.sampleMs; }

  onSample(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async tick(): Promise<void> {
    try {
      const t0 = Date.now();
      this.n++;
      const { totalPct, groups, load, uptimeS } = sampleCpu(this.cpuState);
      const mem = sampleMem();
      const temps = sampleTemps();
      const { disk: rateDisk, net } = sampleRates(this.rateState);
      const { procs, next } = sampleProcs(this.procPrev);
      this.procPrev = next;
      // GPU：每 GPU_EVERY_N 輪 spawn 一次 nvidia-smi，其餘沿用最後值（省開銷）
      if (this.n % CFG.gpuEvery === 1 || this.n === 1) {
        const g = await queryGpu();
        if (g) this.lastGpu = g;
      }
      const socMax = temps.soc.length ? Math.max(...temps.soc) : 0;
      const s: Sample = {
        ts: t0, uptimeS, load,
        cpu: { totalPct, groups },
        mem,
        gpu: this.lastGpu,
        temps: { soc: temps.soc, nvmeC: temps.nvmeC, maxC: socMax },
        disk: { usedPct: diskUsedPct(), ...rateDisk },
        net,
        procs,
      };
      this.last = s;
      this.store.putSample(s);
      void evaluateAlerts(s, this.store);
      for (const fn of this.listeners) { try { fn(s); } catch { /* client gone */ } }
    } catch (e) {
      console.error('[sampler]', (e as Error).message);
    }
  }
}
