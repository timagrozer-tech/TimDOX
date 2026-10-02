// ИИ в чате: варианты ответа, «кратко о пропущенном» и «улучшить текст». Работает только по нажатию.
import { api } from "../api.js";
import { h, icon } from "../dom.js";
import { modal, showMenu, toastError } from "../ui.js";

let aiOn = null;
export async function aiEnabled() {
  if (aiOn === null) aiOn = api.get("/api/ai/status").then((r) => !!r.enabled).catch(() => false);
  return aiOn;
}

const MODES = [
  ["fix", "Исправить ошибки", "check"], ["short", "Короче", "scissors"], ["polite", "Вежливее", "heart"],
  ["fun", "Веселее", "smile"], ["formal", "Деловой стиль", "user"], ["en", "На английский", "globe"], ["ru", "На русский", "globe"],
];

export function chatAI({ id, conv, form, ta, fit, body }) {
  const btn = h("button.btn.ghost.icon-only.ai-btn", { type: "button", "aria-label": "ИИ-помощник", title: "ИИ: ответ, пересказ, улучшить текст", hidden: true, disabled: !conv.can_write }, icon("sparkle"));
  const strip = h("div.ai-replies", { hidden: true });
  form.append(strip);
  aiEnabled().then((on) => { btn.hidden = !on; if (on) unreadHint(); });

  const setText = (t) => { ta.value = t; fit(); ta.dispatchEvent(new Event("input")); ta.focus(); ta.setSelectionRange(t.length, t.length); };

  async function suggest() {
    strip.hidden = false;
    strip.replaceChildren(h("span.ai-label", icon("sparkle", "sm"), "Думаю над ответом…"), h("span.spinner.sm"));
    try {
      const r = await api.post(`/api/conversations/${id}/ai/replies`, {});
      strip.replaceChildren(h("span.ai-label", icon("sparkle", "sm")),
        ...r.replies.map((t) => h("button.ai-chip", { type: "button", onclick: () => { setText(t); strip.hidden = true; } }, t)),
        h("button.ai-x", { type: "button", "aria-label": "Скрыть", onclick: () => { strip.hidden = true; } }, icon("x", "sm")));
    } catch (e) { strip.hidden = true; toastError(e); }
  }

  async function summarize(fromId = 0) {
    const out = h("div.ai-summary", h("div.ai-thinking", h("span.spinner"), h("span", "Читаю переписку и собираю главное…")));
    modal({ title: "✨ Кратко о переписке", body: out });
    try {
      const r = await api.post(`/api/conversations/${id}/ai/summary`, { from_id: fromId });
      out.replaceChildren(h("div.ai-summary-text", r.summary), h("p.muted.small", `По ${r.count} сообщениям · пересказ сделал ИИ, он может ошибаться`));
    } catch (e) { out.replaceChildren(h("p.muted", e.message)); }
  }

  async function improve(mode, label) {
    const src = ta.value.trim();
    if (!src) return;
    btn.disabled = true; btn.classList.add("busy");
    try {
      const r = await api.post("/api/ai/rewrite", { text: src, mode });
      const prev = ta.value;
      setText(r.text);
      // можно вернуть исходный текст
      strip.hidden = false;
      strip.replaceChildren(h("span.ai-label", icon("sparkle", "sm"), `${label} — готово`),
        h("button.ai-chip", { type: "button", onclick: () => { setText(prev); strip.hidden = true; } }, "↶ Вернуть как было"),
        h("button.ai-x", { type: "button", "aria-label": "Скрыть", onclick: () => { strip.hidden = true; } }, icon("x", "sm")));
    } catch (e) { toastError(e); } finally { btn.disabled = !conv.can_write; btn.classList.remove("busy"); }
  }

  btn.addEventListener("click", () => {
    if (ta.value.trim()) {
      showMenu(btn, MODES.map(([m, label, ic]) => ({ label, icon: ic, onClick: () => improve(m, label) })), { title: "✨ Улучшить текст" });
    } else {
      showMenu(btn, [
        { label: "Предложить ответ", hint: "3 варианта по смыслу переписки", icon: "sparkle", onClick: suggest },
        { label: "Кратко о переписке", hint: "Главное из последних сообщений", icon: "list", onClick: () => summarize(0) },
        { label: "Улучшить текст", hint: "Напишите сообщение — и нажмите ✨ снова", icon: "edit", onClick: () => ta.focus() },
      ], { title: "ИИ-помощник" });
    }
  });

  // пропустили много — предлагаем пересказ прямо в переписке
  function unreadHint() {
    const n = conv.unread || 0;
    if (n < 12) return;
    const chip = h("div.ai-unread", icon("sparkle", "sm"), h("span", `Пропущено ${n} сообщений`),
      h("button.btn.soft.sm", { type: "button", onclick: () => { chip.remove(); summarize((conv.my_last_read_id || 0) + 1); } }, "Кратко"),
      h("button.ai-x", { type: "button", "aria-label": "Скрыть", onclick: () => chip.remove() }, icon("x", "sm")));
    body.parentElement?.insertBefore(chip, body);
  }

  return btn;
}
