"""Оценка сайта компании: есть ли он и насколько он «стрёмненький»."""

import re
from datetime import date
from urllib.parse import urlparse

import requests

# Если вместо сайта указана одна из этих ссылок — настоящего сайта нет
SOCIAL_HOSTS = (
    "vk.com", "vk.ru", "vk.link", "t.me", "telegram.me", "instagram.com", "taplink.cc",
    "taplink.ru", "taplink.at", "ok.ru", "avito.ru", "wa.me", "api.whatsapp.com",
    "youtube.com", "dzen.ru", "max.ru", "mssg.me", "hipolink.me", "linktr.ee",
    "2gis.ru", "yandex.ru", "ozon.ru", "wildberries.ru", "pinterest.com",
)
# Старые бесплатные конструкторы
OLD_BUILDERS = ("ucoz", "narod.ru", ".at.ua", ".do.am", "jimdo", ".ucoz.", "my1.ru")

_COPY_RE = re.compile(r"(?:©|&copy;|copyright)[^<]{0,40}?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?", re.I)
_TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.S | re.I)
MAX_BYTES = 2_000_000


def _host(url):
    try:
        return (urlparse(url if "://" in url else "http://" + url).hostname or "").lower()
    except ValueError:
        return ""


def is_social(url):
    h = _host(url)
    return any(h == s or h.endswith("." + s) for s in SOCIAL_HOSTS)


def check(session, url, timeout=15):
    """Вернуть dict: status ('none'|'social'|'broken'|'ok'), issues (список проблем)."""
    if not url:
        return {"status": "none", "issues": [], "url": ""}
    if is_social(url):
        return {"status": "social", "issues": [], "url": url}
    if "://" not in url:
        url = "http://" + url
    try:
        r = session.get(url, timeout=timeout, stream=True, allow_redirects=True)
        body = r.raw.read(MAX_BYTES, decode_content=True)
        r.close()
    except requests.RequestException:
        return {"status": "broken", "issues": ["сайт не открывается"], "url": url}
    if r.status_code in (401, 403, 429, 503):
        # Обычно это защита от роботов (DDoS-Guard, Cloudflare): человек сайт видит
        return {"status": "unknown", "issues": [], "url": url}
    if r.status_code >= 400:
        return {"status": "broken", "issues": [f"сайт отдаёт ошибку {r.status_code}"], "url": url}
    if is_social(r.url):
        return {"status": "social", "issues": [], "url": url}

    html = body.decode(r.encoding or "utf-8", errors="replace")
    low = html.lower()
    issues = []
    if not r.url.startswith("https://"):
        issues.append("нет https")
    if 'name="viewport"' not in low and "name='viewport'" not in low and "name=viewport" not in low:
        issues.append("не адаптирован под телефон")
    years = [int(y) for m in _COPY_RE.finditer(html) for y in m.groups() if y]
    if years and max(years) <= date.today().year - 3:
        issues.append(f"в подвале © {max(years)}")
    host = _host(r.url)
    if any(b in host or b in low[:5000] for b in OLD_BUILDERS):
        issues.append("старый конструктор (uCoz/Narod)")
    text = re.sub(r"\s+", " ", _TAG_RE.sub(" ", html))
    if len(text) < 600 and "<form" not in low:
        issues.append("почти пустая страница")
    if "<form" not in low:
        issues.append("нет формы заявки")
    return {"status": "ok", "issues": issues, "url": url}
