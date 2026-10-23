// three.js 主視覺「數位晶體」——動畫全部由即時數據驅動
import * as THREE from 'three';

type DashedMat = THREE.LineDashedMaterial & { dashOffset: number };

export interface Drive {
  gpuUtil: number;   // 0-100 → 自轉速度
  maxTempC: number;  // → 色相 teal→琥珀→紅
  ramPct: number;    // 0-100 → 粒子密度/光圈脈動
  netMBs: number;    // 上下行合計 → 邊緣流光速度
  alarmed: boolean;  // 告警 → 強制紅色
}

// 溫度→色相：<=60 teal(168°)，~75 琥珀，>=90 全紅(0°)——紅端對齊 90°C 警戒線（正常重載峰 ~86 呈橘紅）
// 砸擊配色（additive blending 下 RGB→0 即淡出，無需 per-particle opacity）
const IMP_C = [1.0, 0.70, 0.28] as const;    // 琥珀流星
const SPK_C = [1.0, 0.84, 0.55] as const;    // 命中水花（更亮的白琥珀）

function tempColor(c: number): THREE.Color {
  const t = THREE.MathUtils.clamp((c - 60) / 30, 0, 1);
  const hue = THREE.MathUtils.lerp(168, 0, t) / 360;
  const sat = THREE.MathUtils.lerp(0.62, 0.9, t);
  const lig = THREE.MathUtils.lerp(0.5, 0.55, t);
  return new THREE.Color().setHSL(hue, sat, lig);
}

