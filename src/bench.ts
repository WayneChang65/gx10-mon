// LLM Bench: OpenAI-compatible endpoint speed test (prefill / decode / TTFT).
// Method ported from the proven standalone CLI:
//   phase 1  prefill probe — streaming request with max_tokens=1 → TTFT (+ engine counters diff)
//   phase 2  decode run    — full generation → first-to-last token window ÷ completion tokens
// When the target exposes vLLM's /metrics we diff prompt/generation counters and
// prefill/decode time for "engine truth" numbers; otherwise client timing only.
import { randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import type { BenchReq, BenchRun } from './types.ts';

const WORDS =
  ('the quick brown fox jumps over a lazy dog while sailors measure distant harbors and ' +
   'engineers calibrate quiet turbines beneath a steady sky coffee cups gather warm ' +
   'condensation on wooden tables and afternoon trains rattle through small towns where ' +
   'maples turn amber early library lamps glow softly behind rows of patient encyclopedias ' +
   'and morning gulls trace slow circles above the fishing pier again').split(/\s+/);

const OVERALL_MS = 120_000;   // hard budget for one whole run
const STALL_MS = 60_000;      // per-socket inactivity guard
// Engine counter families are matched under any known Prometheus prefix
// (vLLM uses vllm:, TensorFold reuses the same names under tensorfold:).
const PREFIX_RE = '(?:vllm|tensorfold)';
const METRIC_NAMES = [
  'prompt_tokens_total', 'generation_tokens_total',
  'request_prefill_time_seconds_sum', 'request_decode_time_seconds_sum',
  'prefix_cache_hits_total', 'num_requests_running',
] as const;

export class BenchError extends Error {
  code: number;
  constructor(code: number, msg: string) { super(msg); this.code = code; }
}

interface Usage { prompt_tokens?: number; completion_tokens?: number }
interface StreamRes {
  t0: number; tFirst: number; tLast: number; chunks: number;
  usage: Usage | null; nonStream: boolean;
}
interface Caps { streamOptions: boolean; templateKwargs: boolean }
type Metrics = Partial<Record<(typeof METRIC_NAMES)[number], number>>;

function clampInt(v: unknown, d: number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d;
}

/** Validate and normalise a user-typed endpoint; only http(s) origins are allowed. */
function baseOf(endpoint: string): string {
  let u: URL;
  try { u = new URL(endpoint.trim()); }
  catch { throw new BenchError(400, `endpoint is not a valid URL: "${endpoint}"`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new BenchError(400, `only http(s) endpoints are supported (got "${u.protocol}")`);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

/** Map fetch() rejections to our classified errors (504 timeout, 502 unreachable). */
function toFetchError(e: unknown): BenchError {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
    return new BenchError(504, `timed out (${OVERALL_MS / 1000}s budget)`);
  const cause = err?.cause?.code ?? err?.message ?? String(e);
  return new BenchError(502, `cannot reach endpoint: ${cause}`);
}

async function streamChat(
  base: string, apiKey: string, payload: object, signal: AbortSignal,
): Promise<StreamRes> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(payload), signal,
    });
  } catch (e) { throw toFetchError(e); }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new BenchError(502, `upstream HTTP ${res.status}: ${body || res.statusText}`);
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('text/event-stream')) {
  // Server ignored stream=true and answered plain JSON: wall-clock timing only.
  const j = await res.json().catch(() => null) as { usage?: Usage } | null;
  const now = Date.now();
  return { t0, tFirst: now, tLast: now, chunks: 0, usage: j?.usage ?? null, nonStream: true };
  }
  let tFirst = 0, tLast = 0, chunks = 0;
  let usage: Usage | null = null;
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let done = false, value: Uint8Array | undefined;
    try { ({ done, value } = await reader.read()); }
    catch (e) { throw toFetchError(e); }
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ch: {
        usage?: Usage;
        choices?: { text?: string; delta?: { content?: string; reasoning_content?: string } }[];
      } | null = null;
      try { ch = JSON.parse(data); } catch { continue; }
      if (ch?.usage) usage = ch.usage;
      for (const c of ch?.choices ?? []) {
        const piece = c.text ?? ((c.delta?.content ?? '') + (c.delta?.reasoning_content ?? ''));
        if (piece) { const now = Date.now(); if (!tFirst) tFirst = now; tLast = now; chunks++; }
      }
    }
  }
  if (!tFirst) throw new BenchError(501, 'server streamed no tokens (stream unsupported?)');
  return { t0, tFirst, tLast, chunks, usage, nonStream: false };
}

