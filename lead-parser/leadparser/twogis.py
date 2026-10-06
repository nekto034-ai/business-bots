"""Сбор данных из 2ГИС.

2ГИС кладёт данные страницы прямо в HTML (переменная initialState),
поэтому браузер не нужен — достаточно обычного запроса и разбора JSON.
"""

import json
import re
from datetime import datetime, timezone
from urllib.parse import quote

from .net import Blocked

BASE = "https://2gis.ru"

_STATE_RE = re.compile(r"var initialState = JSON\.parse\('(.*?)'\);", re.S)
_ESC_RE = re.compile(r"\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)", re.S)
_SIMPLE_ESC = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}

SOCIAL_TYPES = {
    "vkontakte": "VK", "telegram": "Telegram", "whatsapp": "WhatsApp", "max": "MAX",
    "instagram": "Instagram", "odnoklassniki": "OK", "youtube": "YouTube",
    "viber": "Viber", "facebook": "Facebook", "twitter": "X", "rutube": "Rutube",
    "dzen": "Дзен",
}


def _unescape_js(s):
    """Раскодировать содержимое JS-строки в одинарных кавычках."""
    def repl(m):
        e = m.group(1)
        if e[0] in "ux" and len(e) > 1:
            return chr(int(e[1:], 16))
        return _SIMPLE_ESC.get(e, e)
    return _ESC_RE.sub(repl, s)


def extract_state(html):
    m = _STATE_RE.search(html)
    if not m:
        return None
    return json.loads(_unescape_js(m.group(1)))


class TwoGis:
    def __init__(self, http):
        self.http = http

    def _state(self, url):
        r = self.http.get(url)
        if r.status_code == 404:
            return None
        state = extract_state(r.text)
        if state is None:
            # Нет данных на странице — почти всегда это капча / защита от ботов
            raise Blocked(f"2ГИС не отдал данные ({r.status_code}) на {url}")
        return state["data"]

    def search(self, city, query, page=1):
        """Вернуть (список карточек из выдачи, всего_страниц)."""
        url = f"{BASE}/{city}/search/{quote(query)}"
        if page > 1:
            url += f"/page/{page}"
        data = self._state(url)
        if not data:
            return [], 0
        meta = next(iter(data["search"]["profile"].values()), {}).get("data", {})
        pages = meta.get("pages") or 0
        # pagination = {<id поиска>: {<номер страницы>: {"data": [id, ...]}}}
        pag = next(iter((data["search"].get("pagination") or {}).values()), {})
        ids = (pag.get(str(page)) or next(iter(pag.values()), {})).get("data", [])
        profiles = data["entity"]["profile"]
        items = [profiles[i]["data"] for i in ids if i in profiles]
        return items, pages

    def firm(self, city, firm_id):
        data = self._state(f"{BASE}/{city}/firm/{firm_id}")
        if not data:
            return None
        p = data["entity"]["profile"].get(str(firm_id))
        return p["data"] if p else None


def branch_count(item):
    return (item.get("org") or {}).get("branch_count") or 1


def review_count(item):
    return (item.get("reviews") or {}).get("general_review_count") or 0


def rating(item):
    return (item.get("reviews") or {}).get("general_rating")


def created_at(item):
    s = (item.get("dates") or {}).get("created_at")
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def months_on_map(item, now=None):
    c = created_at(item)
    if not c:
        return None
    now = now or datetime.now(timezone.utc)
    return (now - c).days / 30.4


def _real_url(contact):
    """2ГИС оборачивает ссылки в свой редирект: link.2gis.ru/...?<настоящий адрес>."""
    v = contact.get("value") or contact.get("url") or ""
    if "link.2gis.ru" in v and "?" in v:
        return v.split("?", 1)[1]
    return v


def contacts(firm):
    out = {"phones": [], "websites": [], "emails": [], "socials": []}
    for group in firm.get("contact_groups") or []:
        for c in group.get("contacts") or []:
            t = c.get("type")
            if t == "phone":
                out["phones"].append(c.get("text") or c.get("value"))
            elif t == "website":
                out["websites"].append(_real_url(c))
            elif t == "email":
                out["emails"].append(c.get("value") or c.get("text"))
            elif t in SOCIAL_TYPES:
                out["socials"].append(f"{SOCIAL_TYPES[t]}: {_real_url(c)}")
    for k in out:
        out[k] = list(dict.fromkeys(x for x in out[k] if x))  # без дублей, порядок сохранён
    return out


def city_name(item):
    for a in item.get("adm_div") or []:
        if a.get("type") == "city":
            return a.get("name")
    return ""


def msk_offset(item):
    """Сдвиг местного времени относительно Москвы, в часах (Новосибирск: +4)."""
    off = item.get("timezone_offset")
    if off is None:
        return None
    return round(off / 60) - 3


def firm_url(city, firm_id):
    return f"{BASE}/{city}/firm/{firm_id}"
