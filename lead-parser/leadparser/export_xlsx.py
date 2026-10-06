"""Выгрузка лидов в Excel."""

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

COLUMNS = [
    ("Балл", 7),
    ("Почему подходит", 60),
    ("Компания", 34),
    ("Чем занимаются", 28),
    ("B2B / B2C", 9),
    ("Ниша (поиск)", 22),
    ("Город", 16),
    ("Время (от МСК)", 10),
    ("Телефоны", 22),
    ("Сайт", 30),
    ("Email", 26),
    ("Соцсети / мессенджеры", 36),
    ("Отзывов", 9),
    ("Рейтинг", 8),
    ("В 2ГИС с", 11),
    ("Вакансии hh", 40),
    ("Адрес", 34),
    ("Карточка 2ГИС", 16),
]

HELP = [
    ("Как читать таблицу", ""),
    ("", ""),
    ("Балл", "Чем выше, тем больше компания похожа на твоего клиента. Список отсортирован по баллу — звони сверху вниз."),
    ("Почему подходит", "Готовый повод для разговора: что именно у компании не так или почему им сейчас актуально."),
    ("Время (от МСК)", "Разница с Москвой. +4 — у них на 4 часа позже, чем в Москве. Чтобы не звонить в 8 утра по их времени."),
    ("Вакансии hh", "Если компания ищет менеджера по продажам — у неё точно есть продажи, а значит и заявки, которые надо где-то вести."),
    ("", ""),
    ("Откуда данные", "2ГИС (открытые карточки компаний), сайты самих компаний, hh.ru (открытые вакансии)."),
    ("Фильтры", "Только компании без филиалов, не больше 15 отзывов, обязательно с телефоном. Настраивается в config.toml."),
]


def _fmt_offset(h):
    if h is None:
        return ""
    return "МСК" if h == 0 else f"{h:+d}"


def write(leads, path):
    wb = Workbook()
    ws = wb.active
    ws.title = "Лиды"
    head_fill = PatternFill("solid", fgColor="1F4E78")
    for i, (title, width) in enumerate(COLUMNS, 1):
        c = ws.cell(row=1, column=i, value=title)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = head_fill
        c.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.row_dimensions[1].height = 30

    top_fill = PatternFill("solid", fgColor="E2EFDA")
    for r, L in enumerate(leads, 2):
        hh_txt = "\n".join(f"{v['title']} — {v['url']}" for v in (L["hh"] or [])[:3])
        row = [
            L["score"],
            "; ".join(L["why"]),
            L["name"],
            L["rubric"],
            L["segment"].upper(),
            L["query"],
            L["city"],
            _fmt_offset(L["msk_offset"]),
            "\n".join(L["contacts"]["phones"]),
            L["site"]["url"] or "",
            "\n".join(L["contacts"]["emails"]),
            "\n".join(L["contacts"]["socials"]),
            L["reviews"],
            L["rating"] or "",
            L["created"] or "",
            hh_txt,
            L["address"],
            "открыть",
        ]
        for c_i, val in enumerate(row, 1):
            cell = ws.cell(row=r, column=c_i, value=val)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        link = ws.cell(row=r, column=len(COLUMNS))
        link.hyperlink = L["url"]
        link.font = Font(color="0563C1", underline="single")
        site_cell = ws.cell(row=r, column=10)
        if L["site"]["url"]:
            site_cell.hyperlink = L["site"]["url"] if "://" in L["site"]["url"] else "http://" + L["site"]["url"]
            site_cell.font = Font(color="0563C1", underline="single")
        if r <= 11:  # первая десятка — подсветка
            ws.cell(row=r, column=1).fill = top_fill

    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}{max(1, len(leads) + 1)}"

    h = wb.create_sheet("Как читать")
    h.column_dimensions["A"].width = 20
    h.column_dimensions["B"].width = 100
    for r, (a, b) in enumerate(HELP, 1):
        h.cell(row=r, column=1, value=a).font = Font(bold=True, size=14 if r == 1 else 11)
        h.cell(row=r, column=2, value=b).alignment = Alignment(wrap_text=True, vertical="top")
    wb.save(path)
