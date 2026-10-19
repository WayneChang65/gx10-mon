# gx10-mon

Self-hosted system monitoring dashboard for the **NVIDIA DGX Spark (GB10)** — a single lightweight container that watches the machine over the LAN, no agents, no cloud, no external CDNs.

TypeScript full-stack: Node 24 + [Hono](https://hono.dev) + built-in `node:sqlite` on the backend; vanilla TS + [Chart.js](https://www.chartjs.org) + [three.js](https://threejs.org) bundled by esbuild on the frontend.

Design philosophy: **every pixel of the 3D "digital crystal" hero animation is driven by live metrics** — GPU utilisation sets spin speed and breathing amplitude, temperature drives the hue, RAM pressure drives the particle ring, network traffic drives the edge glow. No decorative animation.

<img width="1507" height="834" alt="截圖 2026-10-19 14 29 55" src="https://github.com/user-attachments/assets/6199a4ba-5a53-4f7e-9c3a-f75674826358" />

## Features

- **Charts** (each with 5m / 1h / 6h / 24h windows, per-chart Auto-Y fit, fullscreen expand, fold-to-summary row persisted in `localStorage`):
  - CPU — total / P-cores / E-cores (big.LITTLE map auto-probed from `cpufreq`, nothing hardcoded)
  - GPU — utilisation & die temperature (`nvidia-smi` CLI, no native NVML bindings)
  - RAM + Swap — unified-memory view (GB10 has no discrete VRAM)
  - Temperatures — 7 ACPI thermal zones + NVMe SMART, dual-axis chart
  - Disk — read/write MB/s with a second Y-axis for root-filesystem usage %
  - Network — down/up mirrored around zero
  - Top CPU / Top MEM process tables
- **History**: raw points kept 24 h → 10 s aggregates 7 d → 60 s aggregates 90 d (SQLite, WAL); long windows auto-refresh while open.
- **Alerts**: SoC high temp / low available RAM / high swap → Discord webhook embed, 30 min cooldown + recovery notice.
- **SSE live stream** with reconnect; polling fallback via `/api/snapshot`.
- Read-only by design: `/proc`, `/sys` and the host root are mounted **read-only**; the monitor never changes host state. Hard container limits (256 MB / 0.5 CPU) keep the box's real workloads (e.g. vLLM) in first place.

## Quick start

```bash
docker compose up -d --build
# open http://<your-host>:8090
```

Requires a Linux host with `/proc` + `/sys`; GPU panel needs the NVIDIA Container Runtime (it injects `nvidia-smi` into the container automatically). Without a GPU the dashboard still runs — the GPU chart just stays empty.

Local development (no container):

```bash
npm install
npm run build            # tsc --noEmit + esbuild bundles (backend dist/, frontend public/app.js + fonts)
DATA_FILE=data/t.db node --no-warnings src/server.ts   # or run TS directly (Node 24 type stripping)
```

## Configuration (env vars, overridable in docker compose)

| Variable | Default | Description |
|---|---|---|
| `HOST_PORT` | 8090 | LAN port to publish |
| `SAMPLE_INTERVAL_MS` | 1000 | sampling interval (measured ≈0.2% CPU at 1 s) |
| `GPU_EVERY_N` | 5 | spawn `nvidia-smi` every N samples |
| `ALERT_SOC_MAX_C` | 90 | SoC/GPU high-temperature alert threshold |
| `ALERT_MEM_AVAIL_GB` | 4 | alert when available memory drops below |
| `ALERT_SWAP_USED_GB` | 12 | alert when swap usage exceeds |
| `DISCORD_WEBHOOK_URL` | (empty = disabled) | set to enable Discord alert pushes |
| `NET_IFACES` | `enP7s7,wlP9s9` | network interfaces to watch (set to yours) |

Frontend: append `?fx=off` to disable the 3D scene (battery saver on phones).

## API

- `GET /api/snapshot` — latest full sample + active alerts
- `GET /api/stream` — SSE live frames (auto-reconnect every 5 s)
- `GET /api/history?range=5m|1h|6h|24h` — windowed history (server-side aggregated)
- `GET /api/alerts` / `GET /api/config` / `GET /healthz`

## Architecture

```
src/
  server.ts     Hono entry: API + SSE + static files
  sampler.ts    sampling loop (compose Sample → SQLite + SSE + alerts)
  proc.ts       /proc /sys parsers (CPU core map auto-probe, mem, temps, disk, net, procs)
  gpu.ts        nvidia-smi CLI wrapper
  db.ts         node:sqlite tiered downsampling
  alerts.ts     thresholds + cooldown + Discord webhook
  web/scene.ts  three.js digital crystal (fully data-driven)
  web/app.ts    SSE → HUD/charts/tables, Chart.js wiring, fold & zoom UX
```

## Notes

- The dashboard is intended for **LAN use only** — put it behind your own reverse proxy/auth if you expose it.
- Logs are capped (json-file 10 MB × 3); the history DB lives in `./data` (delete the directory to reset).
- Fonts (JetBrains Mono, OFL-1.1) and JS/CSS bundles are generated at build time from npm dependencies; nothing proprietary is committed.

## License

MIT — see [LICENSE](LICENSE). Bundled third-party components keep their own licenses (Chart.js MIT, three.js MIT, Hono MIT, JetBrains Mono OFL-1.1 via `@fontsource-variable/jetbrains-mono`).
