// 告警：簡單閾值 + 30 分鐘冷卻 + Discord webhook embed
import { CFG } from './config.ts';
import type { Sample, AlertEvent, AlertKind } from './types.ts';
import type { Store } from './db.ts';

interface Rule {
  kind: AlertKind;
  trig: (s: Sample) => { value: number; msg: string } | null; // 回 null = 正常
  fmt: (v: number) => string;
}

const rules: Rule[] = [
  {
    kind: 'soc_temp',
    trig: s => {
      const v = Math.max(s.temps.maxC, s.gpu?.tempC ?? 0);
      return v >= CFG.alert.socMaxC ? { value: v, msg: `SoC/GPU max temp ${v.toFixed(1)}°C ≥ ${CFG.alert.socMaxC}°C` } : null;
    },
    fmt: v => `${v.toFixed(1)}°C`,
  },
  {
    kind: 'mem_low',
    trig: s => s.mem.availMB / 1024 < CFG.alert.memAvailGB
      ? { value: s.mem.availMB / 1024, msg: `Available memory ${(s.mem.availMB / 1024).toFixed(1)}G < ${CFG.alert.memAvailGB}G` } : null,
    fmt: v => `${v.toFixed(1)}G avail`,
  },
  {
    kind: 'swap_high',
    trig: s => s.mem.swapUsedMB / 1024 > CFG.alert.swapUsedGB
      ? { value: s.mem.swapUsedMB / 1024, msg: `Swap used ${(s.mem.swapUsedMB / 1024).toFixed(1)}G > ${CFG.alert.swapUsedGB}G` } : null,
    fmt: v => `${v.toFixed(1)}G used`,
  },
];

// 記憶體狀態：firing=事件配對用（受冷卻節流）；live=目前這個時刻是否超標（給 UI，即時無冷卻）
const live = new Map<AlertKind, { firing: boolean; live: boolean; lastSent: number }>();

export async function evaluateAlerts(s: Sample, store: Store): Promise<AlertEvent[]> {
  const out: AlertEvent[] = [];
  for (const r of rules) {
    let st = live.get(r.kind);
    if (!st) {
      // 重啟後恢復冷卻狀態
      const last = store.lastAlertState(r.kind);
      st = { firing: last?.state === 'trig', live: false, lastSent: last?.ts ?? 0 };
      live.set(r.kind, st);
    }
    const hit = r.trig(s);
    st.live = !!hit;                                    // UI 即時真相：這一剎那超不超標
    const now = s.ts;
    if (hit && !st.firing && now - st.lastSent > CFG.alert.cooldownMs) {
      st.firing = true; st.lastSent = now;
      const ev: AlertEvent = { ts: now, kind: r.kind, state: 'trig', value: hit.value, msg: hit.msg };
      store.putAlert(ev); out.push(ev);
    } else if (!hit && st.firing && now - st.lastSent > CFG.alert.cooldownMs) {
      st.firing = false; st.lastSent = now;
      const ev: AlertEvent = { ts: now, kind: r.kind, state: 'ok', value: 0, msg: `${r.kind} recovered` };
      store.putAlert(ev); out.push(ev);
    }
  }
  if (out.length && CFG.discordWebhook) {
    for (const ev of out) void sendDiscord(ev);
  }
  return out;
}

async function sendDiscord(ev: AlertEvent): Promise<void> {
  const color = ev.state === 'trig' ? 0xef4444 : 0x2dd4bf;
  const title = ev.state === 'trig' ? `🔴 gx10 alert: ${ev.kind}` : `🟢 gx10 recovered: ${ev.kind}`;
  try {
    await fetch(CFG.discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title, color,
          description: ev.msg,
          timestamp: new Date(ev.ts).toISOString(),
          footer: { text: 'gx10-mon' },
        }],
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('[alert] webhook failed:', (e as Error).message);
  }
}

export function activeAlerts(): AlertKind[] {
  // 即時超標的項目（不再被 30 分鐘冷卻鎖住顯示）
  return [...live.entries()].filter(([, v]) => v.live).map(([k]) => k);
}
