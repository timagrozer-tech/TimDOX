"""QR-код в SVG без внешних библиотек (байтовый режим, уровень коррекции M, версии 1–10).

Нужен для подключения двухфакторной защиты: адрес otpauth:// помещается в версию 5–8.
Алгоритм — по стандарту ISO/IEC 18004 (как в эталонной реализации Nayuki).
"""

# версия: (кодовых слов коррекции на блок, [(число блоков, слов данных в блоке), …]) — уровень M
_BLOCKS = {
    1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]), 4: (18, [(2, 32)]), 5: (24, [(2, 43)]),
    6: (16, [(4, 27)]), 7: (18, [(4, 31)]), 8: (22, [(2, 38), (2, 39)]), 9: (22, [(3, 36), (2, 37)]),
    10: (26, [(4, 43), (1, 44)]),
}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
          8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]}


def _gf_mul(x: int, y: int) -> int:
    z = 0
    for i in reversed(range(8)):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _rs_divisor(degree: int) -> list[int]:
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 0x02)
    return result


def _rs_remainder(data: list[int], divisor: list[int]) -> list[int]:
    result = [0] * len(divisor)
    for b in data:
        factor = b ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


def _codewords(text: bytes) -> tuple[int, list[int]]:
    for version in range(1, 11):
        ec_len, groups = _BLOCKS[version]
        cap = sum(n * k for n, k in groups)
        count_bits = 8 if version < 10 else 16
        if 4 + count_bits + 8 * len(text) <= cap * 8:
            break
    else:
        raise ValueError("Слишком длинный текст для QR-кода")
    bits: list[int] = []

    def put(val: int, n: int):
        bits.extend((val >> i) & 1 for i in reversed(range(n)))
    put(0b0100, 4)
    put(len(text), count_bits)
    for b in text:
        put(b, 8)
    put(0, min(4, cap * 8 - len(bits)))
    put(0, (-len(bits)) % 8)
    data = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(data) < cap:
        data.append(pad)
        pad ^= 0xEC ^ 0x11
    # блоки, коррекция, перемежение
    divisor = _rs_divisor(ec_len)
    blocks, pos = [], 0
    for n, k in groups:
        for _ in range(n):
            chunk = data[pos:pos + k]
            pos += k
            blocks.append((chunk, _rs_remainder(chunk, divisor)))
    out = []
    for i in range(max(len(d) for d, _ in blocks)):
        out += [d[i] for d, _ in blocks if i < len(d)]
    for i in range(ec_len):
        out += [e[i] for _, e in blocks]
    return version, out


def _mask_bit(mask: int, x: int, y: int) -> bool:
    return [(x + y) % 2 == 0, y % 2 == 0, x % 3 == 0, (x + y) % 3 == 0, (x // 3 + y // 2) % 2 == 0,
            x * y % 2 + x * y % 3 == 0, (x * y % 2 + x * y % 3) % 2 == 0, ((x + y) % 2 + x * y % 3) % 2 == 0][mask]


def _penalty(m: list[list[bool]]) -> int:
    size, score = len(m), 0
    for lines in (m, [list(c) for c in zip(*m)]):
        for line in lines:
            run, prev = 0, None
            for v in line:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        score += run - 2
                    run, prev = 1, v
            if run >= 5:
                score += run - 2
    for y in range(size - 1):
        for x in range(size - 1):
            if m[y][x] == m[y][x + 1] == m[y + 1][x] == m[y + 1][x + 1]:
                score += 3
    dark = sum(map(sum, m))
    score += abs(dark * 20 - size * size * 10) // (size * size) * 10
    return score


def matrix(text: str) -> list[list[bool]]:
    version, data = _codewords(text.encode("utf-8"))
    size = version * 4 + 17
    mod = [[False] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def setf(x, y, dark):
        mod[y][x] = dark
        fn[y][x] = True
    for i in range(size):  # линии синхронизации
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)
    for cx, cy in ((3, 3), (size - 4, 3), (3, size - 4)):  # поисковые узоры с разделителями
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))
    pos = _ALIGN[version]
    for i, ax in enumerate(pos):
        for j, ay in enumerate(pos):
            if (i, j) in ((0, 0), (0, len(pos) - 1), (len(pos) - 1, 0)):
                continue
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    setf(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)

    def draw_format(mask):
        d = mask  # уровень M кодируется как 00
        rem = d
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = ((d << 10) | rem) ^ 0x5412
        b = [(bits >> i) & 1 == 1 for i in range(15)]
        for i in range(6):
            setf(8, i, b[i])
        setf(8, 7, b[6])
        setf(8, 8, b[7])
        setf(7, 8, b[8])
        for i in range(9, 15):
            setf(14 - i, 8, b[i])
        for i in range(8):
            setf(size - 1 - i, 8, b[i])
        for i in range(8, 15):
            setf(8, size - 15 + i, b[i])
        setf(8, size - 8, True)
    draw_format(0)
    if version >= 7:
        rem = version
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = version << 12 | rem
        for i in range(18):
            bit = (bits >> i) & 1 == 1
            a, b2 = size - 11 + i % 3, i // 3
            setf(a, b2, bit)
            setf(b2, a, bit)
    # данные — змейкой снизу вверх парами столбцов
    i, right = 0, size - 1
    total = len(data) * 8
    while right >= 1:
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = size - 1 - vert if upward else vert
                if not fn[y][x] and i < total:
                    mod[y][x] = (data[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1
        right -= 2
    best, best_score = None, None
    for mask in range(8):
        m = [row[:] for row in mod]
        for y in range(size):
            for x in range(size):
                if not fn[y][x] and _mask_bit(mask, x, y):
                    m[y][x] = not m[y][x]
        saved = mod
        mod = m
        draw_format(mask)
        mod = saved
        score = _penalty(m)
        if best_score is None or score < best_score:
            best, best_score = m, score
    return best


def svg(text: str, scale: int = 6, border: int = 4) -> str:
    m = matrix(text)
    n = len(m) + border * 2
    path = "".join(f"M{x + border},{y + border}h1v1h-1z" for y, row in enumerate(m) for x, v in enumerate(row) if v)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" width="{n * scale}" height="{n * scale}" '
            f'shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="{path}" fill="#000"/></svg>')
