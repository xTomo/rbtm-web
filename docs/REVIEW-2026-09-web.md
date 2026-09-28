# Ревью rbtm-web (сентябрь 2026)

Ветка: `review/web-cleanup`. База: `dev` @ `50a89cd`.
Общий документ по стыкам модулей: `xtomo/plans/REVIEW-2026-09-cross-module.md` (C3, C5–C8, C10).

Что смотрели: `robotom/experiment` (views, шаблоны, JS), `robotom/storage`, `robotom/main`, настройки, Docker/Apache, тесты, README.
Ссылки `file:line` — по состоянию базы. rbtm-web **не читает HDF5** (коммит «try HDF5 v2» лишь удалил неиспользуемый `import h5py`).

---

## 1. Главное

| # | Проблема | Где | Риск |
|---|---|---|---|
| 1 | **Принятие заявки на роль сломано архитектурно**: `try_user_sending` шлёт POST на `STORAGE_ALT_USER_HOST` (`/storage/users/update`) — такого роута в storage нет; вызов отключён `REQUEST_DEBUG=True` во всех конфигурациях; если бы выполнялся, `if attempt: return attempt` прерывал бы принятие до `profile.save()`. Кнопка «Отмена» в форме заявки → `UnboundLocalError` 500. | `main/views.py:44-66, 267-307, 317-344` | high |
| 2 | **Детект зависшего эксперимента никогда не срабатывает**: JS читает `result.last_frame_at`, drivers не отдают (исправлено в drivers). «Завершён/не запущен» различаются только по `frame_num>0`; при `running=false` поллинг гасится навсегда и не возобновляется при новом старте; причина остановки не показывается. | `interface.html:774-782, 827, 857-871` | high |
| 3 | **HTTP-обёртки**: `try_request_post/get` парсят JSON до проверки кода → при 409/503 текст `error` теряется, при HTML-500 показывается «нет подключения к сети»; `except BaseException` (14 мест); `experiment_tomograph` без обработки (500 на любой сбой, KeyError на чужом пути); `experiment_source_state` превращает 503 в `{on:false}` 200; 409 от превью → 502. | `experiment/views.py:88-144, 205-230, 745-838` | med |
| 4 | **Форма старта**: `float()/int()` без обработки → 500 на пустом поле; два набора `input` с одинаковыми `name`, читаются оба; диапазоны не валидируются. Таймаут превью `max(120, exp+30)` меньше драйверного `2·exp+30` при экспозиции > 45 с. | `experiment/views.py:445-498, 771`, `interface.html:77,133` | med |
| 5 | **`STORAGE_HDF5_FILE` — голый путь** `/storage/experiments/{id}.h5`: ссылка для браузера работает только через `rbtm-proxy` (внешний nginx делает rewrite на storage :5006); собирать её от `STORAGE_HOST` нельзя — в проде это внутреннее имя докер-сети. Скрытая зависимость нигде не описана. `STORAGE_FRAMES_HOST`, `STORAGE_CREATE_USER_HOST`, `STORAGE_ALT_USER_HOST` указывают на несуществующие роуты storage. | `dev_settings.py:30-37`, `rbtm-proxy/proxy_nginx.conf:40-44` | med (документация), low (мёртвые) |
| 6 | `frames_downloading`, `delete_experiment` без `@login_required`; удаление GET-запросом из JS. | `storage/views.py:315,397`, `storage_index.js:21-37` | high (security, только документируется) |
| 7 | Storage-страницы: `record['datetime']` без `.get`; кадры сортируются строкой и дублируются при дублях в Mongo; `tags`-список ломает автодополнение; `except BaseException` гасит причину до «Сервер хранилища не отвечает». | `storage/views.py:77, 285`, `experiment/views.py:663` | low–med |
| 8 | Оценка длительности (JS): число кадров совпадает с drivers, но нет времени поворота на позицию (`set_angle` × `data_total`), `move_back` (+1 движение), `source_wait_for_ready`; переменная `expMs` содержит секунды. Отрисовка timeline может вылезать за canvas. | `interface.html:636-639, 707-759` | low |
| 9 | Мёртвое: `make_search_query`, `serializers.py` (поле `role` не существует, никем не импортируется), `redirectToHdf5Load`, весь бандл Three.js/blueimp-gallery, jQuery 1.7.1/`my_scripts.js`/`style.css`/`PIE.htc`, `ntsaveforms.js` (классов нет в шаблонах), `/experiment/last-frame/` (никто не вызывает), `h5py`/`Pillow` в requirements и `libhdf5-dev` в Dockerfile, no-op `sed` в Dockerfile, `timeout=1` в `main/views.py:49`. Дубль `experiment_control`/`experiment_adjustment` (~90 строк). | см. §3 | low |
| 10 | Тесты покрывают только загрузку страниц и auth; `test_search_specimen` проходит благодаря недоступности storage, а не проверке поиска; тест старта эксперимента закомментирован. | `*/tests.py` | med |

