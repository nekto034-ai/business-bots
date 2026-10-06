"""Вежливый HTTP-клиент: пауза между запросами к одному сайту, повторы при сбоях."""

import random
import time
from urllib.parse import urlparse

import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0 Safari/537.36"
)


class Blocked(Exception):
    """Сайт начал отвечать капчей / 429 — дальше долбить нельзя."""


class Http:
    def __init__(self, delay=(2.5, 5.0)):
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "ru-RU,ru;q=0.9",
        })
        self._last = {}  # host -> время последнего запроса

    def _wait(self, host):
        last = self._last.get(host)
        if last is not None:
            pause = random.uniform(*self.delay) - (time.monotonic() - last)
            if pause > 0:
                time.sleep(pause)
        self._last[host] = time.monotonic()

    def get(self, url, *, polite=True, timeout=25, retries=3, **kw):
        host = urlparse(url).netloc
        for attempt in range(retries):
            if polite:
                self._wait(host)
            try:
                r = self.session.get(url, timeout=timeout, **kw)
            except requests.RequestException:
                if attempt == retries - 1:
                    raise
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429:
                raise Blocked(f"{host} ответил 429 (слишком много запросов)")
            if r.status_code >= 500 and attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
                continue
            return r
        return r
