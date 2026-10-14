"""Проверка по hh.ru: ищет ли компания сейчас менеджеров по продажам.

Публичный API hh закрыт без регистрации приложения, поэтому читаем
обычные страницы hh — данные лежат в них в JSON.

Названия у компаний часто одинаковые («Элемент», «Траст»), поэтому
работодателя сверяем строго: точное совпадение названия, тот же город,
и, если сайт известен и там и там, — тот же сайт.
"""

import html as htmllib
import json
import re
from urllib.parse import urlencode, urlparse

_STATE_RE = re.compile(r'<template[^>]*id="HH-Lux-InitialState"[^>]*>(.*?)</template>', re.S)
SALES_RE = re.compile(r"продаж|продавец|sales|менеджер по работе с клиент|аккаунт|торгов\w* представ|агент", re.I)
_LEGAL_RE = re.compile(r"\b(ооо|ип|оао|зао|пао|ао|тд|гк|компания|группа компаний)\b")


AMO_QUERY = "amoCRM OR АмоСРМ OR амоCRM OR amoСРМ"


def norm(name):
    s = re.sub(r"\(.*?\)", " ", name or "")  # «Coral Travel (ИП Иванова)» → «Coral Travel»
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[\"'«»“”„]", " ", s)
    s = _LEGAL_RE.sub(" ", s)
    return re.sub(r"[^0-9a-zа-я]+", "", s)


def domain(url):
    if not url:
        return ""
    try:
        h = urlparse(url if "://" in url else "http://" + url).hostname or ""
        h = h.encode("idna").decode("ascii") if not h.isascii() else h
    except (ValueError, UnicodeError):
        return ""
    return h.lower().removeprefix("www.")


def _state(resp):
    m = _STATE_RE.search(resp.text)
    return json.loads(htmllib.unescape(m.group(1))) if m else None


class HH:
    def __init__(self, http):
        self.http = http
        self._employers = {}

    def employer(self, eid):
        if eid not in self._employers:
            st = _state(self.http.get(f"https://hh.ru/employer/{eid}")) or {}
            info = dict(st.get("employerInfo") or {})
            info["vacancy_count"] = st.get("activeEmployerVacancyCount")
            self._employers[eid] = info
        return self._employers[eid]

    def _search(self, **params):
        st = _state(self.http.get("https://hh.ru/search/vacancy?" + urlencode(params)))
        return None if st is None else (st.get("vacancySearchResult") or {})

    def mentions_amocrm(self, eid):
        """Первая вакансия работодателя, где упомянута amoCRM, или None."""
        res = self._search(text=AMO_QUERY, employer_id=eid) or {}
        for v in res.get("vacancies") or []:
            if (v.get("company") or {}).get("id") == eid:
                return {"title": v.get("name", ""), "url": (v.get("links") or {}).get("desktop", "")}
        return None

    def amocrm_employers(self, area_id, city, max_pages=5):
        """Работодатели города, у которых в вакансиях упомянута amoCRM.

        Возвращает {eid: {"name", "title", "url"}} — по первой найденной вакансии.
        """
        out = {}
        for page in range(max_pages):
            res = self._search(text=AMO_QUERY, area=area_id, page=page, items_on_page=50)
            vs = (res or {}).get("vacancies") or []
            for v in vs:
                c = v.get("company") or {}
                if not c.get("id") or (v.get("area") or {}).get("name") != city:
                    continue
                out.setdefault(c["id"], {
                    "name": c.get("name") or c.get("visibleName") or "",
                    "title": v.get("name", ""),
                    "url": (v.get("links") or {}).get("desktop", ""),
                })
            if len(vs) < 20:
                break
        return out

    def site_of(self, eid):
        site = self.employer(eid).get("site") or ""
        return domain(site.get("href", "") if isinstance(site, dict) else site)

    def vacancies(self, company, area_id, city, site_url=""):
        """Вакансии компании в городе.

        Возвращает список {title, url, is_sales, employer_url, confirmed}
        или None, если страницу hh не удалось разобрать.
        confirmed=True — сайт работодателя на hh совпал с сайтом из 2ГИС.
        """
        params = {"text": company, "search_field": "company_name", "items_on_page": 50}
        if area_id:
            params["area"] = area_id
        st = _state(self.http.get("https://hh.ru/search/vacancy?" + urlencode(params)))
        if st is None:
            return None
        want = norm(company)
        by_employer = {}
        for v in (st.get("vacancySearchResult") or {}).get("vacancies") or []:
            c = v.get("company") or {}
            if want not in (norm(c.get("name")), norm(c.get("visibleName"))):
                continue
            if (v.get("area") or {}).get("name") != city:
                continue
            if c.get("id"):
                by_employer.setdefault(c["id"], []).append(v)

        out = []
        site = domain(site_url)
        for eid, vs in by_employer.items():
            info = self.employer(eid)
            hh_site = self.site_of(eid)
            if site and hh_site and site != hh_site:
                continue  # однофамилец: другой сайт
            confirmed = bool(site and hh_site and site == hh_site)
            for v in vs:
                out.append({
                    "title": v.get("name", ""),
                    "url": (v.get("links") or {}).get("desktop", ""),
                    "is_sales": bool(SALES_RE.search(v.get("name", ""))),
                    "employer_url": f"https://hh.ru/employer/{eid}",
                    "employer_id": eid,
                    "confirmed": confirmed,
                    "employer_vacancies": info.get("vacancy_count") if isinstance(info.get("vacancy_count"), int) else len(vs),
                })
        return out
