"""Номера телефонов: приведение к единому виду (+7XXXXXXXXXX) и «технический» адрес почты для аккаунтов без почты.

Таблица users хранит почту как обязательное уникальное поле, поэтому у тех, кто зарегистрировался только по номеру,
там лежит адрес в зарезервированном домене .invalid (на него никогда ничего не отправляется и он не показывается).
"""
import re

PLACEHOLDER_DOMAIN = "phone.invalid"


def normalize(raw) -> str | None:
    """«8 (912) 345-67-89», «+7 912 345 67 89», «9123456789» → «+79123456789»; другие страны — +код и 8–15 цифр"""
    s = str(raw or "").strip()
    if not s:
        return None
    plus = s.startswith("+")
    digits = re.sub(r"\D", "", s)
    if not plus:
        if len(digits) == 11 and digits[0] in "78":
            digits = "7" + digits[1:]
        elif len(digits) == 10 and digits[0] == "9":
            digits = "7" + digits
        else:
            return None
    if digits.startswith("7") and len(digits) != 11:
        return None
    if not (8 <= len(digits) <= 15) or digits[0] == "0":
        return None
    return "+" + digits


def placeholder_email(phone: str) -> str:
    return f"{phone.lstrip('+')}@{PLACEHOLDER_DOMAIN}"


def is_placeholder(email: str | None) -> bool:
    return bool(email) and str(email).lower().endswith("@" + PLACEHOLDER_DOMAIN)


def public_email(email: str | None) -> str:
    return "" if is_placeholder(email) else (email or "")


def mask(phone: str | None) -> str:
    if not phone:
        return ""
    return phone[:-7] + " ••• ••" + phone[-2:] if len(phone) > 9 else phone
