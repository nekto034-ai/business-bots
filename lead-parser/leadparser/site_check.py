"""Оценка сайта компании: есть ли он и насколько он «стрёмненький»."""

import html as htmllib
import re
from datetime import date
from urllib.parse import urlparse

import requests

# Если вместо сайта указана одна из этих ссылок — настоящего сайта нет
SOCIAL_HOSTS = (
    "vk.com", "vk.ru", "vk.link", "t.me", "telegram.me", "instagram.com", "taplink.cc",
    "taplink.ru", "taplink.at", "ok.ru", "avito.ru", "wa.me", "api.whatsapp.com",
    "youtube.com", "dzen.ru", "max.ru", "mssg.me", "hipolink.me", "hipolink.net", "linktr.ee",
    "2gis.ru", "yandex.ru", "ozon.ru", "wildberries.ru", "pinterest.com",
)
# Старые бесплатные конструкторы
OLD_BUILDERS = ("ucoz", "narod.ru", ".at.ua", ".do.am", "jimdo", ".ucoz.", "my1.ru")

# Ищем в видимом тексте (без тегов и стилей), год — отдельным числом
_COPY_RE = re.compile(r"(?:©|\(c\)|copyright)\D{0,30}?(?<!\d)((?:19|20)\d{2})(?!\d)(?:\s*[-–—]\s*((?:19|20)\d{2})(?!\d))?"
    r"|(?<!\d)((?:19|20)\d{2})\s*(?:©|\(c\))", re.I)
_TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>|<[^>]+>", re.S | re.I)
MAX_BYTES = 2_000_000


def _host(url):
    try:
        return (urlparse(url if "://" in url else "http://" + url).hostname or "").lower()
    except ValueError:
        return ""


def is_social(url):
    h = _host(url)
    if "taplink" in h:  # taplink.cc / .ru / .at / .ws / ...
        return True
    return any(h == s or h.endswith("." + s) for s in SOCIAL_HOSTS)


def _fetch(session, url, timeout):
    r = session.get(url, timeout=timeout, stream=True, allow_redirects=True)
    body = r.raw.read(MAX_BYTES, decode_content=True)
    r.close()
    return r, body


def _dns_failed(exc):
    text = repr(exc)
    return "NameResolutionError" in text or "Name or service not known" in text or "nodename nor servname" in text


def check(session, url, timeout=15):
    """Вернуть dict: status, issues (список проблем), url.

    status: none — сайта нет, social — вместо сайта соцсеть/Taplink,
    broken — сайт мёртв, unknown — проверить не удалось (защита / таймаут), ok — открылся.
    """
    if not url:
        return {"status": "none", "issues": [], "url": ""}
    if is_social(url):
        return {"status": "social", "issues": [], "url": url}
    if "://" not in url:
        url = "http://" + url
    try:
        try:
            r, body = _fetch(session, url, timeout)
        except (requests.Timeout, requests.ConnectionError) as e:
            if _dns_failed(e):
                raise
            r, body = _fetch(session, url, timeout)  # второй шанс медленному сайту
    except requests.RequestException as e:
        if _dns_failed(e):
            return {"status": "broken", "issues": ["домен сайта не работает (не продлён?)"], "url": url}
        # Таймаут / обрыв: часто сайт просто не пускает зарубежные адреса — не наш случай считать «сломан»
        return {"status": "unknown", "issues": [], "url": url}
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
    text = re.sub(r"\s+", " ", htmllib.unescape(_TAG_RE.sub(" ", html)))
    years = [int(y) for m in _COPY_RE.finditer(text) for y in m.groups() if y]
    if years and max(years) <= date.today().year - 3:
        issues.append(f"в подвале © {max(years)}")
    host = _host(r.url)
    if any(b in host or b in low[:5000] for b in OLD_BUILDERS):
        issues.append("старый конструктор (uCoz/Narod)")
    if len(text) < 600 and "<form" not in low:
        issues.append("почти пустая страница")
    if "<form" not in low:
        issues.append("нет формы заявки")
    return {"status": "ok", "issues": issues, "url": url}
