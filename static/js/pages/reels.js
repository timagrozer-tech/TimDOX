// Клипы — короткие вертикальные видео (как Reels): листаются по одному, играют сами, лайк двойным нажатием.
import { api, state } from "../api.js";
import { h, icon, avatar, vmark, pl, richText, timeAgo } from "../dom.js";
import { setTitle, toast, toastError, modal, showMenu, confirmDialog, busy } from "../ui.js";
import { setCleanup, navigate } from "../router.js";
import { videoMeta, fmtDur } from "../components/mediakit.js";
import { burst } from "../fx.js";

const MAX_SECONDS = 90;
const MAX_MB = 30;
let soundOn = false; // звук включается одним нажатием и запоминается до перезагрузки

const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".0", "")} млн` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(".0", "")} тыс` : String(n));

export async function reelsPage({ params, query }) {
  setTitle("Клипы");
  const user = query.user || null;
  const feed = h("div.reels", { tabindex: "-1" });
  const root = h("div.reels-page", feed,
    h("div.reels-top",
      h("h1", user ? `Клипы @${user}` : "Клипы"),
      h("div.spacer"),
      h("button.btn.reel-upload", { type: "button", onclick: () => openUpload((r) => { items.unshift(r); feed.prepend(reelNode(r)); feed.scrollTo({ top: 0 }); }) }, icon("plus", "sm"), h("span", "Клип"))),
    h("div.reels-nav",
      h("button", { type: "button", "aria-label": "Предыдущий клип", onclick: () => step(-1) }, icon("up")),
      h("button", { type: "button", "aria-label": "Следующий клип", onclick: () => step(1) }, icon("down"))));

  let items = [];
  let cursor = null;
  let loading = false;
  let done = false;
  const nodes = new Map();

  // ---- воспроизведение только видимого клипа
  const playIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const v = en.target.querySelector("video");
      if (!v) continue;
      if (en.isIntersecting && en.intersectionRatio > .6) {
        v.muted = !soundOn;
        v.play().catch(() => {});
        en.target.classList.add("active");
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
    const hgt = feed.clientHeight;
    feed.scrollBy({ top: dir * hgt, behavior: "smooth" });
  }
  const onKey = (e) => {
    if (e.target.closest("input, textarea, [contenteditable]") || document.querySelector(".modal")) return;
    if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
    if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
    if (e.key === "m") toggleSound();
  };
  document.addEventListener("keydown", onKey);
  setCleanup(() => document.removeEventListener("keydown", onKey));

  function toggleSound() {
    soundOn = !soundOn;
    feed.querySelectorAll("video").forEach((v) => { v.muted = !soundOn; });
    feed.querySelectorAll(".rl-sound").forEach((b) => b.replaceChildren(icon(soundOn ? "volume" : "mute")));
    toast(soundOn ? "Звук включён" : "Звук выключен", { duration: 1200 });
  }

  function reelNode(r) {
    const video = h("video.rl-video", { "data-src": r.video, poster: r.poster || "", loop: true, muted: true, playsinline: true, preload: "none", "webkit-playsinline": "" });
    video.muted = true;
    const bg = r.poster ? h("div.rl-bg", { style: { backgroundImage: `url("${r.poster}")` } }) : h("div.rl-bg");
    const progress = h("i");
    const likeCount = h("span", short(r.likes));
    const likeBtn = h(`button.rl-act.rl-like${r.liked ? ".on" : ""}`, { type: "button", "aria-label": "Нравится", "aria-pressed": String(r.liked) },
      h("span.rl-ic", icon(r.liked ? "heartFill" : "heart")), likeCount);
    const commentCount = h("span", short(r.comments));
    const pauseIcon = h("div.rl-paused", icon("play"));
    let viewed = false, lastTap = 0;

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

    const stage = h("div.rl-stage", bg, video, pauseIcon);
    stage.addEventListener("click", (e) => {
      const now = Date.now();
      if (now - lastTap < 300) { // двойное нажатие — лайк
        const heart = h("span.rl-heart", { style: { left: `${e.offsetX}px`, top: `${e.offsetY}px` } }, "❤️");
        stage.append(heart);
        setTimeout(() => heart.remove(), 900);
        setLike(true);
        lastTap = 0;
        return;
      }
      lastTap = now;
      setTimeout(() => {
        if (lastTap !== now) return;
        if (video.paused) { video.play().catch(() => {}); node.classList.remove("paused"); } else { video.pause(); node.classList.add("paused"); }
      }, 260);
    });
    video.addEventListener("timeupdate", () => {
      if (video.duration) progress.style.transform = `scaleX(${video.currentTime / video.duration})`;
      if (!viewed && video.currentTime > 2) { viewed = true; api.post(`/api/reels/${r.id}/view`).catch(() => {}); }
    });

    const more = h("button.rl-act", { type: "button", "aria-label": "Ещё" }, h("span.rl-ic", icon("more")));
    more.addEventListener("click", () => showMenu(more, [
      { label: "Скопировать ссылку", icon: "link", onClick: () => share(r, true) },
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
    const node = h("article.reel", { dataset: { id: r.id } },
      stage,
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
        h("button.rl-act", { type: "button", "aria-label": "Поделиться", onclick: () => share(r) }, h("span.rl-ic", icon("share")), h("span", "Поделиться")),
        h("button.rl-act.rl-sound", { type: "button", "aria-label": "Звук", onclick: toggleSound }, icon(soundOn ? "volume" : "mute")),
        more),
      h("div.rl-progress", progress));
    nodes.set(r.id, node);
    playIO.observe(node);
    loadIO.observe(node);
    return node;
  }

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    try {
      const res = await api.get("/api/reels", { cursor, user });
      const fresh = res.items.filter((r) => !nodes.has(r.id));
      items.push(...fresh);
      feed.append(...fresh.map(reelNode));
      cursor = res.next_cursor;
      done = !cursor;
      if (!items.length) { feed.replaceChildren(emptyState()); root.classList.add("is-empty"); }
    } catch (e) { toastError(e); }
    loading = false;
  }

  function emptyState() {
    return h("div.reels-empty",
      h("div.big-ic", "🎬"),
      h("h2", "Клипов пока нет"),
      h("p", "Снимите короткое вертикальное видео — до полутора минут — и покажите его друзьям."),
      h("button.btn.primary", { type: "button", onclick: () => openUpload((r) => { feed.replaceChildren(reelNode(r)); items = [r]; root.classList.remove("is-empty"); }) }, icon("plus", "sm"), "Загрузить клип"));
  }

  if (params.id) {
    try {
      const first = await api.get(`/api/reels/${params.id}`);
      items.push(first);
      feed.append(reelNode(first));
    } catch (e) { toastError(e); }
  }
  await loadMore();
  document.body.classList.add("reels-mode");
  setCleanup(() => document.body.classList.remove("reels-mode"));
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
  const row = (c) => h("div.rl-comment", avatar(c.author, "sm", { presence: false }),
    h("div.grow", h("div", h("a", { href: `/u/${c.author.username}` }, h("b", c.author.name)), h("small.muted", ` · ${timeAgo(c.created_at)}`)),
      h("div.rl-comment-text", ...richText(c.text).childNodes)));
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
      body: h("div.reel-upload",
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
