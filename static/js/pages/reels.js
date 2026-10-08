// Клипы — короткие вертикальные видео (как Reels): листаются по одному, играют сами, лайк двойным нажатием.
import { api, state } from "../api.js";
import { h, icon, avatar, vmark, pl, richText, timeAgo } from "../dom.js";
import { setTitle, toast, toastError, modal, showMenu, confirmDialog, busy } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { videoMeta, fmtDur } from "../components/mediakit.js";
import { burst } from "../fx.js";
import { report } from "../components/post.js";

const MAX_SECONDS = 90;
const MAX_MB = 30;
const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
const pref = {
  get(k, d) { try { const v = localStorage.getItem(`yarko:reels-${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`yarko:reels-${k}`, JSON.stringify(v)); } catch { /* приватный режим */ } },
};
let soundOn = pref.get("sound", false);   // звук и скорость запоминаются
let speed = pref.get("speed", 1);
let autoNext = pref.get("auto", false);   // автолистание: после конца клипа — следующий

const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".0", "")} млн` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(".0", "")} тыс` : String(n));
const clock = (t) => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

export async function reelsPage({ params, query }) {
  setTitle("Клипы");
  const user = query.user || null;
  let mode = !user && query.feed === "following" ? "following" : "all";
  const feed = h("div.reels", { tabindex: "-1" });
  const tabs = user ? null : h("div.rl-tabs", { role: "tablist" },
    ...[["all", "Для вас"], ["following", "Подписки"]].map(([id, label]) => h(`button${mode === id ? ".on" : ""}`, {
      type: "button", role: "tab", "aria-selected": String(mode === id), dataset: { mode: id }, onclick: () => switchMode(id),
    }, label)));
  const root = h("div.reels-page", feed,
    h("div.reels-top",
      user ? h("h1", `Клипы @${user}`) : tabs,
      h("div.spacer"),
      h("button.btn.reel-upload", { type: "button", onclick: () => openUpload((r) => { items.unshift(r); feed.prepend(reelNode(r)); feed.scrollTo({ top: 0 }); }) }, icon("plus", "sm"), h("span", "Клип"))),
    h("div.reels-nav",
      h("button", { type: "button", "aria-label": "Предыдущий клип", onclick: () => step(-1) }, icon("up")),
      h("button", { type: "button", "aria-label": "Следующий клип", onclick: () => step(1) }, icon("down"))));

  let items = [];
  let cursor = null;
  let loading = false;
  let done = false;
  let current = null;            // активный клип: { node, video }
  const nodes = new Map();

  // ---- воспроизведение только видимого клипа
  const playIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const v = en.target.querySelector("video");
      if (!v) continue;
      if (en.isIntersecting && en.intersectionRatio > .6) {
        if (!v.src && v.dataset.src) v.src = v.dataset.src;
        v.muted = !soundOn;
        v.playbackRate = speed;
        v.loop = !autoNext;
        if (!en.target.classList.contains("paused")) v.play().catch(() => {});
        en.target.classList.add("active");
        current = { node: en.target, video: v };
        const idx = [...feed.children].indexOf(en.target);
        if (idx >= feed.children.length - 3) loadMore();
      } else {
        v.pause();
        en.target.classList.remove("active");
      }
    }
  }, { root: feed, threshold: [0, .6, 1] });
  // заранее подгружаем соседние видео
  const loadIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const v = en.target.querySelector("video");
      if (v && !v.src) { v.src = v.dataset.src; v.preload = "auto"; }
      loadIO.unobserve(en.target);
    }
  }, { root: feed, rootMargin: "150% 0px" });

  setCleanup(() => { playIO.disconnect(); loadIO.disconnect(); feed.querySelectorAll("video").forEach((v) => { v.pause(); v.removeAttribute("src"); v.load(); }); });

  function step(dir) {
    feed.scrollBy({ top: dir * feed.clientHeight, behavior: "smooth" });
  }
  const onKey = (e) => {
    if (e.target.closest("input, textarea, [contenteditable]") || document.querySelector(".modal")) return;
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
    else if (e.key === "m") toggleSound();
    else if (e.key === " " || e.key === "k") { e.preventDefault(); current?.node._toggle?.(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); current?.node._seek?.(5); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); current?.node._seek?.(-5); }
  };
  document.addEventListener("keydown", onKey);
  setCleanup(() => document.removeEventListener("keydown", onKey));

  function toggleSound() {
    soundOn = !soundOn;
    pref.set("sound", soundOn);
    feed.querySelectorAll("video").forEach((v) => { v.muted = !soundOn; });
    feed.querySelectorAll(".rl-sound").forEach((b) => b.replaceChildren(h("span.rl-ic", icon(soundOn ? "volume" : "mute")), h("span", soundOn ? "Звук" : "Без звука")));
  }
  function setSpeed(x) {
    speed = x;
    pref.set("speed", x);
    feed.querySelectorAll("video").forEach((v) => { v.playbackRate = x; });
    feed.querySelectorAll(".rl-speed").forEach((b) => { b.textContent = `${x}×`; b.hidden = x === 1; });
    toast(`Скорость ${x}×`, { duration: 1000 });
  }
  function setAuto(on) {
    autoNext = on;
    pref.set("auto", on);
    feed.querySelectorAll("video").forEach((v) => { v.loop = !on; });
    toast(on ? "Автолистание включено — следующий клип начнётся сам" : "Автолистание выключено", { duration: 1600 });
  }

  async function switchMode(id) {
    if (id === mode) return;
    mode = id;
    tabs?.querySelectorAll("button").forEach((b) => { const on = b.dataset.mode === id; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); });
    history.replaceState(history.state, "", id === "following" ? "/reels?feed=following" : "/reels");
    feed.querySelectorAll("video").forEach((v) => { v.pause(); v.removeAttribute("src"); v.load(); });
    for (const n of nodes.values()) { playIO.unobserve(n); loadIO.unobserve(n); }
    nodes.clear(); items = []; cursor = null; done = false; current = null;
    root.classList.remove("is-empty");
    feed.replaceChildren(h("div.reels-loading", h("div.spinner")));
    feed.scrollTo({ top: 0 });
    await loadMore(true);
  }

  function reelNode(r) {
    const video = h("video.rl-video", { "data-src": r.video, poster: r.poster || "", loop: !autoNext, muted: true, playsinline: true, preload: "none", "webkit-playsinline": "" });
    video.muted = true;
    const bg = r.poster ? h("div.rl-bg", { style: { backgroundImage: `url("${r.poster}")` } }) : h("div.rl-bg");
    const likeCount = h("span", short(r.likes));
    const likeBtn = h(`button.rl-act.rl-like${r.liked ? ".on" : ""}`, { type: "button", "aria-label": "Нравится", "aria-pressed": String(r.liked) },
      h("span.rl-ic", icon(r.liked ? "heartFill" : "heart")), likeCount);
    const commentCount = h("span", short(r.comments));
    const pauseIcon = h("div.rl-paused", icon("play"));
    const buffer = h("div.rl-buffer", h("div.spinner"));
    const fastBadge = h("div.rl-fast", "2× ", icon("skipForward", "sm"));
    const speedBadge = h("button.rl-speed", { type: "button", hidden: speed === 1, "aria-label": "Скорость воспроизведения", onclick: (e) => { e.stopPropagation(); speedMenu(e.currentTarget); } }, `${speed}×`);
    let viewed = false;

    async function setLike(on, e) {
      if (on === r.liked) return;
      r.liked = on; r.likes += on ? 1 : -1;
      paintLike();
      if (on && e) burst(e.currentTarget || likeBtn, "❤️", 10);
      try {
        const res = on ? await api.post(`/api/reels/${r.id}/like`) : await api.del(`/api/reels/${r.id}/like`);
        r.likes = res.likes; paintLike();
      } catch (err) { r.liked = !on; r.likes += on ? -1 : 1; paintLike(); toastError(err); }
    }
    const paintLike = () => {
      likeBtn.classList.toggle("on", r.liked);
      likeBtn.setAttribute("aria-pressed", String(r.liked));
      likeBtn.querySelector(".rl-ic").replaceChildren(icon(r.liked ? "heartFill" : "heart"));
      likeCount.textContent = short(r.likes);
    };
    likeBtn.addEventListener("click", (e) => setLike(!r.liked, e));

    const toggle = () => {
      if (video.paused) { video.play().catch(() => {}); node.classList.remove("paused"); } else { video.pause(); node.classList.add("paused"); }
    };
    const ripple = (side, text) => {
      const el = h(`div.rl-seek.${side}`, h("b", text));
      stage.append(el);
      setTimeout(() => el.remove(), 650);
    };
    const seek = (d) => {
      if (!video.duration) return;
      video.currentTime = Math.max(0, Math.min(video.duration - .05, video.currentTime + d));
      ripple(d < 0 ? "left" : "right", `${d < 0 ? "−" : "+"}${Math.abs(d)} с`);
    };

    // ---- жесты: нажатие — пауза, двойное — лайк (по краям — перемотка ±5 с), удержание — ускорение 2×
    const stage = h("div.rl-stage", bg, video, pauseIcon, buffer, fastBadge);
    let lastTap = 0, tapTimer = 0, holdTimer = 0, holding = false, downAt = null;
    stage.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      downAt = { x: e.clientX, y: e.clientY };
      holdTimer = setTimeout(() => {
        holding = true;
        video.playbackRate = Math.max(2, speed);
        if (video.paused) video.play().catch(() => {});
        node.classList.add("fast");
      }, 380);
    });
    const endHold = () => {
      clearTimeout(holdTimer);
      if (!holding) return false;
      holding = false;
      video.playbackRate = speed;
      node.classList.remove("fast");
      return true;
    };
    stage.addEventListener("pointermove", (e) => { if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 12) { clearTimeout(holdTimer); downAt = null; } });
    stage.addEventListener("pointercancel", () => { endHold(); downAt = null; });
    stage.addEventListener("pointerleave", () => { endHold(); });
    stage.addEventListener("contextmenu", (e) => e.preventDefault());
    stage.addEventListener("pointerup", (e) => {
      if (endHold() || !downAt) { downAt = null; return; }
      downAt = null;
      const rect = stage.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const now = Date.now();
      if (now - lastTap < 300) {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (x < .3) return seek(-5);
        if (x > .7) return seek(5);
        const heart = h("span.rl-heart", { style: { left: `${e.clientX - rect.left}px`, top: `${e.clientY - rect.top}px` } }, "❤️");
        stage.append(heart);
        setTimeout(() => heart.remove(), 900);
        setLike(true);
        return;
      }
      lastTap = now;
      tapTimer = setTimeout(() => { if (lastTap === now) toggle(); }, 280);
    });

    // ---- полоса прогресса с перемоткой пальцем
    const fill = h("i");
    const knob = h("b.rl-knob");
    const bubble = h("span.rl-time");
    const bar = h("div.rl-progress", { role: "slider", "aria-label": "Перемотка", "aria-valuemin": "0", tabindex: "-1" }, h("div.rl-track", fill, knob), bubble);
    const paint = (t) => {
      const d = video.duration || r.duration || 0;
      const k = d ? Math.min(1, t / d) : 0;
      fill.style.transform = `scaleX(${k})`;
      knob.style.left = `${k * 100}%`;
      bubble.textContent = `${clock(t)} / ${clock(d)}`;
      bar.setAttribute("aria-valuenow", String(Math.round(t)));
    };
    let scrubbing = false, wasPaused = false;
    const scrubTo = (e) => {
      const rect = bar.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const d = video.duration || 0;
      if (d) { video.currentTime = k * d; paint(k * d); }
    };
    bar.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      scrubbing = true; wasPaused = video.paused;
      video.pause();
      node.classList.add("scrubbing");
      bar.setPointerCapture?.(e.pointerId);
      scrubTo(e);
    });
    bar.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e); });
    const scrubEnd = () => {
      if (!scrubbing) return;
      scrubbing = false;
      node.classList.remove("scrubbing");
      if (!wasPaused) video.play().catch(() => {});
    };
    bar.addEventListener("pointerup", scrubEnd);
    bar.addEventListener("pointercancel", scrubEnd);

    video.addEventListener("timeupdate", () => {
      if (!scrubbing) paint(video.currentTime);
      if (!viewed && video.currentTime > 2) { viewed = true; api.post(`/api/reels/${r.id}/view`).catch(() => {}); }
    });
    video.addEventListener("waiting", () => node.classList.add("buffering"));
    video.addEventListener("playing", () => node.classList.remove("buffering"));
    video.addEventListener("canplay", () => node.classList.remove("buffering"));
    video.addEventListener("ended", () => { if (autoNext && node.classList.contains("active")) step(1); });

    function speedMenu(anchor) {
      showMenu(anchor, SPEEDS.map((x) => ({ label: x === 1 ? "Обычная" : `${x}×`, checked: x === speed, onClick: () => setSpeed(x) })), { title: "Скорость" });
    }
    const more = h("button.rl-act", { type: "button", "aria-label": "Ещё" }, h("span.rl-ic", icon("more")), h("span", "Ещё"));
    more.addEventListener("click", () => showMenu(more, [
      { label: `Скорость: ${speed === 1 ? "обычная" : `${speed}×`}`, icon: "clock", onClick: () => setTimeout(() => speedMenu(more), 0) },
      { label: autoNext ? "Выключить автолистание" : "Автолистание", hint: "Следующий клип начнётся сам", icon: "repeat", onClick: () => setAuto(!autoNext) },
      document.pictureInPictureEnabled ? { label: "Картинка в картинке", icon: "monitor", onClick: () => video.requestPictureInPicture?.().catch(() => toast("Не получилось открыть окно поверх")) } : null,
      { label: "Скопировать ссылку", icon: "link", onClick: () => share(r, true) },
      !r.mine ? { label: "Пожаловаться", icon: "flag", danger: true, onClick: () => report("reel", r.id) } : null,
      r.mine ? { label: "Удалить клип", icon: "trash", danger: true, onClick: async () => {
        if (!await confirmDialog({ title: "Удалить клип?", text: "Видео, лайки и комментарии будут удалены.", confirm: "Удалить", danger: true })) return;
        try { await api.del(`/api/reels/${r.id}`); node.remove(); toast("Клип удалён"); } catch (e) { toastError(e); }
      } } : null,
    ]));

    const caption = h("div.rl-caption", ...richText(r.caption || "").childNodes);
    if ((r.caption || "").length > 90) {
      caption.classList.add("clamp");
      caption.addEventListener("click", (e) => { e.stopPropagation(); caption.classList.toggle("clamp"); });
    }
    const sound = h("button.rl-act.rl-sound", { type: "button", "aria-label": "Звук", onclick: toggleSound },
      h("span.rl-ic", icon(soundOn ? "volume" : "mute")), h("span", soundOn ? "Звук" : "Без звука"));
    const node = h("article.reel", { dataset: { id: r.id } },
      stage,
      speedBadge,
      h("div.rl-info",
        h("div.rl-author",
          h("a", { href: `/u/${r.author.username}`, "aria-label": r.author.name }, avatar(r.author, "sm", { presence: false })),
          h("a.rl-name", { href: `/u/${r.author.username}` }, r.author.name, vmark(r.author)),
          !r.mine && !r.following ? h("button.rl-follow", { type: "button", onclick: async (e) => {
            const b = e.currentTarget;
            try { await api.post(`/api/people/${r.author.id}/follow`); b.replaceWith(h("span.rl-followed", "Вы подписаны")); } catch (err) { toastError(err); }
          } }, "Подписаться") : null),
        caption,
        h("div.rl-meta", `${short(r.views)} ${pl(r.views, ["просмотр", "просмотра", "просмотров"]).split(" ")[1]} · ${timeAgo(r.created_at)}${r.duration ? ` · ${fmtDur(r.duration)}` : ""}`)),
      h("div.rl-rail",
        likeBtn,
        h("button.rl-act", { type: "button", "aria-label": "Комментарии", onclick: () => openComments(r, commentCount) }, h("span.rl-ic", icon("comment")), commentCount),
        h("button.rl-act", { type: "button", "aria-label": "Поделиться", onclick: () => share(r) }, h("span.rl-ic", icon("share")), h("span", "Отправить")),
        sound,
        more),
      bar);
    node._toggle = toggle;
    node._seek = seek;
    paint(0);
    nodes.set(r.id, node);
    playIO.observe(node);
    loadIO.observe(node);
    return node;
  }

  async function loadMore(fresh = false) {
    if (loading || done) return;
    loading = true;
    const want = mode;
    try {
      const res = await api.get("/api/reels", { cursor, user, feed: mode === "following" ? "following" : null });
      if (want !== mode) return;
      if (fresh) feed.replaceChildren();
      const add = res.items.filter((r) => !nodes.has(r.id));
      items.push(...add);
      feed.append(...add.map(reelNode));
      cursor = res.next_cursor;
      done = !cursor;
      if (!items.length) { feed.replaceChildren(emptyState()); root.classList.add("is-empty"); }
    } catch (e) { toastError(e); } finally { loading = false; }
  }

  function emptyState() {
    const following = mode === "following";
    return h("div.reels-empty",
      h("div.big-ic", following ? "👀" : "🎬"),
      h("h2", following ? "Здесь появятся клипы ваших подписок" : "Клипов пока нет"),
      h("p", following ? "Подпишитесь на авторов во вкладке «Для вас» — их новые клипы будут собираться здесь."
        : "Снимите короткое вертикальное видео — до полутора минут — и покажите его друзьям."),
      following ? h("button.btn.primary", { type: "button", onclick: () => switchMode("all") }, "Смотреть «Для вас»")
        : h("button.btn.primary", { type: "button", onclick: () => openUpload((r) => { feed.replaceChildren(reelNode(r)); items = [r]; root.classList.remove("is-empty"); }) }, icon("plus", "sm"), "Загрузить клип"));
  }

  if (params.id) {
    try {
      const first = await api.get(`/api/reels/${params.id}`);
      items.push(first);
      feed.append(reelNode(first));
    } catch (e) { toastError(e); }
  }
  const here = location.pathname;
  await loadMore();
  if (location.pathname !== here) return root; // пока грузилось, человек ушёл на другую страницу
  document.body.classList.add("reels-mode");
  setCleanup(() => document.body.classList.remove("reels-mode"));
  if (!pref.get("hint", false)) {
    pref.set("hint", true);
    setTimeout(() => toast("Подсказка: удерживайте — 2×, двойное нажатие по краю — перемотка на 5 секунд", { duration: 4500 }), 1200);
  }
  return root;
}

function share(r, copyOnly = false) {
  const url = `${location.origin}/reels/${r.id}`;
  if (!copyOnly && navigator.share) {
    navigator.share({ title: `Клип ${r.author.name}`, url }).catch(() => {});
    return;
  }
  navigator.clipboard?.writeText(url).then(() => toast("Ссылка на клип скопирована", { icon: "link" }), () => toast(url));
}

async function openComments(r, counter) {
  const list = h("div.rl-comments", h("div.spinner"));
  const input = h("input.input", { placeholder: "Добавьте комментарий…", maxlength: 1000, "aria-label": "Комментарий" });
  const send = h("button.btn.primary.icon-only", { type: "submit", "aria-label": "Отправить" }, icon("send"));
  const form = h("form.rl-comment-form", input, send);
  modal({ title: "Комментарии", body: h("div.stack", list), footer: [form] });
  const row = (c) => {
    const el = h("div.rl-comment", avatar(c.author, "sm", { presence: false }),
      h("div.grow", h("div", h("a", { href: `/u/${c.author.username}` }, h("b", c.author.name)), h("small.muted", ` · ${timeAgo(c.created_at)}`)),
        h("div.rl-comment-text", ...richText(c.text).childNodes)));
    const menuBtn = h("button.btn.ghost.icon-only.sm", { type: "button", "aria-label": "Действия с комментарием" }, icon("more", "sm"));
    menuBtn.addEventListener("click", () => showMenu(menuBtn, [
      c.mine || r.mine ? { label: "Удалить", icon: "trash", danger: true, onClick: async () => {
        try { await api.del(`/api/reel-comments/${c.id}`); el.remove(); counter.textContent = String(Math.max(0, (+counter.textContent || 1) - 1)); } catch (e) { toastError(e); }
      } } : null,
      !c.mine ? { label: "Пожаловаться", icon: "flag", danger: true, onClick: () => report("reel_comment", c.id) } : null,
    ]));
    el.append(menuBtn);
    return el;
  };
  const load = async () => {
    const { items } = await api.get(`/api/reels/${r.id}/comments`);
    list.replaceChildren(...(items.length ? items.map(row) : [h("p.muted", { style: { textAlign: "center", padding: "20px 0" } }, "Будьте первым, кто оставит комментарий 💬")]));
    list.scrollTop = list.scrollHeight;
  };
  load().catch((e) => list.replaceChildren(h("p.muted", e.message)));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    busy(send, async () => {
      try {
        const c = await api.post(`/api/reels/${r.id}/comments`, { text });
        input.value = "";
        list.querySelector("p.muted")?.remove();
        list.append(row(c));
        r.comments++; counter.textContent = short(r.comments);
        list.scrollTop = list.scrollHeight;
      } catch (err) { toastError(err); }
    });
  });
}

/** Загрузка клипа: выбор видео, предпросмотр, подпись, прогресс */
export function openUpload(onDone) {
  const input = h("input", { type: "file", accept: "video/mp4,video/webm,video/quicktime", hidden: true });
  document.body.append(input);
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > MAX_MB * 1024 * 1024) return toast(`Видео больше ${MAX_MB} МБ — выберите покороче`, { error: true });
    const meta = await videoMeta(file);
    if (meta.duration > MAX_SECONDS + 1) return toast(`Клип должен быть не длиннее ${MAX_SECONDS} секунд (у вас ${fmtDur(meta.duration)})`, { error: true });
    const url = URL.createObjectURL(file);
    const caption = h("textarea.textarea", { rows: 3, maxlength: 2200, placeholder: "Подпись, #теги, @упоминания" });
    const bar = h("div.bar", h("i", { style: { width: "0%" } }));
    const status = h("small.muted", `${fmtDur(meta.duration)} · ${(file.size / 1048576).toFixed(1)} МБ`);
    const publish = h("button.btn.primary", { type: "button" }, "Опубликовать");
    let upload = null;
    const m = modal({
      title: "Новый клип",
      body: h("div.reel-upload-form",
        h("div.ru-preview", h("video", { src: url, autoplay: true, muted: true, loop: true, playsinline: true })),
        h("div.stack.grow", caption, status, bar)),
      footer: [h("button.btn.ghost", { type: "button", onclick: () => { upload?.abort(); m.close(); } }, "Отмена"), publish],
      onClose: () => { upload?.abort(); URL.revokeObjectURL(url); },
    });
    publish.addEventListener("click", async () => {
      publish.disabled = true;
      const fd = new FormData();
      fd.append("caption", caption.value);
      if (meta.duration) fd.append("duration", String(meta.duration));
      if (meta.width) { fd.append("width", String(meta.width)); fd.append("height", String(meta.height)); }
      if (meta.poster) fd.append("poster", meta.poster, "poster.jpg");
      fd.append("video", file, file.name);
      upload = api.upload("/api/reels", fd, (p) => {
        bar.firstChild.style.width = `${Math.round(p * 100)}%`;
        status.textContent = p < 1 ? `Загружаем… ${Math.round(p * 100)}%` : "Обрабатываем…";
      });
      try {
        const r = await upload.promise;
        upload = null;
        m.close();
        toast("Клип опубликован 🎬", { icon: "check" });
        onDone?.(r);
      } catch (err) {
        publish.disabled = false;
        if (err.code !== "aborted") toastError(err);
      }
    });
  });
  input.click();
}

export { navigate, state };
