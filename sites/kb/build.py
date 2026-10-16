#!/usr/bin/env python3
"""Сборка базы знаний: src/pages/*.html + общий каркас -> public/.

Запуск: python3 sites/kb/build.py  (результат коммитится, сервер отдаёт public/ как есть).
Первая строка каждой страницы: <!-- title: Заголовок -->
"""
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parent
SRC, OUT = ROOT / "src", ROOT / "public"

NAV = [
    ("index.html", "Главная"),
    ("strategiya.html", "Стратегия"),
    ("produkty.html", "Продукты"),
    ("ceny.html", "Цены"),
    ("vnedrenie.html", "Внедрение"),
    ("soprovozhdenie.html", "Сопровождение"),
    ("prodazhi.html", "Продажи"),
    ("moduli.html", "Модули"),
    ("vozrazheniya.html", "Возражения"),
    ("modelirovanie.html", "Моделирование"),
    ("plan.html", "План"),
]

LAYOUT = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>{title} · Математика бизнеса</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap">
<link rel="stylesheet" href="assets/style.css?v={ver}">
</head>
<body>
<header class="top"><div class="top-in">
  <a class="logo" href="index.html"><span class="logo-mark">∑</span><span>Математика бизнеса<small>база знаний</small></span></a>
  <nav class="nav" aria-label="Разделы">{nav}</nav>
</div></header>
<main class="wrap">
{content}
</main>
<footer class="footer">Математика бизнеса · внутренняя база знаний · не для передачи клиентам</footer>
{scripts}
</body>
</html>
"""


def main():
    pages = sorted((SRC / "pages").glob("*.html"))
    ver = str(sum(p.stat().st_mtime_ns for p in (ROOT / "assets").glob("*")) % 10**8)
    OUT.mkdir(exist_ok=True)
    for page in pages:
        text = page.read_text(encoding="utf-8")
        m = re.match(r"<!--\s*title:\s*(.+?)\s*-->\s*", text)
        title = m.group(1) if m else page.stem
        body = text[m.end():] if m else text
        cur = ' aria-current="page"'
        nav = "".join(
            f'<a href="{href}"{cur if href == page.name else ""}>{name}</a>'
            for href, name in NAV)
        scripts = ""
        if "data-needs-js" in body:
            scripts = f'<script src="assets/data.js?v={ver}"></script>\n<script src="assets/app.js?v={ver}"></script>'
        (OUT / page.name).write_text(
            LAYOUT.replace("{title}", title).replace("{nav}", nav).replace("{ver}", ver)
            .replace("{scripts}", scripts).replace("{content}", body), encoding="utf-8")
    shutil.copytree(ROOT / "assets", OUT / "assets", dirs_exist_ok=True)
    shutil.copytree(SRC / "static", OUT, dirs_exist_ok=True)
    print(f"built {len(pages)} pages -> {OUT}")


if __name__ == "__main__":
    main()
