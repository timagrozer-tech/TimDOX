"""Запуск на обычном хостинге (Passenger): WSGI-обёртка передаёт запросы ASGI-приложению и отдаёт ответы."""
import io
import json
import os
import unittest
from wsgiref.util import setup_testing_defaults

from test_api import Client  # noqa: F401 — настраивает окружение и тестовую базу


def call(app, method="GET", path="/", body=b"", headers=None):
    env = {}
    setup_testing_defaults(env)
    env.update({"REQUEST_METHOD": method, "PATH_INFO": path, "wsgi.input": io.BytesIO(body),
                "CONTENT_LENGTH": str(len(body)), "REMOTE_ADDR": "95.1.2.3", "HTTP_HOST": "localhost"})
    for k, v in (headers or {}).items():
        env[k] = v
    got = {}

    def start_response(status, hdrs, exc_info=None):
        got["status"], got["headers"] = status, dict(hdrs)
    data = b"".join(app(env, start_response))
    return got["status"], got["headers"], data


class WsgiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["KRUG_BACKGROUND"] = "0"
        from app import wsgi
        cls.app = staticmethod(wsgi.application)

    def test_health_and_static(self):
        status, _, data = call(self.app, path="/api/health")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(json.loads(data)["status"], "ok")
        self.assertEqual(json.loads(data)["runtime"], "passenger")
        status, headers, data = call(self.app, path="/static/js/api.js")
        self.assertTrue(status.startswith("200"))
        self.assertIn("javascript", headers["content-type"])
        self.assertIn(b"connectStream", data)

    def test_post_body_and_errors(self):
        status, _, data = call(self.app, "POST", "/api/auth/login", json.dumps({"login": "nobody", "password": "x"}).encode(),
                               {"CONTENT_TYPE": "application/json", "HTTP_ORIGIN": "http://localhost"})
        self.assertFalse(status.startswith("5"), data)
        status, _, _ = call(self.app, path="/api/definitely-missing")
        self.assertTrue(status.startswith("404"))

    def test_cyrillic_path(self):
        status, _, data = call(self.app, path="/тест".encode("utf-8").decode("latin-1"))
        self.assertTrue(status.startswith("200"))
        self.assertIn(b"<html", data.lower())
