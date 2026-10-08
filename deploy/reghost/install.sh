#!/usr/bin/env bash
# Yarko на обычном хостинге Рег.ру (ispmanager + Python/Passenger) — полный переезд с Render.
#
# Перед запуском в панели: Сайты → ярко.space → Изменить → «Дополнительные возможности»:
#   включить «CGI-скрипты» и «Python» (любая версия) → ОК.
# Запуск (Shell-клиент в панели или SSH):
#   curl -fsSL https://raw.githubusercontent.com/timagrozer-tech/TimDOX/krug-site/deploy/reghost/install.sh | bash
#
# Что делает: ставит Python 3.11 (свой, если на хостинге старее), код и зависимости, забирает настройки
# с Render (по секрету российского входа, который уже лежит на хостинге), переключает сайт на Python-приложение,
# проверяет его и при неудаче возвращает всё как было. Повторный запуск безопасен.
set -uo pipefail

DOMAIN="${YARKO_DOMAIN:-xn--j1aie3d.space}"
REPO="timagrozer-tech/TimDOX"
BRANCH="krug-site"
OLD="${YARKO_OLD:-https://krug-social.onrender.com}"
Y="$HOME/yarko"
SITE="${YARKO_SITE:-$HOME/www/$DOMAIN}"
TS=$(date +%Y%m%d-%H%M%S)

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

[ -d "$SITE" ] || die "Не найдена папка сайта $SITE"
mkdir -p "$Y/releases" "$Y/data/uploads"
cd "$Y" || die "нет $Y"
exec > >(tee -a "$Y/install.log") 2>&1
echo "=== Установка $(date) ==="

