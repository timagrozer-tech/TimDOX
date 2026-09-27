/**
 * Отправка писем «Круга» с вашего Gmail (Google Apps Script).
 * 1. script.google.com → «Новый проект» → вставьте этот код вместо всего, что там есть.
 * 2. Впишите в SECRET значение переменной MAIL_WEBHOOK_SECRET с Render.
 * 3. «Начать развертывание» → «Новое развертывание» → тип «Веб-приложение»:
 *    «Выполнять как» — Я, «У кого есть доступ» — Все. Разрешите доступ к Gmail.
 * 4. Скопируйте URL веб-приложения (…/exec) в переменную MAIL_WEBHOOK_URL на Render.
 */
const SECRET = "ВСТАВЬТЕ_СЮДА_MAIL_WEBHOOK_SECRET";

function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: "bad json" }); }
  if (data.secret !== SECRET) return reply({ ok: false, error: "forbidden" });
  MailApp.sendEmail({ to: data.to, subject: data.subject, body: data.text, htmlBody: data.html, name: data.name || "Круг" });
  return reply({ ok: true, left: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