export class Crystal {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private crystal!: THREE.Mesh;
  private wire!: THREE.LineSegments;
  private edges!: THREE.LineSegments;
  private ring!: THREE.Points;
  private stars!: THREE.Points;
  // GPU util 驅動「流星砸擊」：粒子環發射、直線撲向晶體，數量∝loading（CPU 模擬，零 shader）
  private impacts!: THREE.Points;
  private impAttr!: THREE.BufferAttribute;
  private impPos = new Float32Array(0);
  private impVel = new Float32Array(0);
  private impTtl = new Float32Array(0);   // <0 = 死粒子（泊於地下不可見）
  private impCol = new Float32Array(0);
  private impColAttr!: THREE.BufferAttribute;
  private spkAttr!: THREE.BufferAttribute;
  private spkColAttr!: THREE.BufferAttribute;
  private spkPos = new Float32Array(0);
  private spkVel = new Float32Array(0);
  private spkTtl = new Float32Array(0);
  private spkCol = new Float32Array(0);
  private spkN = 0;
  private impN = 0;
  private emitAcc = 0;
  private excite = 0;                     // 激發能量：砸中+1粒，τ=0.45s 衰減 → 剧烈運動
  private ringR = 1;                      // 粒子環目前世界半徑（發射參考）
  private frames = 0;
  private mat!: THREE.MeshStandardMaterial;
  private edgeMat!: DashedMat;
  private ringMat!: THREE.PointsMaterial;
  private raf = 0;
  private spin = 0.002;
  private ringFit = 1; // 粒子環自動貼邊縮放
  private pivot = new THREE.Group();          // 視差傾側樞紐（滑鼠凝視/敲擊掛這，不干擾自轉四元數）
  private pTX = 0; private pTY = 0;           // 滑鼠視差目標(-1..1，hero 內)
  private pX = 0; private pY = 0;             // 平滑值（hero 視差）
  private pokeX = 0; private pokeV = 0;       // 敲擊彈簧位移/速度
  private qSpin = new THREE.Quaternion();     // 自轉姿態（獨立積分）
  private axis: [number, number, number] = [0.10, 0.99, 0.09]; // 動態自轉軸（單位向量）
  private qTmp = new THREE.Quaternion();
  private vTmp = new THREE.Vector3();
  private drive: Drive = { gpuUtil: 0, maxTempC: 50, ramPct: 0, netMBs: 0, alarmed: false };
  private smooth: Drive = { ...this.drive };
  private clock = new THREE.Clock();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 0.9, 7.2);
    this.camera.lookAt(0, 0, 0);

    // 散射光設計：半球柔光為主（天頂冷白→地面微青），方向光只留少量塑形
    this.scene.add(new THREE.HemisphereLight(0xe6fffa, 0x14403a, 3.2)); // 散射主光加壓
    this.scene.add(new THREE.AmbientLight(0x1a3a36, 0.6));
    const key = new THREE.PointLight(0x2dd4bf, 55, 30); key.position.set(4, 5, 6); this.scene.add(key);
    const rim = new THREE.PointLight(0x1e6ea6, 35, 30); rim.position.set(-5, -3, 4); this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffffff, 1.5); fill.position.set(-3, 4, 5); this.scene.add(fill); // 明暗走向加重

    this.build();
    this.resize();
    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause(); else if (this.wantOn) this.resume();
    });
    // 行動裝置 Safari 回前台時 WebGL context 可能已丢失：允許恢復並重繪
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.pause(); });
    canvas.addEventListener('webglcontextrestored', () => { this.resize(); this.resume(); });
    (globalThis as { __gxmonCrystal?: unknown }).__gxmonCrystal = this;   // E2E 除錯柄
  }

  get enabled() { return this.wantOn; }
  private wantOn = true;

  private build(): void {
    // 主晶體：正八面體拉長（鑽石形）
    const geo = new THREE.OctahedronGeometry(1.7, 0);
    geo.scale(1, 1.35, 1);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x0f2b28, emissive: 0x2dd4bf, emissiveIntensity: 0.15,
      metalness: 0.5, roughness: 0.26, transparent: false, opacity: 1, flatShading: true,
    });
    this.crystal = new THREE.Mesh(geo, this.mat);
    this.pivot.add(this.crystal);
    this.scene.add(this.pivot);

    // 線框
    this.wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 1),
      new THREE.LineBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.55 }));
    this.crystal.add(this.wire);

    // 邊緣流光（虛線 dash 滾動）
    this.edgeMat = new THREE.LineDashedMaterial({
      color: 0xaffff2, dashSize: 0.22, gapSize: 0.7, transparent: true, opacity: 0.9 }) as DashedMat;
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), this.edgeMat);
    this.edges.scale.setScalar(1.02);
    this.edges.computeLineDistances();
    this.crystal.add(this.edges);

    // 環繞粒子流
    const N = innerWidth < 720 ? 1000 : 2800;
    const pos = new Float32Array(N * 3); const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 0.78 + Math.random() * 0.22; // 單位環：外緣 1，實際尺寸由 fitRing() 縮放
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 0.18; // 扁環（厚度隨 fit 等比）
      pos[i * 3 + 2] = Math.sin(a) * r;
      seed[i] = Math.random();
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.ringMat = new THREE.PointsMaterial({
      color: 0x2dd4bf, size: 0.03, transparent: true, opacity: 0.7, depthWrite: false });
    this.ring = new THREE.Points(pg, this.ringMat);
    this.scene.add(this.ring);

    // 背景星塵
    const S = innerWidth < 720 ? 200 : 600;
    const sp = new Float32Array(S * 3);
    for (let i = 0; i < S; i++) {
      sp[i * 3] = (Math.random() - 0.5) * 40;
      sp[i * 3 + 1] = (Math.random() - 0.5) * 20;
      sp[i * 3 + 2] = -6 - Math.random() * 20;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0x355f5a, size: 0.05, transparent: true, opacity: 0.6 }));
    this.scene.add(this.stars);

    // 流星池：固定池反覆利用，死粒子泊地下不出場
    this.impN = innerWidth < 720 ? 40 : 90;
    this.impPos = new Float32Array(this.impN * 3);
    this.impVel = new Float32Array(this.impN * 3);
    this.impTtl = new Float32Array(this.impN).fill(-1);
    for (let i = 0; i < this.impN; i++) this.impPos[i * 3 + 1] = -999;
    const ig = new THREE.BufferGeometry();
    this.impAttr = new THREE.BufferAttribute(this.impPos, 3);
    this.impCol = new Float32Array(this.impN * 3);
    this.impColAttr = new THREE.BufferAttribute(this.impCol, 3);
    ig.setAttribute('position', this.impAttr);
    ig.setAttribute('color', this.impColAttr);
    this.impacts = new THREE.Points(ig, new THREE.PointsMaterial({
      vertexColors: true, size: 0.09, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    this.impacts.frustumCulled = false;   // 每幀 CPU 更新位置，毋需內建包圍球
    this.scene.add(this.impacts);

    // 命中水花池：砸中瞬間自命中點爆散，additive＋vertex color 漸滅
    this.spkN = innerWidth < 720 ? 40 : 80;
    this.spkPos = new Float32Array(this.spkN * 3);
    this.spkVel = new Float32Array(this.spkN * 3);
    this.spkTtl = new Float32Array(this.spkN).fill(-1);
    this.spkCol = new Float32Array(this.spkN * 3);
    for (let i = 0; i < this.spkN; i++) this.spkPos[i * 3 + 1] = -999;
    const spg = new THREE.BufferGeometry();
    this.spkAttr = new THREE.BufferAttribute(this.spkPos, 3);
    this.spkColAttr = new THREE.BufferAttribute(this.spkCol, 3);
    spg.setAttribute('position', this.spkAttr);
    spg.setAttribute('color', this.spkColAttr);
    const sparksObj = new THREE.Points(spg, new THREE.PointsMaterial({
      vertexColors: true, size: 0.07, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending }));
    sparksObj.frustumCulled = false;
    this.scene.add(sparksObj);
  }

  setData(d: Drive): void { this.drive = d; }

  /** 滑鼠視差：(-1..1, -1..1) = hero 區內的相對位置 */
  setPointer(nx: number, ny: number): void {
    this.pTX = THREE.MathUtils.clamp(nx, -1, 1);
    this.pTY = THREE.MathUtils.clamp(ny, -1, 1);
  }

  /** 敲擊晶體：彈簧脈衝 */
  poke(): void { this.pokeV += 3.2; }

  /** 發射一顆流星：粒子環隨機點 → 直線撲向晶體中心 */
  private spawnImpact(): void {
    const i = this.impTtl.indexOf(-1);
    if (i < 0) return;                                    // 池滿，這顆作廢
    const a = Math.random() * Math.PI * 2;
    const r0 = this.ringR * (0.82 + Math.random() * 0.18);
    const px = Math.cos(a) * r0 + this.ring.position.x;
    const py = this.ring.position.y + (Math.random() - 0.5) * 0.18;
    const pz = Math.sin(a) * r0 + this.ring.position.z;
    const d = Math.hypot(px, py, pz) || 1;
    const speed = 6 + Math.random() * 5;
    const o = i * 3;
    this.impPos[o] = px; this.impPos[o + 1] = py; this.impPos[o + 2] = pz;
    this.impVel[o] = -px / d * speed; this.impVel[o + 1] = -py / d * speed; this.impVel[o + 2] = -pz / d * speed;
    this.impTtl[i] = d / speed + 0.6;
    this.impCol[o] = IMP_C[0]; this.impCol[o + 1] = IMP_C[1]; this.impCol[o + 2] = IMP_C[2];
  }

  /** 命中水花：命中點爆 4 點球面四散微粒 */
  private spawnSplash(x: number, y: number, z: number): void {
    for (let k = 0; k < 4; k++) {
      const i = this.spkTtl.indexOf(-1);
      if (i < 0) return;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const v = 2.5 + Math.random() * 2.5;
      const o = i * 3;
      this.spkPos[o] = x; this.spkPos[o + 1] = y; this.spkPos[o + 2] = z;
      this.spkVel[o] = Math.sin(ph) * Math.cos(th) * v;
      this.spkVel[o + 1] = Math.cos(ph) * v;
      this.spkVel[o + 2] = Math.sin(ph) * Math.sin(th) * v;
      this.spkTtl[i] = 0.25 + Math.random() * 0.25;
      this.spkCol[o] = SPK_C[0]; this.spkCol[o + 1] = SPK_C[1]; this.spkCol[o + 2] = SPK_C[2];
    }
  }

  private killImpact(i: number): void {
    this.impTtl[i] = -1;
    const o = i * 3;
    this.impPos[o + 1] = -999;
    this.impCol[o] = 0; this.impCol[o + 1] = 0; this.impCol[o + 2] = 0;
  }

  /** E2E 除錯：砸擊現況快照 */
  get impactDebug(): { excite: number; alive: number; sparks: number; frames: number } {
    let alive = 0;
    for (let i = 0; i < this.impN; i++) if (this.impTtl[i] >= 0) alive++;
    let sparks = 0;
    for (let i = 0; i < this.spkN; i++) if (this.spkTtl[i] >= 0) sparks++;
    return { excite: this.excite, alive, sparks, frames: this.frames };
  }

  setOn(on: boolean): void {
    this.wantOn = on;
    localStorage.setItem('fx', on ? '1' : '0');
    if (on) this.resume(); else this.pause();
  }
  get on(): boolean { return this.wantOn; }

  private pause(): void { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  private resume(): void {
    if (this.raf || !this.wantOn || document.hidden) return;
    this.clock.getDelta();
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fitRing();
  }

  /** 粒子環自動撐到畫布邊界：左右對稱、留 10% 餘裕、永不壓到 HUD 文字 */
  private fitRing(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const halfH = 0.41421 * 7.25;                     // tan(fov/2) × 相機距離
    let limitPx = w / 2;                              // 左界：畫布左緣（與右緣對稱）
    const hud = document.getElementById('heroHud');
    if (hud) {
      const hr = hud.getBoundingClientRect(), fr = this.canvas.getBoundingClientRect();
      const gap = hr.left - fr.left - fr.width / 2;   // 中心→HUD 文字左緣
      if (gap > 20) limitPx = Math.min(limitPx, gap); // HUD 壓在畫布上（桌面態）才設限
    }
    const rH = 0.90 * limitPx * (2 * halfH / h);      // 水平界換算世界單位
    const rV = 0.85 * halfH / 0.22;                   // 垂向界：扁橢圓(視角7°+厚度)不切頂底
    this.ringFit = Math.max(1, Math.min(rH, rV));
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const s = this.smooth, d = this.drive;
    const k = Math.min(1, dt * 3); // 平滑跟隨
    s.gpuUtil += (d.gpuUtil - s.gpuUtil) * k;
    s.maxTempC += (d.maxTempC - s.maxTempC) * k;
    s.ramPct += (d.ramPct - s.ramPct) * k;
    s.netMBs += (d.netMBs - s.netMBs) * k;
    s.alarmed = d.alarmed;

    // ① GPU util → 自轉速度＋軸線翻滾（高 util：歲差更快，且歲差參考軸本身擺盪 → 軌跡完全不規則＝忙碌感）
    const u = s.gpuUtil / 100;
    this.spin = THREE.MathUtils.lerp(0.09, 4.2, u) * (1 + this.excite * 0.6);          // 砸擊能量再推轉速
    const tumble = (0.10 + 30 * u * u) * (1 + this.excite * 1.2) * dt;                 // 歲差角速度：0% 微擺 → 100% 暴翻，激發時更翻
    const wob = u * u * Math.sin(t * (4 + 21 * u));            // 高載調變：100% 時參考軸全幅擺盪（~4Hz）
    const mix = 0.5 * (1 + wob);                               // 兩條參考軸之間的混合權重
    let nx = 0.2544 * mix + 0.88 * (1 - mix);
    let ny = 0.407 * mix - 0.35 * (1 - mix);
    let nz = 0.8788 * mix - 0.32 * (1 - mix);
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const a = this.axis;
    const cw = Math.cos(tumble), sw = Math.sin(tumble);
    const dot = a[0] * nx + a[1] * ny + a[2] * nz;
    const kx = ny * a[2] - nz * a[1], ky = nz * a[0] - nx * a[2], kz = nx * a[1] - ny * a[0];
    a[0] += a[0] * (cw - 1) + kx * sw + nx * dot * (1 - cw);
    a[1] += a[1] * (cw - 1) + ky * sw + ny * dot * (1 - cw);
    a[2] += a[2] * (cw - 1) + kz * sw + nz * dot * (1 - cw);
    const len = Math.hypot(a[0], a[1], a[2]) || 1;
    a[0] /= len; a[1] /= len; a[2] /= len;
    this.vTmp.set(a[0], a[1], a[2]);
    this.qSpin.premultiply(this.qTmp.setFromAxisAngle(this.vTmp, this.spin * dt));

    // ①b GPU util → 呼吸縮放：閒置慢而微幅、忙碌快而劇烈；雙頻疊加不規則化＝喘氣感
    const amp = Math.min(0.22, 0.02 + 0.20 * u * u + this.excite * 0.05); // ±2% 微喘 → ±22% 劇喘；砸擊加分但 1.22x 幾何安全上限不破
    const rate = 1.8 + 11 * u;                                   // 0.29Hz 呼吸 → ~2.0Hz 急喘
    const br = Math.sin(t * rate) * 0.6 + Math.sin(t * rate * 1.7 + 1.3) * 0.4;
    this.crystal.scale.setScalar(1 + amp * br);

    // ② 溫度 → 色相（告警強制紅）
    const col = s.alarmed ? new THREE.Color(0xef4444) : tempColor(s.maxTempC);
    this.mat.emissive.copy(col);
    this.mat.emissiveIntensity = 0.15 + this.excite * 0.45;   // 砸擊 → 晶體瞬時發亮
    (this.wire.material as THREE.LineBasicMaterial).color.copy(col);
    this.ringMat.color.copy(col);

    // ③ RAM 壓力 → 光圈半徑脈動＋粒子亮度
    const pulse = 1 + Math.sin(t * (1 + s.ramPct / 25)) * 0.06 * (s.ramPct / 100 + 0.3);
    this.ringR = pulse * this.ringFit;
    this.ring.scale.setScalar(this.ringR);
    this.ring.rotation.y -= (0.001 + s.ramPct / 100 * 0.004) * (dt * 60);
    this.ringMat.opacity = 0.35 + (s.ramPct / 100) * 0.5;

    // ③b 流星砸擊：發射率∝GPU loading（桌機滿載 ~30 顆/秒、手機 15）
    this.excite *= Math.exp(-dt / 0.45);                      // 激發能量指數衰減
    this.emitAcc += (this.impN >= 90 ? 30 : 15) * u * dt;
    while (this.emitAcc >= 1) { this.emitAcc -= 1; this.spawnImpact(); }
    const hitR2 = 1.7 * 1.7;                                  // 命中判定：晶體外接半徑內
    for (let i = 0; i < this.impN; i++) {
      if (this.impTtl[i] < 0) continue;
      this.impTtl[i] -= dt;
      const o = i * 3;
      this.impPos[o] += this.impVel[o] * dt;
      this.impPos[o + 1] += this.impVel[o + 1] * dt;
      this.impPos[o + 2] += this.impVel[o + 2] * dt;
      const d2 = this.impPos[o] ** 2 + this.impPos[o + 1] ** 2 + this.impPos[o + 2] ** 2;
      const fade = Math.min(1, this.impTtl[i] / 0.15);        // 末段淡出：砸中/超齡都不突消失
      this.impCol[o] = IMP_C[0] * fade; this.impCol[o + 1] = IMP_C[1] * fade; this.impCol[o + 2] = IMP_C[2] * fade;
      if (d2 <= hitR2) {                                      // 砸中：能量灌入＋命中點水花
        this.excite = Math.min(1, this.excite + 0.05);
        this.spawnSplash(this.impPos[o], this.impPos[o + 1], this.impPos[o + 2]);
        this.killImpact(i);
      } else if (this.impTtl[i] <= 0) {                       // 超齡回收
        this.killImpact(i);
      }
    }
    this.impAttr.needsUpdate = true;
    this.impColAttr.needsUpdate = true;

    // 水花四散：速度阻尼收攏、亮度隨壽命漸滅
    for (let i = 0; i < this.spkN; i++) {
      if (this.spkTtl[i] < 0) continue;
      this.spkTtl[i] -= dt;
      const o = i * 3;
      const damp = Math.exp(-dt * 3);
      this.spkVel[o] *= damp; this.spkVel[o + 1] *= damp; this.spkVel[o + 2] *= damp;
      this.spkPos[o] += this.spkVel[o] * dt;
      this.spkPos[o + 1] += this.spkVel[o + 1] * dt;
      this.spkPos[o + 2] += this.spkVel[o + 2] * dt;
      const f = Math.max(0, Math.min(1, this.spkTtl[i] / 0.3));
      this.spkCol[o] = SPK_C[0] * f; this.spkCol[o + 1] = SPK_C[1] * f; this.spkCol[o + 2] = SPK_C[2] * f;
      if (this.spkTtl[i] <= 0) { this.spkTtl[i] = -1; this.spkPos[o + 1] = -999; }
    }
    this.spkAttr.needsUpdate = true;
    this.spkColAttr.needsUpdate = true;

    // ④ 網路 → 邊緣流光速度
    const flow = 0.4 + Math.min(8, s.netMBs) * 1.6;
    this.edgeMat.dashOffset -= flow * dt;
    this.edgeMat.opacity = 0.35 + Math.min(1, s.netMBs / 5) * 0.6;

    // ⑤ 滑鼠互動：hero 視差微傾＋敲擊彈簧（自轉姿態由 qSpin 獨立積分直接驅動）
    const pk = Math.min(1, dt * 4);
    this.pX += (this.pTX - this.pX) * pk;
    this.pY += (this.pTY - this.pY) * pk;
    this.crystal.quaternion.copy(this.qSpin);
    this.pokeV += (-260 * this.pokeX - 16 * this.pokeV) * dt;   // 彈簧：硬彈、兩下內穩定
    this.pokeX += this.pokeV * dt;
    const j1 = this.excite * 0.045 * Math.sin(t * 57.9) * Math.sin(t * 23.7 + 1.7);    // 砸擊 → 高頻顫動（確定性偽噪音）
    const j2 = this.excite * 0.05 * Math.sin(t * 49.3 + 0.6) * Math.sin(t * 31.1 + 2.3);
    this.pivot.rotation.y = this.pX * 0.16 + this.pokeX * 0.5 + j1;
    this.pivot.rotation.x = this.pY * 0.11 + this.pokeX * 0.3 + j2;
    this.pivot.rotation.z = (j1 + j2) * 0.6;
    this.pivot.scale.setScalar(1 - Math.min(0.07, Math.abs(this.pokeX) * 0.45));
    this.ring.position.x = -this.pX * 0.22;
    this.ring.position.y = this.pY * 0.10;

    this.stars.rotation.y += 0.00015 * (dt * 60);
    this.frames++;
    this.renderer.render(this.scene, this.camera);
  }
}
