// Установка «Круга» как приложения (PWA): регистрация сервис-воркера и кнопка «Установить».
import { h, icon } from "./dom.js";
import { modal, toast } from "./ui.js";

let deferred = null;
const listeners = new Set();

export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Можно ли предложить установку (Chrome/Edge/Android — кнопкой, iPhone — инструкцией) */
export const canInstall = () => !isStandalone() && (!!deferred || isIOS());

export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function initPwa() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    // нажали на уведомление, а KRUG уже открыт — переходим внутри приложения, без перезагрузки
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type !== "open" || !e.data.url) return;
      const u = new URL(e.data.url);
      if (u.origin === location.origin) import("./router.js").then((r) => r.navigate(u.pathname + u.search));
    });
  }
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    listeners.forEach((fn) => fn());
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((fn) => fn());
    toast("Круг установлен — ищите значок на рабочем столе", { icon: "check" });
  });
}

export async function install() {
  if (deferred) {
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({}));
    if (outcome === "accepted") deferred = null;
    listeners.forEach((fn) => fn());
    return;
  }
  // iPhone и iPad: установка только через меню «Поделиться»
  modal({
    title: "Установить Круг", narrow: true,
    body: h("div.stack.install-steps",
      h("p", "На iPhone и iPad приложение ставится из Safari:"),
      h("ol",
        h("li", "Нажмите кнопку ", h("b", "«Поделиться»"), " внизу экрана (квадрат со стрелкой)."),
        h("li", "Выберите ", h("b", "«На экран „Домой“»"), "."),
        h("li", "Нажмите ", h("b", "«Добавить»"), " — значок Круга появится рядом с другими приложениями.")),
      h("p.muted", "Откроется на весь экран, без адресной строки, как обычное приложение.")),
  });
}

export function installButton(cls = "btn.soft") {
  const btn = h(`button.${cls}`, { type: "button", onclick: install }, icon("install", "sm"), "Установить приложение");
  const paint = () => { btn.hidden = !canInstall(); };
  paint();
  onInstallChange(paint);
  return btn;
}
