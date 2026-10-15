// Звук уведомлений внутри Yarko: короткий сигнал при новом уведомлении или сообщении.
// Не чаще раза в 1,5 секунды и только из одной вкладки (если Yarko открыт в нескольких — не «хором»).
// Выключается в Настройках → Уведомления; выбор хранится на этом устройстве.
const KEY = "krug-sound";
const LAST = "krug-sound-last";
const SRC = "/static/sounds/notify.mp3";
let audio = null;

export function soundEnabled() {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}

export function setSoundEnabled(on) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* приватный режим — просто не запомним */ }
}

function element() {
  if (!audio) {
    audio = new Audio(SRC);
    audio.preload = "auto";
    audio.volume = 0.7;
  }
  return audio;
}

/** Сыграть сигнал. force — для кнопки «Прослушать» в настройках (без проверок) */
export function playNotifySound({ force = false } = {}) {
  if (!force && !soundEnabled()) return;
  const now = Date.now();
  if (!force) {
    try {
      const last = Number(localStorage.getItem(LAST) || 0);
      if (now - last < 1500) return;
      localStorage.setItem(LAST, String(now));
    } catch { /* без хранилища — играем как есть */ }
  }
  try {
    const a = element();
    a.currentTime = 0;
    // браузер может запретить звук до первого нажатия на странице — тогда молча пропускаем
    a.play()?.catch?.(() => {});
  } catch { /* звук недоступен */ }
}

// Заранее подгружаем файл после первого действия человека, чтобы первый сигнал прозвучал без задержки
addEventListener("pointerdown", () => { if (soundEnabled()) element().load(); }, { once: true, passive: true });
