// Клиент API: JSON, загрузка файлов, CSRF-токен, события реального времени.

export const state = {
  me: null,
  csrf: null,
  counters: { notifications: 0, messages: 0, friend_requests: 0 },
  requireEmailConfirm: false,
};

// ---------------------------------------------------------------- Шина событий
const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
export function emit(event, data) {
  for (const fn of [...(listeners.get(event) || [])]) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || "Ошибка сети");
    this.status = status;
    this.fields = data?.fields || {};
    this.code = data?.code;
  }
}

async function request(method, url, data, isForm = false) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (state.csrf && method !== "GET") opts.headers["X-CSRF-Token"] = state.csrf;
  if (data !== undefined) {
    if (isForm) opts.body = data;
    else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(data);
    }
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, { error: "Нет соединения с сервером. Проверьте интернет." });
  }
  if (url.startsWith("/api/calls")) boostPoll();
  const ver = res.headers.get("x-app-version");
  if (ver) {
    if (!state.appVersion) state.appVersion = ver;
    else if (ver !== state.appVersion) window.__krugUpdate = true;
  }
  const ctype = res.headers.get("content-type") || "";
  const body = ctype.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, body);
    if (res.status === 401 && state.me) emit("logged-out");
    throw err;
  }
  return body;
}

// Короткий кэш ответов GET: повторный заход в раздел (туда-обратно, вкладки) — мгновенно, без похода в сеть.
// Одинаковые одновременные запросы склеиваются в один. Любое изменение (POST/PATCH/PUT/DELETE) и события
// реального времени очищают кэш, поэтому устаревших данных человек не видит.
const getCache = new Map(); // url → { t, p }
const CACHE_MS = 20000;
const NO_CACHE = /^\/api\/(poll|auth\/|calls|music\/(play|art|wave)|perf|admin)/;
export function clearApiCache() { getCache.clear(); }
function cachedGet(url) {
  if (NO_CACHE.test(url)) return request("GET", url);
  const hit = getCache.get(url);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = request("GET", url);
  getCache.set(url, { t: Date.now(), p });
  p.catch(() => { if (getCache.get(url)?.p === p) getCache.delete(url); });
  if (getCache.size > 200) getCache.delete(getCache.keys().next().value);
  return p;
}
// служебные записи (замеры, прослушивания, прочтение) не меняют то, что на экране, — кэш не трогаем
const KEEPS_CACHE = /^\/api\/(perf|calls\/[^/]+\/(diag|signal)|music\/songs\/\d+\/play|conversations\/\d+\/(read|typing)|notifications\/read)/;
const mutate = (method, url, data, isForm) => { if (!KEEPS_CACHE.test(url)) getCache.clear(); return request(method, url, data, isForm); };

export const api = {
  get: (url, params) => {
    if (params) {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
      if ([...q].length) url += (url.includes("?") ? "&" : "?") + q;
    }
    return cachedGet(url);
  },
  /** то же без кэша — когда нужны самые свежие данные */
  fresh: (url) => request("GET", url),
  post: (url, data = {}) => mutate("POST", url, data),
  patch: (url, data) => mutate("PATCH", url, data),
  put: (url, data) => mutate("PUT", url, data),
  del: (url, data) => mutate("DELETE", url, data),
  form: (url, formData, method = "POST") => mutate(method, url, formData, true),
  /** Загрузка с прогрессом (0..1). Возвращает { promise, abort }. */
  upload(url, formData, onProgress) {
    getCache.clear();
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open("POST", url);
      if (state.csrf) xhr.setRequestHeader("X-CSRF-Token", state.csrf);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          if (xhr.status === 401 && state.me) emit("logged-out");
          reject(new ApiError(xhr.status, data || { error: xhr.status === 413 ? "Файл слишком большой" : "Ошибка загрузки" }));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, { error: "Нет соединения с сервером. Проверьте интернет." }));
      xhr.onabort = () => reject(new ApiError(0, { error: "Загрузка отменена", code: "aborted" }));
      xhr.send(formData);
    });
    return { promise, abort: () => xhr.abort() };
  },
};

