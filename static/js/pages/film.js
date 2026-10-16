// «Фильм о вас»: браузер сам монтирует ролик о жизни человека в Ярко — фото, друзья, цифры, лучший пост,
// слово года — и сочиняет под него музыку (Web Audio). Фильм записывается в видео (MediaRecorder): его можно
// скачать, отправить или сразу опубликовать в Клипы. Всё считается на телефоне, сервер отдаёт только данные.
import { api } from "../api.js";
import { h, icon, thumb } from "../dom.js";
import { setTitle, toast, toastError } from "../ui.js";
import { setCleanup, navigate } from "../router.js";

const W = 720, H = 1280, BPM = 112, SPB = 60 / BPM; // секунд на долю
const FONT_T = "Unbounded, Manrope, system-ui, sans-serif";
const FONT_B = "Manrope, system-ui, sans-serif";

/* ------------------------------------------------------------ утилиты */
function rng(seed) { // mulberry32 — у каждого свой, но всегда одинаковый фильм
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => { x = clamp(x); return 1 - Math.pow(1 - x, 3); };
const easeIO = (x) => { x = clamp(x); return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const back = (x) => { x = clamp(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const lerp = (a, b, t) => a + (b - a) * t;
const fmtN = (n) => Math.round(n).toLocaleString("ru-RU");
const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many; };
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const dateRu = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

function loadImg(src, timeout = 7000) {
  return new Promise((res) => {
    if (!src) { res(null); return; }
    const im = new Image();
    im.crossOrigin = "anonymous"; // картинка не должна «запачкать» холст — иначе видео не записать
    im.decoding = "async";
    const t = setTimeout(() => res(null), timeout);
    im.onload = () => { clearTimeout(t); res(im.naturalWidth ? im : null); };
    im.onerror = () => { clearTimeout(t); res(null); };
    im.src = src;
  });
}
function cover(g, im, x, y, w, hh, zoom = 1, px = 0, py = 0) {
  const s = Math.max(w / im.naturalWidth, hh / im.naturalHeight) * zoom;
  const iw = im.naturalWidth * s, ih = im.naturalHeight * s;
  g.drawImage(im, x + (w - iw) / 2 + px * (iw - w) / 2, y + (hh - ih) / 2 + py * (ih - hh) / 2, iw, ih);
}
function circleImg(g, im, cx, cy, r, fallbackText, color) {
  g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath(); g.clip();
  if (im) cover(g, im, cx - r, cy - r, r * 2, r * 2);
  else {
    g.fillStyle = color || "#4a6d93"; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = "#fff"; g.font = `700 ${Math.round(r * .8)}px ${FONT_T}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(fallbackText || "?", cx, cy + r * .04);
  }
  g.restore();
}
function initials(name) { return (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase(); }
function fitFont(g, text, weight, family, maxW, maxPx, minPx = 20) {
  let px = maxPx;
  for (; px > minPx; px -= 2) { g.font = `${weight} ${px}px ${family}`; if (g.measureText(text).width <= maxW) break; }
  return px;
}
function wrap(g, text, maxW, maxLines = 8) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  const lines = []; let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; if (lines.length === maxLines) break; } else line = t;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  return lines;
}

/* ------------------------------------------------------------ сценарий */
function buildScript(d, assets) {
  const c = d.counts, r = rng((d.me.id || 7) * 2654435761);
  const S = [];
  const add = (beats, draw, extra = {}) => S.push({ beats, draw, ...extra });

  add(8, sIntro, { pal: ["#ff3d2e", "#ff9a3c"] });
  add(8, sDays, { pal: ["#f4ead5", "#e8d9b8"] });
  const ph = assets.photos.slice(0, 6);
  if (ph.length) add(ph.length === 1 ? 4 : Math.ceil(ph.length * 2 / 4) * 4, sPhotos, { pal: ["#0d0d0d", "#1a1a1a"], photos: ph });
  const stats = [
    ["posts", c.posts, ["пост", "поста", "постов"], "вы написали"],
    ["reactions", c.reactions, ["реакция", "реакции", "реакций"], "вам подарили"],
    ["comments", c.comments, ["комментарий", "комментария", "комментариев"], "вам оставили"],
    ["messages", c.messages, ["сообщение", "сообщения", "сообщений"], "вы отправили"],
    ["photos", c.photos, ["фото", "фото", "фото"], "вы показали"],
    ["reels", c.reels, ["клип", "клипа", "клипов"], "вы сняли"],
    ["songs", c.songs, ["песня", "песни", "песен"], "вы загрузили"],
  ].filter((s) => s[1] > 0).slice(0, 4);
  if (stats.length) add(Math.max(8, stats.length * 2 + 4), sNumbers, { pal: ["#ffd400", "#ffb800"], stats });
  add(d.friends.length ? 12 : 8, sFriends, { pal: ["#00a99d", "#08605d"] });
  if (d.word) add(8, sWord, { pal: ["#ff2e88", "#3a0d4f"] });
  if (d.top_post) add(12, sPost, { pal: ["#2f5bff", "#1834b0"] });
  const hours = d.times.map((t) => new Date(t).getHours()).filter((x) => !isNaN(x));
  if (hours.length >= 3) {
    const cnt = Array(24).fill(0); hours.forEach((x) => cnt[x]++);
    const best = cnt.indexOf(Math.max(...cnt));
    add(8, sTime, { pal: best >= 6 && best < 18 ? ["#ffcf7a", "#ff8a5c"] : ["#24324a", "#101826"], hour: best, cnt });
  }
  add(12, sFinale, { pal: ["#4a6d93", "#16263a"] });

  let beat = 0;
  for (const s of S) { s.start = beat; beat += s.beats; }
  return { scenes: S, beats: beat, dur: beat * SPB + 1.2, seed: r };
}

/* фон сцены: две краски, мягкие пятна, зерно плёнки */
let grain;
function makeGrain() {
  grain = document.createElement("canvas"); grain.width = grain.height = 256;
  const gg = grain.getContext("2d"), im = gg.createImageData(256, 256);
  for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 26; }
  gg.putImageData(im, 0, 0);
}
function bg(g, pal, t, seed = 0) {
  const gr = g.createLinearGradient(0, 0, W * .3, H);
  gr.addColorStop(0, pal[0]); gr.addColorStop(1, pal[1]);
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.save(); g.globalCompositeOperation = "soft-light";
  for (let i = 0; i < 3; i++) {
    const x = W * (.5 + .45 * Math.sin(t * .35 + i * 2.1 + seed)), y = H * (.5 + .4 * Math.cos(t * .27 + i * 1.7 + seed));
    const rg = g.createRadialGradient(x, y, 0, x, y, 520);
    rg.addColorStop(0, "rgba(255,255,255,.55)"); rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }
  g.restore();
}
function finish(g, t, pulse) {
  // зерно и виньетка — «киношность»
  g.save(); g.globalAlpha = .9;
  const ox = Math.floor(Math.random() * 256), oy = Math.floor(Math.random() * 256);
  g.translate(-ox, -oy); g.fillStyle = g.createPattern(grain, "repeat"); g.fillRect(ox, oy, W, H);
  g.restore();
  const v = g.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, H * .75);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, `rgba(0,0,0,${.38 + pulse * .05})`);
  g.fillStyle = v; g.fillRect(0, 0, W, H);
}
function wipe(g, lt, color) {
  // смена сцены: цветные полосы уезжают вверх по очереди
  if (lt > .55) return;
  const n = 6, bw = W / n;
  g.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const k = clamp((lt - i * .045) / .32);
    const hh = H * (1 - easeIO(k));
    if (hh > 0) g.fillRect(i * bw - 1, 0, bw + 2, hh);
  }
}
function label(g, text, x, y, color, size = 26, align = "center", spacing = 6) {
  g.save(); g.font = `800 ${size}px ${FONT_B}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = "alphabetic";
  if ("letterSpacing" in g) g.letterSpacing = spacing + "px";
  g.fillText(text.toUpperCase(), x, y); g.restore();
}

/* ------------------------------------------------------------ сцены (lt — секунды от начала сцены, b — доля в сцене) */
function sIntro(g, F, lt, b, pulse) {
  const { d, A } = F;
  bg(g, this.pal, F.t, 1);
  // «ЯРКО ПРЕДСТАВЛЯЕТ» — по букве на восьмую
  const tag = "ЯРКО ПРЕДСТАВЛЯЕТ";
  const shown = Math.floor(clamp(lt / (SPB * 2.2)) * tag.length);
  label(g, tag.slice(0, shown), W / 2, 250, "rgba(255,255,255,.92)", 28, "center", 10);
  const k = ease((b - 2.5) / 2);
  if (k > 0) {
    const r = 170 * back((b - 2.5) / 1.6);
    for (let i = 0; i < 3; i++) { // кольца в такт
      g.strokeStyle = `rgba(255,255,255,${(.5 - i * .14) * (.4 + pulse * .6)})`; g.lineWidth = 6 - i * 1.5;
      g.beginPath(); g.arc(W / 2, 600, r + 26 + i * 30 + pulse * 18, 0, Math.PI * 2); g.stroke();
    }
    circleImg(g, A.avatar, W / 2, 600, Math.max(1, r), initials(d.me.name), "#b3241a");
  }
  const k2 = ease((b - 4) / 1.5);
  if (k2 > 0) {
    g.save(); g.globalAlpha = k2; g.fillStyle = "#fff"; g.textAlign = "center";
    const px = fitFont(g, d.me.name, 700, FONT_T, W - 100, 82);
    g.font = `700 ${px}px ${FONT_T}`; g.fillText(d.me.name, W / 2, 920 + (1 - k2) * 60);
    g.font = `600 30px ${FONT_B}`; g.globalAlpha = k2 * .85;
    g.fillText(`@${d.me.username}${d.me.city ? " · " + d.me.city : ""}`, W / 2, 985 + (1 - k2) * 60);
    g.restore();
  }
  const k3 = ease((b - 5.5) / 1.5);
  if (k3 > 0) { g.globalAlpha = k3; label(g, "фильм о вас", W / 2, 1110, "rgba(255,255,255,.9)", 30, "center", 8); g.globalAlpha = 1; }
}

function sDays(g, F, lt, b) {
  const { d } = F;
  bg(g, this.pal, F.t, 2);
  const joined = new Date(d.me.joined);
  const days = Math.max(1, Math.ceil((Date.now() - joined) / 864e5));
  const n = Math.round(days * easeIO(b / 4));
  label(g, "вы в Ярко уже", W / 2, 330, "#7a5c2e", 30);
  g.fillStyle = "#1b1b1b"; g.textAlign = "center";
  const s = fmtN(n);
  const px = fitFont(g, s, 700, FONT_T, W - 80, 300);
  g.font = `700 ${px}px ${FONT_T}`; g.fillText(s, W / 2, 640);
  g.font = `800 64px ${FONT_T}`; g.fillText(plural(n, "день", "дня", "дней"), W / 2, 740);
  const k = ease((b - 3) / 1.5);
  g.globalAlpha = k;
  g.font = `600 32px ${FONT_B}`; g.fillStyle = "#3b2f1d";
  g.fillText(`с ${dateRu(d.me.joined)}`, W / 2, 820);
  if (d.first_post) {
    const k2 = ease((b - 4.5) / 1.5);
    g.globalAlpha = k2;
    g.save(); g.translate(W / 2, 1010 + (1 - k2) * 40); g.rotate(-.025);
    g.fillStyle = "#1b1b1b"; g.fillRect(-300, -95, 600, 190);
    g.fillStyle = "#f4ead5"; g.font = `800 20px ${FONT_B}`; if ("letterSpacing" in g) g.letterSpacing = "4px";
    g.fillText("ПЕРВЫЙ ПОСТ · " + dateRu(d.first_post.created_at).toUpperCase(), 0, -50);
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    g.font = `600 28px ${FONT_B}`;
    wrap(g, "«" + d.first_post.text + "»", 540, 3).forEach((l, i) => g.fillText(l, 0, -5 + i * 36));
    g.restore();
  }
  g.globalAlpha = 1;
}

function sPhotos(g, F, lt, b, pulse) {
  const per = this.beats / this.photos.length;
  const i = Math.min(this.photos.length - 1, Math.floor(b / per));
  const lb = (b - i * per) / per;
  g.fillStyle = "#0d0d0d"; g.fillRect(0, 0, W, H);
  const im = this.photos[i];
  g.save();
  // кадр на плёнке: поля и перфорация по краям
  const fx = 70, fy = 150, fw = W - 140, fh = H - 300;
  g.beginPath(); g.rect(fx, fy, fw, fh); g.clip();
  const dir = i % 2 ? 1 : -1;
  cover(g, im, fx, fy, fw, fh, 1.08 + lb * .14, dir * (lb - .5) * .6, (lb - .5) * .3);
  g.restore();
  g.fillStyle = "rgba(255,255,255," + (pulse * .16) + ")"; g.fillRect(fx, fy, fw, fh); // вспышка в такт
  g.fillStyle = "#e9e2d0";
  for (let y = ((F.t * 220) % 70) - 70; y < H; y += 70) { g.fillRect(22, y, 26, 40); g.fillRect(W - 48, y, 26, 40); }
  label(g, "ваши кадры", W / 2, 105, "#e9e2d0", 26, "center", 10);
  g.font = `700 26px ${FONT_T}`; g.fillStyle = "#e9e2d0"; g.textAlign = "center";
  g.fillText(`${String(i + 1).padStart(2, "0")} / ${String(this.photos.length).padStart(2, "0")}`, W / 2, H - 92);
}

function sNumbers(g, F, lt, b, pulse) {
  bg(g, this.pal, F.t, 3);
  label(g, "ваша жизнь в цифрах", W / 2, 190, "#1b1b1b", 28, "center", 8);
  const top = 300, rowH = (H - top - 160) / this.stats.length;
  this.stats.forEach(([, v, word, pre], i) => {
    const k = (b - 1 - i * 2) / 1.6;
    if (k <= 0) return;
    const y = top + i * rowH;
    g.save(); g.translate(W / 2, y + rowH / 2); g.rotate((i % 2 ? 1 : -1) * .02 * (1 - ease(k))); g.scale(back(k), back(k));
    g.fillStyle = "#1b1b1b"; g.textAlign = "center";
    g.font = `700 22px ${FONT_B}`; if ("letterSpacing" in g) g.letterSpacing = "5px";
    g.fillText(pre.toUpperCase(), 0, -rowH * .36);
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    const cur = Math.round(v * easeIO(k * .9)), n = fmtN(cur);
    const px = fitFont(g, n, 700, FONT_T, W - 120, Math.min(150, rowH * .42));
    g.font = `700 ${px}px ${FONT_T}`; g.fillText(n, 0, rowH * .1);
    g.font = `800 32px ${FONT_B}`; g.fillText(plural(cur, ...word), 0, rowH * .1 + 42);
    g.restore();
  });
  g.fillStyle = `rgba(27,27,27,${.08 + pulse * .1})`;
  g.fillRect(0, H - 24, W * clamp(b / this.beats), 24);
}

function sFriends(g, F, lt, b, pulse) {
  const { d, A } = F;
  bg(g, this.pal, F.t, 4);
  const fr = d.friends;
  if (!fr.length) {
    label(g, "ваши люди", W / 2, 300, "#e6fffb", 30, "center", 8);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + F.t * .3;
      g.setLineDash([10, 12]); g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 4;
      g.beginPath(); g.arc(W / 2 + Math.cos(a) * 200, 660 + Math.sin(a) * 200, 60 + pulse * 6, 0, Math.PI * 2); g.stroke();
    }
    g.setLineDash([]);
    circleImg(g, A.avatar, W / 2, 660, 90, initials(d.me.name), "#0b6e6e");
    g.fillStyle = "#fff"; g.textAlign = "center"; g.font = `700 44px ${FONT_T}`;
    g.fillText("скоро здесь", W / 2, 1000); g.fillText("будут друзья", W / 2, 1060);
    return;
  }
  label(g, "ваши люди", W / 2, 190, "#e6fffb", 28, "center", 8);
  g.fillStyle = "#fff"; g.textAlign = "center"; g.font = `700 64px ${FONT_T}`;
  const n = d.counts.friends;
  g.fillText(`${fmtN(n * ease(b / 3))} ${plural(n, "друг", "друга", "друзей")}`, W / 2, 280);
  // аватары слетаются в кольцо, по одному на восьмую
  const m = Math.min(fr.length, 16), cx = W / 2, cy = 690, R = 250;
  const focus = d.top_friend && b > 7;
  const fk = focus ? ease((b - 7) / 1.5) : 0;
  for (let i = 0; i < m; i++) {
    const k = ease((b - .5 - i * .25) / 1.2);
    if (k <= 0) continue;
    const a = i / m * Math.PI * 2 - Math.PI / 2 + F.t * .12;
    const from = { x: cx + Math.cos(a) * 900, y: cy + Math.sin(a) * 900 };
    const x = lerp(from.x, cx + Math.cos(a) * R, k), y = lerp(from.y, cy + Math.sin(a) * R, k);
    const isTop = d.top_friend && fr[i].id === d.top_friend.id;
    const r = (isTop ? 62 : 48) * (1 - fk * (isTop ? 0 : .35)) + (isTop ? pulse * 6 : 0);
    g.globalAlpha = isTop ? 1 : 1 - fk * .55;
    g.fillStyle = "rgba(255,255,255,.9)"; g.beginPath(); g.arc(x, y, r + 5, 0, Math.PI * 2); g.fill();
    circleImg(g, A.friends[i], x, y, r, initials(fr[i].name), "#0b6e6e");
  }
  g.globalAlpha = 1;
  // в центре — вы
  circleImg(g, A.avatar, cx, cy, 92 + pulse * 5, initials(d.me.name), "#0b6e6e");
  if (focus) {
    const tf = d.top_friend;
    g.globalAlpha = fk;
    g.fillStyle = "#fff"; g.textAlign = "center";
    g.font = `800 24px ${FONT_B}`; if ("letterSpacing" in g) g.letterSpacing = "5px";
    g.fillText("БОЛЬШЕ ВСЕХ ВАС ПОДДЕРЖИВАЕТ", W / 2, 1040);
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    const px = fitFont(g, tf.name, 700, FONT_T, W - 100, 60);
    g.font = `700 ${px}px ${FONT_T}`; g.fillText(tf.name, W / 2, 1110);
    g.font = `700 32px ${FONT_B}`;
    g.fillText(`♥ ${fmtN(tf.reactions)} ${plural(tf.reactions, "реакция", "реакции", "реакций")}`, W / 2, 1165);
    g.globalAlpha = 1;
  }
}

function sWord(g, F, lt, b, pulse) {
  const w = F.d.word.word;
  bg(g, this.pal, F.t, 5);
  g.save(); g.globalAlpha = .16; g.fillStyle = "#fff"; g.font = `700 110px ${FONT_T}`; g.textBaseline = "middle";
  const tw = g.measureText(w + "  ").width;
  for (let row = 0; row < 11; row++) { // бегущие строки во весь экран
    const dir = row % 2 ? 1 : -1, y = row * 125 + 20;
    const off = ((F.t * 140 * dir) % tw + tw) % tw;
    for (let x = -tw + off; x < W + tw; x += tw) g.fillText(w.toUpperCase(), x, y);
  }
  g.restore();
  label(g, "ваше слово", W / 2, 420, "#ffd9ea", 30, "center", 10);
  const k = back((b - 1) / 1.4);
  if (k > 0) {
    g.save(); g.translate(W / 2, 640); g.scale(k * (1 + pulse * .04), k * (1 + pulse * .04)); g.rotate(-.04);
    const txt = `«${w}»`;
    const px = fitFont(g, txt, 700, FONT_T, W - 70, 150);
    g.font = `700 ${px}px ${FONT_T}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillStyle = "#3a0d4f"; g.fillText(txt, 6, 8);
    g.fillStyle = "#fff"; g.fillText(txt, 0, 0);
    g.restore();
  }
  const k2 = ease((b - 3.5) / 1.5);
  if (k2 > 0) {
    g.globalAlpha = k2; g.fillStyle = "#fff"; g.textAlign = "center"; g.font = `700 40px ${FONT_B}`;
    const c = F.d.word.count;
    g.fillText(`встречается ${c} ${plural(c, "раз", "раза", "раз")}`, W / 2, 860);
    g.globalAlpha = 1;
  }
}

function sPost(g, F, lt, b, pulse) {
  const p = F.d.top_post, A = F.A;
  bg(g, this.pal, F.t, 6);
  label(g, "ваш лучший пост", W / 2, 170, "#dbe4ff", 28, "center", 8);
  const k = back((b - .5) / 1.4);
  if (k <= 0) return;
  g.save(); g.translate(W / 2, 680); g.scale(k, k); g.rotate(.015 * Math.sin(F.t));
  const cw = 600, img = A.post;
  g.font = `600 34px ${FONT_B}`;
  const chars = Math.floor(clamp((b - 1.5) / 6) * p.text.length);
  const lines = wrap(g, p.text, cw - 80, img ? 5 : 9);
  const imgH = img ? 300 : 0;
  const ch = 150 + imgH + lines.length * 46 + 90;
  g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 40; g.shadowOffsetY = 18;
  g.fillStyle = "#fff"; roundRect(g, -cw / 2, -ch / 2, cw, ch, 28); g.fill();
  g.shadowColor = "transparent";
  let y = -ch / 2 + 40;
  circleImg(g, A.avatar, -cw / 2 + 70, y + 32, 32, initials(F.d.me.name), "#2f5bff");
  g.fillStyle = "#14161a"; g.textAlign = "left"; g.font = `800 28px ${FONT_B}`;
  g.fillText(F.d.me.name, -cw / 2 + 118, y + 26);
  g.fillStyle = "#8a90a0"; g.font = `600 22px ${FONT_B}`; g.fillText(dateRu(p.created_at), -cw / 2 + 118, y + 58);
  y += 100;
  if (img) { g.save(); roundRect(g, -cw / 2 + 40, y, cw - 80, imgH - 20, 16); g.clip(); cover(g, img, -cw / 2 + 40, y, cw - 80, imgH - 20, 1 + b * .01); g.restore(); y += imgH; }
  g.fillStyle = "#14161a"; g.font = `600 34px ${FONT_B}`;
  let left = chars;
  for (const l of lines) { if (left <= 0) break; g.fillText(l.slice(0, left), -cw / 2 + 40, y + 34); left -= l.length + 1; y += 46; }
  // счётчик реакций выпрыгивает в конце
  const k2 = back((b - 8) / 1.2);
  if (k2 > 0 && p.reactions > 0) {
    g.save(); g.translate(cw / 2 - 40, ch / 2 - 10); g.scale(k2 * (1 + pulse * .08), k2 * (1 + pulse * .08));
    g.fillStyle = "#ff2e63"; roundRect(g, -150, -45, 190, 90, 45); g.fill();
    g.fillStyle = "#fff"; g.textAlign = "center"; g.font = `700 40px ${FONT_T}`; g.fillText(`♥ ${fmtN(p.reactions)}`, -55, 14);
    g.restore();
  }
  g.restore();
}
function roundRect(g, x, y, w, hh, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function sTime(g, F, lt, b, pulse) {
  const day = this.hour >= 6 && this.hour < 18;
  bg(g, this.pal, F.t, 7);
  const ink = day ? "#3a1d0c" : "#e8eefc";
  label(g, "ваше время", W / 2, 210, ink, 28, "center", 8);
  const cx = W / 2, cy = 600, R = 250;
  // циферблат-диаграмма: 24 столбика активности по часам
  const max = Math.max(...this.cnt) || 1;
  for (let i = 0; i < 24; i++) {
    const a = i / 24 * Math.PI * 2 - Math.PI / 2;
    const k = ease((b - i * .08) / 1.2) * (this.cnt[i] / max);
    const r1 = R * .62, r2 = r1 + R * .5 * k + 4;
    g.strokeStyle = i === this.hour ? (day ? "#c2410c" : "#ffd400") : (day ? "rgba(58,29,12,.35)" : "rgba(232,238,252,.35)");
    g.lineWidth = 16; g.lineCap = "round";
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
  }
  const ha = (this.hour / 24) * Math.PI * 2 * ease((b - 1) / 3) - Math.PI / 2;
  g.strokeStyle = ink; g.lineWidth = 10;
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ha) * R * .5, cy + Math.sin(ha) * R * .5); g.stroke();
  g.fillStyle = ink; g.beginPath(); g.arc(cx, cy, 16 + pulse * 4, 0, Math.PI * 2); g.fill();
  const k = ease((b - 3.5) / 1.5);
  if (k > 0) {
    const kind = this.hour < 5 ? "Ночная сова" : this.hour < 12 ? "Жаворонок" : this.hour < 18 ? "Человек дня" : "Вечерний мечтатель";
    g.globalAlpha = k; g.fillStyle = ink; g.textAlign = "center";
    g.font = `700 64px ${FONT_T}`; g.fillText(kind, W / 2, 1000);
    g.font = `600 34px ${FONT_B}`; g.fillText(`чаще всего вы пишете около ${String(this.hour).padStart(2, "0")}:00`, W / 2, 1065);
    g.globalAlpha = 1;
  }
}

function sFinale(g, F, lt, b, pulse) {
  const { d, A } = F;
  bg(g, this.pal, F.t, 8);
  const k = ease(b / 2);
  circleImg(g, A.avatar, W / 2, 520, 150 * k + pulse * 6, initials(d.me.name), "#16263a");
  g.fillStyle = "#fff"; g.textAlign = "center";
  const k2 = ease((b - 1.5) / 1.5);
  g.globalAlpha = k2;
  g.font = `700 70px ${FONT_T}`; g.fillText("это только", W / 2, 820); g.fillText("начало", W / 2, 900);
  const k3 = ease((b - 4) / 1.5);
  g.globalAlpha = k3;
  g.font = `600 32px ${FONT_B}`; g.fillText(`${d.me.name.split(" ")[0]}, продолжение — за вами`, W / 2, 975);
  g.globalAlpha = 1;
  const k4 = ease((b - 6) / 1.5);
  if (k4 > 0) { g.globalAlpha = k4; label(g, "ярко.space", W / 2, 1150, "#fff", 34, "center", 12); g.globalAlpha = 1; }
  // затемнение в конце
  const fade = clamp((b - this.beats + 2) / 2);
  if (fade > 0) { g.fillStyle = `rgba(0,0,0,${fade})`; g.fillRect(0, 0, W, H); }
}

/* ------------------------------------------------------------ музыка: своя для каждого, в ритм монтажа */
const KEYS = [57, 60, 62, 64, 55]; // ля, до, ре, ми, соль — минор
const PROG = [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]]; // i–VI–III–VII
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function soundtrack(ac, out, script, t0) {
  const r = script.seed, root = KEYS[Math.floor(r() * KEYS.length)];
  const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  // простая «комната»
  const rev = ac.createConvolver(), ir = ac.createBuffer(2, ac.sampleRate * 2.2, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const x = ir.getChannelData(ch); for (let i = 0; i < x.length; i++) x[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / x.length, 3); }
  rev.buffer = ir; const revG = ac.createGain(); revG.gain.value = .22; rev.connect(revG).connect(out);

  const env = (node, t, a, peak, d) => { node.gain.setValueAtTime(0.0001, t); node.gain.linearRampToValueAtTime(peak, t + a); node.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const kick = (t, v = 1) => {
    if (!v) return;
    const o = ac.createOscillator(), gn = ac.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + .14);
    env(gn, t, .003, .9 * v, .32); o.connect(gn).connect(out); o.start(t); o.stop(t + .4);
  };
  const nz = (t, f, type, q, peak, d, wet = 0) => {
    const s = ac.createBufferSource(); s.buffer = noise;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const gn = ac.createGain(); env(gn, t, .002, peak, d);
    s.connect(fl).connect(gn).connect(out); if (wet) gn.connect(rev);
    s.start(t, Math.random() * .5); s.stop(t + d + .05);
  };
  const tone = (t, m, type, peak, a, d, cutoff, wet = .0, detune = 0) => {
    const o = ac.createOscillator(); o.type = type; o.frequency.value = hz(m); o.detune.value = detune;
    const fl = ac.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = cutoff;
    const gn = ac.createGain(); env(gn, t, a, peak, d);
    o.connect(fl).connect(gn).connect(out); if (wet) { const w = ac.createGain(); w.gain.value = wet; gn.connect(w).connect(rev); }
    o.start(t); o.stop(t + a + d + .05);
  };
  // секции: какая сцена — такая аранжировка
  const sceneAt = (beat) => script.scenes.find((s) => beat >= s.start && beat < s.start + s.beats) || script.scenes[script.scenes.length - 1];
  let next = 0; // следующая доля к планированию
  const total = script.beats;
  const plan = () => {
    const horizon = ac.currentTime + 1.4;
    while (next < total && t0 + next * SPB < horizon) {
      const beat = next, t = t0 + beat * SPB, sc = sceneAt(beat), lb = beat - sc.start;
      const bar = Math.floor(beat / 4), chord = PROG[bar % 4], inBar = beat % 4;
      const intro = sc.draw === sIntro && lb < 4, outro = sc.draw === sFinale && lb >= sc.beats - 4;
      const calm = sc.draw === sPost || sc.draw === sTime;
      // смена сцены — удар
      if (lb === 0 && beat > 0) { kick(t, 1.1); nz(t, 900, "lowpass", .5, .35, 1.4, 1); }
      if (!intro && !outro) {
        kick(t, calm && inBar % 2 ? .0 : 1);
        if (inBar === 1 || inBar === 3) nz(t, 1800, "bandpass", .8, calm ? .18 : .32, .18, .6);
        for (const off of [.5]) nz(t + off * SPB, 8500, "highpass", 1, calm ? .05 : .09, .05);
        if (!calm) nz(t + .75 * SPB, 9500, "highpass", 1, .04, .03);
        // бас восьмыми
        for (const off of [0, .5]) tone(t + off * SPB, root - 24 + chord[0] + (off && inBar === 3 ? 7 : 0), "sawtooth", .16, .005, SPB * .42, 520);
      }
      // аккорд-подложка раз в такт
      if (inBar === 0 && !outro) chord.forEach((iv, i) => tone(t, root - 12 + iv + (i === 0 ? 12 : 0), "sawtooth", .045, SPB * 1.2, SPB * 3.2, 1400, .35, (i - 1) * 7));
      if (outro && lb === sc.beats - 4) chord.forEach((iv) => tone(t, root - 12 + iv, "triangle", .07, .05, SPB * 6, 2200, .6));
      // арпеджио шестнадцатыми — в «ярких» сценах
      if (!intro && !outro && !calm) {
        const notes = [chord[0], chord[1], chord[2], chord[1] + 12];
        for (let s = 0; s < 4; s++) tone(t + s * SPB / 4, root + notes[(s + inBar) % 4], "square", .035, .002, SPB * .22, 3200, .25);
      } else if (calm && !outro) {
        tone(t, root + 12 + chord[inBar % 3], "triangle", .06, .005, SPB * 1.6, 2600, .5);
      }
      if (intro && inBar === 0) tone(t, root + chord[0], "triangle", .06, .01, SPB * 3.5, 2000, .6);
      // подъём перед финалом
      const fin = script.scenes[script.scenes.length - 1];
      if (beat === fin.start - 4) {
        const s = ac.createBufferSource(); s.buffer = noise; s.loop = true;
        const fl = ac.createBiquadFilter(); fl.type = "bandpass"; fl.Q.value = 2; fl.frequency.setValueAtTime(400, t); fl.frequency.exponentialRampToValueAtTime(7000, t + SPB * 4);
        const gn = ac.createGain(); gn.gain.setValueAtTime(.0001, t); gn.gain.exponentialRampToValueAtTime(.25, t + SPB * 4); gn.gain.setValueAtTime(.0001, t + SPB * 4 + .01);
        s.connect(fl).connect(gn).connect(out); s.start(t); s.stop(t + SPB * 4 + .05);
      }
      next++;
    }
  };
  plan();
  const iv = setInterval(plan, 200);
  return () => clearInterval(iv);
}

/* ------------------------------------------------------------ страница */
function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const c = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return c.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || null;
}

export async function filmPage() {
  setTitle("Фильм о вас");
  if (!document.querySelector('link[data-film]')) {
    document.head.append(h("link", { rel: "stylesheet", href: "/static/css/film.css?v=1", dataset: { film: "1" } }));
  }
  const canvas = h("canvas.film-canvas", { width: W, height: H, "aria-label": "Фильм о вас" });
  const g = canvas.getContext("2d");
  const status = h("div.film-status", "Собираю материалы для фильма…");
  const bar = h("div.film-bar", h("i"));
  const actions = h("div.film-actions");
  const playBtn = h("button.film-play", { type: "button", disabled: true, "aria-label": "Смотреть фильм" }, h("span", "▶"), h("b", "Смотреть фильм"));
  const startCard = h("div.film-start", playBtn, h("p", "Сайт сам смонтирует ролик о вас и сочинит к нему музыку. Включите звук 🔊"));
  const root = h("div.film",
    h("div.film-top",
      h("button.film-back", { type: "button", onclick: () => (history.length > 1 ? history.back() : navigate("/")) }, "← Назад"),
      h("span.film-title", "Фильм о вас")),
    h("div.film-stage", canvas, startCard),
    bar, status, actions);

  let stopped = false, raf = 0, stopMusic = null, ac = null, rec = null, chunks = [], video = null;
  setCleanup(() => {
    stopped = true; cancelAnimationFrame(raf); stopMusic?.();
    try { rec?.state === "recording" && rec.stop(); } catch { /* */ }
    ac?.close().catch(() => {});
  });

  (async () => {
    try {
      if (!grain) makeGrain();
      const d = await api.fresh("/api/film");
      status.textContent = "Подбираю кадры…";
      await Promise.all([document.fonts?.load(`700 80px Unbounded`), document.fonts?.load(`800 30px Manrope`), document.fonts?.load(`600 30px Manrope`)].map((p) => p?.catch?.(() => {})));
      const [avatar, post, ...rest] = await Promise.all([
        loadImg(d.me.avatar), loadImg(d.top_post?.image),
        ...d.photos.map((p) => loadImg(p)), ...d.friends.map((f) => loadImg(thumb(f.avatar))),
      ]);
      const photos = rest.slice(0, d.photos.length).filter(Boolean);
      const friends = rest.slice(d.photos.length);
      const A = { avatar, post, photos, friends };
      const script = buildScript(d, A);
      if (stopped) return;
      // постер — первый кадр финала
      drawFrame({ d, A, script, t: 0 }, script.scenes[0].start * SPB + SPB * 6);
      status.textContent = `Фильм готов: ${Math.round(script.dur)} секунд, ${script.scenes.length} ${plural(script.scenes.length, "сцена", "сцены", "сцен")}`;
      playBtn.disabled = false;
      playBtn.onclick = () => play({ d, A, script });
    } catch (e) {
      status.textContent = "Не удалось собрать фильм";
      toastError(e);
    }
  })();

  function drawFrame(F, t) {
    const { script } = F;
    F.t = t;
    const beat = t / SPB;
    const sc = script.scenes.find((s) => beat >= s.start && beat < s.start + s.beats) || script.scenes[script.scenes.length - 1];
    const lt = t - sc.start * SPB, b = beat - sc.start;
    const pulse = Math.exp(-((beat % 1 + 1) % 1) * 5);
    g.save();
    sc.draw.call(sc, g, F, lt, b, pulse);
    g.restore();
    g.textAlign = "left"; g.globalAlpha = 1;
    finish(g, t, pulse);
    const prev = script.scenes[script.scenes.indexOf(sc) - 1];
    if (prev) wipe(g, lt, sc.pal[0]);
    // полосы «широкого экрана»
    g.fillStyle = "#000"; g.fillRect(0, 0, W, 18); g.fillRect(0, H - 18, W, 18);
  }

  async function play(F) {
    startCard.hidden = true;
    actions.replaceChildren();
    video = null;
    const AC = window.AudioContext || window.webkitAudioContext;
    ac?.close().catch(() => {});
    ac = new AC();
    await ac.resume().catch(() => {});
    const master = ac.createGain(); master.gain.value = .85;
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ac.destination);
    const dest = ac.createMediaStreamDestination ? ac.createMediaStreamDestination() : null;
    if (dest) comp.connect(dest);
    const t0 = ac.currentTime + .25;
    stopMusic?.();
    stopMusic = soundtrack(ac, master, F.script, t0);
    // запись: картинка с холста + звук
    const mime = pickMime();
    rec = null; chunks = [];
    if (mime && canvas.captureStream && dest) {
      try {
        const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 128_000 });
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => { video = new Blob(chunks, { type: mime.split(";")[0] }); showActions(F); };
        setTimeout(() => { try { rec.start(1000); } catch { rec = null; } }, 200);
      } catch { rec = null; }
    }
    status.textContent = rec ? "Идёт показ и запись фильма — не сворачивайте страницу" : "Идёт показ фильма";
    cancelAnimationFrame(raf);
    const loop = () => {
      if (stopped) return;
      const t = ac.currentTime - t0;
      drawFrame(F, Math.max(0, t));
      bar.firstChild.style.width = `${clamp(t / F.script.dur) * 100}%`;
      if (t < F.script.dur) raf = requestAnimationFrame(loop);
      else {
        stopMusic?.();
        if (rec && rec.state === "recording") { status.textContent = "Сохраняю видео…"; rec.stop(); } else showActions(F);
      }
    };
    raf = requestAnimationFrame(loop);
  }

  function showActions(F) {
    if (stopped) return;
    drawFrame(F, SPB * 6.5); // на экране остаётся «обложка» — она же постер клипа
    status.textContent = video ? `Видео готово · ${(video.size / 1048576).toFixed(1)} МБ` : "Фильм закончился";
    const ext = video && video.type.includes("mp4") ? "mp4" : "webm";
    const file = video ? new File([video], `yarko-film.${ext}`, { type: video.type }) : null;
    const btns = [h("button.btn.soft", { type: "button", onclick: () => play(F) }, icon("repeat", "sm"), "Смотреть снова")];
    if (file) {
      btns.push(h("button.btn.soft", { type: "button", onclick: () => {
        const a = h("a", { href: URL.createObjectURL(file), download: file.name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      } }, icon("download", "sm"), "Скачать видео"));
      if (navigator.canShare?.({ files: [file] })) {
        btns.push(h("button.btn.soft", { type: "button", onclick: () => navigator.share({ files: [file], title: "Мой фильм в Ярко" }).catch(() => {}) }, icon("share", "sm"), "Отправить"));
      }
      const pub = h("button.btn.primary", { type: "button", onclick: async () => {
        pub.disabled = true;
        try {
          const poster = await new Promise((res) => canvas.toBlob(res, "image/jpeg", .86));
          const fd = new FormData();
          fd.append("caption", "Мой фильм в Ярко 🎬 #фильмовас");
          fd.append("duration", String(Math.round(F.script.dur)));
          fd.append("visibility", "public");
          fd.append("width", String(W)); fd.append("height", String(H));
          if (poster) fd.append("poster", poster, "poster.jpg");
          fd.append("video", file, file.name);
          const up = api.upload("/api/reels", fd, (p) => { status.textContent = p < 1 ? `Публикую… ${Math.round(p * 100)}%` : "Сохраняю…"; });
          const r = await up.promise;
          toast("Фильм опубликован в Клипы 🎬", { icon: "check" });
          navigate(`/reels/${r.id}`);
        } catch (e) { pub.disabled = false; status.textContent = "Не получилось опубликовать"; toastError(e); }
      } }, icon("film", "sm"), "Опубликовать в Клипы");
      btns.unshift(pub);
    } else {
      status.textContent = "Фильм закончился. Этот браузер не умеет записывать видео — откройте сайт в Chrome, чтобы сохранить ролик.";
    }
    actions.replaceChildren(...btns);
  }

  return root;
}

