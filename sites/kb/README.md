# kb — база знаний «Математика бизнеса»

Отдельный раздел сервера (сессия «Математика бизнеса»). Спорт и лендинг не трогает.

- Адрес: `https://kb.<hostname>` (hostname из `/etc/bots/hostname`, сейчас `91-186-199-30.sslip.io`).
- Исходники: `sites/kb/src/pages/*.html` (страницы), `sites/kb/assets/` (стили, данные модулей, скрипт), `sites/kb/src/static/` (образцы).
- Сборка: `python3 sites/kb/build.py` → `sites/kb/public/` (коммитится; Caddy отдаёт её как есть).
- Вход по логину и паролю (basic auth). В репозитории только bcrypt-хэш (`sites/kb/auth.caddy`), пароль у Артёма.
- Источник текстов: ветка `claude/dreamy-fermat-pm3dyx`, папка `docs/matematika-biznesa/` (там же markdown-документы).
- Дальше: разделы для ролей (продавец, аналитик, бухгалтер) и клиентские страницы `client.<hostname>` со своим логином у каждого клиента.
