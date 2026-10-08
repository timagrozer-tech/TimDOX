// Push-уведомления на этом устройстве: подписка браузера, переключатели и мягкое приглашение в ленте.
import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { toast, toastError, busy } from "./ui.js";
import { inTelegram } from "./components/tglink.js";

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext && !inTelegram();
}

/** iPhone/iPad: уведомления работают только у сайта, добавленного на экран «Домой» */
export function needsInstallForPush() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  return ios && !standalone && !("PushManager" in window);
}

function keyBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function enablePush() {
  if (!pushSupported()) throw new Error("Этот браузер не поддерживает уведомления");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "Уведомления запрещены в настройках браузера — разрешите их для сайта" : "Вы не разрешили уведомления");
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api.get("/api/push");
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // ключ сервера мог смениться — пересоздаём подписку
    const cur = sub.options?.applicationServerKey;
    const same = cur && btoa(String.fromCharCode(...new Uint8Array(cur))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === key;
    if (!same) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api.post("/api/push/subscribe", { subscription: sub.toJSON(), hello: true });
  return sub;
}

export async function disablePush() {
  const sub = await currentSub();
  if (!sub) return;
  await api.post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** Блок в настройках */
export function pushSettingsBox() {
  const box = h("div.stack.push-box", h("div.spinner"));
  const sw = (checked, onchange) => h("input.switch", { type: "checkbox", role: "switch", checked: !!checked, onchange });
  const row = (title, hint, control) => h("div.setting-row", h("div.label-block", h("b", title), hint ? h("small", hint) : null), control);
  async function render() {
    if (inTelegram()) {
      box.replaceChildren(h("p.muted", "Внутри Telegram уведомления присылает бот Yarko — настройте их во вкладке «Telegram»."));
      return;
    }
    if (!pushSupported()) {
      box.replaceChildren(h("p.muted", needsInstallForPush()
        ? "На iPhone уведомления работают, когда Yarko добавлен на экран «Домой»: «Поделиться» → «На экран „Домой“», затем откройте Yarko оттуда."
        : "Этот браузер не поддерживает уведомления. Попробуйте Chrome, Edge, Firefox или Safari."));
      return;
    }
    const sub = await currentSub();
    const st = await api.get("/api/push", sub ? { endpoint: sub.endpoint } : undefined);
    if (!sub || !st.this) {
      const btn = h("button.btn.primary", { type: "button" }, icon("bell", "sm"), "Включить уведомления");
      btn.addEventListener("click", () => busy(btn, async () => {
        try { await enablePush(); toast("Уведомления включены 🔔", { icon: "check" }); render(); } catch (e) { toastError(e); }
      }));
      box.replaceChildren(
        h("div.push-hero", h("div.push-hero-ic", icon("bell")), h("div.label-block",
          h("b", "Узнавайте о главном сразу"),
          h("small", "Новые сообщения, заявки в друзья, ответы и упоминания — на этот телефон или компьютер, даже когда Yarko закрыт."))),
        Notification.permission === "denied"
          ? h("p.stk-warn", "Уведомления для сайта запрещены в настройках браузера. Разрешите их (значок замка у адреса) и вернитесь сюда.")
          : h("div.row", btn),
        st.devices ? h("p.muted.small", `Уведомления уже включены на других устройствах: ${st.devices}`) : null);
      return;
    }
    const patch = (k) => (e) => api.patch("/api/push", { endpoint: sub.endpoint, [k]: e.target.checked }).catch(toastError);
    const test = h("button.btn.soft.sm", { type: "button" }, "Проверить");
    test.addEventListener("click", () => busy(test, async () => {
      try { await api.post("/api/push/test", { endpoint: sub.endpoint }); toast("Отправили — уведомление появится через пару секунд"); } catch (e) { toastError(e); if (e.code === "push_gone") render(); }
    }));
    const off = h("button.btn.ghost.sm", { type: "button" }, "Выключить на этом устройстве");
    off.addEventListener("click", () => busy(off, async () => { await disablePush(); toast("Уведомления на этом устройстве выключены"); render(); }));
    box.replaceChildren(
      h("div.push-hero.ok", h("div.push-hero-ic", icon("check")), h("div.label-block", h("b", "Уведомления включены"),
        h("small", st.devices > 1 ? `На этом и ещё ${st.devices - 1} устр.` : "На этом устройстве")), test),
      row("Сообщения", "Когда вас нет на сайте", sw(st.this.notify_messages, patch("notify_messages"))),
      row("Друзья и записи", "Заявки, ответы, упоминания, подарки", sw(st.this.notify_social, patch("notify_social"))),
      h("div.row", off));
  }
  render().catch((e) => box.replaceChildren(h("p.muted", e.message)));
  return box;
}

/** Мягкое приглашение в ленте: один раз, без системного окна, пока человек сам не нажмёт */
export function pushInvite() {
  const KEY = "krug:pushInvite";
  try {
    if (!pushSupported() || Notification.permission !== "default" || localStorage.getItem(KEY)) return null;
  } catch { return null; }
  const card = h("section.card.push-invite");
  const close = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* приватный режим */ } card.remove(); };
  const yes = h("button.btn.primary.sm", { type: "button" }, icon("bell", "sm"), "Включить");
  yes.addEventListener("click", () => busy(yes, async () => {
    try { await enablePush(); toast("Готово! Уведомления включены 🔔", { icon: "check" }); close(); } catch (e) { toastError(e); close(); }
  }));
  card.append(h("div.push-hero-ic", icon("bell")),
    h("div.label-block", h("b", "Не пропускайте сообщения"), h("small", "Включите уведомления — пришлём, когда вам напишут или добавят в друзья.")),
    h("div.push-invite-act", yes, h("button.btn.ghost.sm", { type: "button", onclick: close }, "Не сейчас")));
  return card;
}
