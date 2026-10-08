// Интерактивное обучение: подсказки-прожекторы, которые показываются при первом заходе в раздел.
// Затемнение с «вырезом» вокруг нужной кнопки, стеклянная карточка с текстом, звук и лёгкая вибрация.
// Прогресс хранится на сервере — на другом устройстве подсказки не повторятся.
import { api, state } from "./api.js";
import { h } from "./dom.js";
import { pushOverlay } from "./router.js";

let profile = null; // { style, tours, sound }
let running = false;
let stopCurrent = null; // закрыть подсказку при уходе со страницы

const TOURS = {
  feed: [
    { sel: ".tab-create, .create-btn", title: "Делитесь моментами", text: "Здесь создаются записи, истории и клипы. Фото, видео, опросы, музыка — всё в одном месте." },
    { sel: ".feed-tabs, .tabs", title: "Две ленты", text: "«Друзья и подписки» — только ваши люди по времени. «Обзор» — интересное из всего QEVI." },
    { sel: '[data-nav="Пригласить"]', title: "Позовите друзей", text: "Приглашайте друзей и получайте галочки: базовую за 3 друга, серебряную за 10, золотую за 50, легендарную за 100." },
  ],
  profile: [
    { sel: ".profile-top .avatar, .set-av-wrap", title: "Ваше лицо в QEVI", text: "Нажмите на фото, чтобы сменить аватар или обложку." },
    { sel: ".stats-btn", title: "Личная статистика", text: "Сколько людей видят ваши записи и когда лучше публиковать." },
    { sel: ".profile-counts", title: "Ваш круг в цифрах", text: "Нажмите на число, чтобы увидеть друзей, подписчиков и приглашённых." },
  ],
  friends: [
    { sel: ".tabs, .seg", title: "Заявки и рекомендации", text: "Здесь заявки в друзья и люди, которых вы, возможно, знаете." },
  ],
  messages: [
    { sel: ".chat-list-head, .conv-list, .conv", title: "Ваши переписки", text: "Личные и групповые чаты, голосовые, фото, стикеры и музыка. Свайп влево — быстрые действия." },
  ],
  settings: [
    { sel: '[data-tab="security"], .set-tabs button:nth-child(4)', title: "Защитите аккаунт", text: "Во вкладке «Защита» включите двухфакторную защиту — без кода с телефона в аккаунт не войти." },
    { sel: '[data-tab="look"], .set-tabs button:nth-child(2)', title: "Ваш стиль", text: "Темы, цвета, фоны и шрифты — QEVI выглядит так, как нравится вам." },
  ],
  security: [
    { sel: ".tfa-box", title: "Двухфакторная защита", text: "Подключите приложение-аутентификатор за минуту — это лучший способ защитить аккаунт." },
    { sel: ".logins", title: "Журнал входов", text: "Все входы и неудачные попытки. Видите незнакомое — завершите сеанс и смените пароль." },
  ],
  invite: [
    { sel: ".iv-link", title: "Ваша личная ссылка", text: "Нажмите, чтобы скопировать. Друзья по ней сразу подписываются на вас." },
    { sel: ".iv-tiers", title: "Галочки", text: "Засчитываются активные друзья: с фото и заходившие в 3 разных дня." },
  ],
  music: [
    { sel: ".mu-tabs, .mu-shelf", title: "Музыка QEVI", text: "Полные треки и радио прямо в QEVI. Сердечко добавляет трек в «Мою музыку» — его увидят друзья." },
  ],
};

export function tourKeyFor(path, query = {}) {
  if (path === "/" || path === "/explore") return "feed";
  if (state.me && path === `/u/${state.me.username}`) return "profile";
  if (path.startsWith("/friends")) return "friends";
  if (path === "/messages") return "messages";
  if (path.startsWith("/settings")) return query.tab === "security" ? "security" : "settings";
  if (path === "/invite") return "invite";
  if (path === "/music") return "music";
  return null;
}

async function loadProfile() {
  if (profile) return profile;
  try { profile = await api.get("/api/onboarding"); } catch { profile = { tours: [], sound: true }; }
  return profile;
}

