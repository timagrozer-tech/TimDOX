// Применяем тему и оформление до отрисовки страницы, чтобы не было «вспышки» другого вида.
(function () {
  var root = document.documentElement;
  try {
    var t = localStorage.getItem("krug-theme") || "system";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.motion = localStorage.getItem("krug-motion") || "full";
    var look = JSON.parse(localStorage.getItem("krug-look") || "null");
    if (look && look.vars) {
      for (var k in look.vars) root.style.setProperty(k, look.vars[k]);
      root.dataset.bg = look.bg || "orbit";
      root.dataset.shape = look.shape || "soft";
      if (look.font) {
        var l = document.createElement("link");
        l.id = "look-font"; l.rel = "stylesheet"; l.href = look.font;
        document.head.appendChild(l);
      }
    }
  } catch (e) { root.dataset.theme = root.dataset.theme || "light"; }
})();
