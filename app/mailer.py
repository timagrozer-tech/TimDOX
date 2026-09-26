"""Отправка писем. Без настроенного SMTP письма пишутся в консоль и в data/outbox.log."""
import logging
import smtplib
from email.message import EmailMessage

from starlette.concurrency import run_in_threadpool

from . import config, db

log = logging.getLogger("krug.mail")


def _send_sync(to: str, subject: str, text: str, html: str) -> None:
    msg = EmailMessage()
    msg["From"] = config.SMTP_FROM
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


async def send(to: str, subject: str, text: str, link: str | None = None) -> None:
    html = f"""<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px">
<h2 style="color:#1d3a8a;margin:0 0 16px">{config.APP_NAME}</h2>
<p style="font-size:15px;line-height:1.5;color:#222">{text.replace(chr(10), '<br>')}</p>
{f'<p><a href="{link}" style="display:inline-block;background:#1d3a8a;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">Открыть ссылку</a></p>' if link else ''}
<p style="font-size:12px;color:#888">Если вы не запрашивали это письмо, просто проигнорируйте его.</p></div>"""
    full_text = text + (f"\n\n{link}" if link else "")
    if not config.SMTP_HOST:
        entry = f"[{db.now()}] To: {to}\nSubject: {subject}\n{full_text}\n{'-' * 60}\n"
        log.warning("SMTP не настроен, письмо не отправлено:\n%s", entry)
        with open(config.DATA_DIR / "outbox.log", "a", encoding="utf-8") as f:
            f.write(entry)
        return
    try:
        await run_in_threadpool(_send_sync, to, subject, full_text, html)
    except Exception:  # письмо не должно ронять запрос
        log.exception("Ошибка отправки письма на %s", to)
