// Применяем тему и оформление до отрисовки страницы, чтобы не было «вспышки» другого вида.
(function () {
  var root = document.documentElement;
  // шрифты Google грузятся, не задерживая страницу: если сервер шрифтов недоступен, сайт открывается с системным шрифтом
  var gf = document.querySelector("link[data-fonts]");
  if (gf) { if (gf.sheet) gf.media = "all"; else gf.addEventListener("load", function () { gf.media = "all"; }); }
  try {
    var t = localStorage.getItem("krug-theme") || "dark";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    // открыто в Telegram: «как в системе» = как в Telegram (по цвету фона его темы)
    var tp = /tgWebAppThemeParams=([^&]+)/.exec(location.hash);
    if (tp && t === "system") {
      var bg = (JSON.parse(decodeURIComponent(tp[1])).bg_color || "").replace("#", "");
      if (bg.length === 6) {
        var n = parseInt(bg, 16), lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
        dark = lum < 128;
        try { sessionStorage.setItem("krug:tgDark", dark ? "1" : "0"); } catch (e2) { /* ничего */ }
      }
    } else if (t === "system") {
      try { var sd = sessionStorage.getItem("krug:tgDark"); if (sd) dark = sd === "1"; } catch (e3) { /* ничего */ }
    }
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.motion = localStorage.getItem("krug-motion") || "full";
    root.dataset.glass = localStorage.getItem("krug-glass") || "liquid";
    var look = JSON.parse(localStorage.getItem("krug-look") || "null");
    if (look && look.vars) {
      for (var k in look.vars) root.style.setProperty(k, look.vars[k]);
      root.dataset.bg = look.bg || "orbit";
      root.dataset.palette = look.palette || "qevi";
      root.dataset.shape = look.shape || "soft";
      if (look.skin) { root.dataset.skin = look.skin; root.dataset.glass = "classic"; }
      if (look.font) {
        var l = document.createElement("link");
        l.id = "look-font"; l.rel = "stylesheet"; l.href = look.font;
        document.head.appendChild(l);
      }
    }
  } catch (e) { root.dataset.theme = root.dataset.theme || "light"; }
})();