async function scrapeMetrics(base: string, apiKey: string, signal: AbortSignal): Promise<Metrics | null> {
  let res: Response;
  try { res = await fetch(`${base}/metrics`, { headers: authHeaders(apiKey), signal }); }
  catch { return null; }
  if (!res.ok) return null;
  const text = await res.text().catch(() => '');
  if (!new RegExp(`^${PREFIX_RE}:prompt_tokens_total`, 'm').test(text)) return null;
  const out: Metrics = {};
  for (const name of METRIC_NAMES) {
    const re = new RegExp(`^${PREFIX_RE}:${name}(?:\\{[^}]*\\})? ([0-9.eE+-]+)$`, 'gm');
    let m: RegExpExecArray | null, total: number | undefined;
    while ((m = re.exec(text))) total = (total ?? 0) + Number(m[1]);
    if (total !== undefined) out[name] = total;
  }
  return out.prompt_tokens_total !== undefined ? out : null;
}

function metricDelta(a: Metrics | null, b: Metrics | null): Metrics | null {
  if (!a || !b) return null;
  const d: Metrics = {};
  for (const k of METRIC_NAMES) {
    const x = a[k], y = b[k];
    d[k] = x === undefined || y === undefined ? undefined : y - x;
  }
  return d;
}

function buildPrompt(words: number, targetWords = 200): string {
  let filler = '';
  for (let i = 0; i < words; i++) filler += WORDS[Math.floor(Math.random() * WORDS.length)] + ' ';
  return `Benchmark passage ${randomUUID()}: ${filler}\n` +
    `Question: Write a very detailed summary of the passage above in at least ${targetWords} words. `
    + 'Keep writing until you reach the target.';
}

export class BenchRunner {
  private store: Store;
  private current: { stage: string; started: number } | null = null;

  constructor(store: Store) { this.store = store; }

  status(): { busy: boolean; stage: string; elapsedS: number } {
    if (!this.current) return { busy: false, stage: '', elapsedS: 0 };
    return {
      busy: true, stage: this.current.stage,
      elapsedS: (Date.now() - this.current.started) / 1000,
    };
  }

