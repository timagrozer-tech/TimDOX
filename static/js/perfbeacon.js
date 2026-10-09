// Замер плавности на устройстве пользователя: кадры в секунду при прокрутке и в покое, «долгие кадры» и чей
// в них код (Long Animation Frames). Раз в ~30 секунд, не дольше 4 минут после открытия — короткая сводка на сервер.
// Без адресов, текстов и личных данных — только цифры и имена файлов сайта.
import { api } from "./api.js";

export function startPerfBeacon() {
  if (!matchMedia("(pointer: coarse)").matches) return;
  const t0 = performance.now();
  let frames = 0, scrollFrames = 0, scrollMs = 0, idleMs = 0, worst = 0, last = 0, scrolling = 0;
  const loaf = new Map(); let loafN = 0, loafMs = 0, lt = 0;
  addEventListener("scroll", () => { scrolling = performance.now(); }, { passive: true });
  const tick = (t) => {
    if (last) {
      const d = t - last;
      if (d < 1000) { // вкладка в фоне — не считаем
        const sc = t - scrolling < 150;
        if (sc) { scrollFrames++; scrollMs += d; } else { frames++; idleMs += d; }
        if (sc && d > worst) worst = d;
      }
    }
    last = t;
    if (performance.now() - t0 < 240000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        loafN++; loafMs += e.blockingDuration || 0;
        for (const s of e.scripts || []) {
          const k = `${(s.sourceURL || "").split("/").pop() || s.invokerType}:${s.sourceFunctionName || s.invoker || "?"}`.slice(0, 50);
          loaf.set(k, (loaf.get(k) || 0) + s.duration);
        }
        if (!(e.scripts || []).length) loaf.set("render", (loaf.get("render") || 0) + (e.renderStart ? e.duration - (e.renderStart - e.startTime) : e.duration));
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch { /* нет LoAF */ }
  try { new PerformanceObserver((l) => { lt += l.getEntries().length; }).observe({ type: "longtask", buffered: true }); } catch { /* */ }
  // время ответов сервера, как его видит телефон (сеть + сервер), без опроса событий
  let apiN = 0, apiSum = 0, apiMax = 0, apiTtfb = 0;
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (!e.name.includes("/api/") || e.name.includes("/api/poll") || e.name.includes("/api/perf")) continue;
        apiN++; apiSum += e.duration; apiMax = Math.max(apiMax, e.duration);
        apiTtfb += e.responseStart > 0 ? e.responseStart - e.startTime : e.duration;
      }
    }).observe({ type: "resource", buffered: false });
  } catch { /* */ }
  const fps = (n, ms) => (ms > 300 ? Math.round(n * 1000 / ms) : -1);
  const send = () => {
    const root = document.documentElement;
    const top = [...loaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}=${Math.round(v)}`).join(",");
    const parts = [
      `page=${location.pathname.split("/").slice(0, 2).join("/") || "/"} scrollfps=${fps(scrollFrames, scrollMs)} idlefps=${fps(frames, idleMs)} worst=${Math.round(worst)} ` +
        `loaf=${loafN} block=${Math.round(loafMs)} lt=${lt} nodes=${document.getElementsByTagName("*").length} ` +
        `dpr=${devicePixelRatio} w=${innerWidth} mem=${navigator.deviceMemory || "-"} cpu=${navigator.hardwareConcurrency || "-"} cls=${root.className.replace(/\s+/g, ".")} ` +
        `glass=${root.dataset.glass || "-"} motion=${root.dataset.motion || "-"} anims=${document.getAnimations().length}`,
      `top:${top || "none"} api=${apiN} avg=${apiN ? Math.round(apiSum / apiN) : 0} ttfb=${apiN ? Math.round(apiTtfb / apiN) : 0} max=${Math.round(apiMax)} net=${navigator.connection?.effectiveType || "-"} rtt=${navigator.connection?.rtt ?? "-"}`,
    ];
    api.post("/api/perf", { parts }).catch(() => {});
    frames = scrollFrames = 0; scrollMs = idleMs = worst = 0; loaf.clear(); loafN = 0; loafMs = 0; lt = 0; apiN = apiSum = apiMax = apiTtfb = 0;
  };
  let n = 0;
  const timer = setInterval(() => { if (document.hidden) return; send(); if (++n >= 8) clearInterval(timer); }, 30000);
}
