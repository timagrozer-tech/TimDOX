// Применяем тему до отрисовки страницы, чтобы не было «вспышки» светлой темы.
(function () {
  try {
    var t = localStorage.getItem("krug-theme") || "system";
    var dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) { document.documentElement.dataset.theme = "light"; }
})();
