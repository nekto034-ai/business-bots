"""Запуск: python run.py [--config config.toml] [--target 60]

Собирает компании из 2ГИС по нишам и городам из config.toml, отсеивает
по фильтрам, проверяет сайт и вакансии на hh.ru, считает баллы и сохраняет
Excel в папку output/.
"""

import argparse
import json
import sys
import tomllib
from datetime import datetime
from pathlib import Path

from leadparser import hh as hhmod
from leadparser import site_check, twogis
from leadparser.export_xlsx import write
from leadparser.net import Blocked, Http
from leadparser.scoring import score

ROOT = Path(__file__).parent
DATA = ROOT / "data"
OUTPUT = ROOT / "output"
SEEN_FILE = DATA / "exported.json"


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


def plan(niches, cities):
    """Порядок поисков: каждая ниша по очереди в разных городах, чтобы список был разнообразным."""
    for rnd in range(len(cities)):
        for i, niche in enumerate(niches):
            yield niche, cities[(i + rnd) % len(cities)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT / "config.toml"))
    ap.add_argument("--target", type=int, help="сколько лидов собрать (перекрывает config)")
    args = ap.parse_args()

    cfg = tomllib.loads(Path(args.config).read_text(encoding="utf-8"))
    run, flt, w = cfg["run"], cfg["filters"], cfg["scoring"]
    target = args.target or run["target_leads"]

    http = Http(delay=(run["delay_min"], run["delay_max"]))
    gis = twogis.TwoGis(http)
    hh = hhmod.HH(http)
    seen = load_seen() if run.get("skip_already_exported", True) else set()
    taken = set()  # org id, уже взятые в этом запуске
    leads = []
    stats = {"просмотрено": 0, "филиалы": 0, "много отзывов": 0, "уже были": 0, "без телефона": 0}
    hh_ok = run.get("check_hh", True)

    try:
        for niche, city in plan(cfg["niches"], cfg["cities"]):
            if len(leads) >= target:
                break
            got = 0
            log(f"Ищу «{niche['query']}» — {city['name']} (собрано {len(leads)}/{target})")
            for page in range(1, run["max_pages_per_query"] + 1):
                items, pages = gis.search(city["alias"], niche["query"], page)
                for it in items:
                    if got >= run["per_query_limit"] or len(leads) >= target:
                        break
                    if it.get("type") != "branch":
                        continue
                    stats["просмотрено"] += 1
                    org_id = (it.get("org") or {}).get("id") or it["id"]
                    if org_id in taken:
                        continue
                    if org_id in seen:
                        stats["уже были"] += 1
                        continue
                    if twogis.branch_count(it) > flt["max_branches"]:
                        stats["филиалы"] += 1
                        continue
                    if twogis.review_count(it) > flt["max_reviews"]:
                        stats["много отзывов"] += 1
                        continue

                    firm = gis.firm(city["alias"], it["id"]) or it
                    cts = twogis.contacts(firm)
                    if flt.get("require_phone", True) and not cts["phones"]:
                        stats["без телефона"] += 1
                        continue
                    taken.add(org_id)

                    site_url = cts["websites"][0] if cts["websites"] else ""
                    if run.get("check_websites", True):
                        site = site_check.check(http.session, site_url)
                    else:
                        site = {"status": "ok" if site_url else "none", "issues": [], "url": site_url}

                    name = firm.get("name") or it.get("name")
                    short = (firm.get("name_ex") or {}).get("primary") or name
                    vac = None
                    if hh_ok:
                        try:
                            vac = hh.vacancies(short, city.get("hh_area"), city["name"], site_url)
                        except Blocked as e:
                            log(f"hh.ru: {e} — дальше без проверки вакансий")
                            hh_ok = False

                    created = twogis.created_at(firm)
                    lead = {
                        "id": org_id,
                        "name": name,
                        "rubric": ", ".join(r["name"] for r in firm.get("rubrics") or [])[:120],
                        "segment": niche["segment"],
                        "seasonal": niche.get("seasonal", False),
                        "query": niche["query"],
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
                        "url": twogis.firm_url(city["alias"], it["id"]),
                    }
                    lead["score"], lead["why"] = score(lead, w)
                    leads.append(lead)
                    got += 1
                    log(f"  + {name} — балл {lead['score']}: {'; '.join(lead['why'])}")
                if got >= run["per_query_limit"] or page >= pages or len(leads) >= target:
                    break
    except Blocked as e:
        log(f"СТОП: {e}. Сохраняю то, что успел собрать.")
    except KeyboardInterrupt:
        log("Остановлено вручную. Сохраняю то, что успел собрать.")

    leads.sort(key=lambda L: -L["score"])
    OUTPUT.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    xlsx = OUTPUT / f"leads_{stamp}.xlsx"
    write(leads, xlsx)
    (OUTPUT / f"leads_{stamp}.json").write_text(
        json.dumps(leads, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    save_seen(seen | {L["id"] for L in leads})

    log(f"Готово: {len(leads)} компаний → {xlsx}")
    log("Отсеяно: " + ", ".join(f"{k} — {v}" for k, v in stats.items()))
    return 0 if leads else 1


if __name__ == "__main__":
    sys.exit(main())
