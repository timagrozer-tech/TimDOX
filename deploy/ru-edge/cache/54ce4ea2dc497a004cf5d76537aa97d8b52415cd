// Согласия: ИИ-функции (перед первым использованием), cookie, обновлённые документы и раздел в настройках.
import { api, state } from "../api.js";
import { h, icon } from "../dom.js";
import { modal, toast, toastError, busy } from "../ui.js";

let cache = null;
export async function consents(force = false) {
  if (!state.me) return { items: {} };
  if (!cache || force) cache = await api.get("/api/consents").catch(() => ({ items: {} }));
  return cache;
}
const set = async (payload) => { cache = await api.post("/api/consents", payload); return cache; };

/** Перед ИИ-функцией: если согласия нет — объясняем, что и куда уходит, и спрашиваем. true — можно продолжать. */
export async function ensureAI() {
  const c = await consents();
  if (c.items?.ai?.granted) return true;
  return new Promise((resolve) => {
    let ok = false;
    const yes = h("button.btn.primary", { type: "button" }, icon("sparkle", "sm"), "Включить ИИ-функции");
    const m = modal({
      title: "ИИ-функции Yarko", narrow: true,
      body: h("div.stack.ai-consent",
        h("p", "Помощник в чатах, ИИ-персонажи, расшифровка голосовых и ИИ-подписи к стикерам работают с помощью нейросети."),
        h("ul",
          h("li", "Нейросети передаётся только то, что нужно для выбранной функции: фрагмент переписки, текст или изображение."),
          h("li", "Сервис — Groq, Inc. (США). Это передача данных за пределы России, поэтому нужно ваше отдельное согласие."),
          h("li", "Выключить можно в любой момент: «Настройки» → «Ещё» → «Документы и согласия».")),
        h("p.muted.small", h("a", { href: "/ai-consent", target: "_blank" }, "Полный текст согласия"))),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => m.close() }, "Не сейчас"), yes],
      onClose: () => resolve(ok),
    });
    yes.addEventListener("click", () => busy(yes, async () => {
      try { await set({ kind: "ai", granted: true }); ok = true; m.close(); toast("ИИ-функции включены ✨", { icon: "check" }); } catch (e) { toastError(e); }
    }));
  });
}

/** Ошибка сервера «нужно согласие на ИИ»: спросить и повторить действие */
export async function withAI(fn) {
  if (!(await ensureAI())) return null;
  try { return await fn(); } catch (e) {
    if (e?.code === "ai_consent") { cache = null; if (await ensureAI()) return fn(); return null; }
    throw e;
  }
}

/** Плашка про cookie: один раз, только необходимые cookie — подтверждение ознакомления */
export function cookieNotice() {
  const KEY = "qevi:cookies";
  try { if (localStorage.getItem(KEY)) return; } catch { return; }
  const bar = h("div.cookie-bar", { role: "region", "aria-label": "Cookie" },
    h("span", "Yarko использует только необходимые cookie — для входа в аккаунт и защиты. ", h("a", { href: "/cookies" }, "Подробнее")),
    h("button.btn.soft.sm", { type: "button", onclick: () => {
      try { localStorage.setItem(KEY, new Date().toISOString()); } catch { /* приватный режим */ }
      if (state.me) set({ kind: "cookies", granted: true }).catch(() => {});
      bar.remove();
    } }, "Понятно"));
  document.body.append(bar);
}

/** Документы обновились — ненавязчивая карточка в ленте с кнопкой «Принять» */
export function documentsReview() {
  const card = h("section.card.docs-review", { hidden: true });
  consents().then((c) => {
    if (!c.review) return;
    const accept = h("button.btn.primary.sm", { type: "button" }, "Принять");
    accept.addEventListener("click", () => busy(accept, async () => {
      try { await set({ accept_documents: true }); card.remove(); toast("Спасибо! Документы приняты", { icon: "check" }); } catch (e) { toastError(e); }
    }));
    card.hidden = false;
    card.append(h("div.push-hero-ic", icon("shield")),
      h("div.label-block", h("b", "Мы обновили документы Yarko"),
        h("small", "Новые ", h("a", { href: "/terms" }, "Пользовательское соглашение"), ", ", h("a", { href: "/privacy" }, "Политика конфиденциальности"),
          " и отдельное ", h("a", { href: "/consent" }, "согласие на обработку данных"), ". Ваш аккаунт и данные не меняются.")),
      h("div.push-invite-act", accept));
  });
  return card;
}

const KIND_HINT = {
  pd: ["Обработка персональных данных", "/consent", "Отзывается удалением аккаунта"],
  terms: ["Пользовательское соглашение", "/terms", "Отзывается удалением аккаунта"],
  content: ["Обработка пользовательского контента", "/terms", "Часть Соглашения"],
  ai: ["ИИ-функции и передача данных ИИ-сервису", "/ai-consent", null],
  notifications: ["Push-уведомления", "/privacy", "Включаются в «Уведомлениях» на каждом устройстве"],
  cookies: ["Cookie", "/cookies", "Только необходимые"],
};

/** Раздел «Документы и согласия» в настройках */
export function consentsBox() {
  const box = h("div.stack.consents-box", h("div.spinner"));
  const fmt = (at) => (at ? new Date(at).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
  async function render(force) {
    const c = await consents(force);
    const rows = Object.entries(KIND_HINT).map(([k, [label, href, hint]]) => {
      const it = c.items?.[k];
      const status = it ? (it.granted ? `дано ${fmt(it.at)} · ред. ${it.version}` : `отозвано ${fmt(it.at)}`) : "не давалось";
      const control = k === "ai"
        ? h("input.switch", { type: "checkbox", role: "switch", checked: !!it?.granted, "aria-label": label,
          onchange: async (e) => { try { await set({ kind: "ai", granted: e.target.checked }); toast(e.target.checked ? "ИИ-функции включены" : "ИИ-функции выключены — данные больше не передаются", { icon: "check" }); render(); } catch (er) { toastError(er); } } })
        : h(`span.consent-state${it?.granted ? ".on" : ""}`, it?.granted ? "✓" : "—");
      return h("div.setting-row", h("div.label-block", h("b", h("a", { href }, label)), h("small", [status, hint].filter(Boolean).join(" · "))), control);
    });
    box.replaceChildren(...rows,
      c.review ? h("div.row", h("button.btn.primary.sm", { type: "button", onclick: async (e) => busy(e.currentTarget, async () => { await set({ accept_documents: true }); render(); }) }, "Принять обновлённые документы")) : null,
      h("p.muted.small", "Каждое изменение сохраняется с датой и версией документа. Отозвать согласие на обработку персональных данных можно, удалив аккаунт ниже."));
  }
  render().catch((e) => box.replaceChildren(h("p.muted", e.message)));
  return box;
}
