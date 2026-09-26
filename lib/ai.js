// TimDOX — общий модуль работы с ИИ.
// API-ключ живёт только на сервере и никогда не попадает в браузер.
// По умолчанию — OpenRouter с бесплатными моделями (openrouter/free).
// Также поддерживается DeepSeek и любой OpenAI-совместимый API.

const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  custom: {
    name: 'Свой API',
    baseUrl: '',
    model: '',
    keyEnv: 'AI_API_KEY',
  },
};

// Какой провайдер использовать: явно из AI_PROVIDER, иначе — по тому, какой ключ задан.
function detectProvider() {
  const explicit = (process.env.AI_PROVIDER || '').toLowerCase().trim();
  if (PROVIDERS[explicit]) return explicit;
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  const k = process.env.AI_API_KEY || '';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k && process.env.AI_BASE_URL) return 'custom';
  return 'openrouter';
}

export function getConfig() {
  const providerId = detectProvider();
  const p = PROVIDERS[providerId];
  const apiKey = (process.env[p.keyEnv] || process.env.AI_API_KEY || '').trim();
  const model = process.env.AI_MODEL || p.model;
  return {
    providerId,
    providerName: p.name,
    isFree: providerId === 'openrouter' && (model === 'openrouter/free' || model.endsWith(':free')),
    baseUrl: (process.env.AI_BASE_URL || p.baseUrl).replace(/\/+$/, ''),
    model,
    apiKey,
    accessCode: process.env.ACCESS_CODE || '',
    maxInputChars: Number(process.env.MAX_INPUT_CHARS || 200000),
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 8000),
    rateLimitPerHour: Number(process.env.RATE_LIMIT_PER_HOUR || 30),
    siteUrl: process.env.SITE_URL || '',
  };
}

export function healthInfo() {
  const c = getConfig();
  // Только ИМЕНА похожих переменных (без значений) — чтобы понять, почему ключ не виден
  const envNames = Object.keys(process.env)
    .filter((k) => /OPEN|ROUTER|DEEPSEEK|API_?KEY|^AI_/i.test(k))
    .sort();
  return {
    ok: true,
    configured: Boolean(c.apiKey && c.baseUrl && c.model),
    provider: c.providerName + (c.isFree ? ' · бесплатно' : ''),
    model: c.model,
    accessCodeRequired: Boolean(c.accessCode),
    envNames,
    environment: process.env.VERCEL_ENV || 'local',
  };
}

// ---- простой лимит запросов по IP (в памяти процесса) ----
const hits = new Map();
function rateLimited(ip, limit) {
  if (!limit || limit <= 0) return false;
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const list = (hits.get(ip) || []).filter((t) => t > hourAgo);
  if (list.length >= limit) {
    hits.set(ip, list);
    return true;
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => t > hourAgo)) hits.delete(k);
  }
  return false;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

async function readJsonBody(req, limitBytes) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel уже распарсил
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

// Понятные сообщения об ошибках провайдера
function upstreamError(status, detail, c) {
  const d = (detail || '').toLowerCase();
  if (d.includes('data policy') || d.includes('no endpoints found matching')) {
    return {
      status: 503, code: 'openrouter_privacy',
      error: 'OpenRouter не пускает к бесплатным моделям: владельцу сайта нужно включить настройку «Free model publication» на странице openrouter.ai/settings/privacy.',
    };
  }
  if (status === 401 || status === 403) {
    return { status: 502, code: 'bad_key', error: 'ИИ-провайдер отклонил API-ключ. Проверьте ключ в настройках сервера.' };
  }
  if (status === 402) {
    return { status: 502, code: 'no_credits', error: c.providerId === 'openrouter'
      ? 'OpenRouter требует пополнения баланса для этой модели. Для бесплатной работы используйте модель openrouter/free.'
      : 'На балансе ИИ-провайдера закончились средства.' };
  }
  if (status === 429) {
    if (d.includes('per-day') || d.includes('per day') || d.includes('daily')) {
      return { status: 429, code: 'daily_limit', error: 'Бесплатный дневной лимит запросов к ИИ исчерпан. Он обновится завтра (или владелец сайта может пополнить OpenRouter на $10 — тогда лимит станет 1000 запросов в день).' };
    }
    return { status: 429, code: 'rate_limited', error: 'Бесплатные модели сейчас перегружены. Подождите минуту и попробуйте снова.' };
  }
  if (status === 404) {
    return { status: 502, code: 'bad_model', error: `Модель «${c.model}» не найдена у провайдера. Проверьте AI_MODEL.` };
  }
  if (status === 400) {
    return { status: 400, code: 'bad_request', error: 'ИИ не принял запрос — возможно, слишком много данных для этой модели. Сократите таблицу или образец.' };
  }
  return { status: 502, code: 'upstream', error: 'ИИ-провайдер временно недоступен. Попробуйте ещё раз.' };
}

