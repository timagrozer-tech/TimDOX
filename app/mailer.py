"""Отправка писем.

Способы (по приоритету):
1. Brevo HTTP API (BREVO_API_KEY) — работает на бесплатном Render, где SMTP-порты закрыты;
2. SMTP (SMTP_HOST);
3. ничего не настроено — письмо пишется в журнал и в data/outbox.log.
"""
import html as html_lib
import json
import logging
import smtplib
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr

from starlette.concurrency import run_in_threadpool

from . import config, db

log = logging.getLogger("krug.mail")


def configured() -> bool:
    return bool((config.MAIL_WEBHOOK_URL and config.MAIL_WEBHOOK_SECRET) or config.BREVO_API_KEY or config.SMTP_HOST)


def _render_html(text: str, link: str | None, code: str | None) -> str:
    body = html_lib.escape(text).replace("\n", "<br>")
    code_block = ""
    if code:
        spaced = " ".join(code)
        code_block = f"""<div style="margin:22px 0;text-align:center">
<div style="display:inline-block;padding:14px 26px;border-radius:14px;background:#f1edff;border:1px solid #d9d0ff;
font:700 30px/1 'Courier New',monospace;letter-spacing:6px;color:#3b24c7">{spaced}</div>
<div style="font-size:12px;color:#777;margin-top:8px">Код действует 60 минут</div></div>"""
    button = ""
    if link:
        button = f"""<p style="text-align:center;margin:18px 0"><a href="{html_lib.escape(link)}"
style="display:inline-block;background:linear-gradient(120deg,#5b3df5,#d6246e);background-color:#5b3df5;color:#fff;
padding:13px 24px;border-radius:12px;text-decoration:none;font-weight:700">Подтвердить одним нажатием</a></p>"""
    return f"""<div style="background:#f4f1ff;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:20px;padding:28px;box-shadow:0 10px 40px rgba(60,30,160,.12)">
<div style="font-size:22px;font-weight:800;color:#5b3df5;margin-bottom:14px">◯ {html_lib.escape(config.APP_NAME)}</div>
<p style="font-size:15px;line-height:1.55;color:#222;margin:0">{body}</p>
{code_block}{button}
<p style="font-size:12px;color:#999;margin:20px 0 0">Если вы не запрашивали это письмо, просто проигнорируйте его.</p>
</div></div>"""


def _send_brevo(to: str, subject: str, text: str, html: str) -> None:
    payload = {
        "sender": {"name": config.MAIL_FROM_NAME, "email": config.MAIL_FROM_EMAIL},
        "to": [{"email": to}],
        "subject": subject,
        "htmlContent": html,
        "textContent": text,
    }
    req = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email", data=json.dumps(payload).encode(), method="POST",
        headers={"api-key": config.BREVO_API_KEY, "content-type": "application/json", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Brevo ответил {e.code}: {e.read()[:300]!r}") from None


def _send_webhook(to: str, subject: str, text: str, html: str) -> None:
    """Google Apps Script (или любой сервис с тем же форматом): POST JSON, ответ {"ok": true}."""
    payload = {"secret": config.MAIL_WEBHOOK_SECRET, "to": to, "subject": subject, "text": text, "html": html,
               "name": config.MAIL_FROM_NAME}
    req = urllib.request.Request(config.MAIL_WEBHOOK_URL, data=json.dumps(payload).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # Google отвечает перенаправлением — urllib проходит его сам
            body = resp.read()[:500]
    except urllib.error.HTTPError as e:
        hint = " — в развёртывании скрипта нужно выбрать доступ «Все»" if e.code in (401, 403) else ""
        raise RuntimeError(f"Скрипт отправки писем ответил {e.code}{hint}") from None
    try:
        ok = json.loads(body).get("ok")
    except ValueError:
        ok = False
    if not ok:
        raise RuntimeError(f"Скрипт отправки ответил: {body!r}")


def _send_smtp(to: str, subject: str, text: str, html: str) -> None:
    msg = EmailMessage()
    msg["From"] = formataddr((config.MAIL_FROM_NAME, config.MAIL_FROM_EMAIL))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    if config.SMTP_TLS and config.SMTP_PORT == 465:
        server = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=15)
    else:
        server = smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15)
        if config.SMTP_TLS:
            server.starttls()
    with server:
        if config.SMTP_USER:
            server.login(config.SMTP_USER, config.SMTP_PASSWORD)
        server.send_message(msg)


async def send(to: str, subject: str, text: str, link: str | None = None, code: str | None = None) -> bool:
    """Отправляет письмо. Возвращает True, если письмо ушло (или принято сервисом)."""
    from . import phones
    if phones.is_placeholder(to):  # аккаунт без почты (только телефон) — писать некуда
        return False
    html = _render_html(text, link, code)
    full_text = text + (f"\n\nКод: {code}" if code else "") + (f"\n\n{link}" if link else "")
    if not configured():
        entry = f"[{db.now()}] To: {to}\nSubject: {subject}\n{full_text}\n{'-' * 60}\n"
        log.warning("Отправка писем не настроена, письмо не отправлено (адресат %s)", to)
        try:
            with open(config.DATA_DIR / "outbox.log", "a", encoding="utf-8") as f:
                f.write(entry)
        except OSError:
            pass
        return False
    try:
        if config.MAIL_WEBHOOK_URL and config.MAIL_WEBHOOK_SECRET:
            await run_in_threadpool(_send_webhook, to, subject, full_text, html)
        elif config.BREVO_API_KEY:
            await run_in_threadpool(_send_brevo, to, subject, full_text, html)
        else:
            await run_in_threadpool(_send_smtp, to, subject, full_text, html)
        return True
    except Exception:  # письмо не должно ронять запрос
        log.exception("Ошибка отправки письма на %s", to)
        return False
