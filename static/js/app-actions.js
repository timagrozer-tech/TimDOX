// Действия уровня приложения, которые нужны в нескольких модулях.
import { api, state, disconnectStream, emit, loadMe, connectStream } from "./api.js";
import { navigate } from "./router.js";
import { applyTheme } from "./ui.js";

export async function logout() {
  try { await api.post("/api/auth/logout"); } catch { /* сессия уже могла истечь */ }
  state.me = null;
  state.csrf = null;
  disconnectStream();
  emit("logged-out");
}

export async function afterLogin(next) {
  await loadMe();
  if (state.me?.theme && state.me.theme !== "system") applyTheme(state.me.theme);
  connectStream();
  navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
}
