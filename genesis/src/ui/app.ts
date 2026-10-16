import { Renderer } from "../rendering/renderer";
import { h, $ } from "./dom";
import type { FromWorker, Snapshot, ToWorker, SnapEvent } from "../workers/protocol";
import type { Article, Kind, Link } from "../encyclopedia/articles";
import type { WorldSettings, WorldState } from "../simulation/types";
import { DEFAULT_SETTINGS, TOOLS, type Tool } from "../simulation/sim";
import { deleteWorld, listWorlds, loadWorld, saveWorld, type SaveMeta } from "../storage/db";
import { compress, decompress, fromJSON, toJSON } from "../storage/saveFormat";
import { GOV_NAMES } from "../simulation/types";

declare const __GENESIS_WORKER__: string | undefined;

function createWorker(): Worker {
  if (typeof __GENESIS_WORKER__ === "string") return new Worker(__GENESIS_WORKER__, { type: "module" });
  return new Worker(new URL("../workers/sim.worker.ts", import.meta.url), { type: "module" });
}

const fmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " млн" : n >= 1e4 ? Math.round(n / 1000) + " тыс." : Math.round(n).toLocaleString("ru-RU"));
const randomSeed = () => Math.random().toString(36).slice(2, 8);

/**
 * Интерфейс GENESIS: связывает поток симуляции, отрисовку, ввод (мышь, касания, клавиатура),
 * панели (хроника, энциклопедия, режим Творца, миры) и сохранения.
 */
export class App {
  private worker = createWorker();
  private r: Renderer;
  private req = 0;
  private waiters = new Map<number, (m: FromWorker) => void>();
  private speed = 1;
  private lastSpeed = 6;
  private snap: Snapshot | null = null;
  private meta: SaveMeta | null = null;
  private tool: Tool | null = null;
  private history: { kind: Kind; id: number }[] = [];
  private panelMode: string | null = null;
  private lastAutosave = performance.now();
  private toastsShown = 0;
  private introDone = false;
  private firstEvent = true;

