// Свой упаковщик MP4 (ISO BMFF) для готовых кадров из WebCodecs: видео H.264 или VP9, звук AAC или Opus.
// Файл собирается целиком в памяти и «быстрым стартом» (moov впереди) — клип начинает играть сразу, без докачки.

const enc = new TextEncoder();
const u8 = (n) => new Uint8Array(n);
function u16(v) { const b = u8(2); new DataView(b.buffer).setUint16(0, v); return b; }
function u32(v) { const b = u8(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function i16(v) { const b = u8(2); new DataView(b.buffer).setInt16(0, v); return b; }
function cat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = u8(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...parts) {
  const body = cat(parts.flat(Infinity).filter(Boolean));
  return cat([u32(body.length + 8), enc.encode(type), body]);
}
const full = (type, version, flags, ...parts) => box(type, u8(1).fill(version), [(flags >> 16) & 255, (flags >> 8) & 255, flags & 255].map((x) => Uint8Array.of(x)), ...parts);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
const zeros = (n) => u8(n);

/** Последовательность одинаковых длительностей → записи stts */
function runs(durs) {
  const out = [];
  for (const d of durs) { const last = out[out.length - 1]; if (last && last[1] === d) last[0]++; else out.push([1, d]); }
  return out;
}

function sampleEntryVideo(t) {
  const visual = [zeros(6), u16(1), zeros(16), u16(t.width), u16(t.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), i16(-1)];
  if (t.codec.startsWith("avc")) return box("avc1", visual, box("avcC", t.description));
  // VP9: vpcC собираем из строки кодека vp09.PP.LL.DD
  const [, prof, lvl, depth] = t.codec.split(".").map(Number);
  const vpcC = full("vpcC", 1, 0, Uint8Array.of(prof || 0, lvl || 10, ((depth || 8) << 4) | (1 << 1) | 0, 1, 1, 1), u16(0));
  return box("vp09", visual, vpcC);
}
function esdsDescr(tag, body) { return cat([Uint8Array.of(tag, body.length), body]); }
function sampleEntryAudio(t) {
  const base = [zeros(6), u16(1), zeros(8), u16(t.channels), u16(16), u16(0), u16(0), u32(t.sampleRate << 16)];
  if (t.codec.startsWith("mp4a")) {
    const asc = t.description;
    const dsi = esdsDescr(5, asc);
    const dcd = esdsDescr(4, cat([Uint8Array.of(0x40, 0x15, 0, 0, 0), u32(t.bitrate || 128000), u32(t.bitrate || 128000), dsi]));
    const es = esdsDescr(3, cat([u16(1), Uint8Array.of(0), dcd, esdsDescr(6, Uint8Array.of(2))]));
    return box("mp4a", base, full("esds", 0, 0, es));
  }
  // Opus в MP4: dOps (поля big-endian), pre-skip берём из OpusHead, если кодер его дал
  let preSkip = 312;
  if (t.description && t.description.length >= 12) preSkip = t.description[10] | (t.description[11] << 8);
  const dOps = box("dOps", Uint8Array.of(0, t.channels), u16(preSkip), u32(t.sampleRate), i16(0), Uint8Array.of(0));
  return box("Opus", base, dOps);
}

function trak(t, id, offsets, movieDurMs) {
  const isV = t.kind === "video";
  const durs = t.samples.map((s) => s.dur);
  const total = durs.reduce((a, b) => a + b, 0);
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(Math.round(total / t.timescale * 1000)), zeros(8), u16(0), u16(0),
    u16(isV ? 0 : 0x0100), u16(0), MATRIX, u32((isV ? t.width : 0) << 16), u32((isV ? t.height : 0) << 16));
  const mdhd = full("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(total), u16(0x55c4), u16(0));
  const hdlr = full("hdlr", 0, 0, u32(0), enc.encode(isV ? "vide" : "soun"), zeros(12), enc.encode(isV ? "Yarko Video\0" : "Yarko Sound\0"));
  const stts = full("stts", 0, 0, u32(runs(durs).length), runs(durs).map(([n, d]) => [u32(n), u32(d)]));
  const keys = isV ? t.samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean) : null;
  const stbl = box("stbl",
    full("stsd", 0, 0, u32(1), isV ? sampleEntryVideo(t) : sampleEntryAudio(t)),
    stts,
    keys ? full("stss", 0, 0, u32(keys.length), keys.map(u32)) : null,
    full("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1)),
    full("stsz", 0, 0, u32(0), u32(t.samples.length), t.samples.map((s) => u32(s.data.length))),
    full("stco", 0, 0, u32(offsets.length), offsets.map(u32)));
  const minf = box("minf", isV ? full("vmhd", 0, 1, zeros(8)) : full("smhd", 0, 0, zeros(4)),
    box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
}

/**
 * tracks: [{ kind: "video"|"audio", codec, timescale, width, height, channels, sampleRate, description,
 *            samples: [{ data: Uint8Array, dur, time, key }] }]
 * time — начало сэмпла в единицах timescale (для перемешивания видео и звука в mdat)
 */
export function muxMp4(tracks) {
  tracks = tracks.filter((t) => t.samples.length);
  // порядок сэмплов в mdat — по времени, чтобы плеер читал файл подряд
  const order = [];
  tracks.forEach((t, ti) => t.samples.forEach((s, si) => order.push([s.time / t.timescale, ti, si])));
  order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const movieDurMs = Math.max(...tracks.map((t) => t.samples.reduce((a, s) => a + s.dur, 0) / t.timescale * 1000));
  const ftyp = box("ftyp", enc.encode("isom"), u32(512), enc.encode("isomiso2avc1mp41"));
  const build = (base) => {
    const offs = tracks.map(() => []);
    let pos = base;
    for (const [, ti, si] of order) { offs[ti][si] = pos; pos += tracks[ti].samples[si].data.length; }
    const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(movieDurMs)), u32(0x10000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1));
    return box("moov", mvhd, tracks.map((t, i) => trak(t, i + 1, offs[i], movieDurMs)));
  };
  let mdatSize = 8;
  for (const t of tracks) for (const s of t.samples) mdatSize += s.data.length;
  // размер moov не зависит от значений смещений — считаем его один раз, потом строим с верными смещениями
  const moovLen = build(0).length;
  const moov = build(ftyp.length + moovLen + 8);
  const mdat = u8(mdatSize);
  new DataView(mdat.buffer).setUint32(0, mdatSize); mdat.set(enc.encode("mdat"), 4);
  let o = 8;
  for (const [, ti, si] of order) { const d = tracks[ti].samples[si].data; mdat.set(d, o); o += d.length; }
  return new Blob([ftyp, moov, mdat], { type: "video/mp4" });
}
