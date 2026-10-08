// Привязка Telegram. Внутри мини-приложения бота — сразу, по подписанным данным Telegram (без переходов).
// В обычном браузере — открываем бота по одноразовой ссылке; окно открываем синхронно, чтобы его не заблокировали.
import { api } from "../api.js";

const KEY = "krug:tgInitData";

export function saveInitData(v) {
  try { sessionStorage.setItem(KEY, v); } catch { /* приватный режим */ }
}

export function tgInitData() {
  try { return sessionStorage.getItem(KEY) || ""; } catch { return ""; }
}

export function inTelegram() {
  return !!tgInitData() || document.documentElement.classList.contains("in-telegram");
}

/** Возвращает { linked: true, view } если привязали сразу, иначе { opened: true } — ждём «Запустить» в боте. */
export async function linkTelegram() {
  const init = tgInitData();
  if (init) {
    try {
      const view = await api.post("/api/telegram/link", { init_data: init });
      if (view.linked) return { linked: true, view };
    } catch (e) {
      if (e?.code !== "tg_init_bad") throw e;
    }
  }
  // окно — до любого await, иначе браузер посчитает его всплывающим и не откроет
  const w = inTelegram() ? null : window.open("", "_blank");
  let r;
  try {
    r = await api.post("/api/telegram/link", {});
  } catch (e) {
    w?.close();
    throw e;
  }
  if (w && !w.closed) w.location.href = r.url;
  else location.href = r.url; // Telegram и браузеры без всплывающих окон: переходим по ссылке t.me сами
  return { opened: true };
}
