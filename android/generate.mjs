// Создаёт Android-проект приложения Yarko (Trusted Web Activity — сайт ярко.space во весь экран, без адресной строки).
// Запускается на сервере сборки GitHub: node android/generate.mjs <папка проекта>
import fs from "node:fs";
import path from "node:path";
import { TwaGenerator, TwaManifest, ConsoleLog } from "@bubblewrap/core";
import Color from "color";

const out = path.resolve(process.argv[2] || "android/project");
const cfg = JSON.parse(fs.readFileSync(new URL("./app.json", import.meta.url), "utf8"));
const web = JSON.parse(fs.readFileSync(new URL("../static/manifest.webmanifest", import.meta.url), "utf8"));

// значки берём прямо из репозитория — сборка не зависит от того, отвечает ли сайт серверам GitHub
const RAW = cfg.rawBase;
web.icons = web.icons.map((i) => ({ ...i, src: RAW + i.src }));
web.shortcuts = (web.shortcuts || []).map((s) => ({ ...s, icons: (s.icons || []).map((i) => ({ ...i, src: RAW + i.src })) }));

const m = TwaManifest.fromWebManifestJson(new URL(`https://${cfg.host}/static/manifest.webmanifest`), web);
// цвета в bubblewrap — объекты из библиотеки color
const col = (v) => Color(v);
Object.assign(m, {
  packageId: cfg.packageId,
  host: cfg.host,
  name: cfg.name,
  launcherName: cfg.launcherName,
  startUrl: cfg.startUrl,
  themeColor: col(cfg.themeColor),
  appVersionName: cfg.versionName,
  appVersionCode: cfg.versionCode,
  enableNotifications: true,
  fallbackType: "customtabs",
  orientation: "portrait",
  minSdkVersion: cfg.minSdkVersion,
  iconUrl: RAW + "/static/img/icon-512.png",
  maskableIconUrl: RAW + "/static/img/icon-maskable-512.png",
  signingKey: { path: "./unused.keystore", alias: "unused" },
  generatorApp: "yarko-ci",
});
for (const key of ["navigationColor", "navigationColorDark", "navigationDividerColor", "navigationDividerColorDark", "backgroundColor", "themeColorDark"]) {
  if (cfg[key]) m[key] = col(cfg[key]);
}
console.log(JSON.stringify(m.toJson ? m.toJson() : m, null, 2));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await new TwaGenerator().createTwaProject(out, m, new ConsoleLog("yarko"));
console.log("project ready:", out);
