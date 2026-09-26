// TimDOX — сервер без внешних зависимостей. Запуск: node server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Мини-загрузчик .env (чтобы не ставить пакет dotenv)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

const { handleChat, handleHealth, healthInfo } = await import('./lib/ai.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.statusCode = 403; return res.end('Forbidden'); }
  fs.stat(filePath, (err, st) => {
    const target = !err && st.isFile() ? filePath : path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(target);
    res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', ext === '.html' || target.endsWith('sw.js') ? 'no-cache' : 'public, max-age=86400');
    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname === '/api/chat') return await handleChat(req, res);
    if (pathname === '/api/health') return handleHealth(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
    return serveStatic(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end('Server error'); } else res.end();
  }
});

server.listen(PORT, () => {
  const h = healthInfo();
  console.log(`TimDOX запущен: http://localhost:${PORT}`);
  console.log(`ИИ: ${h.provider} / ${h.model} — ${h.configured ? 'ключ найден ✅' : 'КЛЮЧ НЕ УКАЗАН ❌ (см. .env)'}`);
  if (h.accessCodeRequired) console.log('Включён код доступа (ACCESS_CODE).');
});
