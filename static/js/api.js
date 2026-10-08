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
  put: (url, data) => request("PUT", url, data),
  del: (url, data) => request("DELETE", url, data),
  form: (url, formData, method = "POST") => request(method, url, formData, true),
  /** Загрузка с прогрессом (0..1). Возвращает { promise, abort }. */
  upload(url, formData, onProgress) {
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
  const me = await api.get("/api/auth/me");
  state.me = me.user;
  state.csrf = me.csrf || null;
  state.requireEmailConfirm = !!me.require_email_confirm;
  state.mailEnabled = !!me.mail_enabled;
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
  // сервер закрыл поток: сессия завершена на другом устройстве, истекла или аккаунт заблокирован
  source.addEventListener("session_end", () => { disconnectStream(); if (state.me) emit("logged-out"); });
  for (const ev of ["notification", "message", "message_update", "typing", "read", "presence", "counters", "items", "conv_theme",
    "call_invite", "call_signal", "call_join", "call_leave", "call_decline", "call_end"]) {
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
