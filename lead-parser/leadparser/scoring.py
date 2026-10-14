"""Баллы и человеческое объяснение «почему компания подходит»."""


def crm_label(lead):
    """Какая CRM у компании и откуда это известно — для колонки «CRM»."""
    parts = []
    amo = lead.get("amocrm")
    if amo:
        parts.append(f"amoCRM — упомянута в вакансии на hh «{amo['title']}» {amo['url']}")
    for name in lead["site"].get("crm") or []:
        if name == "amoCRM" and amo:
            continue
        parts.append(f"{name} — видно на сайте")
    return "; ".join(parts)


def score(lead, w):
    pts = 0
    why = []

    site_crm = lead["site"].get("crm") or []
    if lead.get("amocrm"):
        pts += w["crm_amocrm"]
        why.append("упоминают amoCRM в вакансии на hh")
    elif "amoCRM" in site_crm:
        pts += w["crm_amocrm"]
        why.append("на сайте форма/чат amoCRM")
    elif site_crm:
        pts += w.get("crm_other", 0)
        why.append(f"у них {', '.join(site_crm)}")

    if lead["segment"] == "b2b" and w.get("b2b"):
        pts += w["b2b"]
        why.append("продают компаниям (B2B)")
    if lead["seasonal"] and w.get("seasonal"):
        pts += w["seasonal"]
        why.append("сезонная ниша")

    n = lead["reviews"]
    if n == 0:
        pts += w["reviews_0"]
        why.append("в 2ГИС отзывов нет")
    elif n <= 5:
        pts += w["reviews_1_5"]
        why.append(f"в 2ГИС всего {n} отз.")
    elif n <= 15:
        pts += w["reviews_6_15"]
        why.append(f"в 2ГИС мало отзывов ({n})")

    m = lead["months_on_map"]
    if m is not None and m <= w["new_company_months"]:
        pts += w["new_company"]
        why.append(f"новая — в 2ГИС {max(1, round(m))} мес.")

    site = lead["site"]
    if site["status"] == "none":
        pts += w["no_website"]
        why.append("сайта нет")
    elif site["status"] == "social":
        pts += w["social_only"]
        why.append("вместо сайта — соцсеть")
    elif site["status"] == "broken":
        pts += w["broken_website"]
        why.append(site["issues"][0])
    elif site["issues"]:
        pts += min(len(site["issues"]) * w["per_site_issue"], w["max_site_issues"])
        why.append("сайт: " + ", ".join(site["issues"]))

    hh = lead["hh"]
    if hh:
        sales = [v for v in hh if v["is_sales"]]
        if sales:
            v = next((x for x in sales if x["confirmed"]), sales[0])
            if v["confirmed"]:
                pts += w["hiring_sales"]
                why.append(f"ищут продажника на hh: «{v['title']}»")
            else:
                pts += w["hiring_sales_unconfirmed"]
                why.append(f"похоже, ищут продажника на hh: «{v['title']}» (совпало название и город — проверь)")
        else:
            pts += w["hiring_any"]
            why.append(f"есть вакансии на hh ({len(hh)})")

    return pts, why
