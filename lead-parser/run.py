"""Запуск: python run.py [--config config.toml] [--target 60]

Два входа в одну воронку:
  1. hh.ru: работодатели, у которых в вакансиях упомянута amoCRM → ищем их в 2ГИС;
  2. 2ГИС: поиск по нишам из config.toml.
Дальше каждая компания проходит фильтры, проверку сайта и вакансий,
получает баллы, и всё сохраняется в Excel в папку output/.
"""

import argparse
import json
import re
import sys
import time
import tomllib
from datetime import datetime, timedelta
from pathlib import Path

from leadparser import hh as hhmod
from leadparser import site_check, twogis
from leadparser.export_xlsx import write
from leadparser.net import Blocked, Http
from leadparser.scoring import crm_label, score

ROOT = Path(__file__).parent
DATA = ROOT / "data"
OUTPUT = ROOT / "output"
SEEN_FILE = DATA / "exported.json"
COOLDOWN_FILE = DATA / "cooldown.json"


class TimeUp(Exception):
    """Истекло время, отведённое на запуск."""


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def load_seen():
    try:
        return set(json.loads(SEEN_FILE.read_text(encoding="utf-8")))
    except (FileNotFoundError, ValueError):
        return set()


def save_seen(seen):
    DATA.mkdir(exist_ok=True)
    SEEN_FILE.write_text(json.dumps(sorted(seen), ensure_ascii=False), encoding="utf-8")


