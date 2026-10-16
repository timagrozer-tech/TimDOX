import { App } from "./ui/app";

// Точка входа: запуск интерфейса и установка офлайн-режима (PWA)
const app = new App();
(window as unknown as { genesis: App }).genesis = app;
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