export async function loadMe() {
  // при первом запуске данные уже лежат в странице (сервер вложил их в HTML) — без лишнего запроса
  let me = null;
  const boot = document.getElementById("boot-me");
  if (boot) { try { me = JSON.parse(boot.textContent); } catch { /* */ } boot.remove(); }
  if (!me) me = await api.get("/api/auth/me");
  state.me = me.user;
  state.csrf = me.csrf || null;
  state.requireEmailConfirm = !!me.require_email_confirm;
  state.mailEnabled = !!me.mail_enabled;
  state.realtime = me.realtime || "sse";
  if (me.counters) setCounters(me.counters);
  return me.user;
}

export function setCounters(c) {
  state.counters = { ...state.counters, ...c };
  emit("counters", state.counters);
}

// ---------------------------------------------------------------- Реальное время (SSE)
let source = null;
let retry = 1000;
const EVENTS = ["notification", "message", "message_update", "typing", "read", "presence", "counters", "items", "conv_theme",
  "call_invite", "call_signal", "call_join", "call_leave", "call_decline", "call_end"];

function dispatch(ev, data) {
  if (ev !== "presence" && ev !== "typing") getCache.clear(); // пришло новое — кэш устарел
  if (ev === "counters") setCounters(data);
  if (ev.startsWith("call_")) boostPoll();
  emit(ev, data);
}

// ---- опрос сервера (хостинг без постоянных соединений): раз в 2 с, во время звонка — чаще, в фоне — реже
let lastTouch = Date.now();
addEventListener("pointerdown", () => { lastTouch = Date.now(); }, { passive: true, capture: true });
addEventListener("keydown", () => { lastTouch = Date.now(); }, { passive: true, capture: true });
let polling = false, pollTimer = null, cursor = null, boostUntil = 0, pollFails = 0;
export function boostPoll(ms = 90000) {
  boostUntil = Date.now() + ms;
  if (polling && pollTimer) { clearTimeout(pollTimer); pollTimer = setTimeout(pollOnce, 150); }
}
function pollDelay() {
  if (pollFails) return Math.min(2000 * 2 ** pollFails, 30000);
  if (Date.now() < boostUntil) return 700;
  if (document.hidden) return 30000;
  return Date.now() - lastTouch < 30000 ? 2500 : 5000; // человек что-то делает — чаще, просто смотрит — реже
}
async function pollOnce() {
  pollTimer = null;
  if (!polling || !state.me) return;
  try {
    const res = await fetch(`/api/poll${cursor == null ? "" : `?after=${cursor}`}`, { credentials: "same-origin", cache: "no-store" });
    if (res.status === 401) { stopPolling(); if (state.me) emit("logged-out"); return; }
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    const first = cursor == null || pollFails > 0;
    cursor = d.cursor;
    pollFails = 0;
    if (first) emit("stream-open");
    for (const e of d.events || []) { if (EVENTS.includes(e.event)) dispatch(e.event, e.data); }
  } catch {
    pollFails = Math.min(pollFails + 1, 5);
  }
  if (polling) pollTimer = setTimeout(pollOnce, pollDelay());
}
function stopPolling() {
  polling = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
document.addEventListener("visibilitychange", () => {
  if (polling && !document.hidden && pollTimer) { clearTimeout(pollTimer); pollTimer = setTimeout(pollOnce, 50); }
});

export function connectStream() {
  if (state.realtime === "poll") {
    if (polling || !state.me) return;
    polling = true; cursor = null; pollFails = 0;
    pollOnce();
    return;
  }
  if (source || !state.me) return;
  source = new EventSource("/api/stream");
  source.addEventListener("hello", () => { retry = 1000; emit("stream-open"); });
  // сервер закрыл поток: сессия завершена на другом устройстве, истекла или аккаунт заблокирован
  source.addEventListener("session_end", () => { disconnectStream(); if (state.me) emit("logged-out"); });
  for (const ev of EVENTS) {
    source.addEventListener(ev, (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      dispatch(ev, data);
    });
  }
  source.onerror = () => {
    source?.close();
    source = null;
    if (!state.me) return;
    setTimeout(connectStream, retry);
    retry = Math.min(retry * 2, 30000);
  };
}

export function disconnectStream() {
  stopPolling();
  source?.close();
  source = null;
}