  async models(endpoint: string, apiKey = ''): Promise<string[]> {
    const base = baseOf(endpoint);
    let res: Response;
    try { res = await fetch(`${base}/v1/models`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(15_000) }); }
    catch (e) { throw toFetchError(e); }
    if (!res.ok) throw new BenchError(502, `upstream HTTP ${res.status} on /v1/models`);
    const j = await res.json().catch(() => null) as { data?: { id: string }[] } | null;
    return (j?.data ?? []).map((m) => m.id).filter((s) => typeof s === 'string');
  }

  /** One measured run: validation errors throw BenchError(400/409); endpoint
   *  failures resolve as status:'err' rows (also persisted to history). */
  async run(req: BenchReq): Promise<BenchRun> {
    if (this.current) throw new BenchError(409, 'a bench run is already in progress');
    const base = baseOf(req?.endpoint ?? '');
    if (!req?.model || !req.model.trim()) throw new BenchError(400, 'model is required');
    const apiKey = (req.apiKey ?? '').trim();
    const model = req.model.trim();
    const maxTokens = clampInt(req.maxTokens, 512, 16, 1024);
    const promptWords = clampInt(req.promptWords, 2000, 50, 4000);
    const think = !!req.think;
    const userLabel = typeof req.label === 'string' ? req.label.trim().slice(0, 120) : '';

    this.current = { stage: 'prefill…', started: Date.now() };
    const startedAt = Date.now();
    const remaining = () => AbortSignal.timeout(Math.max(OVERALL_MS - (Date.now() - startedAt), 1_000));
    const notes: string[] = [];
    const caps: Caps = { streamOptions: true, templateKwargs: !think };

    const row: BenchRun = {
      ts: Date.now(), endpoint: base, model, status: 'err',
      promptTokens: null, genTokens: null, ttftMs: null,
      prefillTps: null, decodeTps: null,
      enginePrefillTps: null, engineDecodeTps: null,
      clientPrefillTps: null, clientDecodeTps: null,
      engineMetrics: false, cacheHits: null,
    };

    const phase = async (prompt: string, maxTok: number): Promise<StreamRes> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const payload: Record<string, unknown> = {
          model, stream: true, max_tokens: maxTok, temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        };
        if (caps.streamOptions) payload.stream_options = { include_usage: true };
        if (caps.templateKwargs) payload.chat_template_kwargs = { enable_thinking: false };
        try {
          return await streamChat(base, apiKey, payload, AbortSignal.any([remaining(), AbortSignal.timeout(STALL_MS)]));
        } catch (e) {
          if (e instanceof BenchError && e.code === 502) {
            const m = e.message.toLowerCase();
            if (caps.streamOptions && m.includes('stream_options')) {
              caps.streamOptions = false;
              notes.push('stream_options rejected — token counts estimated from chunks');
              continue;
            }
            if (caps.templateKwargs &&
                (m.includes('chat_template_kwargs') || m.includes('enable_thinking') || m.includes('extra inputs'))) {
              caps.templateKwargs = false;
              notes.push('chat_template_kwargs rejected — thinking NOT disabled');
              continue;
            }
          }
          throw e;
        }
      }
      throw new BenchError(500, 'unreachable');
    };

    try {
      // metrics support probe (cheap GET; null → client-only mode)
      let metricsOn = await scrapeMetrics(base, apiKey, remaining());
      // counter reset detection across the whole run
      let negative = false;

      // ---- phase 1: prefill probe (max_tokens=1) ----
      this.current.stage = 'prefill…';
      const beforeP = await scrapeMetrics(base, apiKey, remaining());
      const pRes = await phase(buildPrompt(promptWords), 1);
      const afterP = await scrapeMetrics(base, apiKey, remaining());
      const dP = metricDelta(beforeP, afterP);
      metricsOn ??= afterP;

      const ttftMs = pRes.tFirst - pRes.t0 || (pRes.tLast - pRes.t0);
      row.ttftMs = ttftMs > 0 ? ttftMs : null;
      const dPrompt = dP?.prompt_tokens_total ?? null;
      row.promptTokens = pRes.usage?.prompt_tokens ?? dPrompt;
      if (row.promptTokens && ttftMs > 0) row.clientPrefillTps = 1000 * row.promptTokens / ttftMs;
      if (dPrompt !== null && dP?.request_prefill_time_seconds_sum)
        row.enginePrefillTps = dPrompt / dP.request_prefill_time_seconds_sum;

      // ---- phase 2: decode run (full generation) ----
      this.current.stage = 'decode…';
      const beforeD = await scrapeMetrics(base, apiKey, remaining());
      if ((beforeD?.num_requests_running ?? 0) > 0)
        notes.push('engine had other traffic — counter diffs may be contaminated');
      const dRes = await phase(buildPrompt(promptWords, Math.max(50, Math.floor(maxTokens * 0.8))), maxTokens);
      const afterD = await scrapeMetrics(base, apiKey, remaining());
      const dD = metricDelta(beforeD, afterD);

      row.genTokens = dRes.usage?.completion_tokens ?? (dRes.chunks || null);
      const window = dRes.tLast - dRes.tFirst;
      if (dRes.nonStream) notes.push('server ignored stream=true — wall-clock timing only');
      if (row.genTokens && window > 0 && row.genTokens > 1)
        row.clientDecodeTps = 1000 * (row.genTokens - 1) / window;
      const dGen = dD?.generation_tokens_total ?? null;
      if (dGen !== null && dD?.request_decode_time_seconds_sum)
        row.engineDecodeTps = dGen / dD.request_decode_time_seconds_sum;

      for (const d of [dP, dD]) {
        if (d) for (const k of METRIC_NAMES) if ((d[k] ?? 0) < -1e-9) negative = true;
      }
      if (negative) {
        row.enginePrefillTps = row.engineDecodeTps = null;
        notes.push('counter reset detected (engine restart?) — client timing only');
      }
      const hits = (dP?.prefix_cache_hits_total ?? 0) + (dD?.prefix_cache_hits_total ?? 0);
      row.cacheHits = (dP || dD) ? hits : null;
      if (hits > 0) notes.push(`prefix-cache hits +${hits} — prefill may be inflated`);
      row.engineMetrics = !negative && (row.enginePrefillTps !== null || row.engineDecodeTps !== null);

      row.prefillTps = row.enginePrefillTps ?? row.clientPrefillTps;
      row.decodeTps = row.engineDecodeTps ?? row.clientDecodeTps;
      row.status = 'ok';
    } catch (e) {
      row.status = 'err';
      row.err = e instanceof BenchError ? e.message : String((e as Error)?.message ?? e);
    } finally {
      this.current = null;
    }

    if (userLabel) notes.unshift(`📝 ${userLabel}`);
    if (notes.length) row.note = notes.join(' · ');
    this.store.putBench(row);
    return row;
  }
}
