#!/usr/bin/env bash
# Yarko на своём сервере в России (Ubuntu 22.04/24.04): сайт, HTTPS, ретранслятор звонков и автообновление.
#
# Запуск в консоли сервера (под root):
#   curl -fsSL https://raw.githubusercontent.com/timagrozer-tech/TimDOX/krug-site/deploy/vps/install.sh | bash -s -- ТОКЕН
# ТОКЕН — одноразовый ключ переезда: по нему сервер сам заберёт настройки со старого сайта (Render).
# Повторный запуск безопасен: обновит код и настройки сервисов, ключи не тронет.
set -euo pipefail

DOMAIN="xn--j1aie3d.space"                 # ярко.space
REPO="https://github.com/timagrozer-tech/TimDOX.git"
BRANCH="krug-site"
OLD="https://krug-social.onrender.com"
APP=/opt/yarko
DATA=/var/lib/yarko
ENVF=/etc/yarko.env
TOKEN="${1:-}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Запустите от root (или через sudo)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "1/7 Пакеты"
apt-get update -qq
apt-get install -y -qq git python3-venv python3-pip curl openssl coturn ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq caddy >/dev/null 2>&1 || {
    # нет в репозитории — ставим готовый пакет с GitHub
    ARCH=$(dpkg --print-architecture)
    URL=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | grep -o "https://[^\"]*linux_${ARCH}.deb" | head -1)
    curl -fsSL "$URL" -o /tmp/caddy.deb && dpkg -i /tmp/caddy.deb >/dev/null
  }
fi

say "2/7 Код сайта"
id yarko >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin yarko
mkdir -p "$DATA/uploads"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH" && git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$APP"
fi
python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"
chown -R yarko:yarko "$DATA"

say "3/7 Настройки"
if [ ! -s "$ENVF" ]; then
  [ -n "$TOKEN" ] || { echo "Нужен токен переезда: bash -s -- ТОКЕН"; exit 1; }
  curl -fsS --retry 3 -X POST "$OLD/api/edge/env" -H "x-migrate-token: $TOKEN" -o /tmp/yarko-env.json \
    || { echo "Не удалось забрать настройки со старого сайта (токен неверный или уже использован)"; exit 1; }
  TURN_SECRET=$(openssl rand -hex 24)
  python3 - "$ENVF" "$DOMAIN" "$DATA" "$TURN_SECRET" <<'PY'
import json, sys, shlex
envf, domain, data, turn = sys.argv[1:]
env = json.load(open("/tmp/yarko-env.json"))
env.update({"APP_URL": f"https://{domain}", "DATA_DIR": data, "UPLOAD_DIR": f"{data}/uploads",
            "TRUSTED_PROXY_HOPS": "1", "TURN_SECRET": turn, "TURN_HOST": domain, "PORT": "8000"})
with open(envf, "w") as f:
    for k, v in env.items():
        if "\n" in v:
            continue
        f.write(f"{k}={v}\n")
PY
  rm -f /tmp/yarko-env.json
  chmod 600 "$ENVF"
fi
TURN_SECRET=$(grep '^TURN_SECRET=' "$ENVF" | cut -d= -f2-)

say "4/7 Служба сайта"
cat > /etc/systemd/system/yarko.service <<EOF
[Unit]
Description=Yarko
After=network-online.target
Wants=network-online.target

[Service]
User=yarko
WorkingDirectory=$APP
EnvironmentFile=$ENVF
Environment=PYTHONUNBUFFERED=1
ExecStartPre=$APP/.venv/bin/python -m scripts.bootstrap
ExecStart=$APP/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips 127.0.0.1 --timeout-graceful-shutdown 5
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

say "5/7 HTTPS (Caddy)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN, www.$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8000 {
		flush_interval -1
	}
}
EOF

say "6/7 Ретранслятор звонков (TURN)"
IP=$(hostname -I | awk '{print $1}')
cat > /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
external-ip=$IP
min-port=49160
max-port=49999
no-tls
no-dtls
no-cli
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
total-quota=200
log-file=syslog
EOF
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
if command -v ufw >/dev/null && ufw status | grep -q active; then
  ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp; ufw allow 3478; ufw allow 49160:49999/udp
fi

say "7/7 Автообновление (как на Render: после каждой выкладки кода)"
cat > /usr/local/bin/yarko-update <<EOF
#!/usr/bin/env bash
set -e
cd $APP
git fetch -q origin $BRANCH
[ "\$(git rev-parse HEAD)" = "\$(git rev-parse origin/$BRANCH)" ] && exit 0
OLD_REQ=\$(md5sum requirements.txt)
git reset -q --hard origin/$BRANCH
[ "\$OLD_REQ" = "\$(md5sum requirements.txt)" ] || $APP/.venv/bin/pip install -q -r requirements.txt
systemctl restart yarko
EOF
chmod +x /usr/local/bin/yarko-update
cat > /etc/systemd/system/yarko-update.service <<EOF
[Unit]
Description=Yarko: обновление кода
[Service]
Type=oneshot
ExecStart=/usr/local/bin/yarko-update
EOF
cat > /etc/systemd/system/yarko-update.timer <<EOF
[Unit]
Description=Yarko: проверка обновлений каждые 2 минуты
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable -q --now yarko yarko-update.timer coturn caddy
systemctl restart yarko coturn caddy
sleep 4
if curl -fsS http://127.0.0.1:8000/api/health >/dev/null; then
  say "Готово! Сайт работает на этом сервере."
else
  say "Сайт не ответил — журнал: journalctl -u yarko -n 50"
fi
echo
echo "Адрес сервера: $IP"
echo "Теперь в Рег.ру поменяйте обе A-записи ярко.space (@ и www) на $IP."
echo "Сертификат HTTPS выпустится сам в течение пары минут после смены DNS."
