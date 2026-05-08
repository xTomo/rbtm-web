# RBTM-Web

Веб-интерфейс системы управления рентгеновским томографом. Django-приложение, выступающее в роли фронтенда и координатора для двух независимых микросервисов: **storage** (хранение данных экспериментов) и **experiment** (управление томографом).

## Стек технологий

| Компонент | Версия |
|---|---|
| Python | 3.12 |
| Django | 5.2 |
| Django REST Framework | 3.15.2 |
| PostgreSQL | 16 |
| psycopg2-binary | 2.9.9 |
| pymemcache | 4.0.0 |
| h5py | 3.11.0 |
| numpy | 1.26.4 |
| Pillow | 10.4.0 |
| Bootstrap | 3 (django-bootstrap3 23.6) |

## Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                     rbtm-web (этот репозиторий)         │
│                                                         │
│  Django 5.2 + Apache2/mod_wsgi + PostgreSQL             │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   main   │  │  experiment  │  │     storage      │  │
│  │  (auth)  │  │  (томограф)  │  │  (эксперименты)  │  │
│  └──────────┘  └──────┬───────┘  └────────┬─────────┘  │
└─────────────────────────────────────────────────────────┘
                         │                  │
                         ▼                  ▼
              ┌─────────────────┐  ┌────────────────────┐
              │ Experiment API  │  │   Storage API      │
              │ localhost:5001  │  │   localhost:5006   │
              └─────────────────┘  └────────────────────┘
```

- **`main`** — аутентификация, профили пользователей, система ролей, запросы на смену роли
- **`experiment`** — управление томографом: настройка, запуск/остановка экспериментов, интерфейс оборудования. Проксирует команды в **Experiment API** (HTTP)
- **`storage`** — просмотр результатов экспериментов (HDF5-файлы), поиск по метаданным, визуализация кадров. Проксирует запросы в **Storage API** (HTTP)

## Структура проекта

```
rbtm-web/
├── Dockerfile                  # python:3.12-slim + Apache2 + mod_wsgi
├── docker-compose.yml          # web + postgres:16
├── requirements.txt
├── 000-default.conf            # конфигурация Apache VirtualHost
├── apache2-foreground          # entrypoint для Docker
└── robotom/                    # Django-проект
    ├── manage.py
    ├── logs/                   # логи приложения
    ├── robotom/                # пакет настроек проекта
    │   ├── urls.py             # корневой URL-роутер
    │   ├── wsgi.py
    │   ├── utils.py            # общие утилиты (force_https и др.)
    │   ├── dev_settings.py     # настройки для разработки
    │   └── bamboo_settings.py  # настройки для CI (SQLite, наследует dev_settings)
    ├── main/                   # приложение: аутентификация и профили
    │   ├── models.py           # UserProfile, RoleRequest
    │   ├── views.py            # регистрация, вход, профиль, управление ролями
    │   ├── forms.py
    │   ├── serializers.py      # DRF: UserSerializer, RoleRequestSerializer
    │   ├── admin.py
    │   ├── urls.py
    │   ├── migrations/
    │   ├── static/             # CSS, Bootstrap 3, изображения
    │   └── templates/
    │       ├── base.html       # базовый шаблон
    │       └── main/           # index, profile, manage_requests, role_request, done, empty
    ├── experiment/             # приложение: управление томографом
    │   ├── apps.py             # ExperimentConfig: создаёт Tomograph при первом запуске
    │   ├── models.py           # Tomograph (state: unavailable/ready/experiment)
    │   ├── views.py            # experiment_view, adjustment, interface, tomograph
    │   ├── admin.py
    │   ├── urls.py
    │   ├── migrations/
    │   ├── static/experiment/  # JS (jQuery, my_scripts), CSS
    │   └── templates/experiment/ # start, adjustment, interface
    ├── storage/                # приложение: просмотр результатов
    │   ├── views.py            # storage_view, storage_record_view, frames_downloading, delete_experiment
    │   ├── urls.py
    │   ├── static/storage/     # Three.js, bootstrap-image-gallery, storage_index.js
    │   └── templates/storage/  # storage_index, storage_record
    └── templates/              # глобальные шаблоны
        └── registration/       # login, logout, password_reset_*, registration_form
