// Действия уровня приложения, которые нужны в нескольких модулях.
import { api, state, disconnectStream, emit, loadMe, connectStream } from "./api.js";
import { navigate } from "./router.js";
import { applyTheme } from "./ui.js";
import { applyLook } from "./look.js";

/** Применяет тему и оформление, сохранённые в аккаунте */
export function applyUserLook() {
  if (!state.me) return;
  if (state.me.theme) applyTheme(state.me.theme);
  if (state.me.appearance) applyLook(state.me.appearance, state.me.background);
}

export async function logout() {
  try { await api.post("/api/auth/logout"); } catch { /* сессия уже могла истечь */ }
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
