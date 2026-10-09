// Обработка видео прямо в браузере: обрезка по времени, уменьшение размера кадра и битрейта, без звука.
// Видео проигрывается в скрытом элементе, кадры рисуются на холст, а MediaRecorder записывает WebM (VP8/VP9 + Opus).
// Работает в реальном времени: 30 секунд клипа обрабатываются ~30 секунд. Нужно, чтобы большие ролики с телефона
// (1080p, 15+ Мбит/с) помещались в лимит загрузки и быстро грузились по мобильному интернету.

export function canTranscode() {
  return typeof MediaRecorder !== "undefined" && !!HTMLCanvasElement.prototype.captureStream &&
    !!pickType();
}

function pickType() {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/**
 * @param {File|Blob} file
 * @param {{start?:number, end?:number, maxSide?:number, fps?:number, videoBps?:number, mute?:boolean,
 *          onProgress?:(p:number)=>void, signal?:AbortSignal}} o
 * @returns {Promise<{blob:Blob, duration:number, width:number, height:number}>}
 */
export function transcode(file, o = {}) {
  const { maxSide = 1280, fps = 30, videoBps = 2_200_000, mute = false, onProgress, signal } = o;
  // звук через Web Audio: в динамики не идёт, только в запись (контекст создаём сразу — пока действует нажатие)
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = !mute && AC ? new AC() : null;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.src = url; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    v.muted = !actx; // без Web Audio звук не записать — тогда и не играем его вслух
    const cleanup = () => {
      try { v.pause(); } catch { /* ничего */ }
      v.removeAttribute("src"); v.load();
      URL.revokeObjectURL(url);
      actx?.close().catch(() => {});
    };
    const fail = (e) => { cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };
    signal?.addEventListener("abort", () => { try { rec?.state !== "inactive" && rec?.stop(); } catch { /* */ } aborted = true; });
    let rec = null, aborted = false, raf = 0;

    v.addEventListener("error", () => fail(new Error("Не удалось открыть видео в браузере")), { once: true });
    v.addEventListener("loadedmetadata", async () => {
      const dur = v.duration;
      const start = Math.max(0, Math.min(o.start || 0, (dur || 0) - .2));
      const end = Math.min(o.end ?? dur, dur || o.end || 0);
      const total = Math.max(.1, end - start);
      const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.max(2, Math.round(v.videoWidth * scale / 2) * 2), hgt = Math.max(2, Math.round(v.videoHeight * scale / 2) * 2);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = hgt;
      const ctx = canvas.getContext("2d", { alpha: false });
      const stream = canvas.captureStream(fps);
      if (actx) {
        try {
          const src = actx.createMediaElementSource(v);
          const dest = actx.createMediaStreamDestination();
          src.connect(dest);
          dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
          await actx.resume();
        } catch { /* без звука */ }
      }
      const chunks = [];
      try {
        rec = new MediaRecorder(stream, { mimeType: pickType(), videoBitsPerSecond: videoBps, audioBitsPerSecond: 96_000 });
      } catch (e) { return fail(e); }
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        cancelAnimationFrame(raf);
        const recorded = Math.min(total, Math.max(0, v.currentTime - start));
        cleanup();
        if (aborted) return reject(Object.assign(new Error("Обработка отменена"), { code: "aborted" }));
        const raw = new Blob(chunks, { type: "video/webm" });
        try {
          const blob = await fixWebmDuration(raw, recorded * 1000);
          resolve({ blob, duration: recorded, width: w, height: hgt });
        } catch { resolve({ blob: raw, duration: recorded, width: w, height: hgt }); }
      };
      const draw = () => {
        if (v.readyState >= 2) ctx.drawImage(v, 0, 0, w, hgt);
        const p = Math.min(1, Math.max(0, (v.currentTime - start) / total));
        onProgress?.(p);
        if (v.currentTime >= end - .03 || v.ended) { if (rec.state !== "inactive") rec.stop(); return; }
        raf = requestAnimationFrame(draw);
      };
      v.addEventListener("ended", () => { if (rec.state !== "inactive") rec.stop(); }, { once: true });
      const go = async () => {
        ctx.drawImage(v, 0, 0, w, hgt);
        rec.start(1000);
        try { await v.play(); } catch (e) { return fail(e); }
        raf = requestAnimationFrame(draw);
      };
      if (start > 0) { v.currentTime = start; v.addEventListener("seeked", go, { once: true }); } else go();
    }, { once: true });
  });
}

// ---------------------------------------------------------------- длительность в WebM
// MediaRecorder пишет WebM без длительности — плееры не показывают время и плохо перематывают.
// Дописываем элемент Duration в заголовок Info (TimecodeScale по умолчанию — 1 мс).
function readVint(buf, pos, keepMarker = false) {
  const first = buf[pos];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  return { len, value };
}

export async function fixWebmDuration(blob, durationMs) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  // Segment (18 53 80 67) → внутри ищем Info (15 49 A9 66)
  const find = (seq, from = 0, to = buf.length) => {
    outer: for (let i = from; i <= to - seq.length; i++) {
      for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
      return i;
    }
    return -1;
  };
  const info = find([0x15, 0x49, 0xa9, 0x66], 0, Math.min(buf.length, 4096));
  if (info < 0) return blob;
  const size = readVint(buf, info + 4);
  if (!size) return blob;
  const start = info + 4 + size.len, end = start + size.value;
  // уже есть Duration (44 89) среди прямых потомков Info — ничего не делаем
  for (let p = start; p < end;) {
    const id = readVint(buf, p, true); if (!id) break;
    const sz = readVint(buf, p + id.len); if (!sz) break;
    if (id.value === 0x4489) return blob;
    p += id.len + sz.len + sz.value;
  }
  const dur = new Uint8Array(11);
  dur.set([0x44, 0x89, 0x88]);
  new DataView(dur.buffer).setFloat64(3, durationMs);
  const newSize = size.value + dur.length;
  const sizeBytes = new Uint8Array(8); // размер — 8-байтовым vint: 0x01 и 7 байт значения
  sizeBytes[0] = 0x01;
  let x = newSize;
  for (let i = 7; i >= 1; i--) { sizeBytes[i] = x & 0xff; x = Math.floor(x / 256); }
  return new Blob([buf.subarray(0, info + 4), sizeBytes, buf.subarray(start, end), dur, buf.subarray(end)], { type: blob.type || "video/webm" });
}

/** Кадр видео в момент t (секунды) как JPEG — обложка клипа или истории */
export function frameAt(file, t, maxSide = 720) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    const done = (b) => { URL.revokeObjectURL(url); resolve(b); };
    const timer = setTimeout(() => done(null), 8000);
    v.addEventListener("loadedmetadata", () => { v.currentTime = Math.min(Math.max(0, t), Math.max(0, v.duration - .05)); }, { once: true });
    v.addEventListener("seeked", () => {
      try {
        const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => { clearTimeout(timer); done(b); }, "image/jpeg", .85);
      } catch { clearTimeout(timer); done(null); }
    }, { once: true });
    v.addEventListener("error", () => { clearTimeout(timer); done(null); }, { once: true });
  });
}