---

## 2. Архитектура

Django 5.2 + Apache/mod_wsgi (:5080). Три приложения: `main` (auth/роли), `experiment` (прокси к drivers :5001, единый `TOMO_NUM`),
`storage` (прокси к storage :5006, PNG кешируются в `MEDIA_ROOT` с 5 ретраями по 3 с на 404). Реконструкция — внешняя ссылка на recon :5550
(Apache `ProxyPass /reconstruct → web_web_1:5550`, резолвится через общую сеть `rbtmstorage_default`).
`settings.py` (prod) не в git; `bamboo_settings` = `dev_settings` + sqlite (тесты).

---

## 3. По компонентам

### 3.1 experiment
- Сборка JSON старта: simple `DARK/EMPTY {count:int, exposure:float мс}`, `DATA {step count, exposure, angle step, count per step}`; advanced плоский. Типы проходят строгие `type(x) is float/int` в drivers только потому, что web их так формирует (C6).
- Поллинг `/experiment/status/` каждые 2 с (прозрачный проброс тела и кода, 502 при исключении), превью из storage каждые 10 с (`storage-preview`). Ключи, которые читает JS: `running, exp_id, frame_num, total_frames, progress_pct, current_mode, current_angle, elapsed_sec, last_frame_at, timeline` (+ `error` после правок drivers).
- `adjustment.js`/`control.html`: `shutter/state` приходит как строка JSON внутри `result` (двойное кодирование — JS знает), `warming_status` из `/source/state` дропается Django-прокси; `get-vertical-position` — mock в памяти Flask.
- `get_preview_data` декодирует npz → base64 uint16; `EXPERIMENT_GET_STATUS`/`GET_LAST_FRAME`/`DETECTOR_GET_MODEL` читаются через `getattr` с fallback, остальные — напрямую.

### 3.2 storage
- `storage_view` игнорирует `request.POST` (поиск на клиенте), `make_search_query` мёртв. `ExperimentRecord` конвертирует мс → с, строит `hdf_host`/`recon_url`. `FrameRecord` — защитный разбор вложенного JSON без схемы. `storage_record.html` навигация по кадрам через `childNodes[19]` — хрупко.

### 3.3 main
- Регистрация с активацией по email, роли `GST/RES/EXP/ADM`, `RoleRequest`. См. §1 п.1.

### 3.4 Docker/Apache
- `Dockerfile`: `sed` замены HOST — no-op (в `settings.py` уже `os.environ`); `libhdf5-dev` ради неиспользуемого h5py. `docker-compose.yml`: `POSTGRES_PASSWORD` открыто; healthcheck БД есть. `000-default.conf`: Alias static/media, ProxyPass только `/reconstruct`; `/storage/experiments/*.h5` Apache не проксирует — это делает `rbtm-proxy`.

---

## 4. План работ (ветка `review/web-cleanup`)

