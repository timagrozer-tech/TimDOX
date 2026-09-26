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
  const ctype = res.headers.get("content-type") || "";
  const body = ctype.includes("application/json") ? await res.json() : null;
  if (!res.ok) {
    const err = new ApiError(res.status, body);
    if (res.status === 401 && state.me) emit("logged-out");
    throw err;
  }
  return body;
}

export const api = {
  get: (url, params) => {
    if (params) {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
      if ([...q].length) url += (url.includes("?") ? "&" : "?") + q;
    }
    return request("GET", url);
  },
  post: (url, data = {}) => request("POST", url, data),
  patch: (url, data) => request("PATCH", url, data),
  del: (url, data) => request("DELETE", url, data),
  form: (url, formData, method = "POST") => request(method, url, formData, true),
};

export async function loadMe() {
  const me = await api.get("/api/auth/me");
  state.me = me.user;
  state.csrf = me.csrf || null;
  state.requireEmailConfirm = !!me.require_email_confirm;
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

export function connectStream() {
  if (source || !state.me) return;
  source = new EventSource("/api/stream");
  source.addEventListener("hello", () => { retry = 1000; emit("stream-open"); });
  for (const ev of ["notification", "message", "typing", "read", "presence", "counters"]) {
    source.addEventListener(ev, (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (ev === "counters") setCounters(data);
      emit(ev, data);
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
  source?.close();
  source = null;
}
