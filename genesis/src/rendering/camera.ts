/** Камера карты: положение в клетках и масштаб (пикселей экрана на клетку). Плавные переходы — через цель. */
export class Camera {
  x = 0; y = 0; zoom = 4;
  tx = 0; ty = 0; tzoom = 4;
  minZoom = 1; maxZoom = 48;
  vw = 1; vh = 1;

  setViewport(w: number, h: number): void { this.vw = w; this.vh = h; }
  fit(mapW: number, mapH: number): void {
    this.minZoom = Math.min(this.vw / mapW, this.vh / mapH) * 0.9;
    const fit = Math.min(this.vw / mapW, this.vh / mapH) * 0.98;
    // на вертикальном экране телефона карта занимает больше высоты (её можно двигать пальцем)
    this.zoom = this.tzoom = this.vh > this.vw * 1.2 ? Math.max(fit, (this.vh * 0.82) / mapH) : Math.max(this.vw / mapW, this.vh / mapH);
    this.minZoom = Math.min(this.vw / mapW, this.vh / mapH) * 0.98;
    this.x = this.tx = mapW / 2; this.y = this.ty = mapH / 2;
  }
  /** экран → клетки */
  toWorld(sx: number, sy: number): [number, number] { return [this.x + (sx - this.vw / 2) / this.zoom, this.y + (sy - this.vh / 2) / this.zoom]; }
  toScreen(wx: number, wy: number): [number, number] { return [(wx - this.x) * this.zoom + this.vw / 2, (wy - this.y) * this.zoom + this.vh / 2]; }
  panBy(dxPx: number, dyPx: number): void { this.x -= dxPx / this.zoom; this.y -= dyPx / this.zoom; this.tx = this.x; this.ty = this.y; }
  /** масштаб вокруг точки экрана (колёсико, щипок) */
  zoomAt(factor: number, sx: number, sy: number, smooth = false): void {
    const [wx, wy] = this.toWorld(sx, sy);
    const nz = Math.max(this.minZoom, Math.min(this.maxZoom, (smooth ? this.tzoom : this.zoom) * factor));
    // точка под курсором остаётся на месте
    const nx = wx - (sx - this.vw / 2) / nz, ny = wy - (sy - this.vh / 2) / nz;
    if (smooth) { this.tzoom = nz; this.tx = nx; this.ty = ny; } else { this.zoom = this.tzoom = nz; this.x = this.tx = nx; this.y = this.ty = ny; }
  }
  flyTo(wx: number, wy: number, zoom?: number): void { this.tx = wx; this.ty = wy; if (zoom) this.tzoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom)); }
  clamp(mapW: number, mapH: number): void {
    const mx = this.vw / this.zoom / 2, my = this.vh / this.zoom / 2;
    const cx = (a: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, a)));
    this.x = cx(this.x, mx, mapW - mx); this.y = cx(this.y, my, mapH - my);
    this.tx = cx(this.tx, mx, mapW - mx); this.ty = cx(this.ty, my, mapH - my);
  }
  /** плавное приближение к цели; true — если ещё двигаемся */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 8);
    const moving = Math.abs(this.tx - this.x) > 0.01 || Math.abs(this.ty - this.y) > 0.01 || Math.abs(this.tzoom - this.zoom) > 0.001;
    if (!moving) return false;
    this.x += (this.tx - this.x) * k; this.y += (this.ty - this.y) * k;
    this.zoom *= Math.pow(this.tzoom / this.zoom, k);
    return true;
  }
}