| Коммит | Содержание | Проверка |
|---|---|---|
| HTTP-обёртки | код ответа до JSON, показ `error` из тела, `RequestException` вместо `BaseException`, `experiment_tomograph` 404/502, `source_state` 502, превью 409 и таймаут `2·exp+30` | тесты с mock `requests` |
| форма старта | try/except на приведениях, поля по режиму, сообщения вместо 500 | тесты payload типов, пустое поле |
| JS interface | `exp_id` вместо `frame_num` для «завершён», показ `error`, поллинг не гасится, оценка длительности (+поворот, +move_back), canvas | рендер страницы |
| настройки | `STORAGE_PUBLIC_HOST` (пусто → относительный путь через rbtm-proxy) для ссылки на `.h5`; удалить мёртвые `STORAGE_*_USER_HOST`/`FRAMES_HOST`, `REQUEST_DEBUG`; README про nginx/rbtm-proxy | — |
| main | `role_request_view` cancel; принятие заявки без storage; удалить `try_user_sending`, `serializers.py` | тесты cancel, accept |
| storage views | `.get('datetime')`, числовая сортировка + дедуп кадров, `tags` список | тесты |
| мёртвое | `make_search_query`, статика, `ntsaveforms`, `last-frame`, requirements/Dockerfile | grep |
| тесты | `test_status_proxy_passthrough` (ключи), search с mock, старт эксперимента | `manage.py test --settings=robotom.bamboo_settings` |

Не делаем без отдельного решения: `@login_required` и POST/CSRF на `delete_experiment`/`frames_downloading`;
объединение `control`/`adjustment`; вынос секретов из `settings.py`/compose; удаление DRF из `INSTALLED_APPS`.

---

## 5. Статус на 22.09.2026

Ветка `review/web-cleanup`: 29 коммитов поверх `dev` (`aa17ac8` … `0cb9957`), рабочее дерево чистое. Сделано всё из §4.
Ревью диффа (Opus) нашло 10 замечаний, исправлены в follow-up коммитах: дедуп кадров по `_id` (а не по `num` с дефолтом `"0"`),
ссылка на `.h5` — относительный путь через rbtm-proxy с опцией `STORAGE_PUBLIC_HOST` (сборка от `STORAGE_HOST` ломала бы скачивание в проде),
показ `error` при `success:false`, защита от не-dict JSON в статусе, моки сети в тестах интерфейса, ранний `cancel` в заявке на роль,
битый `{% static 'storage/styles.css' %}`.

Проверено локально:

| Проверка | Результат |
|---|---|
| `python robotom/manage.py test --settings=robotom.bamboo_settings` (sqlite, mock `requests`) | 40 OK (было 11, два старых падения `main/tests.py` починены: относительный `Location`, редирект `/experiment/` → `/experiment/interface/`) |
| `/experiment/status/` passthrough | ключи `result` совпадают с ответом drivers ветки `review/hardware-cleanup` (10 + `error`) |
| Payload старта | simple: `count` int, `exposure` float мс, `angle step` float, `count per step` int; advanced плоский — как до ветки |
| Пустое поле формы, 409/503/HTML-500 от drivers | сообщение пользователю, не 500 |

NOT VERIFIED — требует стенда: prod `settings.py` (не в git) — `DATABASES.HOST` из окружения (sed из Dockerfile удалён), отсутствие
удалённых `STORAGE_*_USER_HOST`/`STORAGE_FRAMES_HOST`/`REQUEST_DEBUG`, `STORAGE_HDF5_FILE`; рендер `interface.html` с живыми drivers
(бейдж «Ошибка», возобновление поллинга); сборка образа без `libhdf5-dev`.

Не сделано (решение пользователя): `@login_required`/POST+CSRF на `delete_experiment` и `frames_downloading`; объединение
`control`/`adjustment` (там же остались классы `ntSaveForms` без подключённого плагина); секреты в `settings.py`/compose; DRF в `INSTALLED_APPS`
без использования.

---

## 6. Межмодульные контракты (сторона web)

- **→ drivers**: JSON старта (C6), поллинг статуса (C8, список ключей зафиксирован тестом), команды управления; ошибки drivers — JSON `{success:false,error}` с 409/503 или `create_response` 200.
- **→ storage**: `experiments/get` (`{}` — весь список), `frames_info/get` (`{exp_id}`), PNG по nginx-alias, `.h5` через `rbtm-proxy` (C7). Web не читает HDF5 и Mongo напрямую.
- **→ recon**: только ссылка `RECONSTRUCTION_URL` и Apache-прокси `/reconstruct`.
