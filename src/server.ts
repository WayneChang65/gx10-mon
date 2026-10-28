// gx10-mon 後端入口：Hono API + SSE + 靜態前端
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CFG } from './config.ts';
import { Store } from './db.ts';
import { Sampler } from './sampler.ts';
import { BenchRunner, BenchError } from './bench.ts';
import type { BenchReq } from './types.ts';

const store = new Store();
const sampler = new Sampler(store);
sampler.start();
const bench = new BenchRunner(store);

const app = new Hono();
// 歷史 JSON 是高重複文本，gzip 壓 ~9 成；SSE 即時幀很小不壓縮（compress 預設跳過 chunked 小回應亦可）
app.use('/api/history', compress());

app.get('/healthz', c => c.json({ ok: true, uptimeS: sampler.latest?.uptimeS ?? 0 }));

app.get('/api/config', c => c.json({
  sampleMs: sampler.intervalMs,
  ifaces: CFG.ifaces,
  alert: CFG.alert,
  webhook: Boolean(CFG.discordWebhook),
}));

app.get('/api/snapshot', c => {
  if (!sampler.latest) return c.json({ error: 'warming up' }, 503);
  return c.json({ sample: sampler.latest, alerts: sampler.alerts });
});

app.get('/api/history', c => {
  const range = c.req.query('range') ?? '5m';
  return c.json(store.history(range));
});

app.get('/api/alerts', c => c.json(store.recentAlerts(100)));

// ---- LLM Bench (manual-only speed test; one concurrent run) ----
app.post('/api/bench/run', async c => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  try {
    const run = await bench.run(body as BenchReq);
    return c.json(run, run.status === 'ok' ? 200 : 502);
  } catch (e) {
    if (e instanceof BenchError) return c.json({ error: e.message }, e.code as ContentfulStatusCode);
    return c.json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

app.get('/api/bench/status', c => c.json(bench.status()));

// Model-list proxy: the browser cannot call arbitrary endpoints directly (CORS).
// The key travels in the POST body (never in URLs) and is only ever forwarded
// to the endpoint the user typed on this card — never persisted, never logged.
app.post('/api/bench/models', async c => {
  let body: { endpoint?: string; apiKey?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid JSON body' }, 400); }
  try {
    return c.json({ models: await bench.models(body?.endpoint ?? '', body?.apiKey ?? '') });
  } catch (e) {
    if (e instanceof BenchError) return c.json({ error: e.message }, e.code as ContentfulStatusCode);
    return c.json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

app.get('/api/bench/history', c => {
  const n = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  return c.json(store.benchHistory(n));
});

app.delete('/api/bench/history', c => c.json({ ok: true, deleted: store.clearBench() }));

// SSE 即時幀
app.get('/api/stream', c => {
  let unsub = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      // 幀附帶即時告警清單：前端不用等輪詢就知道此刻超不超標（顯示用即時值，與 webhook 冷卻無關）
      const send = (s: Parameters<Parameters<Sampler['onSample']>[0]>[0]) =>
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ ...s, alerts: sampler.alerts })}\n\n`));
      ctrl.enqueue(enc.encode(`retry: 5000\n\n`));
      if (sampler.latest) send(sampler.latest);
      unsub = sampler.onSample(send);
      timer = setInterval(() => ctrl.enqueue(enc.encode(`: ping\n\n`)), 30_000);
    },
    cancel() { if (timer) clearInterval(timer); unsub(); },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});

app.use('*', serveStatic({ root: './public' }));
app.get('/', serveStatic({ path: './public/index.html' }));

console.log(`[gx10-mon] listening on :${CFG.port}  sample=${CFG.sampleMs}ms  webhook=${CFG.discordWebhook ? 'ON' : 'off'}`);
serve({ fetch: app.fetch, port: CFG.port, hostname: '0.0.0.0' });
