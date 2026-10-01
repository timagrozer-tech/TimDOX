"""Мини-профиль Steam: разбор XML, безопасные ссылки, кеш, доступ только к нику из Созвездия."""
import unittest
from unittest import mock

from test_api import Client
from app import db, steam
from app.security import rate_limiter

XML = b"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile>
  <steamID64>76561198676436055</steamID64>
  <steamID><![CDATA[Tima]]></steamID>
  <onlineState>in-game</onlineState>
  <stateMessage><![CDATA[In-Game<br/>Counter-Strike 2]]></stateMessage>
  <privacyState>public</privacyState>
  <vacBanned>0</vacBanned>
  <avatarFull><![CDATA[https://avatars.steamstatic.com/abc_full.jpg]]></avatarFull>
  <memberSince>March 3, 2015</memberSince>
  <location><![CDATA[Moscow, Russia]]></location>
  <inGameInfo>
    <gameName><![CDATA[Counter-Strike 2]]></gameName>
    <gameLink><![CDATA[https://steamcommunity.com/app/730]]></gameLink>
    <gameLogo><![CDATA[https://cdn.akamai.steamstatic.com/steam/apps/730/capsule_184x69.jpg]]></gameLogo>
  </inGameInfo>
  <mostPlayedGames>
    <mostPlayedGame>
      <gameName><![CDATA[Counter-Strike 2]]></gameName>
      <gameLink><![CDATA[https://steamcommunity.com/app/730]]></gameLink>
      <gameLogo><![CDATA[https://cdn.akamai.steamstatic.com/steam/apps/730/capsule_184x69.jpg]]></gameLogo>
      <hoursPlayed>12.5</hoursPlayed>
      <hoursOnRecord>1,204</hoursOnRecord>
    </mostPlayedGame>
    <mostPlayedGame>
      <gameName><![CDATA[Evil <script>]]></gameName>
      <gameLink><![CDATA[javascript:alert(1)]]></gameLink>
      <gameLogo><![CDATA[https://evil.example.com/x.jpg]]></gameLogo>
      <hoursPlayed>1</hoursPlayed>
      <hoursOnRecord>3</hoursOnRecord>
    </mostPlayedGame>
  </mostPlayedGames>
</profile>"""


class SteamTest(unittest.TestCase):
    def setUp(self):
        rate_limiter.reset()
        steam._cache.clear()

    def test_parse(self):
        d = steam.parse(XML, "76561198676436055")
        self.assertTrue(d["ok"])
        self.assertEqual(d["name"], "Tima")
        self.assertEqual(d["state"], "in-game")
        self.assertEqual(d["status"], "In-Game · Counter-Strike 2")
        self.assertEqual(d["playing"]["name"], "Counter-Strike 2")
        self.assertEqual(d["url"], "https://steamcommunity.com/profiles/76561198676436055/")
        self.assertEqual(d["games"][0]["total"], 1204)
        self.assertIsNone(d["games"][1]["link"])   # javascript: не пропускаем
        self.assertIsNone(d["games"][1]["logo"])   # чужой домен картинки не пропускаем
        self.assertEqual(steam.parse(b"<response><error>not found</error></response>", "x")["reason"], "not_found")

    def test_paths(self):
        self.assertEqual(steam.profile_url("76561198676436055"), "https://steamcommunity.com/profiles/76561198676436055/")
        self.assertEqual(steam.profile_url("gabelogannewell"), "https://steamcommunity.com/id/gabelogannewell/")
        self.assertEqual(steam.fetch("../../etc")["reason"], "bad_handle")

    def test_endpoint_and_cache(self):
        a = Client().register("steam_owner", "Стим Владелец")
        b = Client().register("steam_guest", "Стим Гость")
        self.assertEqual(b.get("/api/users/steam_owner/steam").status_code, 404)  # Steam не привязан
        r = a.put("/api/me/constellation", {"style": "cosmos", "items": [{"kind": "steam", "value": "@76561198676436055"}]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["items"][0]["url"], "https://steamcommunity.com/profiles/76561198676436055/")
        with mock.patch.object(steam, "_download", return_value=XML) as dl:
            r = b.get("/api/users/steam_owner/steam")
            self.assertEqual(r.status_code, 200, r.text)
            self.assertEqual(r.json()["name"], "Tima")
            b.get("/api/users/steam_owner/steam")
            self.assertEqual(dl.call_count, 1)  # второй раз — из кеша
            self.assertIn("/profiles/76561198676436055/?xml=1", dl.call_args[0][0])
        steam._cache.clear()
        with mock.patch.object(steam, "_download", side_effect=OSError("down")):
            self.assertFalse(b.get("/api/users/steam_owner/steam").json()["ok"])
        db.run("UPDATE profiles SET profile_visibility='friends' WHERE username='steam_owner'")
        self.assertEqual(b.get("/api/users/steam_owner/steam").status_code, 404)  # закрытый профиль


if __name__ == "__main__":
    unittest.main()
