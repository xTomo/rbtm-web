# Студия реконструкции: выкатка rbtm-web

Студия — приложение `robotom/reconstruction/`:

- `/studio/<exp_id>/` — страница студии (шаблон `reconstruction/studio.html`, JS `reconstruction/static/`);
- `/studio/api/<path>` — прокси к recon-service (rbtm-recon, контейнер `web_reconstructor_1`, порт 5560) по белому
  списку (`reconstruction/proxy.py`); браузер к сервису напрямую не ходит, сервис доверяет общему токену `RECON_TOKEN`;
- кнопка «Студия реконструкции» на странице записи хранилища (рядом со старой «Перейти к реконструкции»).

Права: просмотр (страница, сканы, задачи, результаты) — админ, экспериментатор, исследователь; загрузка данных,
интерактивная сессия, запуск и отмена задач — админ и экспериментатор. Гость — 403.

Префикс `/studio/`, а не `/reconstruction/`: всё, что начинается с `/reconstruct`, Apache (`000-default.conf`)
проксирует на старую страницу реконструкции. Правки `000-default.conf` не нужны — `/studio/` обслуживает Django
(`WSGIScriptAlias /`).

## 1. Прод `robotom/robotom/settings.py`

Файл не в git — правится на сервере руками **до сборки образа**: Dockerfile копирует его в образ и запускает
`collectstatic` с этими настройками. Без приложения в `INSTALLED_APPS` JS студии не попадёт в `/static/`, а страница
`/studio/<exp_id>/` упадёт с `TemplateDoesNotExist` (500).

В `INSTALLED_APPS` — строка `'reconstruction',` после `'storage',`:

```python
INSTALLED_APPS = (
    ...
    'main',
    'experiment',
    'storage',
    'reconstruction',
)
```

Рядом с `RECONSTRUCTION_URL` — две настройки (в файле должен быть `import os`; если его нет — добавить в начало):

```python
# Студия реконструкции: recon-service (rbtm-recon, контейнер web_reconstructor_1) и общий с ним секрет —
# тот же RECON_TOKEN, что в web/.env rbtm-recon. Значения приходят из окружения контейнера (docker-compose.yml, .env).
RECON_SERVICE_URL = os.environ.get('RECON_SERVICE_URL', 'http://web_reconstructor_1:5560/')
RECON_TOKEN = os.environ.get('RECON_TOKEN', '')
```

Логи студии идут в логгер `storage_logger.reconstruction` — дочерний к `storage_logger`, поэтому попадают в
`logs/storage.log` без правок `LOGGING` (если в прод-файле есть логгер `storage_logger`, как в `dev_settings.py`).
Миграций у приложения нет.

## 2. Токен: `.env` рядом с `docker-compose.yml`

`docker-compose.yml` передаёт в контейнер `server` переменные `RECON_TOKEN=${RECON_TOKEN}` и
`RECON_SERVICE_URL=http://web_reconstructor_1:5560/`; значение токена docker-compose берёт из файла `.env` в каталоге
rbtm-web (образец — `.env.example`). Файл в `.gitignore` и в `.dockerignore` (в образ не копируется).

Токен — **тот же**, что в `web/.env` rbtm-recon. Если он там уже есть — скопировать строку (пути — каталоги
репозиториев на сервере):

```bash
cd <каталог rbtm-web>
grep '^RECON_TOKEN=' <каталог rbtm-recon>/web/.env > .env
chmod 600 .env
```

Если токена ещё нет нигде — сгенерировать один (`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`)
и записать строкой `RECON_TOKEN=<токен>` в оба файла: `<каталог rbtm-recon>/web/.env` и `<каталог rbtm-web>/.env`.

Пустой или отсутствующий `RECON_TOKEN` не ломает сайт: страница студии открывается, а `/studio/api/*` отвечает
503 «Студия реконструкции не настроена» (в сервис запрос не уходит).

## 3. Порядок выкатки

1. **rbtm-recon** — версия с recon-service (этап 2 студии и новее). `web/.env` с `RECON_TOKEN`, затем
   ```bash
   cd <каталог rbtm-recon>/web
   docker-compose build reconstructor
   docker-compose up -d reconstructor
   docker exec web_reconstructor_1 wget -qO- http://localhost:5560/health
   ```
   В ответе `"ok": true` и `"token_configured": true`.
