// Установка Yarko как приложения (PWA): регистрация сервис-воркера и кнопка «Установить».
import { h, icon } from "./dom.js";
import { modal, toast } from "./ui.js";

let deferred = null;
const listeners = new Set();

export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isAndroid = () => /android/i.test(navigator.userAgent);
export const APK_URL = "/static/downloads/yarko.apk";

/** Можно ли предложить установку (Android — приложение из файла, Chrome/Edge — кнопкой, iPhone — инструкцией) */
export const canInstall = () => !isStandalone() && (isAndroid() || !!deferred || isIOS());

export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function initPwa() {
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    // нажали на уведомление, а Yarko уже открыт — переходим внутри приложения, без перезагрузки
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
    toast("Yarko установлен — ищите значок на рабочем столе", { icon: "check" });
  });
}

export async function install() {
  if (isAndroid()) { androidDialog(); return; }
  if (deferred) {
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({}));
    if (outcome === "accepted") deferred = null;
    listeners.forEach((fn) => fn());
    return;
  }
  // iPhone и iPad: установка только через меню «Поделиться»
  modal({
    title: "Установить Yarko", narrow: true,
    body: h("div.stack.install-steps",
      h("p", "На iPhone и iPad приложение ставится из Safari:"),
      h("ol",
        h("li", "Нажмите кнопку ", h("b", "«Поделиться»"), " внизу экрана (квадрат со стрелкой)."),
        h("li", "Выберите ", h("b", "«На экран „Домой“»"), "."),
        h("li", "Нажмите ", h("b", "«Добавить»"), " — значок Yarko появится рядом с другими приложениями.")),
      h("p.muted", "Откроется на весь экран, без адресной строки, как обычное приложение.")),
  });
}

/** Android: своё приложение Yarko (файл APK с сайта) — на весь экран, с уведомлениями и своим значком */
function androidDialog() {
  const m = modal({
    title: "Приложение Yarko для Android", narrow: true,
    body: h("div.stack.install-steps",
      h("a.btn.primary.apk-btn", { href: APK_URL, download: "yarko.apk" }, icon("download", "sm"), "Скачать приложение"),
      h("ol",
        h("li", "Откройте скачанный файл ", h("b", "yarko.apk"), " (в уведомлении о загрузке или в «Загрузках»)."),
        h("li", "Если телефон спросит — разрешите установку из этого браузера: ", h("b", "«Настройки» → «Разрешить из этого источника»"), "."),
        h("li", "Нажмите ", h("b", "«Установить»"), " и войдите в Yarko.")),
      h("p.muted", "Приложение обновляется само вместе с сайтом. Нужен Android 7.0 или новее."),
      deferred ? h("button.btn.ghost", { type: "button", onclick: async () => { m.close(); deferred.prompt(); await deferred.userChoice.catch(() => ({})); deferred = null; listeners.forEach((fn) => fn()); } },
        "Или установить без скачивания файла") : null),
  });
}

export function installButton(cls = "btn.soft") {
  const label = isAndroid() ? "Приложение для Android" : "Установить приложение";
  const btn = h(`button.${cls}`, { type: "button", onclick: install }, icon("install", "sm"), label);
  const paint = () => { btn.hidden = !canInstall(); };
  paint();
  onInstallChange(paint);
  return btn;
}