```

## Модели данных

### `main.UserProfile`
Расширяет стандартного `User` через `OneToOneField`. Поля:
- `full_name`, `gender`, `phone_number`, `address`, `work_place`, `degree`, `title`
- Флаги ролей: `is_guest` (по умолчанию), `is_admin`, `is_experimentator`, `is_researcher`
- `activation_key` — для подтверждения email при регистрации

### `main.RoleRequest`
Запрос пользователя на присвоение роли (ADM / EXP / RES). Связан с `UserProfile` через `ForeignKey`.

### `experiment.Tomograph`
Состояние томографа: `unavailable` / `ready` / `experiment`. Один экземпляр на установку.
Создаётся автоматически при первом запуске через сигнал `post_migrate` в `ExperimentConfig.ready()`.

## Форматы эксперимента

### Простой режим (`mode=simple`)

В UI задаются: единое количество dark/empty, единая экспозиция, количество угловых позиций, угловой шаг, кадров на позицию.

**Параметры, отправляемые в `rbtm-drivers-next`:**
```json
{
  "exp_id": "uuid",
  "specimen": "название",
  "tags": "тег1, тег2",
  "experiment parameters": {
    "advanced": false,
    "DARK":  { "count": 10,  "exposure": 3000.0 },
    "EMPTY": { "count": 10,  "exposure": 3000.0 },
    "DATA":  { "step count": 500, "exposure": 3000.0, "angle step": 0.36, "count per step": 1 }
  }
}
```

**Последовательность кадров:**
```
[dark × N] → [empty × N] → [data × step_count × cps]
```

### Продвинутый режим (`mode=advanced`)

В UI задаются: единая экспозиция, длина серии dark/empty, периодичность вставки empty, количество data-позиций, угловой шаг, кадров на позицию.

**Параметры, отправляемые в `rbtm-drivers-next`:**
```json
{
  "exp_id": "uuid",
  "specimen": "название",
  "tags": "тег1, тег2",
  "experiment parameters": {
    "advanced":            true,
    "exposure":            3000.0,
    "series_length":       10,
    "data_total":          500,
    "data_angle_step":     0.36,
    "data_count_per_step": 1,
    "empty_period":        50
  }
}
```

**Последовательность кадров:**
```
[dark × series_length]
[empty × series_length]
─ повтор для каждой угловой позиции ─────────────────────────────
  [data × data_count_per_step]
  каждые empty_period позиций (кроме последней):
    [empty × series_length]
    [data_check × data_count_per_step]  ← тот же угол, для контроля дрейфа
──────────────────────────────────────────────────────────────────
```

**Визуализация (data_total=150, empty_period=50, series_length=5):**
```
[dark×5][empty×5][data×50][empty×5][chk][data×50][empty×5][chk][data×50]
```

### Мониторинг выполнения

На странице `/experiment/interface/` отображается блок статуса в реальном времени (поллинг каждые 2 сек):
- Bootstrap прогресс-бар
- Цветной таймлайн сегментов (dark / empty / data / data_check)
- Оценка оставшегося времени (ETA)
- Превью последнего кадра из Storage (поллинг каждые 10 сек)
- Кнопка "Закончить эксперимент" автоматически блокируется по завершении

---

## URL-маршруты

| Префикс | Приложение | Namespace |
|---|---|---|
| `/` | `main` (→ redirect на `/storage/`) | `main` |
| `/experiment/` | `experiment` (→ redirect на `/experiment/interface/`) | `experiment` |
| `/experiment/control/` | Управление томографом (источник + юстировка) | `experiment:index_control` |
| `/experiment/source/state/` | Состояние источника (JSON, AJAX-поллинг) | `experiment:source_state` |
| `/experiment/interface/` | Запуск эксперимента | `experiment:index_interface` |
| `/experiment/status/` | Прокси к статусу (JSON) | `experiment:status` |
| `/experiment/last-frame/` | Прокси к последнему кадру (npz) | `experiment:last_frame` |
| `/experiment/storage-preview/` | PNG превью из Storage для мониторинга | `experiment:storage_preview` |
| `/storage/` | `storage` | `storage` |
| `/admin/` | Django Admin | — |
| `/accounts/` | `django.contrib.auth` | — |

## Настройки

### `dev_settings.py` — для локальной разработки

| Параметр | Описание |
|---|---|
| `SECRET_KEY` | Секретный ключ Django |
| `DEBUG` | `True` в dev, `False` в production |
| `TOMO_NUM` | Номер томографа (суффикс в URL Experiment API, по умолчанию `1`) |
| `ALLOWED_HOSTS` | Реальный домен / IP в production |
| `DATABASES.HOST` | `localhost` в dev; в Docker `sed` заменяет на `database` |
| `STORAGE_HOST` | URL Storage API (default: `http://localhost:5006/`) |
| `EXPERIMENT_HOST` | URL Experiment API (default: `http://localhost:5001/`) |
| `TIMEOUT_DEFAULT` | Таймаут HTTP-запросов к внешним API, секунды (default: `120`) |
| `EMAIL_*` | Настройки SMTP для отправки писем активации |
| `CACHES` | `PyMemcacheCache` — в dev отключён (DummyCache) |