2. **rbtm-web** — эта ветка: правки `settings.py` (п. 1), `.env` (п. 2), затем
   ```bash
   cd <каталог rbtm-web>
   docker-compose up --build -d server
   ```
   Контейнер пересоздаётся — новые переменные окружения попадают в Apache и процесс mod_wsgi.

В обратном порядке тоже работает (до выкатки rbtm-recon прокси отвечает 502), но проверить студию целиком можно
только после обоих шагов.

## 4. Проверка

Сеть и токен из контейнера rbtm-web (значение токена не печатается — только длина):

```bash
docker exec rbtmweb_server_1 python -c "import requests; print(requests.get('http://web_reconstructor_1:5560/health', timeout=5).text)"
docker exec -w /var/www/web/robotom rbtmweb_server_1 python manage.py shell -c "from django.conf import settings; print(settings.RECON_SERVICE_URL, len(settings.RECON_TOKEN))"
```

Ожидается JSON `/health` сервиса и `http://web_reconstructor_1:5560/ 43` (длина токена не 0; для
`token_urlsafe(32)` — 43).

В браузере, войдя пользователем с ролью админа, экспериментатора или исследователя:

1. `https://<сайт>/studio/api/health` — JSON сервиса (`"ok": true`). `/health` сервис отдаёт и без токена, поэтому
   это проверка сети и прав, но не токена.
2. `https://<сайт>/studio/api/jobs` — JSON со списком задач: токены rbtm-web и recon-service совпадают.
3. Страница записи хранилища → кнопка «Студия реконструкции» → `/studio/<exp_id>/` открывается; в инструментах
   разработчика JS студии загружается с `?v=<версия>`.

Под гостем `/studio/api/health` — 403, кнопки в хранилище нет.

Ответы прокси при ошибках (тело — JSON `{"error": ...}`):

| Ответ `/studio/api/...` | Причина | Что делать |
|---|---|---|
| 503 «Студия реконструкции не настроена…» | в Django пустой `RECON_TOKEN` или нет `RECON_SERVICE_URL` | п. 1 и 2, пересоздать контейнер `server` |
| 503 «RECON_TOKEN не задан — сервис не принимает запросы» | нет токена в `web/.env` rbtm-recon | задать, пересоздать `reconstructor` |
| 403 «неверный токен» | токены rbtm-web и rbtm-recon различаются | выровнять `.env`, пересоздать контейнер |
| 502 «Сервис реконструкции недоступен» | контейнер `web_reconstructor_1` не запущен или не в сети `rbtmstorage_default`, неверный `RECON_SERVICE_URL` | `docker ps`, `docker network inspect rbtmstorage_default` |
| 504 «Сервис реконструкции не ответил вовремя» | нет соединения за 5 с или ответа за 300 с | `docker-compose logs reconstructor` в rbtm-recon |
| 403 «Нет доступа к студии…» / «Недостаточно прав…» | у пользователя нет нужной роли | роль в «Запросы смены роли» |
| 404 «Запрос не поддерживается» | путь или метод не из белого списка | сверить фронтенд с `reconstruction/proxy.py` |

Журнал: `docker exec rbtmweb_server_1 tail -n 50 /var/www/web/robotom/logs/storage.log` — строки «Студия: …»
(ошибки связи с сервисом, постановка и отмена задач, открытие и закрытие сессий).

## Заметки

- **Кэш JS.** Apache отдаёт JS с кэшем на год, поэтому страница добавляет к статике `?v=<asset_version>` — хэш
  содержимого `reconstruction/static`, считается один раз на процесс. После обновления JS нужна пересборка
  образа (`collectstatic`) и перезапуск контейнера — версия пересчитается сама.
- **Скачивание файлов результата** (`/studio/api/results/<id>/file/<имя>`, десятки МБ) идёт потоком через Django и
  на время скачивания занимает один поток mod_wsgi (по умолчанию `WSGIDaemonProcess` — 15 потоков).
- **Ошибки 5xx прокси** пишутся только в `storage.log`: письма `mail_admins` на каждый запрос, пока сервис лежит,
  не отправляются.
- **Имя пользователя** уходит в сервис заголовком `X-Recon-User` (владелец сессии, автор задачи). Имя не из ASCII
  передаётся байтами UTF-8, а Werkzeug читает заголовки как latin-1: в сервисе такое имя искажается, но одинаково
  для одного пользователя — владение сессией работает, а имя владельца в сообщениях сервиса («сессию держит …»)
  и автор задачи отображаются нечитаемо. Латинские имена — без изменений.
