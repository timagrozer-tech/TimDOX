// Production-сборка без Vite (esbuild): dist/ — готовая папка для любого статического хостинга.
// Запуск: node scripts/build.mjs   (путь к esbuild можно передать в ESBUILD_PATH)
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD_PATH || "esbuild");
const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets"), { recursive: true });

const common = { bundle: true, format: "esm", target: "es2020", minify: true, legalComments: "none", sourcemap: false, logLevel: "warning" };
await esbuild.build({ ...common, entryPoints: ["src/workers/sim.worker.ts"], outfile: join(out, "assets/worker.js") });
const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 10);
const wHash = hash(join(out, "assets/worker.js"));
await esbuild.build({ ...common, entryPoints: ["src/main.ts"], outfile: join(out, "assets/app.js"), define: { __GENESIS_WORKER__: JSON.stringify(`./assets/worker.js?v=${wHash}`) } });
await esbuild.build({ ...common, entryPoints: ["src/ui/styles.css"], outfile: join(out, "assets/app.css") });
const aHash = hash(join(out, "assets/app.js")), cHash = hash(join(out, "assets/app.css"));

let html = readFileSync("index.html", "utf8");
html = html.replace('<link rel="stylesheet" href="./src/ui/styles.css">', `<link rel="stylesheet" href="./assets/app.css?v=${cHash}">`)
  .replace('<script type="module" src="./src/main.ts"></script>', `<script type="module" src="./assets/app.js?v=${aHash}"></script>`);
writeFileSync(join(out, "index.html"), html);
cpSync("public", out, { recursive: true });

// офлайн-кэш: точный список файлов этой сборки
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p.slice(out.length + 1).replace(/\\/g, "/")); } };
walk(out);
const version = createHash("sha256").update(aHash + cHash + wHash).digest("hex").slice(0, 8);
const list = ["./", ...files.filter((f) => f !== "sw.js").map((f) => "./" + f.replace("assets/app.js", `assets/app.js?v=${aHash}`).replace("assets/app.css", `assets/app.css?v=${cHash}`).replace("assets/worker.js", `assets/worker.js?v=${wHash}`))];
const sw = readFileSync(join(out, "sw.js"), "utf8").replace("__VERSION__", version).replace('"__FILES__"', JSON.stringify(list));
writeFileSync(join(out, "sw.js"), sw);
let total = 0; for (const f of files) total += statSync(join(out, f)).size;
console.log(`dist готов: ${files.length} файлов, ${(total / 1024).toFixed(0)} КБ, версия ${version}`);
