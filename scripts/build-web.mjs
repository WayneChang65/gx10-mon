// 前端打包：esbuild 把 app.ts 打成單一 JS，字型複製到 public/fonts
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

// 版號戳章：只顯示 package.json 的 version；小青發版時自行 bump（fix=patch、feature=minor）
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const BUILD_INFO = `v${pkg.version}`;
console.log('BUILD_INFO:', BUILD_INFO);

await esbuild.build({
  entryPoints: ['src/web/app.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  outfile: 'public/app.js',
  loader: { '.woff2': 'file', '.css': 'css' },
  define: {
    'process.env.NODE_ENV': '"production"',
    '__BUILD_INFO__': JSON.stringify(BUILD_INFO),
  },
  logLevel: 'info',
});

// 字型落地到 public/fonts（CSS 內以 /fonts/ 引用）
const src = 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2';
if (existsSync(src)) {
  mkdirSync('public/fonts', { recursive: true });
  cpSync(src, 'public/fonts/jetbrains-mono-latin-wght-normal.woff2');
  console.log('font copied');
} else {
  console.warn('WARN: fontsource woff2 not found at', src);
}
