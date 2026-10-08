<?php
/**
 * Yarko — российский «вход» на обычном хостинге (PHP).
 * Посетители открывают ярко.space на российском сервере, а он сам забирает страницы и данные с основного сервера (Render).
 * Так сайт работает без VPN, даже когда зарубежные адреса замедляют.
 * Статика (стили, скрипты, картинки) кешируется здесь же, чтобы открываться быстрее.
 * Проверка: https://ярко.space/__edge/health
 */
declare(strict_types=1);

define('UPSTREAM', getenv('YARKO_UPSTREAM') ?: 'https://krug-social.onrender.com');
define('EDGE_SECRET', getenv('YARKO_EDGE_SECRET') ?: '__EDGE_SECRET__');   // тот же секрет, что EDGE_SECRET на Render
const CACHE_DIR = __DIR__ . '/cache';
const SKIP_REQ = ['host', 'connection', 'content-length', 'accept-encoding', 'expect', 'transfer-encoding', 'te', 'upgrade',
    'keep-alive', 'proxy-connection', 'x-yarko-edge', 'x-edge-client-ip', 'x-forwarded-for', 'x-forwarded-proto',
    'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];
const SKIP_RESP = ['transfer-encoding', 'connection', 'content-length', 'content-encoding', 'keep-alive', 'alt-svc', 'server',
    'report-to', 'nel', 'cf-ray', 'cf-cache-status', 'rndr-id', 'x-render-origin-server', 'x-powered-by'];

@set_time_limit(0);
@ini_set('zlib.output_compression', '0');
@ini_set('output_buffering', '0');
@ini_set('implicit_flush', '1');
ignore_user_abort(false);
while (ob_get_level() > 0) { @ob_end_clean(); }

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = $_SERVER['REQUEST_URI'] ?? '/';
if (strpos($uri, '/__edge/health') === 0) { health(); exit; }

$isStatic = in_array($method, ['GET', 'HEAD'], true)
    && preg_match('#^/static/[^?]+\.(css|js|svg|png|jpe?g|webp|gif|ico|woff2?|json|webmanifest|mp3|wav)(\?|$)#i', $uri);
if ($isStatic && serve_cached($uri, $method)) exit;
$isStream = strpos($uri, '/api/stream') === 0;

function req_headers(): array {
    if (function_exists('getallheaders')) return getallheaders() ?: [];
    $out = [];
    foreach ($_SERVER as $k => $v) {
        if (strpos($k, 'HTTP_') === 0) $out[str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($k, 5)))))] = $v;
    }
    if (isset($_SERVER['CONTENT_TYPE'])) $out['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    return $out;
}

$in = req_headers();
$ctype = '';
foreach ($in as $k => $v) { if (strtolower($k) === 'content-type') $ctype = (string)$v; }
$multipart = stripos($ctype, 'multipart/form-data') === 0;
$headers = [];
foreach ($in as $k => $v) {
    $lk = strtolower((string)$k);
    if (in_array($lk, SKIP_REQ, true)) continue;
    if ($multipart && $lk === 'content-type') continue;      // curl соберёт тело заново со своей границей
    $headers[] = $k . ': ' . $v;
}
$headers[] = 'X-Yarko-Edge: ' . EDGE_SECRET;
$headers[] = 'X-Edge-Client-IP: ' . ($_SERVER['REMOTE_ADDR'] ?? '');
$headers[] = 'X-Forwarded-Proto: https';
$headers[] = 'Expect:';
if ($isStream) $headers[] = 'Accept-Encoding: identity';

$ch = curl_init(UPSTREAM . $uri);
$status = 0;
$respHeaders = [];
$started = false;
$cacheBuf = $isStatic ? '' : null;

$emitHeaders = function () use (&$started, &$status, &$respHeaders, $isStream) {
    if ($started) return;
    $started = true;
    http_response_code($status ?: 502);
    foreach ($respHeaders as $line) header($line, false);
    if ($isStream) { header('X-Accel-Buffering: no'); header('Cache-Control: no-cache'); }
};

curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => $method,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_ENCODING => $isStream ? null : '',
    CURLOPT_CONNECTTIMEOUT => 20,
    CURLOPT_TIMEOUT => $isStream ? 50 : 180,   // поток событий переподключается сам — так зависшие соединения не занимают хостинг
    CURLOPT_BUFFERSIZE => 16384,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status, &$respHeaders) {
        $t = trim($line);
        if ($t === '') return strlen($line);
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $t, $m)) { $status = (int)$m[1]; $respHeaders = []; return strlen($line); }
        $name = strtolower(trim(explode(':', $t, 2)[0]));
        if (in_array($name, SKIP_RESP, true)) return strlen($line);
        if ($name === 'location') $t = str_replace(UPSTREAM, '', $t);
        $respHeaders[] = $t;
        return strlen($line);
    },
    CURLOPT_WRITEFUNCTION => function ($ch, $data) use ($emitHeaders, &$cacheBuf, $method) {
        $emitHeaders();
        if ($cacheBuf !== null) $cacheBuf .= $data;
        if ($method !== 'HEAD') { echo $data; @flush(); }
        return connection_aborted() ? 0 : strlen($data);
    },
]);
if ($method === 'HEAD') curl_setopt($ch, CURLOPT_NOBODY, true);
if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
    if ($multipart) {
        $fields = flatten($_POST);
        foreach ($_FILES as $field => $f) {
            if (is_array($f['tmp_name'])) {
                foreach ($f['tmp_name'] as $i => $tmp) {
                    if (is_uploaded_file($tmp)) $fields[$field . '[' . $i . ']'] = new CURLFile($tmp, $f['type'][$i] ?: 'application/octet-stream', $f['name'][$i]);
                }
            } elseif (is_uploaded_file($f['tmp_name'])) {
                $fields[$field] = new CURLFile($f['tmp_name'], $f['type'] ?: 'application/octet-stream', $f['name']);
            }
        }
        curl_setopt($ch, CURLOPT_POSTFIELDS, $fields);
    } else {
        curl_setopt($ch, CURLOPT_POSTFIELDS, (string)file_get_contents('php://input'));
    }
}
$ok = curl_exec($ch);
if ($ok === false && !$started) {
    $status = 502;
    $respHeaders = ['Content-Type: text/plain; charset=utf-8', 'Retry-After: 5'];
    $emitHeaders();
    echo 'Сервер Yarko временно недоступен. Обновите страницу через несколько секунд.';
} else {
    $emitHeaders();
}
curl_close($ch);
if ($isStatic && $status === 200 && $cacheBuf !== null && $cacheBuf !== '') save_cache($uri, $respHeaders, $cacheBuf);

function flatten(array $a, string $prefix = ''): array {
    $out = [];
    foreach ($a as $k => $v) {
        $key = $prefix === '' ? (string)$k : $prefix . '[' . $k . ']';
        if (is_array($v)) $out += flatten($v, $key); else $out[$key] = $v;
    }
    return $out;
}

function cache_path(string $uri): string { return CACHE_DIR . '/' . sha1($uri); }

function serve_cached(string $uri, string $method): bool {
    $p = cache_path($uri);
    if (!is_file($p) || !is_file($p . '.h')) return false;
    // со «?v=» в адресе файл не меняется — храним неделю; остальное — 5 минут (после выкладки обновится само)
    $ttl = strpos($uri, '?v=') !== false ? 7 * 86400 : 300;
    if (time() - filemtime($p) > $ttl) return false;
    foreach (json_decode((string)file_get_contents($p . '.h'), true) ?: [] as $line) header($line, false);
    header('X-Edge-Cache: HIT');
    header('Content-Length: ' . filesize($p));
    if ($method !== 'HEAD') readfile($p);
    return true;
}

function save_cache(string $uri, array $headers, string $body): void {
    if (!is_dir(CACHE_DIR) && !@mkdir(CACHE_DIR, 0755, true)) return;
    $keep = array_values(array_filter($headers, fn($h) => preg_match('#^(content-type|cache-control|etag|last-modified):#i', $h)));
    $p = cache_path($uri);
    @file_put_contents($p . '.tmp', $body);
    @rename($p . '.tmp', $p);
    @file_put_contents($p . '.h', json_encode($keep));
}

function health(): void {
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo "Yarko edge: PHP " . PHP_VERSION . ", curl " . (curl_version()['version'] ?? '?') . "\n";
    foreach (['/api/health', '/static/css/orbit.css'] as $path) {
        $ch = curl_init(UPSTREAM . $path);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_ENCODING => '',
            CURLOPT_HTTPHEADER => ['X-Yarko-Edge: ' . EDGE_SECRET]]);
        $t = microtime(true);
        $body = curl_exec($ch);
        printf("%s → %s, %d байт, %.2f с%s\n", $path, curl_getinfo($ch, CURLINFO_HTTP_CODE), $body === false ? 0 : strlen($body),
            microtime(true) - $t, $body === false ? ' — ошибка: ' . curl_error($ch) : '');
        curl_close($ch);
    }
    echo 'Кеш: ' . (is_dir(CACHE_DIR) ? count(glob(CACHE_DIR . '/*.h') ?: []) . ' файлов' : 'пусто') . "\n";
}
