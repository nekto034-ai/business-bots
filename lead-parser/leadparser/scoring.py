"""Баллы и человеческое объяснение «почему компания подходит»."""


def score(lead, w):
    pts = 0
    why = []

    if lead["segment"] == "b2b":
        pts += w["b2b"]
        why.append("продают компаниям (B2B)")
    if lead["seasonal"]:
        pts += w["seasonal"]
        why.append("сезонная ниша — перед Новым годом пик заявок")

    n = lead["reviews"]
    if n == 0:
        pts += w["reviews_0"]
        why.append("отзывов нет")
    elif n <= 5:
        pts += w["reviews_1_5"]
        why.append(f"всего {n} отз.")
    elif n <= 15:
        pts += w["reviews_6_15"]
        why.append(f"мало отзывов ({n})")

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
