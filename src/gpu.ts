// GPU 取數：nvidia-smi --query CSV（CLI spawn，規避 NVML native 依賴）
import { execFile } from 'node:child_process';
import { CFG } from './config.ts';

export type GpuRow = { utilPct: number; tempC: number; powerW: number } | null;

export function queryGpu(): Promise<GpuRow> {
  return new Promise((resolve) => {
    const bin = process.env.NVIDIA_SMI_BIN ?? '/usr/bin/nvidia-smi';
    execFile(bin, ['--query-gpu=utilization.gpu,temperature.gpu,power.draw', '--format=csv,noheader,nounits'],
      { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const p = stdout.trim().split(',').map(s => s.trim());
        const util = Number(p[0]); const temp = Number(p[1]);
        const pow = Number(String(p[2]).replace('[N/A]', 'NaN'));
        if (!Number.isFinite(util) && !Number.isFinite(temp)) return resolve(null);
        resolve({
          utilPct: Number.isFinite(util) ? util : 0,
          tempC: Number.isFinite(temp) ? temp : 0,
          powerW: Number.isFinite(pow) ? pow : 0,
        });
      });
  });
}