# ------------------------------------------------------------------ 1. Python
say "1/7 Python"
PY=""
for c in "$Y/python/bin/python3" /opt/python/python-3.1[0-9]*/bin/python3 /opt/python/python-3.1[0-9]*/bin/python \
         /usr/local/bin/python3.1[0-9] /usr/bin/python3.1[0-9] /usr/bin/python3; do
  [ -x "$c" ] || continue
  if "$c" -c 'import sys, venv, ssl; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "    На хостинге нет Python 3.10+ — скачиваю готовый Python 3.11"
  URL=$(curl -fsSL https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
        | grep -o '"browser_download_url": *"[^"]*cpython-3\.11\.[0-9]*+[0-9]*-x86_64-unknown-linux-gnu-install_only\.tar\.gz"' \
        | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
  [ -n "$URL" ] || die "Не удалось найти сборку Python"
  rm -rf "$Y/python" && curl -fsSL "$URL" | tar -xz -C "$Y" || die "Не удалось скачать Python"
  PY="$Y/python/bin/python3"
fi
"$PY" --version && ok "Python: $PY"

# ------------------------------------------------------------------ 2. Код
say "2/7 Код сайта"
SHA=$(curl -fsSL "https://github.com/$REPO.git/info/refs?service=git-upload-pack" | tr -d '\0' \
      | grep -a "refs/heads/$BRANCH\$" | head -1 | cut -c5-44)
[ ${#SHA} -eq 40 ] || SHA=$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH")
[ ${#SHA} -eq 40 ] || die "Не удалось узнать последнюю версию кода на GitHub"
REL="$Y/releases/$SHA"
if [ ! -f "$REL/.commit" ]; then
  rm -rf "$REL.tmp" && mkdir -p "$REL.tmp"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$SHA" | tar -xz -C "$REL.tmp" --strip-components=1 || die "Не удалось скачать код"
  echo "$SHA" > "$REL.tmp/.commit"
  rm -rf "$REL" && mv "$REL.tmp" "$REL"
fi
ok "версия ${SHA:0:8}"

# ------------------------------------------------------------------ 3. Зависимости
say "3/7 Библиотеки (пара минут)"
[ -x "$Y/venv/bin/python" ] || "$PY" -m venv "$Y/venv" || die "Не удалось создать окружение Python"
if [ "${YARKO_SKIP_PIP:-0}" != 1 ]; then
"$Y/venv/bin/python" -m pip install -q --disable-pip-version-check --upgrade pip >/dev/null 2>&1
"$Y/venv/bin/python" -m pip install -q --disable-pip-version-check -r "$REL/requirements.txt" || die "Не удалось установить библиотеки"
fi
ok "готово"

# ------------------------------------------------------------------ 4. Настройки
say "4/7 Настройки с Render"
if [ ! -s "$Y/yarko.env" ] || [ "${YARKO_REFETCH:-0}" = 1 ]; then
  SECRET=$(grep -o "YARKO_EDGE_SECRET') ?: '[^']*'" "$SITE/index.php" 2>/dev/null | sed "s/.*?: '\([^']*\)'/\1/")
  [ -z "$SECRET" ] && [ -f "$Y/edge-secret" ] && SECRET=$(cat "$Y/edge-secret")
  [ -n "$SECRET" ] && [ "$SECRET" != "__EDGE_SECRET__" ] || die "Не найден секрет российского входа в $SITE/index.php"
  echo "$SECRET" > "$Y/edge-secret" && chmod 600 "$Y/edge-secret"
  for i in 1 2 3 4 5 6; do   # бесплатный Render мог уснуть — даём ему проснуться
    curl -fsS --max-time 120 -X POST "$OLD/api/edge/env" -H "X-Yarko-Edge: $SECRET" -H "Content-Type: application/json" \
         -d '{}' -o "$Y/env.json" 2>/dev/null && grep -q DATABASE_URL "$Y/env.json" && break
    echo "    Render просыпается… ($i)"; sleep 20
  done
  grep -q DATABASE_URL "$Y/env.json" 2>/dev/null || die "Не удалось забрать настройки с Render"
  "$Y/venv/bin/python" - "$Y" "$SITE" "$DOMAIN" "$SHA" <<'PY'
import json, sys, os
y, site, domain, sha = sys.argv[1:]
env = json.load(open(f"{y}/env.json"))
env.update({
    "APP_URL": f"https://{domain}", "DATA_DIR": f"{y}/data", "UPLOAD_DIR": f"{y}/data/uploads",
    "REALTIME": "db", "TRUSTED_PROXY_HOPS": "0", "MEDIA_PROXY": "1", "MEDIA_CACHE_DIR": f"{site}/uploads",
    "YARKO_HOME": y, "YARKO_SITE": site, "COOKIE_SECURE": "1", "DEBUG": "0",
})
env.pop("RENDER", None)
with open(f"{y}/yarko.env", "w") as f:
    for k, v in env.items():
        v = str(v)
        if "\n" not in v:
            f.write(f"{k}={v}\n")
os.chmod(f"{y}/yarko.env", 0o600)
print(f"    перенесено настроек: {len(env)}")
PY
  rm -f "$Y/env.json"
fi
ok "файл настроек $Y/yarko.env"

# ------------------------------------------------------------------ 5. Проверка базы и кода
say "5/7 Проверка"
ln -sfn "releases/$SHA" "$Y/current"
CHECK=$(cd "$Y/current" && KRUG_BACKGROUND=0 "$Y/venv/bin/python" -c '
import os, sys
for line in open(sys.argv[1], encoding="utf-8"):
    k, _, v = line.rstrip("\n").partition("=")
    if k and not k.startswith("#"):
        os.environ.setdefault(k, v)
import app.main
from app import db
db.connect()
print("users:", db.value("SELECT count(*) FROM users"))' "$Y/yarko.env" 2>&1 | tail -3)
echo "    $CHECK"
echo "$CHECK" | grep -q "^users:" || die "Код не запустился или нет связи с базой (см. выше)"
ok "база доступна"
SMOKE=$(cd "$Y/current" && KRUG_BACKGROUND=0 YARKO_SELFUPDATE=0 "$Y/venv/bin/python" -c '
import io, os, sys
for line in open(sys.argv[1], encoding="utf-8"):
    k, _, v = line.rstrip("\n").partition("=")
    if k and not k.startswith("#"):
        os.environ.setdefault(k, v)
os.environ["DATA_DIR"] = os.environ.get("DATA_DIR", "") + "/smoke"
from app.wsgi import application
res = {}
body = b"".join(application({"REQUEST_METHOD": "GET", "PATH_INFO": "/api/health", "QUERY_STRING": "", "wsgi.input": io.BytesIO(),
    "SERVER_NAME": "localhost", "SERVER_PORT": "443", "HTTP_HOST": sys.argv[2], "wsgi.url_scheme": "https", "REMOTE_ADDR": "127.0.0.1"},
    lambda st, h, e=None: res.update(st=st)))
print("wsgi:", res.get("st"), body[:60].decode("utf-8", "replace"))
os._exit(0)' "$Y/yarko.env" "$DOMAIN" 2>&1 | tail -4)
echo "    $SMOKE"
echo "$SMOKE" | grep -q '^wsgi: 200' || die "Приложение не запускается в режиме хостинга (см. выше)"
ok "приложение отвечает"

# ------------------------------------------------------------------ 6. Переключение сайта
say "6/7 Переключаю сайт на Python"
BK="$Y/edge-backup-$TS"
mkdir -p "$BK"
for f in index.php .htaccess .user.ini cache static; do
  [ -e "$SITE/$f" ] || [ -L "$SITE/$f" ] || continue
  if [ "$f" = static ] && [ -L "$SITE/static" ]; then rm -f "$SITE/static"; continue; fi
  mv "$SITE/$f" "$BK/"
done
mkdir -p "$SITE/uploads" "$SITE/tmp"
rm -rf "$SITE/static" && cp -R "$Y/current/static" "$SITE/static" || die "Не удалось скопировать static"
cat > "$SITE/passenger_wsgi.py" <<EOF
# Yarko: запуск через Passenger (создано установщиком deploy/reghost/install.sh)
import os, sys
HOME = "$Y"
INTERP = HOME + "/venv/bin/python"
if sys.executable != INTERP:
    os.execl(INTERP, INTERP, *sys.argv)
APP = os.path.realpath(HOME + "/current")
for line in open(HOME + "/yarko.env", encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v)
os.environ["YARKO_COMMIT"] = open(APP + "/.commit").read().strip()[:12]
sys.path.insert(0, APP)
os.chdir(APP)
from app.wsgi import application  # noqa: E402,F401
EOF
cat > "$SITE/.htaccess" <<'EOF'
# Yarko: Python-приложение (Passenger). Готовые файлы (static, uploads) отдаёт сам веб-сервер.
<FilesMatch "^(passenger_wsgi\.py|\.restart-app|\.htaccess)$">
  <IfModule mod_authz_core.c>
    Require all denied
  </IfModule>
  <IfModule !mod_authz_core.c>
    Order allow,deny
    Deny from all
  </IfModule>
</FilesMatch>
RewriteEngine On
RewriteCond %{HTTPS} !=on
RewriteCond %{HTTP:X-Forwarded-Proto} !=https
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]
RewriteRule ^(tmp|cache)(/|$) - [F,L]
AddType application/javascript .js .mjs
AddType application/manifest+json .webmanifest
AddType image/svg+xml .svg
AddType image/webp .webp
AddType font/woff2 .woff2
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css application/javascript application/json image/svg+xml application/manifest+json
</IfModule>
<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType image/jpeg "access plus 1 year"
  ExpiresByType image/png "access plus 1 year"
  ExpiresByType image/webp "access plus 1 year"
  ExpiresByType video/mp4 "access plus 1 year"
</IfModule>
EOF
touch "$SITE/.restart-app" "$SITE/tmp/restart.txt"
ok "сайт переключён (старый вход сохранён в $BK)"

# ------------------------------------------------------------------ 7. Проверка сайта
say "7/7 Проверяю ярко.space"
GOOD=0
for i in $(seq 1 24); do
  sleep 5
  CODE=$(curl -s --max-time 40 -o "$Y/last-response.html" -w "%{http_code}" "https://$DOMAIN/api/health" 2>/dev/null)
  if grep -q '"ok"' "$Y/last-response.html" 2>/dev/null; then GOOD=1; break; fi
  TXT=$(sed 's/<[^>]*>/ /g' "$Y/last-response.html" 2>/dev/null | tr -s ' \n' ' ' | cut -c1-120)
  echo "    ждём запуска… ($i) код $CODE: $TXT"
done
if [ "$GOOD" != 1 ]; then
  echo
  echo "    ---- ответ сайта ----"
  sed 's/<[^>]*>//g' "$Y/last-response.html" 2>/dev/null | grep -v '^[[:space:]]*$' | head -40
  echo "    ---- журналы ошибок ----"
  for f in "$HOME"/logs/*"$DOMAIN"*error* "$HOME"/logs/*error*; do [ -f "$f" ] && { echo "[$f]"; tail -n 25 "$f"; break; }; done
  echo "    -------------------"
  echo "    Не запустилось — возвращаю прежний вход (через Render)"
  rm -rf "$SITE/passenger_wsgi.py" "$SITE/.htaccess" "$SITE/static"
  for f in "$BK"/* "$BK"/.htaccess "$BK"/.user.ini; do [ -e "$f" ] && mv "$f" "$SITE/"; done
  die "Python-приложение не ответило (подробности выше). Пришлите скриншот этого экрана."
fi
echo
printf '\033[1;32m✓ Готово! Yarko работает прямо на хостинге Рег.ру, без Render.\033[0m\n'
echo "  Обновления с GitHub подтягиваются сами каждые 3 минуты (журнал: $Y/update.log)."
