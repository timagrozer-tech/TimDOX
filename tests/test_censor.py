"""Фильтр брани: ловит мат, но не трогает обычные слова с похожими буквами."""
import unittest

from app.security import censor, is_rude


class CensorTest(unittest.TestCase):
    def test_clean_words_untouched(self):
        t = "корабля рублям хлебать застрахуем небо обед зебра команда хулиган похудеть убедить вебинар"
        self.assertEqual(censor(t), t)
        self.assertFalse(is_rude(t))

    def test_rude_words(self):
        for w in ("хуеглот", "похуй", "заебал", "уебок", "блядь", "бля", "сука", "долбоеб", "пиздец"):
            self.assertNotEqual(censor(w), w, w)
        self.assertTrue(is_rude("с кем б*****"))


if __name__ == "__main__":
    unittest.main()