def cooldown_left():
    """Сколько ещё «затихариться» после блокировки: (осталось, причина) или (None, None)."""
    try:
        c = json.loads(COOLDOWN_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return None, None
    left = datetime.fromisoformat(c["until"]) - datetime.now()
    return (left, c.get("reason")) if left.total_seconds() > 0 else (None, None)


def start_cooldown(hours, reason):
    DATA.mkdir(exist_ok=True)
    until = datetime.now() + timedelta(hours=hours)
    COOLDOWN_FILE.write_text(json.dumps({"until": until.isoformat(timespec="minutes"), "reason": reason},
                                        ensure_ascii=False), encoding="utf-8")
    return until


def in_stop_list(item, stop):
    """Федеральные бренды: у 2ГИС их офисы часто числятся отдельными компаниями «без филиалов»."""
    ex = item.get("name_ex") or {}
    names = {hhmod.norm(ex.get("primary")), hhmod.norm(item.get("name"))} - {""}
    for s in stop:
        for n in names:
            if n == s or (len(s) >= 7 and n.startswith(s)):
                return True
    return False


def competitor_check(flt):
    """Функция «это конкурент?» по рубрикам и словам в названии из config.toml."""
    any_r = {r.lower() for r in flt.get("competitor_rubrics", [])}
    prim_r = {r.lower() for r in flt.get("competitor_primary_rubrics", [])}
    words = flt.get("competitor_name_words", [])
    name_rx = re.compile(r"(?<![a-zа-яё])(" + "|".join(map(re.escape, words)) + r")(?![a-zа-яё])", re.I) if words else None

    def is_competitor(item):
        for r in item.get("rubrics") or []:
            n = (r.get("name") or "").lower()
            if n in any_r or (r.get("kind") == "primary" and n in prim_r):
                return True
        ex = item.get("name_ex") or {}
        return bool(name_rx and name_rx.search(f"{item.get('name', '')} {ex.get('primary', '')}"))

    return is_competitor


def plan(niches, cities):
    """Порядок поисков: каждая ниша по очереди в разных городах, чтобы список был разнообразным."""
    for rnd in range(len(cities)):
        for i, niche in enumerate(niches):
            yield niche, cities[(i + rnd) % len(cities)]


class Collector:
    def __init__(self, cfg):
        self.run, self.flt, self.w = cfg["run"], cfg["filters"], cfg["scoring"]
        self.http = Http(delay=(self.run["delay_min"], self.run["delay_max"]),
                         rest_every=self.run.get("rest_every", 40),
                         rest=(self.run.get("rest_min", 30), self.run.get("rest_max", 60)))
        self.gis = twogis.TwoGis(self.http)
        self.hh = hhmod.HH(self.http)
        self.seen = load_seen() if self.run.get("skip_already_exported", True) else set()
        self.taken = set()  # org id, уже взятые в этом запуске
        self.leads = []
        self.stats = {"просмотрено": 0, "чужой регион": 0, "филиалы": 0, "много отзывов": 0, "стоп-лист": 0,
                      "конкуренты": 0, "крупные по hh": 0, "уже были": 0, "без телефона": 0}
        self.is_competitor = competitor_check(self.flt)
        self.stop = [hhmod.norm(x) for x in self.flt.get("stop_list", [])]
        self.hh_ok = self.run.get("check_hh", True)
        self.deadline = None
        self.regions = {}  # город из config → его область (узнаём по первой карточке из этого города)

    def check_time(self):
        if self.deadline and time.monotonic() > self.deadline:
            raise TimeUp()

    def process(self, it, city, source, segment="", seasonal=False, amocrm=None):
        """Проверить карточку из выдачи 2ГИС; если подходит — добавить в лиды. Вернуть True/False."""
        flt = self.flt
        self.check_time()
        if it.get("type") != "branch":
            return False
        self.stats["просмотрено"] += 1
        org_id = (it.get("org") or {}).get("id") or it["id"]
        if org_id in self.taken:
            return False
        if org_id in self.seen:
            self.stats["уже были"] += 1
            return False
        # 2ГИС иногда подмешивает в выдачу компании из других регионов — берём только город и его область
        it_city, it_region = twogis.city_name(it), twogis.region_name(it)
        if it_city == city["name"] and it_region:
            self.regions.setdefault(city["name"], it_region)
        if it_city != city["name"] and it_region != self.regions.get(city["name"]):
            self.stats["чужой регион"] += 1
            return False
        if twogis.branch_count(it) > flt["max_branches"]:
            self.stats["филиалы"] += 1
            return False
        if twogis.review_count(it) > flt["max_reviews"]:
            self.stats["много отзывов"] += 1
            return False
        if in_stop_list(it, self.stop):
            self.stats["стоп-лист"] += 1
            return False
        if self.is_competitor(it):
            self.stats["конкуренты"] += 1
            return False

        firm = self.gis.firm(city["alias"], it["id"]) or it
        cts = twogis.contacts(firm)
        if flt.get("require_phone", True) and not cts["phones"]:
            self.stats["без телефона"] += 1
            return False
        self.taken.add(org_id)

        site_url = cts["websites"][0] if cts["websites"] else ""
        if self.run.get("check_websites", True):
            site = site_check.check(self.http.session, site_url)
        else:
            site = {"status": "ok" if site_url else "none", "issues": [], "url": site_url}

        name = firm.get("name") or it.get("name")
        short = (firm.get("name_ex") or {}).get("primary") or name
        vac = None
        if self.hh_ok:
            try:
                vac = self.hh.vacancies(short, city.get("hh_area"), city["name"], site_url)
                if vac and amocrm is None:
                    # Нашли компанию на hh — заодно проверим, упоминает ли она amoCRM в вакансиях
                    eid = next((v["employer_id"] for v in vac if v["confirmed"]), vac[0]["employer_id"])
                    amocrm = self.hh.mentions_amocrm(eid)
            except Blocked as e:
                log(f"hh.ru: {e} — дальше без hh, пауза для hh записана")
                start_cooldown(self.run.get("cooldown_hours", 12), str(e))
                self.hh_ok = False

        if vac and max(v["employer_vacancies"] for v in vac) > flt.get("max_hh_vacancies", 10**9):
            self.stats["крупные по hh"] += 1
            log(f"  - {name}: на hh слишком много вакансий — похоже на крупную компанию")
            return False

        created = twogis.created_at(firm)
        lead = {
            "id": org_id,
            "name": name,
            "rubric": ", ".join(r["name"] for r in firm.get("rubrics") or [])[:120],
            "segment": segment,
            "seasonal": seasonal,
            "query": source,
            "city": twogis.city_name(firm) or city["name"],
            "msk_offset": twogis.msk_offset(firm),
            "address": firm.get("address_name") or "",
            "contacts": cts,
            "site": site,
            "reviews": twogis.review_count(firm),
            "rating": twogis.rating(firm),
            "months_on_map": twogis.months_on_map(firm),
            "created": created.strftime("%m.%Y") if created else "",
            "hh": vac,
            "amocrm": amocrm,
            "url": twogis.firm_url(city["alias"], it["id"]),
        }
        lead["score"], lead["why"] = score(lead, self.w)
        lead["crm"] = crm_label(lead)
        self.leads.append(lead)
        log(f"  + {name} — балл {lead['score']}: {'; '.join(lead['why'])}")
        return True

    def from_hh_amocrm(self, cities, target):
        """Вход 1: работодатели с amoCRM в вакансиях → та же компания в 2ГИС."""
        for city in cities:
            if len(self.leads) >= target:
                return
            log(f"hh.ru: ищу работодателей с amoCRM в вакансиях — {city['name']}")
            emps = self.hh.amocrm_employers(city["hh_area"], city["name"],
                                            self.run.get("hh_amocrm_pages", 5))
            log(f"  найдено работодателей: {len(emps)}")
            for eid, e in emps.items():
                if len(self.leads) >= target:
                    return
                info = self.hh.employer(eid)
                cnt = info.get("vacancy_count")
                if isinstance(cnt, int) and cnt > self.flt.get("max_hh_vacancies", 10**9):
                    self.stats["крупные по hh"] += 1
                    continue
                want = hhmod.norm(e["name"])
                if len(want) < 3:
                    continue
                items, _ = self.gis.search(city["alias"], e["name"])
                match = next((it for it in items
                              if want in (hhmod.norm((it.get("name_ex") or {}).get("primary")),
                                          hhmod.norm((it.get("org") or {}).get("primary")))), None)
                if not match:
                    continue
                self.process(match, city, "hh: вакансии с amoCRM",
                             amocrm={"title": e["title"], "url": e["url"]})

    def from_2gis_niches(self, niches, cities, target):
        """Вход 2: поиск в 2ГИС по нишам."""
        run = self.run
        for niche, city in plan(niches, cities):
            if len(self.leads) >= target:
                return
            got = 0
            log(f"Ищу «{niche['query']}» — {city['name']} (собрано {len(self.leads)}/{target})")
            for page in range(1, run["max_pages_per_query"] + 1):
                items, pages = self.gis.search(city["alias"], niche["query"], page)
                for it in items:
                    if got >= run["per_query_limit"] or len(self.leads) >= target:
                        break
                    if self.process(it, city, niche["query"], niche.get("segment", ""),
                                    niche.get("seasonal", False)):
                        got += 1
                if got >= run["per_query_limit"] or page >= pages or len(self.leads) >= target:
                    break


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config.toml"))
    ap.add_argument("--target", type=int, help="сколько лидов собрать (перекрывает config)")
    ap.add_argument("--force", action="store_true", help="запустить, даже если идёт пауза после блокировки")
    ap.add_argument("--minutes", type=int, help="максимум минут работы (перекрывает config)")
    args = ap.parse_args()

    # Главное правило: не попасть в блокировку. Если недавно ловили капчу/429 — не стучимся.
    left, reason = cooldown_left()
    if left and not args.force:
        log(f"Пауза после блокировки ещё {int(left.total_seconds() // 3600)} ч "
            f"{int(left.total_seconds() % 3600 // 60)} мин ({reason}). Не запускаюсь.")
        return 2

    cfg = tomllib.loads(Path(args.config).read_text(encoding="utf-8"))
    target = args.target or cfg["run"]["target_leads"]
    src = cfg.get("sources", {})
    c = Collector(cfg)
    minutes = args.minutes or cfg["run"].get("max_minutes")
    if minutes:
        c.deadline = time.monotonic() + minutes * 60
        log(f"Ограничение по времени: {minutes} мин — потом остановлюсь и сохраню собранное")

    try:
        if src.get("hh_amocrm", True):
            c.from_hh_amocrm(cfg["cities"], target)
        if src.get("niches_2gis", True):
            c.from_2gis_niches(cfg["niches"], cfg["cities"], target)
    except Blocked as e:
        until = start_cooldown(cfg["run"].get("cooldown_hours", 12), str(e))
        log(f"СТОП: {e}. Сохраняю то, что успел собрать. Следующий запуск — не раньше {until:%d.%m %H:%M}.")
    except TimeUp:
        log("Время вышло. Сохраняю то, что успел собрать.")
    except KeyboardInterrupt:
        log("Остановлено вручную. Сохраняю то, что успел собрать.")

    leads = sorted(c.leads, key=lambda L: -L["score"])
    OUTPUT.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    xlsx = OUTPUT / f"leads_{stamp}.xlsx"
    write(leads, xlsx)
    (OUTPUT / f"leads_{stamp}.json").write_text(
        json.dumps(leads, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    save_seen(c.seen | {L["id"] for L in leads})

    log(f"Готово: {len(leads)} компаний → {xlsx}")
    log("Отсеяно: " + ", ".join(f"{k} — {v}" for k, v in c.stats.items()))
    return 0 if leads else 1


if __name__ == "__main__":
    sys.exit(main())