// Некоторые бесплатные модели пишут рассуждения прямо в текст в тегах <think>…</think> — вырезаем их.
function makeThinkFilter() {
  const OPEN = '<think>', CLOSE = '</think>';
  let pending = '';
  let inThink = false;
  let started = false;
  const emit = (s) => {
    if (!started) { s = s.replace(/^\s+/, ''); if (s) started = true; }
    return s;
  };
  return {
    push(text) {
      pending += text;
      let out = '';
      while (pending) {
        if (inThink) {
          const i = pending.indexOf(CLOSE);
          if (i === -1) { pending = pending.slice(-(CLOSE.length - 1)); break; }
          pending = pending.slice(i + CLOSE.length);
          inThink = false;
        } else {
          const i = pending.indexOf(OPEN);
          if (i !== -1) { out += pending.slice(0, i); pending = pending.slice(i + OPEN.length); inThink = true; continue; }
          // держим хвост, если он может оказаться началом тега <think>
          let keep = 0;
          for (let k = Math.min(OPEN.length - 1, pending.length); k > 0; k--) {
            if (OPEN.startsWith(pending.slice(-k))) { keep = k; break; }
          }
          out += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
          break;
        }
      }
      return emit(out);
    },
    flush() { const rest = inThink ? '' : pending; pending = ''; return emit(rest); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handleChat(req, res) {
  const c = getConfig();

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Используйте POST' });
  if (!c.apiKey) {
    return sendJson(res, 503, { code: 'not_configured', error: 'ИИ ещё не подключён: владельцу сайта нужно указать API-ключ на сервере.' });
  }
  if (c.accessCode && req.headers['x-access-code'] !== c.accessCode) {
    return sendJson(res, 401, { code: 'access_code', error: 'Нужен код доступа.' });
  }
  if (rateLimited(clientIp(req), c.rateLimitPerHour)) {
    return sendJson(res, 429, { code: 'rate_limited', error: 'Слишком много запросов с вашего адреса. Попробуйте через час.' });
  }

  let body;
  try {
    body = await readJsonBody(req, c.maxInputChars * 4 + 50_000);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.status === 413 ? 'Слишком много данных в запросе.' : 'Некорректный запрос.' });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || !messages.length || messages.length > 40) {
    return sendJson(res, 400, { error: 'Некорректный список сообщений.' });
  }
  let total = 0;
  const clean = [];
  for (const m of messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) {
      return sendJson(res, 400, { error: 'Некорректное сообщение.' });
    }
    total += m.content.length;
    clean.push({ role: m.role, content: m.content });
  }
  if (total > c.maxInputChars) {
    return sendJson(res, 413, { code: 'too_large', error: `Слишком много данных (${total} симв., максимум ${c.maxInputChars}). Сократите таблицу или образец.` });
  }

  const payload = {
    model: c.model,
    messages: clean,
    stream: true,
    max_tokens: Math.min(Number(body.max_tokens) || c.maxOutputTokens, c.maxOutputTokens),
  };
  if (c.providerId === 'deepseek') {
    payload.thinking = { type: 'disabled' }; // быстрее и дешевле для деловых текстов
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${c.apiKey}`,
  };
  if (c.providerId === 'openrouter') {
    const referer = c.siteUrl || (req.headers.host ? `https://${req.headers.host}` : '');
    if (referer) headers['HTTP-Referer'] = referer;
    headers['X-Title'] = 'TimDOX';
  }

  const controller = new AbortController();
  req.on('close', () => { if (!res.writableEnded) controller.abort(); });

  // Запрос к провайдеру; один повтор при временных сбоях (перегрузка бесплатных моделей и т.п.)
  let upstream;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      upstream = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) return res.end();
      console.error('[TimDOX] upstream fetch failed:', e?.message);
      if (attempt === 2) return sendJson(res, 502, { error: 'Не удалось связаться с ИИ-провайдером.' });
      await sleep(1500);
      continue;
    }
    if (upstream.ok && upstream.body) break;
    const detail = await upstream.text().catch(() => '');
    console.error('[TimDOX] upstream error', upstream.status, detail.slice(0, 500));
    const err = upstreamError(upstream.status, detail, c);
    const transient = [408, 500, 502, 503, 504].includes(upstream.status) || err.code === 'rate_limited';
    if (attempt === 1 && transient && !controller.signal.aborted) {
      const ra = Number(upstream.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 && ra <= 10 ? ra * 1000 : 2000);
      continue;
    }
    return sendJson(res, err.status, { code: err.code, error: err.error });
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const filter = makeThinkFilter();
  const decoder = new TextDecoder();
  let buffer = '';
  let sentAny = false;
  const write = (s) => { if (s) { res.write(s); sentAny = true; } };
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // служебные комментарии и пустые строки
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const err = upstreamError(Number(json.error.code) || 502, json.error.message, c);
            write(`\n\n[Ошибка ИИ: ${err.error}]`);
            continue;
          }
          write(filter.push(json.choices?.[0]?.delta?.content || ''));
        } catch { /* неполная строка — пропускаем */ }
      }
    }
    write(filter.flush());
  } catch (e) {
    if (!controller.signal.aborted) console.error('[TimDOX] stream error:', e?.message);
  }
  if (!sentAny && !controller.signal.aborted) res.write('[Ошибка ИИ: модель вернула пустой ответ, попробуйте ещё раз]');
  res.end();
}

export function handleHealth(req, res) {
  sendJson(res, 200, healthInfo());
}
