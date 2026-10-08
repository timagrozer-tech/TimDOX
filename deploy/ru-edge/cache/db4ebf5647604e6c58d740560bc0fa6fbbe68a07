// Действия уровня приложения, которые нужны в нескольких модулях.
import { api, state, disconnectStream, emit, loadMe, connectStream } from "./api.js";
import { navigate } from "./router.js";
import { applyTheme } from "./ui.js";
import { applyLook, DEFAULT_LOOK } from "./look.js";

/** Применяет тему и оформление, сохранённые в аккаунте */
export function applyUserLook() {
  if (!state.me) return;
  // у каждого аккаунта своё оформление: если своего нет — стандартное, а не оставшееся от другого аккаунта
  applyTheme(state.me.theme || "dark");
  applyLook(state.me.appearance || DEFAULT_LOOK, state.me.background || null);
}

export async function logout() {
  let r = null;
  try { r = await api.post("/api/auth/logout"); } catch { /* сессия уже могла истечь */ }
  if (r?.switched) { location.assign("/"); return; } // на устройстве есть другой аккаунт — открываем его
  state.me = null;
  state.csrf = null;
  disconnectStream();
  emit("logged-out");
}

export async function afterLogin(next) {
  await loadMe();
  applyUserLook();
  connectStream();
  navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
}

/** Мгновенное переключение на другой аккаунт устройства */
export async function switchAccount(slot) {
  await api.post("/api/accounts/switch", { slot });
  disconnectStream();
  // полная перезагрузка: у каждого аккаунта свои кэши, настройки и поток событий — так ничего не смешается
  location.assign("/");
}
