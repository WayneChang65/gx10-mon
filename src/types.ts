// 資料模型
export interface GroupStat {
  name: string; // "P-cores 3.9GHz" / "E-cores 2.8GHz"
  cores: number[];
  usagePct: number;
  curMHz: number;
  maxMHz: number;
}

export interface Sample {
  ts: number; // epoch ms
  uptimeS: number;
  load: [number, number, number];
  cpu: { totalPct: number; groups: GroupStat[] };
  mem: { totalMB: number; usedMB: number; availMB: number; swapTotalMB: number; swapUsedMB: number };
  gpu: { utilPct: number; tempC: number; powerW: number } | null;
  temps: { soc: number[]; nvmeC: number; maxC: number };
  disk: { usedPct: number; readMBs: number; writeMBs: number; readIops: number; writeIops: number };
  net: Record<string, { rxMBs: number; txMBs: number }>;
  procs: { cpu: ProcRow[]; mem: ProcRow[] };
}

export interface ProcRow { pid: number; comm: string; pct: number; mb: number }

export type AlertKind = 'soc_temp' | 'mem_low' | 'swap_high';
export interface AlertEvent {
  ts: number;
  kind: AlertKind;
  state: 'trig' | 'ok';
  value: number;
  msg: string;
}

// ---- LLM Bench ----
export interface BenchReq {
  endpoint: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  promptWords?: number;
  think?: boolean;
  label?: string;
}

export interface BenchRun {
  ts: number;
  endpoint: string;
  model: string;
  status: 'ok' | 'err';
  promptTokens: number | null;
  genTokens: number | null;
  ttftMs: number | null;
  prefillTps: number | null;   // display value: engine if available, else client
  decodeTps: number | null;
  enginePrefillTps: number | null;
  engineDecodeTps: number | null;
  clientPrefillTps: number | null;
  clientDecodeTps: number | null;
  engineMetrics: boolean;
  cacheHits: number | null;
  note?: string;
  err?: string;
}
