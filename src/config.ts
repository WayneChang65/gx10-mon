// 環境設定：全部可由環境變數覆寫
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const CFG = {
  sampleMs: Math.max(500, num(process.env.SAMPLE_INTERVAL_MS, 1000)),
  port: num(process.env.HOST_PORT, 8090),
  dataFile: process.env.DATA_FILE ?? 'data/metrics.db',
  gpuEvery: Math.max(1, num(process.env.GPU_EVERY_N, 5)), // GPU 查詢頻率（每 N 輪一次）
  procTopN: 5,
  diskDevice: process.env.DISK_DEVICE ?? 'nvme0n1',
  ifaces: (process.env.NET_IFACES ?? 'enP7s7,wlP9s9').split(',').map(s => s.trim()).filter(Boolean),
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || '',
  alert: {
    socMaxC: num(process.env.ALERT_SOC_MAX_C, 90),
    memAvailGB: num(process.env.ALERT_MEM_AVAIL_GB, 4),
    swapUsedGB: num(process.env.ALERT_SWAP_USED_GB, 12),
    cooldownMs: num(process.env.ALERT_COOLDOWN_MIN, 30) * 60_000,
  },
};
