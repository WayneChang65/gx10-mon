// 歷史存儲：SQLite 三級保留——原始 24h / 10s 聚合 7d / 60s 聚合 90d
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CFG } from './config.ts';
import type { Sample, AlertEvent, AlertKind } from './types.ts';

export class Store {
  private db: DatabaseSync;
  private insRaw: ReturnType<DatabaseSync['prepare']>;
  private insAgg: ReturnType<DatabaseSync['prepare']>;
  private ticks = 0;

  constructor() {
    mkdirSync(dirname(CFG.dataFile), { recursive: true });
    this.db = new DatabaseSync(CFG.dataFile);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS raw(
        ts INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agg(
        bucket INTEGER PRIMARY KEY, step INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts(
        ts INTEGER PRIMARY KEY, kind TEXT, state TEXT, value REAL, msg TEXT);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);`);
    this.insRaw = this.db.prepare('INSERT OR REPLACE INTO raw(ts, json) VALUES(?,?)');
    this.insAgg = this.db.prepare('INSERT OR REPLACE INTO agg(bucket, step, json) VALUES(?,?,?)');
    // 讀取上次記錄的原始間隔，若設定變過就重整對齊
    const meta = this.db.prepare('SELECT v FROM meta WHERE k=?').get('sampleMs') as { v: string } | undefined;
    if (!meta) this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('sampleMs', String(CFG.sampleMs));
    else if (Number(meta.v) !== CFG.sampleMs) {
      this.db.exec('DELETE FROM raw; DELETE FROM agg;');
      this.db.prepare('UPDATE meta SET v=? WHERE k=?').run(String(CFG.sampleMs), 'sampleMs');
    }
  }

  putSample(s: Sample): void {
    this.insRaw.run(s.ts, JSON.stringify(s));
    this.ticks++;
    // 10s 聚合：每 10 秒桶（取桶內最後一個原始點為代表值）
    const aggJson = JSON.stringify(Store.slim(s));
    const b10 = Math.floor(s.ts / 10_000) * 10_000;
    if (s.ts % 10_000 < CFG.sampleMs) this.insAgg.run(b10, 10, aggJson);
    // 60s 聚合
    const b60 = Math.floor(s.ts / 60_000) * 60_000;
    if (s.ts % 60_000 < CFG.sampleMs) this.insAgg.run(b60, 60, aggJson);
    if (this.ticks % 300 === 0) this.prune();
  }

  prune(): void {
    this.db.exec(`
      DELETE FROM raw WHERE ts < (MAX(ts) FROM raw) - ${86_400_000};`
      .replace('(MAX(ts) FROM raw)', '(SELECT MAX(ts) FROM raw)'));
    this.db.exec(`DELETE FROM agg WHERE step=10 AND bucket < (SELECT MAX(bucket) FROM agg WHERE step=10) - ${7 * 86_400_000};
                  DELETE FROM agg WHERE step=60 AND bucket < (SELECT MAX(bucket) FROM agg WHERE step=60) - ${90 * 86_400_000};`);
  }

  /** 曲線圖瘦身：砍掉 procs（即時快照，歷史無意義）與 core 清單/頻率細節，約省 7 成體積 */
  private static slim(s: Sample): Sample {
    return {
      ts: s.ts, uptimeS: s.uptimeS, load: s.load,
      cpu: { totalPct: s.cpu.totalPct, groups: s.cpu.groups.map(g => ({ name: g.name, cores: [] as number[], usagePct: g.usagePct, curMHz: 0, maxMHz: 0 })) },
      mem: s.mem, gpu: s.gpu, temps: s.temps,
      disk: { usedPct: s.disk.usedPct, readMBs: s.disk.readMBs, writeMBs: s.disk.writeMBs, readIops: 0, writeIops: 0 },
      net: s.net,
      procs: { cpu: [], mem: [] },
    } as Sample;
  }

  history(range: string): Sample[] {
    const now = Date.now();
    const winMs: Record<string, number> = { '5m': 300_000, '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000, '90d': 7_776_000_000 };
    const w = winMs[range] ?? winMs['5m'];
    let q: { sql: string; args: [number] };
    // 5m/1h 用原始點；24h 用 10s 聚合；7d/90d 用 60s 聚合（前端圖表庫友好）
    if (w <= 3_600_000) q = { sql: 'SELECT json FROM raw WHERE ts >= ? ORDER BY ts', args: [now - w] };
    else if (w <= 86_400_000) q = { sql: 'SELECT json FROM agg WHERE step=10 AND bucket >= ? ORDER BY bucket', args: [now - w] };
    else q = { sql: 'SELECT json FROM agg WHERE step=60 AND bucket >= ? ORDER BY bucket', args: [now - w] };
    const rows = this.db.prepare(q.sql).all(...q.args) as { json: string }[];
    return rows.map(r => Store.slim(JSON.parse(r.json) as Sample));
  }

  putAlert(a: AlertEvent): void {
    this.db.prepare('INSERT INTO alerts(ts,kind,state,value,msg) VALUES(?,?,?,?,?)')
      .run(a.ts, a.kind, a.state, a.value, a.msg);
  }
  recentAlerts(limit = 50): AlertEvent[] {
    return (this.db.prepare('SELECT ts,kind,state,value,msg FROM alerts ORDER BY ts DESC LIMIT ?').all(limit) as unknown as AlertEvent[]).reverse();
  }
  lastAlertState(kind: AlertKind): AlertEvent | undefined {
    return this.db.prepare('SELECT ts,kind,state,value,msg FROM alerts WHERE kind=? ORDER BY ts DESC LIMIT 1').get(kind) as unknown as AlertEvent | undefined;
  }
}