### `bamboo_settings.py` — для CI

Наследует все настройки из `dev_settings.py` через `from .dev_settings import *`,
переопределяет только:
- `DATABASES` → SQLite
- `REQUEST_DEBUG = True`

### `settings.py` — production

Файл `robotom/robotom/settings.py` содержит production-настройки и **не хранится в git**.
При сборке Docker-образа `Dockerfile` заменяет `'HOST': 'localhost'` → `'HOST': 'database'` через `sed`.

Ключевые отличия от `dev_settings.py`:
- `DEBUG = False`
- `STORAGE_HOST = 'http://rbtmstorage_server_1:5006/'`
- `EXPERIMENT_HOST = 'http://10.0.6.86:5001/'` (реальный IP томографа)
- `CSRF_TRUSTED_ORIGINS` — список доменов и IP, с которых принимаются POST-запросы

> **При обновлении:** добавить в `settings.py` строку:
> ```python
> EXPERIMENT_SOURCE_GET_STATE = urljoin(EXPERIMENT_HOST, '/tomograph/{}/source/state')
> ```
> (автоматически наследуется из `dev_settings.py`, но в production файле должна быть явно)

## Запуск

### Docker (рекомендуется)

```bash
docker-compose up --build -d
```

Поднимает два контейнера:
- `rbtmweb_server_1` — Django 5.2 + Apache2 + mod_wsgi (Python 3.12)
- `rbtmweb_database_1` — PostgreSQL 16

**Важно:** `server` не стартует до готовности `database` (healthcheck).

После первого запуска применить миграции:

```bash
# Если база не создалась автоматически (POSTGRES_DB работает только при первой инициализации пустого тома)
docker exec rbtmweb_database_1 psql -U postgres -c "CREATE DATABASE robotom_users;"

docker-compose exec server python robotom/manage.py migrate --fake-initial
```

### Локальная разработка

```bash
pip install -r requirements.txt

# Применить миграции
python robotom/manage.py migrate --settings=robotom.dev_settings

# Запустить сервер
python robotom/manage.py runserver --settings=robotom.dev_settings
```

Или через переменную окружения:

```bash
# Unix
export DJANGO_SETTINGS_MODULE=robotom.dev_settings
# Windows CMD
set DJANGO_SETTINGS_MODULE=robotom.dev_settings

python robotom/manage.py runserver
```

## Тесты

```bash
python robotom/manage.py test main --settings=robotom.dev_settings
python robotom/manage.py test storage --settings=robotom.dev_settings
python robotom/manage.py test experiment --settings=robotom.dev_settings
```

> **Примечание:** Тесты `experiment` и `storage` проверяют только страницы Django и не требуют запущенных внешних API-сервисов.

## Статика и медиа

```bash
python robotom/manage.py collectstatic --settings=robotom.dev_settings
```

- `STATIC_ROOT` → `robotom/static/` (собирается при сборке Docker-образа)
- `MEDIA_ROOT` → `robotom/media/` (PNG-кадры, кешируемые из Storage API)
- `RECONSTRUCTION_ROOT` → `robotom/media/reconstructions/` (3D-реконструкции)

**Медиафайлы генерируются динамически:** при открытии страницы эксперимента Django скачивает PNG-кадры из `rbtmstorage_server_1` и кеширует их в `MEDIA_ROOT`. При повторном обращении файл берётся из кеша (проверяется `os.path.exists`).

