// Вложения «что угодно»: любой файл, местоположение, контакт из QEVI.
import { h, icon, avatar, vmark } from "../dom.js";
import { fmtSize } from "./mediakit.js";

// ---------------------------------------------------------------- файлы
const GROUPS = [
  ["pdf", "#e5484d", ["pdf"]],
  ["doc", "#3b82f6", ["doc", "docx", "odt", "rtf", "txt", "md", "pages"]],
  ["xls", "#16a34a", ["xls", "xlsx", "ods", "csv", "numbers"]],
  ["ppt", "#f97316", ["ppt", "pptx", "odp", "key"]],
  ["zip", "#eab308", ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]],
  ["app", "#22c55e", ["apk", "aab", "ipa", "exe", "msi", "dmg", "deb", "rpm", "appimage"]],
  ["code", "#8b5cf6", ["js", "ts", "py", "json", "html", "css", "java", "kt", "c", "cpp", "cs", "go", "rs", "php", "rb", "sql", "xml", "yml", "yaml", "sh"]],
  ["img", "#ec4899", ["svg", "heic", "heif", "bmp", "tif", "tiff", "psd", "ai", "raw", "cr2", "nef", "ico"]],
  ["media", "#06b6d4", ["mkv", "avi", "wmv", "flv", "aac", "opus", "amr", "wma", "mid", "midi"]],
  ["font", "#64748b", ["ttf", "otf", "woff", "woff2"]],
  ["book", "#a16207", ["epub", "fb2", "mobi", "djvu"]],
];
const RISKY = new Set(["exe", "msi", "bat", "cmd", "scr", "com", "vbs", "js", "jar", "ps1", "sh", "apk", "dmg", "app", "lnk", "reg", "hta"]);

export function fileKind(ext) {
  const e = (ext || "").toLowerCase();
  const g = GROUPS.find(([, , list]) => list.includes(e));
  return g ? { kind: g[0], color: g[1] } : { kind: "file", color: "#7c7c93" };
}

export function fileIcon(ext, big = false) {
  const { color } = fileKind(ext);
  const label = (ext || "file").toUpperCase().slice(0, 4);
  return h(`span.file-ic${big ? ".big" : ""}`, { style: { "--fc": color }, "aria-hidden": "true" }, h("span.file-ic-fold"), h("b", label));
}

/** Имя с многоточием в середине: «очень-длинный-отчёт…2026.pdf» */
function midName(name, max = 34) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const tail = dot > 0 && name.length - dot <= 8 ? name.slice(dot - 4) : name.slice(-8);
  return `${name.slice(0, max - tail.length - 1)}…${tail}`;
}

export function fileCard(m) {
  const href = `${m.url}?dl=${encodeURIComponent(m.name || "file")}`;
  const risky = RISKY.has((m.ext || "").toLowerCase());
  return h("div.file-card",
    h("a.file-main", { href, download: m.name || "", rel: "noopener", title: `Скачать «${m.name}»` },
      fileIcon(m.ext),
      h("div.file-meta", h("b.file-name", midName(m.name || "Файл")), h("small", [fmtSize(m.size), (m.ext || "").toUpperCase()].filter(Boolean).join(" · "))),
      h("span.file-dl", icon("download", "sm"))),
    risky ? h("small.file-warn", icon("alert", "sm"), "Программа или скрипт — открывайте, только если доверяете отправителю") : null);
}

// ---------------------------------------------------------------- местоположение
const TILE = 256, Z = 15;
function lon2x(lon, z) { return ((lon + 180) / 360) * TILE * 2 ** z; }
function lat2y(lat, z) { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; }

/** Мини-карта OpenStreetMap из тайлов с меткой по центру */
export function mapPreview(lat, lon, w = 280, hgt = 150) {
  const px = lon2x(lon, Z), py = lat2y(lat, Z);
  const x0 = px - w / 2, y0 = py - hgt / 2;
  const tiles = [];
  for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + hgt) / TILE); ty++) {
      tiles.push(h("img.map-tile", { src: `https://tile.openstreetmap.org/${Z}/${tx}/${ty}.png`, alt: "", loading: "lazy", draggable: false,
        onerror: (e) => { e.currentTarget.style.visibility = "hidden"; },
        referrerpolicy: "strict-origin-when-cross-origin", style: { left: `${tx * TILE - x0}px`, top: `${ty * TILE - y0}px` } }));
    }
  }
  return h("div.map-box", { style: { width: `${w}px`, height: `${hgt}px` } }, ...tiles,
    h("span.map-ping"), h("span.map-pin", h("i")), h("small.map-attr", "© OpenStreetMap"));
}

export function locationCard(m) {
  const yandex = `https://yandex.ru/maps/?pt=${m.lon},${m.lat}&z=16&l=map`;
  const osm = `https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lon}#map=16/${m.lat}/${m.lon}`;
  return h("div.loc-card",
    h("a.loc-map", { href: yandex, target: "_blank", rel: "noopener noreferrer", "aria-label": "Открыть в Яндекс Картах" }, mapPreview(m.lat, m.lon)),
    h("div.loc-info",
      h("span.loc-ic", icon("pin", "sm")),
      h("div.grow", h("b", m.label || "Местоположение"), h("small", `${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}${m.acc ? ` · ±${m.acc} м` : ""}`))),
    h("div.loc-links",
      h("a", { href: yandex, target: "_blank", rel: "noopener noreferrer" }, "Яндекс Карты"),
      h("a", { href: osm, target: "_blank", rel: "noopener noreferrer" }, "OpenStreetMap")));
}

// ---------------------------------------------------------------- контакт
export function contactCard(m, { onMessage } = {}) {
  const u = { id: m.user_id, username: m.username, name: m.name, avatar: m.avatar, verified: m.verified };
  return h("div.contact-card",
    h("a.contact-main", { href: `/u/${m.username}` }, avatar(u, "md", { presence: false }),
      h("div.grow", h("b", m.name, vmark(u)), h("small", `@${m.username}`))),
    h("div.contact-actions",
      h("a.btn.soft.sm", { href: `/u/${m.username}` }, "Профиль"),
      onMessage ? h("button.btn.soft.sm", { type: "button", onclick: () => onMessage(u) }, icon("message", "sm"), "Написать") : null));
}
