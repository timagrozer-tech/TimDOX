// Действия уровня приложения, которые нужны в нескольких модулях.
import { api, state, disconnectStream, emit, loadMe, connectStream } from "./api.js";
import { navigate } from "./router.js";
import { applyTheme } from "./ui.js";
import { applyLook, DEFAULT_LOOK, RETRO_DEFAULT_VERSION } from "./look.js";

/** Применяет тему и оформление, сохранённые в аккаунте */
export function applyUserLook() {
  if (!state.me) return;
  // у каждого аккаунта своё оформление: если своего нет — стандартное, а не оставшееся от другого аккаунта
  let look = state.me.appearance || DEFAULT_LOOK;
  // один раз переводим на новое основное оформление «Ретро 2010» тех, кто оставался на стандартном
  try {
    if (localStorage.getItem("krug-retro-default") !== RETRO_DEFAULT_VERSION) {
      localStorage.setItem("krug-retro-default", RETRO_DEFAULT_VERSION);
      if (!state.me.appearance || ["qevi", "orbit", undefined, null, ""].includes(state.me.appearance.preset)) {
        look = { ...DEFAULT_LOOK };
        state.me.appearance = look;
        api.patch("/api/me/settings", { appearance: look, theme: "light" }).catch(() => {});
        state.me.theme = "light";
      }
    }
  } catch { /* приватный режим */ }
  applyLook(look, state.me.background || null);
  applyTheme(state.me.theme || "light");
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