// ---------------------------------------------------------------- звук и вибрация
let audio = null;
export function blip(kind = "step") {
  if (profile && profile.sound === false) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const style = profile?.style || document.documentElement.dataset.uiStyle || "modern";
    const base = { modern: 660, fun: 880, future: 520 }[style] || 660;
    const notes = kind === "done" ? [1, 1.25, 1.5] : kind === "start" ? [1, 1.5] : [1.25];
    notes.forEach((m, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = style === "future" ? "triangle" : "sine";
      o.frequency.value = base * m;
      const t = audio.currentTime + i * 0.08;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(audio.destination);
      o.start(t); o.stop(t + 0.2);
    });
  } catch { /* звук недоступен */ }
  try { navigator.vibrate?.(kind === "done" ? [10, 40, 18] : 8); } catch { /* нет вибрации */ }
}

// ---------------------------------------------------------------- показ
function visibleTarget(sel) {
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

export async function runTour(key, { force = false } = {}) {
  if (running || !state.me || !TOURS[key]) return;
  const p = await loadProfile();
  if (!force && (p.tours || []).includes(key)) return;
  const steps = TOURS[key].filter((s) => visibleTarget(s.sel));
  if (!steps.length) return;
  running = true;
  let i = 0;
  const ring = h("div.tour-ring");
  const card = h("div.tour-card", { role: "dialog", "aria-modal": "true" });
  const layer = h("div.tour-layer", { "aria-live": "polite" }, ring, card);
  document.body.append(layer);
  let release = pushOverlay(() => finish(true));

  const place = () => {
    const el = visibleTarget(steps[i].sel);
    if (!el) return next();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      const r = el.getBoundingClientRect();
      const pad = 8;
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      const below = r.bottom + 200 < innerHeight;
      const left = Math.min(innerWidth - 332, Math.max(12, r.left + r.width / 2 - 160));
      Object.assign(card.style, { left: `${left}px`, top: below ? `${r.bottom + 16}px` : "", bottom: below ? "" : `${innerHeight - r.top + 16}px` });
      card.classList.remove("in"); void card.offsetWidth; card.classList.add("in");
    }, 260);
    card.replaceChildren(
      h("div.tour-dots", steps.map((_, k) => h(`i${k === i ? ".on" : ""}`))),
      h("b", steps[i].title), h("p", steps[i].text),
      h("div.tour-actions",
        h("button.btn.ghost.sm", { type: "button", onclick: () => finish(true) }, "Пропустить"),
        h("button.btn.primary.sm", { type: "button", onclick: next }, i === steps.length - 1 ? "Понятно" : "Далее")));
    card.querySelector(".btn.primary").focus({ preventScroll: true });
  };
  function next() {
    i++;
    if (i >= steps.length) return finish(true);
    blip("step");
    place();
  }
  function finish(save) {
    if (!running) return;
    running = false;
    stopCurrent = null;
    layer.classList.add("out");
    setTimeout(() => layer.remove(), 220);
    removeEventListener("resize", place);
    if (release) { const r = release; release = null; r(); }
    if (save !== false) {
      blip("done");
      profile.tours = [...new Set([...(profile.tours || []), key])];
      api.post("/api/onboarding", { tour: key }).catch(() => {});
    }
  }
  stopCurrent = () => finish(false);
  layer.addEventListener("keydown", (e) => { if (e.key === "Escape") finish(true); });
  addEventListener("resize", place);
  blip("start");
  place();
}

/** Вызывается после отрисовки страницы: если для раздела есть непройденное обучение — запускаем */
let pending = 0;
export function queueTour(path, query) {
  clearTimeout(pending);
  const key = tourKeyFor(path, query);
  if (!key) return;
  pending = setTimeout(() => { if (location.pathname === path) runTour(key); }, 900);
}

/** Переход на другую страницу: подсказку закрываем (без отметки «пройдено»), отложенный показ отменяем */
export function stopTour() {
  clearTimeout(pending);
  stopCurrent?.();
}

export function setTourProfile(p) { profile = p; }
