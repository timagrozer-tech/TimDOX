import { Camera } from "./camera";
import { TerrainPainter } from "./terrain";
import { cloudSprites, glowSprite, settlementSprite } from "./sprites";
import { isWater } from "../world/biomes";
import type { Snapshot, StaticWorld, SnapSettlement } from "../workers/protocol";

/**
 * Отрисовка карты на Canvas 2D.
 * Слои: подложка (общая картинка, а при приближении — чёткие плитки) → снег → дороги → мягкая заливка владений →
 * плавные границы (изолинии) → пути → руины → поселения → армии → бедствия → подписи → облака → вспышки → виньетка.
 * Неподвижные слои кэшируются в одну картинку, пока камера стоит; качество подстраивается под частоту кадров.
 */
export class Renderer {
  readonly cam = new Camera();
  private ctx: CanvasRenderingContext2D;
  private painter: TerrainPainter | null = null;
  private tk = 6;
  private fill: HTMLCanvasElement = document.createElement("canvas");
  /** владения растром (заливка + границы) — перерисовывается не чаще 3 раз в секунду */
  private terr: HTMLCanvasElement = document.createElement("canvas");
  private terrK = 5;
  private pendingOwner = false;
  private lastTerr = 0;
  private roads: HTMLCanvasElement = document.createElement("canvas");
  private borders = new Map<number, Path2D>();
  world: StaticWorld | null = null;
  snap: Snapshot | null = null;
  private prevSnap: Snapshot | null = null;
  private snapTime = 0;
  private owner: Int16Array | null = null;
  civColor = new Map<number, [number, number, number]>();
  dpr = 1;
  quality = 2;
  private frameTimes: number[] = [];
  pulses: { x: number; y: number; t0: number; color: string }[] = [];
  reveal = 1;
  selected: { kind: string; id: number } | null = null;
  private clouds: { x: number; y: number; s: number; k: number; v: number }[] = [];
  private t = 0;
  private frameNo = 0;
  fps = 60;
  private layerVer = 0;
  private baseCache: HTMLCanvasElement = document.createElement("canvas");
  private baseKey = "";
  private vignette: CanvasGradient | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    for (let i = 0; i < 7; i++) this.clouds.push({ x: Math.random(), y: Math.random(), s: 0.7 + Math.random() * 0.8, k: i % 4, v: 0.003 + Math.random() * 0.004 });
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality >= 2 ? 2 : this.quality === 1 ? 1.5 : 1);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.cam.setViewport(r.width, r.height);
    this.vignette = null; this.baseKey = "";
  }

  setWorld(w: StaticWorld): void {
    this.world = w;
    const t0 = performance.now();
    this.painter = new TerrainPainter(w);
    this.tk = this.painter.k;
    this.terrK = w.w > 240 ? 4 : 5;
    this.terr.width = w.w * this.terrK; this.terr.height = w.h * this.terrK;
    console.info(`[genesis] подложка карты ${w.w}×${w.h}: ${Math.round(performance.now() - t0)} мс`);
    this.fill.width = w.w; this.fill.height = w.h;
    this.roads.width = w.w; this.roads.height = w.h;
    this.owner = null; this.borders.clear();
    this.cam.fit(w.w, w.h);
    this.layerVer++;
  }

  setSnapshot(s: Snapshot): void {
    for (const c of s.civs) this.civColor.set(c.id, c.color);
    if (s.owner) { this.owner = s.owner; this.pendingOwner = true; }
    if (s.road) { this.paintRoads(s.road); this.layerVer++; }
    this.prevSnap = this.snap;
    this.snap = s;
    this.snapTime = performance.now();
    for (const e of s.events) if (e.imp >= 3 && e.x >= 0) this.pulses.push({ x: e.x + 0.5, y: e.py + 0.5, t0: performance.now(), color: e.imp >= 4 ? "255,214,140" : "255,255,255" });
    if (this.pulses.length > 30) this.pulses.splice(0, this.pulses.length - 30);
  }

  /** Владения: мягкая заливка (1 пиксель на клетку, сглаживается при растяжении) и плавные границы — изолинии по «марширующим квадратам» */
  private paintTerritory(): void {
    const w = this.world!, o = this.owner!, W = w.w, H = w.h, B = w.biome;
    const own = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H || isWater(B[y * W + x]!) ? -1 : o[y * W + x]!);
    const g = this.fill.getContext("2d")!;
    const img = g.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = own(x, y); if (c < 0) continue;
      const col = this.civColor.get(c) ?? [200, 200, 200];
      const p = (y * W + x) * 4;
      d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = 44;
    }
    g.putImageData(img, 0, 0);
    // изолинии: границы по серединам рёбер между центрами клеток — с диагональными срезами вместо «лесенки»
    const paths = new Map<number, Path2D>();
    const P = (c: number) => { let p = paths.get(c); if (!p) { p = new Path2D(); paths.set(c, p); } return p; };
    for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
      const a = own(x, y), b = own(x + 1, y), c = own(x + 1, y + 1), dd = own(x, y + 1);
      if (a === b && b === c && c === dd) continue;
      const cx = x + 0.5, cy = y + 0.5;
      const T: [number, number] = [cx + 0.5, cy], R: [number, number] = [cx + 1, cy + 0.5], Bm: [number, number] = [cx + 0.5, cy + 1], L: [number, number] = [cx, cy + 0.5];
      for (const civ of new Set([a, b, c, dd])) {
        if (civ < 0) continue;
        const k = (a === civ ? 8 : 0) | (b === civ ? 4 : 0) | (c === civ ? 2 : 0) | (dd === civ ? 1 : 0);
        const seg = (p1: [number, number], p2: [number, number]) => { const p = P(civ); p.moveTo(p1[0], p1[1]); p.lineTo(p2[0], p2[1]); };
        switch (k) {
          case 1: case 14: seg(L, Bm); break;
          case 2: case 13: seg(Bm, R); break;
          case 3: case 12: seg(L, R); break;
          case 4: case 11: seg(T, R); break;
          case 6: case 9: seg(T, Bm); break;
          case 7: case 8: seg(L, T); break;
          case 5: seg(L, T); seg(Bm, R); break;
          case 10: seg(T, R); seg(L, Bm); break;
          default: break;
        }
      }
    }
    this.borders = paths;
    const tg = this.terr.getContext("2d")!, K = this.terrK;
    tg.setTransform(1, 0, 0, 1, 0, 0);
    tg.clearRect(0, 0, this.terr.width, this.terr.height);
    tg.imageSmoothingEnabled = true;
    tg.drawImage(this.fill, 0, 0, W * K, H * K);
    tg.setTransform(K, 0, 0, K, 0, 0);
    tg.lineJoin = "round"; tg.lineCap = "round";
    for (const [civ, path] of paths) {
      const c = this.civColor.get(civ) ?? [220, 220, 220];
      tg.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.95)`; tg.lineWidth = 0.36;
      tg.stroke(path);
    }
    tg.strokeStyle = "rgba(25,18,12,0.5)"; tg.lineWidth = 0.1;
    for (const path of paths.values()) tg.stroke(path);
  }
  private paintRoads(road: Uint8Array): void {
    const w = this.world!;
    const g = this.roads.getContext("2d")!;
    const img = g.createImageData(w.w, w.h), d = img.data;
    for (let i = 0; i < road.length; i++) {
      const v = road[i]!;
      if (!v) continue;
      d[i * 4] = 128; d[i * 4 + 1] = 100; d[i * 4 + 2] = 70; d[i * 4 + 3] = Math.min(120, 20 + v * 0.6);
    }
    g.putImageData(img, 0, 0);
  }

  season(): number {
    const s = this.snap; if (!s) return 0;
    if (s.speed > 3 || s.speed === 0) return s.speed === 0 ? this.lastSeason : 0.12;
    const phase = ((this.yearFrac() % 1) + 1) % 1;
    this.lastSeason = Math.max(0, Math.cos((phase - 0.85) * Math.PI * 2)) ** 1.5;
    return this.lastSeason;
  }
  private lastSeason = 0;
  yearFrac(): number {
    const s = this.snap; if (!s) return 0;
    return s.year + Math.min(1, ((performance.now() - this.snapTime) / 1000) * s.speed);
  }

  frame(dt: number): void {
    const t0 = performance.now();
    this.t += dt; this.frameNo++;
    const g = this.ctx, cam = this.cam, w = this.world;
    const W = this.canvas.width, H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (!w || !this.painter) { g.fillStyle = "#0e2234"; g.fillRect(0, 0, W, H); return; }
    cam.update(dt); cam.clamp(w.w, w.h);
    const z = cam.zoom * this.dpr;
    const ox = W / 2 - cam.x * z, oy = H / 2 - cam.y * z;
    const k = this.tk;
    if (this.pendingOwner && performance.now() - this.lastTerr > 330) { this.pendingOwner = false; this.lastTerr = performance.now(); this.paintTerritory(); this.layerVer++; }
    const [vx0, vy0] = cam.toWorld(0, 0), [vx1, vy1] = cam.toWorld(cam.vw, cam.vh);
    // --- неподвижные слои одной картинкой
    const sn = this.season();
    // плитки высокой чёткости — только когда видно немного плиток (иначе хватает общей картинки)
    const visTiles = (Math.floor(Math.min(w.w - 1, vx1) / 16) - Math.floor(Math.max(0, vx0) / 16) + 1) * (Math.floor(Math.min(w.h - 1, vy1) / 16) - Math.floor(Math.max(0, vy0) / 16) + 1);
    const detail = z > k * 1.3 && visTiles <= 24;
    const ppc = detail ? (z > 34 ? 28 : z > 18 ? 20 : 12) : 0;
    let pending = false;
    if (detail) {
      // недостающие плитки высокой чёткости — по 2 за кадр, остальное пока из общей картинки
      const T = 16, tx0 = Math.max(0, Math.floor(vx0 / T)), ty0 = Math.max(0, Math.floor(vy0 / T)), tx1 = Math.min(Math.ceil(w.w / T) - 1, Math.floor(vx1 / T)), ty1 = Math.min(Math.ceil(w.h / T) - 1, Math.floor(vy1 / T));
      let made = 0;
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.painter.tile(tx, ty, ppc, this.frameNo)) { if (made < 2) { this.painter.makeTile(tx, ty, ppc, this.frameNo); made++; this.layerVer++; } else pending = true; }
      }
    }
    const key = `${cam.x.toFixed(3)}:${cam.y.toFixed(3)}:${cam.zoom.toFixed(4)}:${this.layerVer}:${Math.round(sn * 20)}:${this.reveal.toFixed(2)}:${W}x${H}`;
    if (key === this.baseKey) g.drawImage(this.baseCache, 0, 0);
    else {
      const bc = this.baseCache;
      if (bc.width !== W || bc.height !== H) { bc.width = W; bc.height = H; }
      const b = bc.getContext("2d")!;
      b.setTransform(1, 0, 0, 1, 0, 0);
      // за краем карты — глубокое море
      const sea = b.createLinearGradient(0, 0, 0, H); sea.addColorStop(0, "#143149"); sea.addColorStop(1, "#0d2235");
      b.fillStyle = sea; b.fillRect(0, 0, W, H);
      b.globalAlpha = this.reveal;
      b.imageSmoothingEnabled = true; b.imageSmoothingQuality = "high";
      b.setTransform(z / k, 0, 0, z / k, ox, oy);
      b.drawImage(this.painter.base as CanvasImageSource, 0, 0);
      if (detail) {
        const T = 16;
        b.setTransform(z / ppc, 0, 0, z / ppc, ox, oy);
        for (let ty = Math.max(0, Math.floor(vy0 / T)); ty * T <= vy1 && ty * T < w.h; ty++) for (let tx = Math.max(0, Math.floor(vx0 / T)); tx * T <= vx1 && tx * T < w.w; tx++) {
          const c = this.painter.tile(tx, ty, ppc, this.frameNo);
          if (c) b.drawImage(c as CanvasImageSource, tx * T * ppc, ty * T * ppc);
        }
      }
      b.setTransform(z, 0, 0, z, ox, oy);
      if (sn > 0.02) { b.globalAlpha = this.reveal * sn * 0.8; b.drawImage(this.painter.snow as CanvasImageSource, 0, 0, w.w, w.h); b.globalAlpha = this.reveal; }
      b.drawImage(this.roads, 0, 0, w.w, w.h);
      b.globalAlpha = this.reveal;
      if (cam.zoom <= 12) b.drawImage(this.terr, 0, 0, w.w, w.h);
      else {
        // крупно: заливка растром, границы — векторами (чёткие при любом приближении)
        b.globalAlpha = this.reveal * 0.75; b.drawImage(this.fill, 0, 0, w.w, w.h); b.globalAlpha = this.reveal;
        b.lineJoin = "round"; b.lineCap = "round";
        const lw = Math.max(1.2, Math.min(3.2, z * 0.12)) / z;
        for (const [civ, path] of this.borders) { const c = this.civColor.get(civ) ?? [220, 220, 220]; b.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.95)`; b.lineWidth = lw * 1.6; b.stroke(path); }
        b.strokeStyle = "rgba(25,18,12,0.5)"; b.lineWidth = lw * 0.45;
        for (const path of this.borders.values()) b.stroke(path);
      }
      // виньетка («миниатюра под стеклом») — запекается в неподвижный слой, а не рисуется каждый кадр
      b.setTransform(1, 0, 0, 1, 0, 0); b.globalAlpha = 1;
      if (!this.vignette) { const v = b.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.75); v.addColorStop(0, "rgba(5,8,12,0)"); v.addColorStop(1, "rgba(5,8,12,0.4)"); this.vignette = v; }
      b.fillStyle = this.vignette; b.fillRect(0, 0, W, H);
      g.drawImage(bc, 0, 0);
      this.baseKey = pending ? "" : key;
    }
    const s = this.snap;
    if (s) {
      const inView = (x: number, y: number, m = 2) => x >= vx0 - m && x <= vx1 + m && y >= vy0 - m && y <= vy1 + m;
      const P = (x: number, y: number): [number, number] => [ox + (x + 0.5) * z, oy + (y + 0.5) * z];
      g.globalAlpha = this.reveal;
      if (this.quality >= 1) this.drawRoutes(g, s, P, z);
      this.drawRuins(g, s, P, z, inView);
      this.drawDisasters(g, s, P, z);
      this.drawSettlements(g, s, P, z, inView);
      this.drawArmies(g, s, P, z);
      this.drawLabels(g, s, P, z, inView);
      if (this.quality >= 1) this.drawClouds(g, W, H, z);
      this.drawPulses(g, P, z);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    const ft = performance.now() - t0;
    this.frameTimes.push(ft); if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    if (this.frameTimes.length === 90) {
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / 90;
      if ((avg > 22 || this.fps < 24) && this.quality > 0) { this.quality--; this.resize(); console.info("[genesis] качество снижено до", this.quality, "fps", Math.round(this.fps)); }
      else if (avg < 6 && this.quality < 2 && this.fps > 56) { this.quality++; this.resize(); }
      this.frameTimes = [];
    }
  }

  private drawRoutes(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number): void {
    if (z < 4 || z > 30) return;
    const r = s.routes;
    const fade = z > 18 ? (30 - z) / 12 : 1;
    g.lineWidth = Math.max(1, Math.min(2.2, z * 0.07));
    g.setLineDash([z * 0.18, z * 0.32]);
    g.lineDashOffset = -this.t * z * 0.8;
    g.lineCap = "round";
    for (let i = 0; i < r.length; i += 6) {
      const [ax, ay] = P(r[i]!, r[i + 1]!), [bx, by] = P(r[i + 2]!, r[i + 3]!);
      if (r[i + 4]! < 0.6) continue;
      g.strokeStyle = r[i + 5] ? `rgba(200,232,255,${0.4 * fade})` : `rgba(255,232,180,${0.42 * fade})`;
      g.beginPath(); g.moveTo(ax, ay);
      g.quadraticCurveTo((ax + bx) / 2 + (by - ay) * 0.12, (ay + by) / 2 - (bx - ax) * 0.12, bx, by);
      g.stroke();
    }
    g.setLineDash([]);
  }

  private drawRuins(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number, inView: (x: number, y: number) => boolean): void {
    if (z < 5) return;
    g.textAlign = "center"; g.textBaseline = "top";
    for (const r of s.ruins) {
      if (!inView(r.x, r.y)) continue;
      const [x, y] = P(r.x, r.y);
      const sz = Math.min(18, z * (0.45 + r.tier * 0.07));
      g.fillStyle = r.found ? "rgba(230,220,196,0.9)" : "rgba(170,160,140,0.4)";
      g.strokeStyle = "rgba(30,25,20,0.5)"; g.lineWidth = 1;
      for (let k = -1; k <= 1; k++) { const hh = sz * (k === 0 ? 0.7 : 0.45); g.fillRect(x + k * sz * 0.34 - sz * 0.07, y - hh * 0.5, sz * 0.14, hh); }
      g.fillRect(x - sz * 0.5, y + sz * 0.22, sz, sz * 0.1);
      if (r.found && z > 14) { g.font = `italic 11px Georgia, serif`; g.fillStyle = "rgba(240,232,214,0.85)"; g.fillText("руины " + r.name, x, y + sz * 0.45); }
    }
  }

  private drawSettlements(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number, inView: (x: number, y: number) => boolean): void {
    const glow = glowSprite();
    const list = s.settlements.filter((t) => inView(t.x, t.y)).sort((a, b) => a.y - b.y);
    const icons = z >= 9;
    for (const t of list) {
      const [x, y] = P(t.x, t.y);
      const col = this.civColor.get(t.civ) ?? [255, 255, 255];
      const flick = 0.82 + 0.18 * Math.sin(this.t * 5 + t.id * 1.7);
      if (!icons) {
        // мелкий масштаб: огоньки, крупные города — «жемчужины» с цветом державы
        if (z < 6 && t.tier < 1 && !t.cap) continue;
        const gs = Math.max(5, Math.min(30, (4 + t.tier * 3) * Math.sqrt(z / 4)));
        g.globalAlpha = this.reveal * (0.45 + t.tier * 0.08) * flick;
        g.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
        g.globalAlpha = this.reveal;
        if (t.tier >= 3 || t.cap) {
          const r = Math.max(1.8, Math.min(5, z * (0.16 + t.tier * 0.04)));
          g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; g.strokeStyle = "rgba(255,250,235,0.95)"; g.lineWidth = t.cap ? 1.6 : 1;
          g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
          if (t.cap) { g.strokeStyle = "rgba(255,236,190,0.7)"; g.lineWidth = 1; g.beginPath(); g.arc(x, y, r + 2.4, 0, Math.PI * 2); g.stroke(); }
        }
        continue;
      }
      const px = Math.min(120, z * (0.95 + t.tier * 0.32)) * (t.cap ? 1.12 : 1);
      // основание в цвете державы — видно, кому принадлежит город
      g.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.45)`;
      g.beginPath(); g.ellipse(x, y + px * 0.08, px * 0.42, px * 0.15, 0, 0, Math.PI * 2); g.fill();
      if (t.tier === 0) { g.globalAlpha = this.reveal * 0.5 * flick; g.drawImage(glow, x - px * 0.4, y - px * 0.3, px * 0.8, px * 0.8); g.globalAlpha = this.reveal; }
      const spr = settlementSprite(t.tier, s.era, t.walls, px * this.dpr, t.id);
      g.drawImage(spr, x - px / 2, y - px * 0.68, px, px);
      if (t.cap) this.banner(g, x + px * 0.05, y - px * 0.62, col, px);
      if (t.plague) { g.fillStyle = "rgba(120,70,150,0.28)"; g.beginPath(); g.arc(x, y - px * 0.25, px * 0.55, 0, Math.PI * 2); g.fill(); }
      if (this.selected && this.selected.kind === "city" && this.selected.id === t.id) {
        g.strokeStyle = "rgba(255,236,180,0.95)"; g.lineWidth = 1.6;
        g.beginPath(); g.ellipse(x, y + px * 0.08, px * 0.58 + Math.sin(this.t * 4) * 1.5, px * 0.22, 0, 0, Math.PI * 2); g.stroke();
      }
    }
  }
  private banner(g: CanvasRenderingContext2D, x: number, y: number, col: [number, number, number], px: number): void {
    const h = Math.min(16, px * 0.32);
    g.strokeStyle = "#3b2c1c"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y + h * 0.5); g.lineTo(x, y - h); g.stroke();
    const wave = Math.sin(this.t * 3) * h * 0.08;
    g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    g.beginPath(); g.moveTo(x, y - h); g.quadraticCurveTo(x + h * 0.45, y - h * 0.95 + wave, x + h * 0.85, y - h * 0.78 + wave); g.lineTo(x, y - h * 0.52); g.closePath(); g.fill();
    g.strokeStyle = "rgba(255,245,220,0.6)"; g.lineWidth = 0.6; g.stroke();
  }

  private drawArmies(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number): void {
    const prev = new Map((this.prevSnap?.armies ?? []).map((a) => [a.id, a]));
    const f = Math.min(1, (performance.now() - this.snapTime) / 400);
    for (const a of s.armies) {
      const p = prev.get(a.id);
      const ax = p ? p.x + (a.x - p.x) * f : a.x, ay = p ? p.y + (a.y - p.y) * f : a.y;
      const [x, y] = P(ax, ay), [tx, ty] = P(a.tx, a.ty);
      const col = this.civColor.get(a.civ) ?? [255, 80, 80];
      // путь — пунктир со стрелкой
      g.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.75)`; g.lineWidth = Math.max(1.2, Math.min(2.4, z * 0.08));
      g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x, y); g.lineTo(tx, ty); g.stroke(); g.setLineDash([]);
      const r = Math.max(5, Math.min(13, z * 0.32 + Math.log10(a.strength + 10) * 1.2));
      // щит
      g.fillStyle = "rgba(15,10,6,0.35)"; g.beginPath(); g.ellipse(x + 1, y + r * 1.05, r * 0.9, r * 0.3, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; g.strokeStyle = "#f6ecd6"; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(x - r * 0.8, y - r * 0.8); g.lineTo(x + r * 0.8, y - r * 0.8); g.lineTo(x + r * 0.8, y); g.quadraticCurveTo(x + r * 0.7, y + r * 0.8, x, y + r); g.quadraticCurveTo(x - r * 0.7, y + r * 0.8, x - r * 0.8, y); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = "#fff6e0"; g.lineWidth = Math.max(1, r * 0.13); g.lineCap = "round";
      g.beginPath(); g.moveTo(x - r * 0.38, y - r * 0.42); g.lineTo(x + r * 0.38, y + r * 0.38); g.moveTo(x + r * 0.38, y - r * 0.42); g.lineTo(x - r * 0.38, y + r * 0.38); g.stroke();
      if (a.siege) { g.strokeStyle = "rgba(255,110,70,0.85)"; g.lineWidth = 2; g.beginPath(); g.arc(tx, ty, r * 1.8 + Math.sin(this.t * 5) * 2, 0, Math.PI * 2); g.stroke(); }
    }
  }

  private drawDisasters(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number): void {
    for (const d of s.disasters) {
      const [x, y] = P(d.x, d.y);
      const r = Math.max(10, d.r * z);
      const color = d.type === "drought" ? "225,150,60" : d.type === "plague" ? "130,70,160" : d.type === "winter" ? "205,228,255" : d.type === "volcano" ? "205,70,40" : d.type === "locust" ? "170,170,60" : "90,145,215";
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.18 + Math.sin(this.t * 2) * 0.04;
      gr.addColorStop(0, `rgba(${color},${a})`); gr.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (d.type === "volcano" && this.quality >= 1) for (let i = 0; i < 6; i++) {
        const ph = (this.t * 0.4 + i / 6) % 1;
        g.fillStyle = `rgba(70,60,60,${0.45 * (1 - ph)})`; g.beginPath(); g.arc(x + ph * z * 1.5, y - ph * z * 4, z * (0.4 + ph), 0, Math.PI * 2); g.fill();
      }
    }
  }

  private drawLabels(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number, inView: (x: number, y: number, m?: number) => boolean): void {
    const occupied: [number, number, number, number][] = [];
    const free = (x: number, y: number, w: number, h: number) => {
      for (const [a, b, c, d] of occupied) if (x < c && x + w > a && y < d && y + h > b) return false;
      occupied.push([x, y, x + w, y + h]); return true;
    };
    const LS = (v: string) => { if ("letterSpacing" in g) (g as unknown as { letterSpacing: string }).letterSpacing = v; };
    g.textAlign = "center"; g.textBaseline = "middle";
    // названия держав — разрядкой, спокойным шрифтом, по центру владений
    if (z < 12) {
      let shown = 0;
      for (const c of [...s.civs].sort((a, b) => b.area - a.area)) {
        if (c.lx < 0 || c.area < 10 || shown >= 14) continue;
        const size = Math.round(Math.max(10, Math.min(20, Math.sqrt(c.area) * z * 0.11)) * this.dpr / this.dpr);
        if (!inView(c.lx, c.ly, 4)) continue;
        const [x, y] = P(c.lx, c.ly);
        const name = c.title.replace(/^Племя «(.+)»$/, "$1").toUpperCase();
        g.font = `${size}px Georgia, "Times New Roman", serif`;
        LS(`${(size * 0.28).toFixed(1)}px`);
        const tw = g.measureText(name).width;
        if (!free(x - tw / 2, y - size * 0.7, tw, size * 1.4)) { LS("0px"); continue; }
        g.lineWidth = 3; g.strokeStyle = "rgba(20,14,8,0.45)"; g.lineJoin = "round";
        g.strokeText(name, x, y);
        g.fillStyle = "rgba(255,246,226,0.88)"; g.fillText(name, x, y);
        LS("0px");
        shown++;
      }
    }
    // названия городов
    const minTier = z >= 18 ? 0 : z >= 11 ? 1 : z >= 7 ? 3 : 9;
    const list = s.settlements.filter((t) => inView(t.x, t.y) && (t.tier >= minTier || (t.cap && z >= 5))).sort((a, b) => (b.cap ? 1 : 0) - (a.cap ? 1 : 0) || b.pop - a.pop);
    for (const t of list.slice(0, 120)) {
      const [x, y] = P(t.x, t.y);
      const size = t.cap ? 13 : t.tier >= 4 ? 12 : 11;
      g.font = `${t.cap ? 600 : 500} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const tw = g.measureText(t.name).width + 4;
      const ly = y + (z >= 9 ? Math.min(14, z * 0.3) + 6 : 9);
      if (!free(x - tw / 2, ly - size * 0.6, tw, size * 1.2)) continue;
      g.lineWidth = 2.6; g.strokeStyle = "rgba(14,12,10,0.62)"; g.lineJoin = "round"; g.strokeText(t.name, x, ly);
      g.fillStyle = t.cap ? "#ffe6a8" : "#f5efe3"; g.fillText(t.name, x, ly);
    }
  }

  private drawClouds(g: CanvasRenderingContext2D, W: number, H: number, z: number): void {
    const spr = cloudSprites();
    const alpha = Math.max(0, Math.min(0.18, 0.24 - z / 50));
    if (alpha <= 0.02) return;
    g.globalAlpha = alpha * this.reveal;
    for (const c of this.clouds) {
      c.x += c.v * 0.016; if (c.x > 1.3) c.x = -0.3;
      const px = ((c.x - this.cam.x * 0.0015) % 1.6 + 1.6) % 1.6 - 0.3, py = ((c.y - this.cam.y * 0.0015) % 1.4 + 1.4) % 1.4 - 0.2;
      const s = spr[c.k]!, sw = 460 * c.s * this.dpr;
      g.drawImage(s, px * W, py * H, sw, sw / 2);
    }
    g.globalAlpha = this.reveal;
  }

  private drawPulses(g: CanvasRenderingContext2D, P: (x: number, y: number) => [number, number], z: number): void {
    const now = performance.now();
    this.pulses = this.pulses.filter((p) => now - p.t0 < 2400);
    for (const p of this.pulses) {
      const k = (now - p.t0) / 2400;
      const [x, y] = P(p.x - 0.5, p.y - 0.5);
      g.strokeStyle = `rgba(${p.color},${(1 - k) * 0.7})`; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 5 + k * Math.max(26, z * 3), 0, Math.PI * 2); g.stroke();
    }
  }

  settlementAt(sx: number, sy: number): SnapSettlement | null {
    const s = this.snap; if (!s) return null;
    const [wx, wy] = this.cam.toWorld(sx, sy);
    let best: SnapSettlement | null = null, bd = Math.max(1.2, 16 / this.cam.zoom);
    for (const t of s.settlements) { const d = Math.hypot(t.x + 0.5 - wx, t.y + 0.15 - wy); if (d < bd) { bd = d; best = t; } }
    return best;
  }
}