  constructor() {
    this.r = new Renderer($<HTMLCanvasElement>("map"));
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.toast("⚠", "Ошибка симуляции: " + e.message, 5);
    addEventListener("resize", () => this.r.resize());
    this.r.resize();
    this.bindInput();
    this.bindUI();
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.1, (t - last) / 1000); last = t;
      if (!document.hidden) this.r.frame(dt);
      this.tickUI();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    // фоновая вкладка — симуляция на паузе (экономим батарею), при возврате продолжаем
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { this.autosave(true); this.send({ type: "speed", yearsPerSec: 0 }); }
      else this.send({ type: "speed", yearsPerSec: this.speed });
    });
    addEventListener("pagehide", () => this.autosave(true));
    this.start();
  }

  // ---------------------------------------------------------------- связь с потоком
  private send(m: ToWorker): void { this.worker.postMessage(m); }
  private ask<T extends FromWorker>(m: ToWorker & { req: number }): Promise<T> {
    return new Promise((res) => { this.waiters.set(m.req, res as (x: FromWorker) => void); this.send(m); });
  }
  private onMessage(m: FromWorker): void {
    if ("req" in m && this.waiters.has(m.req)) { this.waiters.get(m.req)!(m); this.waiters.delete(m.req); return; }
    switch (m.type) {
      case "world": this.r.setWorld(m.world); $("worldName").textContent = m.world.name; break;
      case "snap": this.onSnap(m.snap); break;
      case "toast": this.toast("☄", m.text, 4); break;
      case "error": console.error(m.message); this.toast("⚠", "Ошибка: " + m.message.split("\n")[0], 5); break;
      default: break;
    }
  }

  private onSnap(s: Snapshot): void {
    this.snap = s;
    this.r.setSnapshot(s);
    $("year").textContent = String(s.year);
    $("era").textContent = s.eraName;
    $("stats").textContent = `${s.stats.states} государств · ${s.stats.cities} поселений · ${fmt(s.stats.pop)} жителей · войн: ${s.stats.wars} · ${s.tickMs.toFixed(1)} мс/год`;
    for (const e of s.events) {
      if (e.imp >= 4 || (this.firstEvent && e.imp >= 2 && this.introDone)) {
        this.toast(e.icon, e.text, e.imp, e);
        this.firstEvent = false;
      }
    }
    if (this.panelMode === "chronicle" && s.events.length) this.refreshChronicle(true);
    if (performance.now() - this.lastAutosave > 120000 || (this.meta && this.meta.year === 0 && s.year > 20)) this.autosave();
  }

  // ---------------------------------------------------------------- запуск
  private async start(): Promise<void> {
    let metas: SaveMeta[] = [];
    try { metas = await listWorlds(); } catch { /* IndexedDB недоступна (приватный режим) */ }
    const last = metas[0];
    if (last) {
      const st = await loadWorld(last.id).catch(() => null);
      if (st) { this.meta = last; this.send({ type: "load", state: st }); this.setSpeed(0); this.intro(false); this.toast("🌍", `Мир «${last.name}» восстановлен — ${last.year} год. Нажмите ▶, чтобы время пошло.`, 3); return; }
    }
    // первый запуск — сразу новый мир с эффектным вступлением
    this.newWorld({ ...DEFAULT_SETTINGS, name: "Первый мир", seed: randomSeed() }, true);
  }

  private newWorld(settings: WorldSettings, intro = false): void {
    this.meta = { id: "w" + Date.now().toString(36), name: settings.name, year: 0, era: "", savedAt: Date.now(), seed: settings.seed, size: settings.size, states: settings.tribes, auto: true };
    this.r.reveal = intro ? 0 : 1;
    this.send({ type: "new", settings });
    this.setSpeed(intro ? 0 : 1);
    this.intro(intro);
    this.closePanel();
  }

  private intro(full: boolean): void {
    const el = $("intro");
    if (!full) { el.classList.add("gone"); setTimeout(() => el.hidden = true, 1700); this.r.reveal = 1; this.introDone = true; return; }
    // тёмный экран → название → проступает карта → загораются огни → время идёт → первое событие → подсказка
    setTimeout(() => el.classList.add("gone"), 2600);
    setTimeout(() => { el.hidden = true; }, 4300);
    const t0 = performance.now() + 2600;
    const reveal = () => { const k = Math.min(1, (performance.now() - t0) / 2200); this.r.reveal = Math.max(0, k); if (k < 1) requestAnimationFrame(reveal); };
    requestAnimationFrame(reveal);
    setTimeout(() => { this.introDone = true; this.setSpeed(1); }, 5200);
    setTimeout(() => {
      const tip = h("div.hint-tip", "Нажмите на огонёк поселения — узнаете его имя, население и историю");
      $("app").append(tip);
      setTimeout(() => tip.remove(), 6500);
      $("map").addEventListener("pointerdown", () => tip.remove(), { once: true });
    }, 7500);
  }

  // ---------------------------------------------------------------- время
  private setSpeed(v: number): void {
    if (v > 0) this.lastSpeed = v;
    this.speed = v;
    this.send({ type: "speed", yearsPerSec: v });
    document.querySelectorAll<HTMLButtonElement>(".hud-speed button").forEach((b) => b.classList.toggle("on", +b.dataset.speed! === v));
  }

  // ---------------------------------------------------------------- ввод
  private bindInput(): void {
    const cv = $<HTMLCanvasElement>("map");
    const pts = new Map<number, { x: number; y: number }>();
    let moved = 0, pinch0 = 0, down = { x: 0, y: 0, t: 0 }, lastTap = 0;
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = 0; down = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a!.x - b!.x, a!.y - b!.y); }
    });
    cv.addEventListener("pointermove", (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 1) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 4) { this.r.cam.panBy(dx, dy); cv.classList.add("dragging"); }
      } else if (pts.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (pinch0 > 0) this.r.cam.zoomAt(d / pinch0, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        pinch0 = d; moved = 99;
        return;
      }
      p.x = e.clientX; p.y = e.clientY;
    });
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      cv.classList.remove("dragging");
      if (pts.size === 0 && moved < 8 && performance.now() - down.t < 500) {
        const now = performance.now();
        if (now - lastTap < 300) { this.r.cam.zoomAt(2, e.clientX, e.clientY, true); lastTap = 0; return; }
        lastTap = now;
        this.tap(e.clientX, e.clientY);
      }
      if (pts.size < 2) pinch0 = 0;
    };
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", (e) => { e.preventDefault(); this.r.cam.zoomAt(Math.pow(1.0018, -e.deltaY), e.clientX, e.clientY, true); }, { passive: false });
    addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      const c = this.r.cam, step = 80;
      switch (e.key) {
        case " ": e.preventDefault(); this.setSpeed(this.speed ? 0 : this.lastSpeed); break;
        case "ArrowLeft": case "a": c.panBy(step, 0); break;
        case "ArrowRight": case "d": c.panBy(-step, 0); break;
        case "ArrowUp": case "w": c.panBy(0, step); break;
        case "ArrowDown": case "s": c.panBy(0, -step); break;
        case "+": case "=": c.zoomAt(1.4, c.vw / 2, c.vh / 2, true); break;
        case "-": c.zoomAt(1 / 1.4, c.vw / 2, c.vh / 2, true); break;
        case "1": case "2": case "3": case "4": this.setSpeed([1, 6, 25, 100][+e.key - 1]!); break;
        case "Escape": this.closePanel(); this.hideCard(); this.setTool(null); break;
        case "c": this.openPanel("chronicle"); break;
        case "e": this.openPanel("encyclopedia"); break;
        default: break;
      }
    });
  }

  private async tap(sx: number, sy: number): Promise<void> {
    const [wx, wy] = this.r.cam.toWorld(sx, sy);
    if (this.tool) { this.send({ type: "intervene", tool: this.tool, x: Math.floor(wx), y: Math.floor(wy) }); return; }
    const local = this.r.settlementAt(sx, sy);
    if (local) { this.showCard("city", local.id); return; }
    const m = await this.ask<Extract<FromWorker, { type: "pick" }>>({ type: "pick", req: ++this.req, x: wx - 0.5, y: wy - 0.5 });
    if (m.hit) this.showCard(m.hit.kind, m.hit.id); else this.hideCard();
  }

  // ---------------------------------------------------------------- карточка
  private async showCard(kind: Kind, id: number): Promise<void> {
    const m = await this.ask<Extract<FromWorker, { type: "article" }>>({ type: "article", req: ++this.req, kind, id });
    const a = m.article;
    if (!a) return;
    this.r.selected = { kind, id };
    const card = $("card");
    const last = a.timeline.slice(-2).reverse();
    card.replaceChildren(
      h("h3", a.color ? h("span.sw", { style: { background: `rgb(${a.color.join(",")})` } }) : null, a.title),
      h("div.sub", a.subtitle),
      ...a.facts.slice(1, 4).map(([k, v]) => h("div.sub", `${k}: ${v}`)),
      ...last.map((e) => h("div.ev", `${e.icon} ${e.y} — ${e.text}`)),
      h("div.row", h("button.btn.primary", { onclick: () => { this.hideCard(); this.openArticle(kind, id); } }, "История и подробности"), h("button.btn", { onclick: () => this.hideCard() }, "Закрыть")),
    );
    card.hidden = false;
  }
  private hideCard(): void { $("card").hidden = true; this.r.selected = null; }

  // ---------------------------------------------------------------- панели
  private bindUI(): void {
    document.querySelectorAll<HTMLButtonElement>(".hud-speed button").forEach((b) => b.addEventListener("click", () => this.setSpeed(+b.dataset.speed!)));
    document.querySelectorAll<HTMLButtonElement>(".dock button").forEach((b) => b.addEventListener("click", () => {
      const what = b.dataset.open!;
      if (what === "creator") { this.toggleCreator(); return; }
      if (this.panelMode === what) this.closePanel(); else this.openPanel(what);
    }));
    $("panelClose").addEventListener("click", () => this.closePanel());
    $("panelBack").addEventListener("click", () => { this.history.pop(); const prev = this.history.pop(); if (prev) this.openArticle(prev.kind, prev.id); else this.openPanel("encyclopedia"); });
  }
  private openPanel(mode: string): void {
    this.panelMode = mode;
    this.hideCard();
    $("panel").hidden = false;
    $("creator").hidden = true; this.setTool(null);
    document.querySelectorAll<HTMLButtonElement>(".dock button").forEach((b) => b.classList.toggle("on", b.dataset.open === mode));
    $("panelBack").hidden = true;
    if (mode === "chronicle") this.renderChronicle();
    else if (mode === "encyclopedia") { this.history = []; this.renderIndex(); }
    else if (mode === "worlds") this.renderWorlds();
    else if (mode === "new") this.renderNewWorld();
  }
  private closePanel(): void {
    this.panelMode = null; $("panel").hidden = true;
    document.querySelectorAll<HTMLButtonElement>(".dock button").forEach((b) => b.classList.remove("on"));
  }
  private setTitle(t: string): void { $("panelTitle").textContent = t; }
  private body(...kids: (Node | string)[]): void { $("panelBody").replaceChildren(...kids); $("panelBody").scrollTop = 0; }

  // хроника
  private chronMin = 3;
  private chronQuery = "";
  private renderChronicle(): void {
    this.setTitle("Хроника мира");
    const list = h("ul.tl", { id: "chronList" });
    const seg = h("div.seg", ...[[3, "Главное"], [2, "Подробно"], [4, "Только великое"]].map(([v, n]) => h(`button${this.chronMin === v ? ".on" : ""}`, { onclick: () => { this.chronMin = v as number; this.renderChronicle(); } }, n as string)));
    const search = h<HTMLInputElement>("input.search", { type: "search", placeholder: "Поиск: имя, город, год…", value: this.chronQuery });
    search.addEventListener("input", () => { this.chronQuery = search.value; this.refreshChronicle(); });
    this.body(seg, search, list);
    this.refreshChronicle();
  }
  private chronBusy = false;
  private async refreshChronicle(soft = false): Promise<void> {
    if (this.chronBusy) return;
    if (soft && $("panelBody").scrollTop > 40) return; // человек читает — не дёргаем список
    this.chronBusy = true;
    const m = await this.ask<Extract<FromWorker, { type: "chronicle" }>>({ type: "chronicle", req: ++this.req, minImp: this.chronMin, limit: 150, query: this.chronQuery });
    this.chronBusy = false;
    const list = document.getElementById("chronList");
    if (!list) return;
    list.replaceChildren(...m.items.map((e) => this.evRow(e)));
    if (!m.items.length) list.append(h("li", h("span"), h("span"), "Пока ничего — время только начинает свой бег."));
  }
  private evRow(e: SnapEvent): HTMLElement {
    return h(`li.imp${e.imp}`, { onclick: () => { if (e.x >= 0) this.r.cam.flyTo(e.x + 0.5, e.py + 0.5, Math.max(this.r.cam.zoom, 9)); this.openArticle("event", e.id); } },
      h("span.y", String(e.y)), h("span", e.icon), h("span", e.text));
  }

  // энциклопедия
  private async renderIndex(): Promise<void> {
    this.setTitle("Энциклопедия мира");
    const m = await this.ask<Extract<FromWorker, { type: "index" }>>({ type: "index", req: ++this.req });
    const groups = Object.entries(m.index).map(([name, links], i) => {
      const d = h("details.idx-group", h("summary", `${name} (${links.length})`), h("div.links", ...links.slice(0, 200).map((l) => this.linkBtn(l))));
      if (i < 2) (d as HTMLDetailsElement).open = true;
      return d;
    });
    this.body(h("p.sub2", "Статьи пишутся сами — из того, что на самом деле произошло в этом мире."), ...groups);
  }
  private linkBtn(l: Link): HTMLElement { return h("button.link", { onclick: () => this.openArticle(l.kind, l.id) }, l.name); }

  private async openArticle(kind: Kind, id: number): Promise<void> {
    const m = await this.ask<Extract<FromWorker, { type: "article" }>>({ type: "article", req: ++this.req, kind, id });
    const a = m.article;
    if (!a) return;
    if (this.panelMode !== "article") { this.panelMode = "article"; $("panel").hidden = false; }
    this.history.push({ kind, id });
    $("panelBack").hidden = this.history.length < 2;
    this.setTitle(a.title);
    this.renderArticle(a);
    // карта показывает объект статьи
    const snap = this.snap;
    if (kind === "city" && snap) { const s = snap.settlements.find((x) => x.id === id); if (s) { this.r.cam.flyTo(s.x + 0.5, s.y + 0.5, Math.max(this.r.cam.zoom, 10)); this.r.selected = { kind, id }; } }
    if (kind === "civ" && snap) { const c = snap.civs.find((x) => x.id === id); if (c && c.lx >= 0) this.r.cam.flyTo(c.lx, c.ly); }
  }
  private renderArticle(a: Article): void {
    const kids: (Node | string)[] = [h("p.sub2", a.subtitle)];
    if (a.facts.length) kids.push(h("dl.facts", ...a.facts.flatMap(([k, v]) => [h("dt", k), h("dd", v)])));
    for (const p of a.text) kids.push(h("p", p));
    if (a.legend) {
      const L = a.legend;
      kids.push(h("h3", "Факт и предание"), h("div.legend",
        h("div.fact", h("span.tag", "Что было на самом деле"), L.fact),
        h("div.myth", h("span.tag", `${L.stage}${L.keepers.length ? ` · помнят: ${L.keepers.join(", ")}` : ""}`),
          L.forgotten ? (L.rediscovered ? "Народ, помнивший это, исчез. Но археологи нашли следы — и история вернулась из небытия." : "Предание забыто: народ, который его хранил, исчез.") : (L.text ?? "Пока это свежая память — без прикрас."))));
    }
    if (a.links.length) kids.push(h("h3", "Связано"), h("div.links", ...a.links.map((l) => this.linkBtn(l))));
    if (a.timeline.length) kids.push(h("h3", "Летопись"), h("ul.tl", ...a.timeline.slice().reverse().map((e) => h("li", { onclick: () => this.openArticle("event", e.id) }, h("span.y", String(e.y)), h("span", e.icon), h("span", e.text)))));
    this.body(...kids);
  }

  // режим Творца
  private toggleCreator(): void {
    const el = $("creator");
    if (!el.hidden) { el.hidden = true; this.setTool(null); document.querySelector('.dock button[data-open="creator"]')?.classList.remove("on"); return; }
    this.closePanel();
    const hint = h("div.hint", "Режим Творца: выберите силу и нажмите на карту");
    el.replaceChildren(hint, ...TOOLS.map((t) => h("button", { "data-tool": t.id, title: t.hint, onclick: () => { this.setTool(this.tool === t.id ? null : t.id); hint.textContent = this.tool ? t.hint + " — нажмите на карту" : "Режим Творца: выберите силу и нажмите на карту"; } }, h("span", t.icon), t.name)));
    el.hidden = false;
    document.querySelector('.dock button[data-open="creator"]')?.classList.add("on");
  }
  private setTool(t: Tool | null): void {
    this.tool = t;
    $("map").classList.toggle("tool", !!t);
    document.querySelectorAll<HTMLButtonElement>(".creator button").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  }

  // миры и сохранения
  private async renderWorlds(): Promise<void> {
    this.setTitle("Миры");
    let metas: SaveMeta[] = [];
    try { metas = await listWorlds(); } catch { /* */ }
    const file = h<HTMLInputElement>("input", { type: "file", accept: ".genesis,.json,.gz", hidden: true });
    file.addEventListener("change", () => this.importFile(file.files?.[0]));
    this.body(
      h("div.row", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" } },
        h("button.btn.primary", { onclick: () => this.openPanel("new") }, "✦ Создать мир"),
        h("button.btn", { onclick: () => this.autosave(false, true) }, "💾 Сохранить"),
        h("button.btn", { onclick: () => this.exportFile() }, "⬇ Экспорт в файл"),
        h("button.btn", { onclick: () => file.click() }, "⬆ Импорт"), file),
      h("div.worlds", ...(metas.length ? metas.map((m) => h("div.world",
        h("b", m.name), h("div.sub2", `${m.year} год · ${m.era || "—"} · ${m.size === "small" ? "малый" : m.size === "large" ? "большой" : "средний"} мир · seed ${m.seed}`),
        h("div.sub2", "Сохранён: " + new Date(m.savedAt).toLocaleString("ru-RU")),
        h("div.row",
          h("button.btn", { onclick: () => this.openSaved(m) }, this.meta?.id === m.id ? "Открыт" : "Открыть"),
          h("button.btn.danger", { onclick: async () => { if (confirm(`Удалить мир «${m.name}» навсегда?`)) { await deleteWorld(m.id); this.renderWorlds(); } } }, "Удалить")))) : [h("p.sub2", "Сохранённых миров пока нет.")])),
      h("h3", "Управление"),
      h("p.sub2", "Пробел — пауза · 1–4 — скорость · стрелки/WASD — карта · колёсико, щипок — масштаб · C — хроника · E — энциклопедия · двойное касание — приблизить"),
    );
  }
  private async openSaved(m: SaveMeta): Promise<void> {
    await this.autosave(true);
    const st = await loadWorld(m.id);
    if (!st) { this.toast("⚠", "Не удалось открыть сохранение", 4); return; }
    this.meta = m;
    this.send({ type: "load", state: st });
    this.setSpeed(0);
    this.closePanel();
    this.toast("🌍", `Мир «${m.name}», ${m.year} год`, 3);
  }

  private renderNewWorld(): void {
    this.setTitle("Создать мир");
    const s: WorldSettings = { ...DEFAULT_SETTINGS, seed: randomSeed(), name: "Мир " + (Math.floor(Math.random() * 900) + 100) };
    const name = h<HTMLInputElement>("input", { type: "text", value: s.name, maxlength: "40" });
    const seed = h<HTMLInputElement>("input", { type: "text", value: s.seed, maxlength: "24" });
    const sel = (opts: [string, string][], v: string) => h<HTMLSelectElement>("select", ...opts.map(([k, n]) => h("option", { value: k, selected: k === v }, n)));
    const size = sel([["small", "Малый (быстрее)"], ["medium", "Средний"], ["large", "Большой"]], s.size);
    const climate = sel([["cold", "Холодный"], ["temperate", "Умеренный"], ["warm", "Тёплый"]], s.climate);
    const era = sel([["0", "Каменный век"], ["1", "Бронзовый век"], ["2", "Железный век"]], "0");
    const range = (min: number, max: number, step: number, v: number) => h<HTMLInputElement>("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(v) });
    const tribes = range(3, 40, 1, s.tribes), res = range(0.3, 2.5, 0.1, s.resources), dis = range(0, 2, 0.1, s.disasters), pace = range(0.5, 2, 0.1, s.pace), land = range(0.25, 0.6, 0.01, s.landRatio);
    const lbl = (t: string, el: HTMLElement, out?: () => string) => { const o = h("span"); const upd = () => { o.textContent = out ? " — " + out() : ""; }; el.addEventListener("input", upd); upd(); return h("label", h("span", t, o), el); };
    this.body(h("div.form",
      lbl("Название мира", name),
      h("div.two", lbl("Seed (зерно мира)", seed), h("label", h("span", " "), h("button.btn", { type: "button", onclick: () => { seed.value = randomSeed(); } }, "🎲 Случайный"))),
      h("div.two", lbl("Размер карты", size), lbl("Климат", climate)),
      lbl("Первых племён", tribes, () => tribes.value),
      lbl("Доля суши", land, () => Math.round(+land.value * 100) + "%"),
      lbl("Природные богатства", res, () => (+res.value).toFixed(1) + "×"),
      lbl("Частота катастроф", dis, () => (+dis.value === 0 ? "нет" : (+dis.value).toFixed(1) + "×")),
      lbl("Скорость развития", pace, () => (+pace.value).toFixed(1) + "×"),
      lbl("Начальная эпоха", era),
      h("p.sub2", "Одинаковый seed и настройки дают одинаковый мир. А вот история в нём каждый раз пойдёт своим путём, если вы вмешаетесь."),
      h("button.btn.primary", { onclick: async () => {
        await this.autosave(true);
        this.newWorld({ name: name.value.trim() || "Безымянный мир", seed: seed.value.trim() || randomSeed(), size: size.value as WorldSettings["size"], tribes: +tribes.value, climate: climate.value as WorldSettings["climate"],
          resources: +res.value, disasters: +dis.value, startEra: +era.value, pace: +pace.value, landRatio: +land.value }, true);
      } }, "✦ Сотворить мир"),
    ));
  }

  private saving = false;
  async autosave(quiet = true, manual = false): Promise<void> {
    if (!this.meta || !this.snap || this.saving) return;
    this.saving = true;
    this.lastAutosave = performance.now();
    try {
      const m = await this.ask<Extract<FromWorker, { type: "save" }>>({ type: "save", req: ++this.req });
      const st = m.state;
      this.meta = { ...this.meta, year: st.year, era: this.snap.eraName, savedAt: Date.now(), states: this.snap.stats.states, auto: !manual };
      await saveWorld(this.meta, st);
      if (!quiet) this.toast("💾", `Мир сохранён — ${st.year} год`, 2);
    } catch (e) {
      this.toast("⚠", "Не удалось сохранить: " + (e as Error).message + ". Попробуйте экспорт в файл.", 4);
    } finally { this.saving = false; }
  }
  private async exportFile(): Promise<void> {
    const m = await this.ask<Extract<FromWorker, { type: "save" }>>({ type: "save", req: ++this.req });
    const blob = await compress(toJSON(m.state));
    const a = h<HTMLAnchorElement>("a", { href: URL.createObjectURL(blob), download: `${(this.meta?.name ?? "мир").replace(/[^\p{L}\p{N}]+/gu, "_")}-${m.state.year}.genesis` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    this.toast("⬇", "Файл мира сохранён на устройство", 2);
  }
  private async importFile(f?: File): Promise<void> {
    if (!f) return;
    try {
      const st: WorldState = fromJSON(await decompress(f));
      await this.autosave(true);
      this.meta = { id: "w" + Date.now().toString(36), name: st.settings.name, year: st.year, era: "", savedAt: Date.now(), seed: st.settings.seed, size: st.settings.size, states: 0, auto: false };
      this.send({ type: "load", state: st });
      this.setSpeed(0);
      this.closePanel();
      this.toast("⬆", `Мир «${st.settings.name}» загружен — ${st.year} год`, 3);
      setTimeout(() => this.autosave(true), 1500);
    } catch (e) { this.toast("⚠", "Файл не подошёл: " + (e as Error).message, 4); }
  }

  // ---------------------------------------------------------------- уведомления
  private toast(icon: string, text: string, imp: number, ev?: SnapEvent): void {
    const box = $("toasts");
    const max = innerWidth < 720 ? 2 : 4;
    while (box.children.length >= max) box.firstElementChild!.remove();
    const el = h(`div.toast.imp${imp}`, { onclick: () => { if (ev) { if (ev.x >= 0) this.r.cam.flyTo(ev.x + 0.5, ev.py + 0.5, Math.max(this.r.cam.zoom, 9)); this.openArticle("event", ev.id); } el.remove(); } },
      h("span.ic", icon), h("div", ev ? h("b", `${ev.y} г. `) : null, text));
    box.append(el);
    this.toastsShown++;
    setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 450); }, imp >= 5 ? 9000 : 6000);
  }
  private tickUI(): void { /* место для анимаций интерфейса, зависящих от кадра */ }
}

export const govName = (g: number): string => GOV_NAMES[g] ?? "";
