"""Проверка ретранслятора звонков (TURN): можно ли выделить канал с нашими учётными данными.

Шлём Allocate (RFC 5766) по TCP/TLS: первый ответ — 401 с realm и nonce, второй, подписанный ключом
MD5(user:realm:password), должен вернуть успех. Так сайт сам проверяет, что звонки из России пойдут через ретранслятор.
"""
import hashlib
import hmac
import os
import socket
import ssl
import struct

MAGIC = 0x2112A442


def _attr(t: int, v: bytes) -> bytes:
    pad = (4 - len(v) % 4) % 4
    return struct.pack("!HH", t, len(v)) + v + b"\0" * pad


def _msg(mtype: int, tid: bytes, attrs: bytes) -> bytes:
    return struct.pack("!HHI", mtype, len(attrs), MAGIC) + tid + attrs


def _parse(data: bytes) -> tuple[int, dict]:
    mtype, length, _ = struct.unpack("!HHI", data[:8])
    attrs, pos = {}, 20
    while pos + 4 <= 20 + length and pos + 4 <= len(data):
        t, ln = struct.unpack("!HH", data[pos:pos + 4])
        attrs[t] = data[pos + 4:pos + 4 + ln]
        pos += 4 + ln + (4 - ln % 4) % 4
    return mtype, attrs


def _recv(sock) -> bytes:
    head = b""
    while len(head) < 20:
        chunk = sock.recv(20 - len(head))
        if not chunk:
            raise ConnectionError("соединение закрыто")
        head += chunk
    length = struct.unpack("!H", head[2:4])[0]
    body = b""
    while len(body) < length:
        chunk = sock.recv(length - len(body))
        if not chunk:
            raise ConnectionError("соединение закрыто")
        body += chunk
    return head + body


def allocate(host: str, port: int, username: str, password: str, tls: bool = False, timeout: float = 8) -> str:
    """Возвращает "ok" или текст ошибки"""
    raw = socket.create_connection((host, port), timeout=timeout)
    sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if tls else raw
    try:
        transport = _attr(0x0019, bytes([17, 0, 0, 0]))  # REQUESTED-TRANSPORT: UDP
        tid = os.urandom(12)
        sock.sendall(_msg(0x0003, tid, transport))
        mtype, attrs = _parse(_recv(sock))
        if mtype != 0x0113:
            return f"неожиданный ответ {mtype:#06x}"
        realm, nonce = attrs.get(0x0014, b""), attrs.get(0x0015, b"")
        key = hashlib.md5(f"{username}:{realm.decode()}:{password}".encode()).digest()
        tid = os.urandom(12)
        body = transport + _attr(0x0006, username.encode()) + _attr(0x0014, realm) + _attr(0x0015, nonce)
        # MESSAGE-INTEGRITY считается по сообщению, где длина уже учитывает сам атрибут (24 байта)
        head = struct.pack("!HHI", 0x0003, len(body) + 24, MAGIC) + tid
        mac = hmac.new(key, head + body, hashlib.sha1).digest()
        sock.sendall(head + body + _attr(0x0008, mac))
        mtype, attrs = _parse(_recv(sock))
        if mtype == 0x0103:
            return "ok"
        err = attrs.get(0x0009, b"")
        code = (err[2] * 100 + err[3]) if len(err) >= 4 else 0
        return f"ошибка {code} {err[4:].decode('utf-8', 'replace')}"
    finally:
        sock.close()


def check_all(servers: list[dict]) -> list[tuple[str, str]]:
    """Проверяет TCP/TLS-адреса ретрансляторов из ice_servers(); UDP здесь не проверить — только по факту звонков"""
    out = []
    for s in servers:
        if not s.get("username"):
            continue
        for url in s["urls"]:
            if not url.startswith(("turn:", "turns:")) or "transport=udp" in url:
                continue
            tls = url.startswith("turns:")
            hostport = url.split(":", 1)[1].split("?")[0]
            host, _, port = hostport.rpartition(":")
            if not ("transport=tcp" in url or tls):
                continue
            try:
                res = allocate(host, int(port), s["username"], s["credential"], tls=tls)
            except Exception as e:  # noqa: BLE001
                res = f"нет связи: {e}"
            out.append((url, res))
    return out
