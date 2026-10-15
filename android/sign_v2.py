"""Подпись APK по схеме APK Signature Scheme v2 (как apksigner), без Android SDK.

Использование: python3 android/sign_v2.py unsigned-aligned.apk signed.apk keystore.p12 password-file
APK должен быть заранее выровнен (zipalign -p 4) — это делает сборка на GitHub.
Подпись v2 достаточна для Android 7.0+ (в приложении minSdk 24). Формат — по документации Android:
https://source.android.com/docs/security/features/apksigning/v2
"""
import hashlib
import struct
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.serialization import pkcs12

SIG_RSA_PKCS1_SHA256 = 0x0103
V2_BLOCK_ID = 0x7109871A
VERITY_PADDING_ID = 0x42726577
MAGIC = b"APK Sig Block 42"
CHUNK = 1024 * 1024


def lp(b: bytes) -> bytes:
    return struct.pack("<I", len(b)) + b


def find_eocd(data: bytes) -> int:
    # EOCD: подпись 0x06054b50, комментарий до 65535 байт
    for i in range(len(data) - 22, max(-1, len(data) - 22 - 65536), -1):
        if data[i:i + 4] == b"PK\x05\x06":
            comment_len = struct.unpack("<H", data[i + 20:i + 22])[0]
            if i + 22 + comment_len == len(data):
                return i
    raise ValueError("EOCD not found")


def chunked_digest(sections: list[bytes]) -> bytes:
    digests = []
    for sec in sections:
        for off in range(0, len(sec), CHUNK):
            part = sec[off:off + CHUNK]
            digests.append(hashlib.sha256(b"\xa5" + struct.pack("<I", len(part)) + part).digest())
    return hashlib.sha256(b"\x5a" + struct.pack("<I", len(digests)) + b"".join(digests)).digest()


def sign(src: str, dst: str, ks_path: str, password: bytes) -> None:
    data = open(src, "rb").read()
    eocd = find_eocd(data)
    cd_offset, = struct.unpack("<I", data[eocd + 16:eocd + 20])
    cd_size, = struct.unpack("<I", data[eocd + 12:eocd + 16])
    if data[cd_offset - 16:cd_offset] == MAGIC:
        raise ValueError("APK already has a signing block")
    if cd_offset + cd_size != eocd:
        raise ValueError("unexpected ZIP layout")
    entries, cd, eocd_bytes = data[:cd_offset], data[cd_offset:eocd], data[eocd:]

    key, cert, _ = pkcs12.load_key_and_certificates(open(ks_path, "rb").read(), password)
    cert_der = cert.public_bytes(serialization.Encoding.DER)
    pub_der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)

    # дайджест считается так, будто в EOCD смещение каталога указывает на начало блока подписи (= старое смещение)
    digest = chunked_digest([entries, cd, eocd_bytes])
    digests = lp(lp(struct.pack("<I", SIG_RSA_PKCS1_SHA256) + lp(digest)))
    certs = lp(lp(cert_der))
    attrs = lp(b"")
    signed_data = digests + certs + attrs
    signature = key.sign(signed_data, padding.PKCS1v15(), hashes.SHA256())
    signer = lp(signed_data) + lp(lp(struct.pack("<I", SIG_RSA_PKCS1_SHA256) + lp(signature))) + lp(pub_der)
    v2_value = lp(lp(signer))

    def pair(pid: int, value: bytes) -> bytes:
        return struct.pack("<Q", 4 + len(value)) + struct.pack("<I", pid) + value

    pairs = pair(V2_BLOCK_ID, v2_value)
    # выравнивание блока до 4096 байт, как у apksigner (пара-заполнитель)
    size = len(pairs) + 8 + 8 + 16
    rem = size % 4096
    if rem:
        pad = 4096 - rem
        if pad < 12:
            pad += 4096
        pairs += pair(VERITY_PADDING_ID, b"\x00" * (pad - 12))
    block_size = len(pairs) + 8 + 16
    block = struct.pack("<Q", block_size) + pairs + struct.pack("<Q", block_size) + MAGIC

    new_eocd = bytearray(eocd_bytes)
    new_eocd[16:20] = struct.pack("<I", cd_offset + len(block))
    with open(dst, "wb") as f:
        f.write(entries + block + cd + bytes(new_eocd))


if __name__ == "__main__":
    src, dst, ks, pw_file = sys.argv[1:5]
    sign(src, dst, ks, open(pw_file, "rb").read().strip())
    print("signed:", dst)
