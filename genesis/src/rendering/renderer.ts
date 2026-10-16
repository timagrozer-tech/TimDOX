import { Camera } from "./camera";
import { buildTerrain, type TerrainLayers } from "./terrain";
import { cloudSprites, glowSprite, settlementSprite } from "./sprites";
import type { Snapshot, StaticWorld, SnapSettlement } from "../workers/protocol";

/**
 * Отрисовка карты на Canvas 2D. Слои: подложка (кэш) → снег по сезону → дороги → владения → торговые пути →
 * руины → поселения → армии → бедствия → подписи → облака → вспышки событий.
 * Рисуем только видимую часть, подписи раскладываем без наложений, качество подстраивается под устройство.
 */
export class Renderer {
  readonly cam = new Camera();
  private ctx: CanvasRenderingContext2D;
  private terrain: TerrainLayers | null = null;
  private territory: HTMLCanvasElement = document.createElement("canvas");
  private roads: HTMLCanvasElement = document.createElement("canvas");
  world: StaticWorld | null = null;
  snap: Snapshot | null = null;
  private prevSnap: Snapshot | null = null;
  private snapTime = 0;
  private owner: Int16Array | null = null;
  civColor = new Map<number, [number, number, number]>();
  dpr = 1;
  quality = 2;                  // 2 — всё, 1 — без облаков и части эффектов, 0 — минимум
  private frameTimes: number[] = [];
  pulses: { x: number; y: number; t0: number; color: string }[] = [];
  reveal = 1;                   // 0…1 — проявление карты во вступлении
  selected: { kind: string; id: number } | null = null;
  hover: [number, number] | null = null;
  private clouds: { x: number; y: number; s: number; k: number; v: number }[] = [];
  private t = 0;
  fps = 0;
  private layerVer = 0;
  private baseCache: HTMLCanvasElement = document.createElement("canvas");
  private baseKey = "";

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    for (let i = 0; i < 8; i++) this.clouds.push({ x: Math.random(), y: Math.random(), s: 0.6 + Math.random() * 0.9, k: i % 4, v: 0.004 + Math.random() * 0.006 });
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality >= 2 ? 2 : this.quality === 1 ? 1.25 : 1);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.cam.setViewport(r.width, r.height);
  }

  setWorld(w: StaticWorld): void {
    this.world = w;
    const t0 = performance.now();
    this.terrain = buildTerrain(w);
    console.info(`[genesis] подложка карты ${w.w}×${w.h}: ${Math.round(performance.now() - t0)} мс`);
    this.territory.width = w.w * 2; this.territory.height = w.h * 2;
    this.roads.width = w.w; this.roads.height = w.h;
    this.owner = null;
    this.cam.fit(w.w, w.h);
  }

  setSnapshot(s: Snapshot): void {
    if (s.owner) { this.owner = s.owner; }
    for (const c of s.civs) this.civColor.set(c.id, c.color);
    if (s.owner) { this.paintTerritory(); this.layerVer++; }
    if (s.road) { this.paintRoads(s.road); this.layerVer++; }
    this.prevSnap = this.snap;
    this.snap = s;
    this.snapTime = performance.now();
    for (const e of s.events) if (e.imp >= 3 && e.x >= 0) this.pulses.push({ x: e.x + 0.5, y: e.py + 0.5, t0: performance.now(), color: e.imp >= 4 ? "255,210,120" : "255,255,255" });
    if (this.pulses.length > 40) this.pulses.splice(0, this.pulses.length - 40);
  }

  private paintTerritory(): void {
    const w = this.world!, o = this.owner!;
    const g = this.territory.getContext("2d")!;
    const img = g.createImageData(w.w * 2, w.h * 2), d = img.data;
    const W2 = w.w * 2;
    for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) {
      const i = y * w.w + x, c = o[i]!;
      if (c < 0) continue;
      const col = this.civColor.get(c) ?? [200, 200, 200];
      const edge = (x > 0 && o[i - 1] !== c) || (x < w.w - 1 && o[i + 1] !== c) || (y > 0 && o[i - w.w] !== c) || (y < w.h - 1 && o[i + w.w] !== c);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const p = ((y * 2 + dy) * W2 + x * 2 + dx) * 4;
        // граница — плотнее и темнее, внутри — лёгкая заливка
        if (edge) { d[p] = col[0] * 0.75; d[p + 1] = col[1] * 0.75; d[p + 2] = col[2] * 0.75; d[p + 3] = 170; }
        else { d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = 64; }
      }
    }
    g.putImageData(img, 0, 0);
  }
  private paintRoads(road: Uint8Array): void {
    const w = this.world!;
    const g = this.roads.getContext("2d")!;
    const img = g.createImageData(w.w, w.h), d = img.data;
    for (let i = 0; i < road.length; i++) {
      const v = road[i]!;
      if (!v) continue;
      d[i * 4] = 120; d[i * 4 + 1] = 92; d[i * 4 + 2] = 62; d[i * 4 + 3] = Math.min(150, 25 + v * 0.8);
    }
    g.putImageData(img, 0, 0);
  }

  /** Сезон: 0 — лето … 1 — зима. На большой скорости сезоны не мелькают. */
  season(): number {
    const s = this.snap; if (!s) return 0;
    if (s.speed > 3) return 0.15;
    const phase = ((this.yearFrac() % 1) + 1) % 1;
    return Math.max(0, Math.cos((phase - 0.85) * Math.PI * 2)) ** 1.5;
  }
  yearFrac(): number {
    const s = this.snap; if (!s) return 0;
    const dt = (performance.now() - this.snapTime) / 1000;
    return s.year + Math.min(1, dt * s.speed);
  }

  frame(dt: number): void {
    const t0 = performance.now();
    this.t += dt;
    const g = this.ctx, cam = this.cam, w = this.world;
    const W = this.canvas.width, H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#0b1622"; g.fillRect(0, 0, W, H);
    if (!w || !this.terrain) return;
    cam.update(dt); cam.clamp(w.w, w.h);
    const z = cam.zoom * this.dpr;
    const ox = W / 2 - cam.x * z, oy = H / 2 - cam.y * z;
    const k = this.terrain.k;
    // неподвижные слои (подложка, снег, дороги, владения) — одной картинкой, пока камера стоит и границы не менялись
    const sn = this.season();
    const key = `${cam.x.toFixed(3)}:${cam.y.toFixed(3)}:${cam.zoom.toFixed(4)}:${this.layerVer}:${Math.round(sn * 20)}:${this.reveal}:${W}x${H}`;
    if (key === this.baseKey) g.drawImage(this.baseCache, 0, 0);
    else {
      const bc = this.baseCache;
      if (bc.width !== W || bc.height !== H) { bc.width = W; bc.height = H; }
      const b = bc.getContext("2d")!;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.fillStyle = "#0b1622"; b.fillRect(0, 0, W, H);
      b.globalAlpha = this.reveal;
      b.imageSmoothingEnabled = true; b.imageSmoothingQuality = cam.zoom > k ? "low" : "high";
      b.setTransform(z / k, 0, 0, z / k, ox, oy);
      b.drawImage(this.terrain.base as CanvasImageSource, 0, 0);
      b.setTransform(z, 0, 0, z, ox, oy);
      if (sn > 0.02) { b.globalAlpha = this.reveal * sn * 0.85; b.drawImage(this.terrain.snow as CanvasImageSource, 0, 0, w.w, w.h); b.globalAlpha = this.reveal; }
      b.drawImage(this.roads, 0, 0, w.w, w.h);
      if (cam.zoom > 9) b.globalAlpha = this.reveal * 0.6;
      b.drawImage(this.territory, 0, 0, w.w, w.h);
      g.drawImage(bc, 0, 0);
      this.baseKey = key;
    }
    const s = this.snap;
    if (!s) return;
    // видимая область (клетки)
    const [vx0, vy0] = cam.toWorld(0, 0), [vx1, vy1] = cam.toWorld(cam.vw, cam.vh);
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
    g.globalAlpha = 1;
    // замер кадра — адаптивное качество
    const ft = performance.now() - t0;
    this.frameTimes.push(ft); if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
    // качество снижаем и по времени кадра, и по реальной частоте кадров (растеризация идёт вне JS)
    if (this.frameTimes.length === 90) {
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / 90;
      if ((avg > 22 || this.fps < 24) && this.quality > 0) { this.quality--; this.frameTimes = []; this.resize(); console.info("[genesis] качество снижено до", this.quality, "fps", Math.round(this.fps)); }
      else if (avg < 6 && this.quality < 2 && this.fps > 55) { this.quality++; this.frameTimes = []; this.resize(); }
      else this.frameTimes = [];
    }
  }

  private drawRoutes(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number): void {
    if (z < 3) return;
    const r = s.routes;
    g.lineWidth = Math.max(1, z * 0.12);
    g.setLineDash([z * 0.5, z * 0.5]);
    g.lineDashOffset = -this.t * z * 2;
    for (let i = 0; i < r.length; i += 6) {
      const [ax, ay] = P(r[i]!, r[i + 1]!), [bx, by] = P(r[i + 2]!, r[i + 3]!);
      g.strokeStyle = r[i + 5] ? "rgba(180,220,255,0.55)" : "rgba(255,226,160,0.55)";
      g.beginPath(); g.moveTo(ax, ay);
      if (r[i + 5]) g.quadraticCurveTo((ax + bx) / 2 + (by - ay) * 0.15, (ay + by) / 2 - (bx - ax) * 0.15, bx, by); else g.lineTo(bx, by);
      g.stroke();
    }
    g.setLineDash([]);
  }

  private drawRuins(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number, inView: (x: number, y: number) => boolean): void {
    if (z < 2.5) return;
    for (const r of s.ruins) {
      if (!inView(r.x, r.y)) continue;
      const [x, y] = P(r.x, r.y);
      const sz = Math.min(20, z * (0.6 + r.tier * 0.12));
      g.fillStyle = r.found ? "rgba(225,215,190,0.9)" : "rgba(160,150,130,0.45)";
      // обломки колонн
      for (let k = -1; k <= 1; k++) g.fillRect(x + k * sz * 0.35 - sz * 0.08, y - sz * (0.2 + (k === 0 ? 0.3 : 0.1)), sz * 0.16, sz * (0.4 + (k === 0 ? 0.3 : 0.1)));
      g.fillRect(x - sz * 0.5, y + sz * 0.2, sz, sz * 0.12);
      if (r.found && z > 10) { g.font = `italic ${Math.min(13, z * 0.5)}px Georgia, serif`; g.textAlign = "center"; g.fillStyle = "rgba(240,230,210,0.85)"; g.fillText("руины " + r.name, x, y + sz * 0.9); }
    }
  }

  private drawSettlements(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number, inView: (x: number, y: number) => boolean): void {
    const glow = glowSprite();
    const flick = (id: number) => 0.8 + 0.2 * Math.sin(this.t * 6 + id * 1.7);
    const list = s.settlements.filter((t) => inView(t.x, t.y)).sort((a, b) => a.y - b.y);
    const detail = z >= 7;
    for (const t of list) {
      const [x, y] = P(t.x, t.y);
      // огонёк — виден на любом масштабе
      const gs = Math.max(6, Math.min(70, (6 + t.tier * 5) * Math.sqrt(z / 4)));
      g.globalAlpha = this.reveal * (detail ? 0.35 : 0.85) * flick(t.id);
      g.drawImage(glow, x - gs / 2, y - gs / 2, gs, gs);
      g.globalAlpha = this.reveal;
      if (detail) {
        const px = Math.min(90, z * (1.6 + t.tier * 0.55));
        const spr = settlementSprite(t.tier, s.era, t.walls, px * this.dpr);
        g.drawImage(spr, x - px / 2, y - px * 0.72, px, px);
        if (t.cap) this.banner(g, x, y - px * 0.72, t.civ, z);
        if (t.plague) { g.fillStyle = "rgba(120,60,140,0.35)"; g.beginPath(); g.arc(x, y - px * 0.3, px * 0.55, 0, Math.PI * 2); g.fill(); }
      } else if (t.tier >= 3 || t.cap) {
        const col = this.civColor.get(t.civ) ?? [255, 255, 255];
        const r = Math.max(1.6, z * (0.18 + t.tier * 0.05));
        g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 1;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke();
        if (t.cap) { g.fillStyle = "#fff"; g.beginPath(); g.arc(x, y, r * 0.4, 0, Math.PI * 2); g.fill(); }
      }
      if (this.selected && this.selected.kind === "city" && this.selected.id === t.id) {
        g.strokeStyle = "rgba(255,240,180,0.95)"; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, Math.max(10, z * 1.2) + Math.sin(this.t * 4) * 2, 0, Math.PI * 2); g.stroke();
      }
    }
  }
  private banner(g: CanvasRenderingContext2D, x: number, y: number, civ: number, z: number): void {
    const col = this.civColor.get(civ) ?? [255, 255, 255];
    const h = Math.min(18, z * 0.6);
    g.strokeStyle = "#3a2a1a"; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(x, y + h * 0.4); g.lineTo(x, y - h); g.stroke();
    const wave = Math.sin(this.t * 3) * h * 0.08;
    g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
    g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + h * 0.9, y - h * 0.8 + wave); g.lineTo(x, y - h * 0.55); g.closePath(); g.fill();
  }

  private drawArmies(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number): void {
    // плавное движение между снимками
    const prev = new Map((this.prevSnap?.armies ?? []).map((a) => [a.id, a]));
    const f = Math.min(1, (performance.now() - this.snapTime) / 400);
    for (const a of s.armies) {
      const p = prev.get(a.id);
      const ax = p ? p.x + (a.x - p.x) * f : a.x, ay = p ? p.y + (a.y - p.y) * f : a.y;
      const [x, y] = P(ax, ay), [tx, ty] = P(a.tx, a.ty);
      const col = this.civColor.get(a.civ) ?? [255, 80, 80];
      g.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},0.6)`; g.lineWidth = Math.max(1, z * 0.1);
      g.setLineDash([z * 0.3, z * 0.25]);
      g.beginPath(); g.moveTo(x, y); g.lineTo(tx, ty); g.stroke(); g.setLineDash([]);
      const r = Math.max(4, Math.min(16, z * 0.45 + Math.log10(a.strength + 10) * 1.5));
      g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; g.strokeStyle = "#1b1410"; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r * 0.8, y); g.lineTo(x, y + r); g.lineTo(x - r * 0.8, y); g.closePath(); g.fill(); g.stroke();
      // скрещённые мечи
      g.strokeStyle = "#fff"; g.lineWidth = Math.max(1, r * 0.15);
      g.beginPath(); g.moveTo(x - r * 0.4, y - r * 0.4); g.lineTo(x + r * 0.4, y + r * 0.4); g.moveTo(x + r * 0.4, y - r * 0.4); g.lineTo(x - r * 0.4, y + r * 0.4); g.stroke();
      if (a.siege) { g.strokeStyle = "rgba(255,90,60,0.8)"; g.lineWidth = 2; g.beginPath(); g.arc(tx, ty, r * 1.6 + Math.sin(this.t * 5) * 2, 0, Math.PI * 2); g.stroke(); }
    }
  }

  private drawDisasters(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number): void {
    for (const d of s.disasters) {
      const [x, y] = P(d.x, d.y);
      const r = Math.max(8, d.r * z);
      const color = d.type === "drought" ? "230,150,50" : d.type === "plague" ? "130,60,160" : d.type === "winter" ? "200,225,255" : d.type === "volcano" ? "200,60,30" : d.type === "locust" ? "160,170,40" : "90,140,210";
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.22 + Math.sin(this.t * 2) * 0.05;
      gr.addColorStop(0, `rgba(${color},${a})`); gr.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      if (d.type === "volcano" && this.quality >= 1) for (let i = 0; i < 6; i++) {
        const ph = (this.t * 0.4 + i / 6) % 1;
        g.fillStyle = `rgba(70,60,60,${0.5 * (1 - ph)})`; g.beginPath(); g.arc(x + ph * z * 1.5, y - ph * z * 4, z * (0.4 + ph), 0, Math.PI * 2); g.fill();
      }
    }
  }

  private drawLabels(g: CanvasRenderingContext2D, s: Snapshot, P: (x: number, y: number) => [number, number], z: number, inView: (x: number, y: number, m?: number) => boolean): void {
    const occupied: [number, number, number, number][] = [];
    const free = (x: number, y: number, w: number, h: number) => {
      for (const [a, b, c, d] of occupied) if (x < c && x + w > a && y < d && y + h > b) return false;
      occupied.push([x, y, x + w, y + h]); return true;
    };
    g.textAlign = "center"; g.textBaseline = "middle";
    // названия государств — крупно, по центру владений (на мелком масштабе)
    if (z < 14) {
      for (const c of [...s.civs].sort((a, b) => b.area - a.area)) {
        if (c.lx < 0 || c.area < 6) continue;
        const size = Math.max(10, Math.min(30, Math.sqrt(c.area) * z * 0.22));
        if (size < 10 || !inView(c.lx, c.ly, 4)) continue;
        const [x, y] = P(c.lx, c.ly);
        const name = c.title.replace(/^Племя «(.+)»$/, "$1").toUpperCase();
        g.font = `600 ${size}px Georgia, "Times New Roman", serif`;
        const tw = g.measureText(name).width * 1.15;
        if (!free(x - tw / 2, y - size / 2, tw, size)) continue;
        g.lineWidth = 3; g.strokeStyle = "rgba(15,12,8,0.55)";
        if ("letterSpacing" in g) (g as unknown as { letterSpacing: string }).letterSpacing = `${size * 0.12}px`;
        g.strokeText(name, x, y);
        g.fillStyle = "rgba(255,248,232,0.92)"; g.fillText(name, x, y);
        if ("letterSpacing" in g) (g as unknown as { letterSpacing: string }).letterSpacing = "0px";
      }
    }
    // названия городов (крупные — раньше)
    if (z >= 5) {
      const list = s.settlements.filter((t) => inView(t.x, t.y) && (t.tier >= 3 || t.cap || (z >= 9 && t.tier >= 1) || z >= 16)).sort((a, b) => (b.cap ? 1 : 0) - (a.cap ? 1 : 0) || b.pop - a.pop);
      for (const t of list.slice(0, 160)) {
        const [x, y] = P(t.x, t.y);
        const size = Math.max(10, Math.min(15, 9 + t.tier + (t.cap ? 2 : 0)));
        g.font = `${t.cap ? "700" : "500"} ${size}px system-ui, sans-serif`;
        const label = t.name;
        const tw = g.measureText(label).width + 6;
        const ly = y + (z >= 7 ? Math.min(14, z * 0.5) : size);
        if (!free(x - tw / 2, ly - size / 2, tw, size)) continue;
        g.lineWidth = 3; g.strokeStyle = "rgba(10,10,10,0.6)"; g.strokeText(label, x, ly);
        g.fillStyle = t.cap ? "#ffe9b0" : "#f4efe6"; g.fillText(label, x, ly);
      }
    }
  }

  private drawClouds(g: CanvasRenderingContext2D, W: number, H: number, z: number): void {
    const spr = cloudSprites();
    const alpha = Math.max(0, Math.min(0.22, 0.3 - z / 40));
    if (alpha <= 0.02) return;
    g.globalAlpha = alpha * this.reveal;
    for (const c of this.clouds) {
      c.x += c.v * 0.016; if (c.x > 1.3) c.x = -0.3;
      // облака плывут с параллаксом относительно карты
      const px = ((c.x - this.cam.x * 0.0015) % 1.6 + 1.6) % 1.6 - 0.3, py = ((c.y - this.cam.y * 0.0015) % 1.4 + 1.4) % 1.4 - 0.2;
      const s = spr[c.k]!, sw = 420 * c.s * this.dpr;
      g.drawImage(s, px * W, py * H, sw, sw / 2);
    }
    g.globalAlpha = this.reveal;
  }

  private drawPulses(g: CanvasRenderingContext2D, P: (x: number, y: number) => [number, number], z: number): void {
    const now = performance.now();
    this.pulses = this.pulses.filter((p) => now - p.t0 < 2600);
    for (const p of this.pulses) {
      const k = (now - p.t0) / 2600;
      const [x, y] = P(p.x - 0.5, p.y - 0.5);
      g.strokeStyle = `rgba(${p.color},${(1 - k) * 0.85})`; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 6 + k * Math.max(30, z * 4), 0, Math.PI * 2); g.stroke();
    }
  }

  /** Поселение под точкой экрана (по снимку — мгновенно, без запроса в поток симуляции) */
  settlementAt(sx: number, sy: number): SnapSettlement | null {
    const s = this.snap; if (!s) return null;
    const [wx, wy] = this.cam.toWorld(sx, sy);
    let best: SnapSettlement | null = null, bd = Math.max(1.2, 14 / this.cam.zoom);
    for (const t of s.settlements) { const d = Math.hypot(t.x + 0.5 - wx, t.y + 0.5 - wy); if (d < bd) { bd = d; best = t; } }
    return best;
  }
}