В Docker медиафайлы монтируются с хоста, чтобы переживать пересборки образа:
```yaml
volumes:
  - /home/robotom/rbtm_data/rbtm_web/media:/var/www/web/robotom/media
```

Права на директорию (www-data = uid 33 в Debian):
```bash
sudo chown -R 33:33 /home/robotom/rbtm_data/rbtm_web/media
sudo chmod -R 775 /home/robotom/rbtm_data/rbtm_web/media
```

## Права пользователей

| Роль | Код | Доступ |
|---|---|---|
| Гость | `GST` | Просмотр хранилища (`/storage/`) |
| Исследователь | `RES` | Просмотр хранилища |
| Экспериментатор | `EXP` | Управление томографом (`/experiment/`) |
| Администратор | `ADM` | Всё + управление запросами на роли |

Новый пользователь регистрируется с подтверждением по email, получает роль **Гость**. Для смены роли подаёт `RoleRequest` — администратор принимает или отклоняет запрос.

## Миграция данных со старой базы (PostgreSQL 9.4 → 16)

### Контекст

Старая база работала под Django 1.8 / PostgreSQL 9.4. Схема таблиц приложений (`main`, `experiment`) практически не изменилась. Поэтому дамп данных можно перелить напрямую.

**Важно:** PostgreSQL 16 **не может читать** файлы данных от PostgreSQL 9.4 — они физически несовместимы. Если том `/home/robotom/rbtm_data/rbtm_web/db` содержит старые данные, контейнер postgres:16 будет падать с ошибкой:

```
FATAL: database files are incompatible with server
DETAIL: The data directory was initialized by PostgreSQL version 9.4
```

Необходимо сначала сделать **логический дамп** (SQL), очистить том, и восстановить данные в postgres:16.

---

### Полный сценарий миграции (рекомендуется)

#### Шаг 1. Остановить новый стек (если уже запущен)

```bash
docker-compose down
```

#### Шаг 2. Сделать дамп через временный postgres:9.4

```bash
docker run --rm \
  -v /home/robotom/rbtm_data/rbtm_web/db:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=postgres \
  --name pg94_temp \
  -d postgres:9.4

sleep 5

docker exec pg94_temp pg_dump -U postgres robotom_users > robotom_backup.sql
docker stop pg94_temp
```

#### Шаг 3. Очистить том от старых файлов

```bash
# ВНИМАНИЕ: это удаляет все файлы PostgreSQL 9.4 из тома
sudo rm -rf /home/robotom/rbtm_data/rbtm_web/db/*
```

#### Шаг 4. Поднять новый стек

```bash
docker-compose up --build -d
```

#### Шаг 5. Восстановить дамп в postgres:16

```bash
docker exec -i rbtmweb_database_1 psql -U postgres -d robotom_users < robotom_backup.sql
```

#### Шаг 6. Применить миграции Django 5.2

```bash
docker-compose exec server python robotom/manage.py migrate --fake-initial
```

> `--fake-initial` помечает `0001_initial`-миграции как выполненные без создания таблиц — только если таблицы уже существуют в базе.

#### Шаг 7. Проверка

```bash
# Все миграции должны быть [X]
docker-compose exec server python robotom/manage.py showmigrations

# Системная проверка Django
docker-compose exec server python robotom/manage.py check
```

---

### Возможные проблемы

| Проблема | Причина | Решение |
|---|---|---|
| `database files are incompatible with server` | Том содержит данные postgres:9.4, а контейнер postgres:16 | Выполнить полный сценарий выше (дамп → очистить том → восстановить) |
| `relation already exists` | Таблица есть в дампе и в новой базе | Использовать `--fake-initial` при `migrate` |
| `column ... does not exist` | В Django 5.2 добавились поля в системные таблицы | Запустить `migrate` без `--fake-initial` |
| Пользователи не могут войти | Старые хэши MD5/SHA1 | Отправить ссылку сброса пароля через `/accounts/password_reset/` |
| `UnicodeDecodeError` при восстановлении | Дамп не в UTF-8 | Добавить `--encoding=UTF8` при `pg_dump` |
| `pg_dump: server version mismatch` | Версия `pg_dump` не совпадает с версией сервера | Использовать временный контейнер postgres:9.4 (шаг 2) |
