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
    │   ├── dev_settings.py     # настройки для разработки
    │   └── bamboo_settings.py  # минимальные настройки для CI (SQLite)
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
    │       ├── base.html       # базовый шаблон ({% load static %})
    │       └── main/           # index, profile, manage_requests, role_request, done, empty, group_*
    ├── experiment/             # приложение: управление томографом
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

## URL-маршруты

| Префикс | Приложение | Namespace |
|---|---|---|
| `/` | `main` | `main` |
| `/experiment/` | `experiment` | `experiment` |
| `/storage/` | `storage` | `storage` |
| `/admin/` | Django Admin | — |
| `/accounts/` | `django.contrib.auth` | — |

## Настройки (`dev_settings.py`)

Ключевые параметры, которые нужно переопределить в `settings.py` для production:

| Параметр | Описание |
|---|---|
| `SECRET_KEY` | Секретный ключ Django |
| `DEBUG` | Выключить (`False`) |
| `ALLOWED_HOSTS` | Реальный домен |
| `DATABASES` | Параметры подключения к PostgreSQL |
| `STORAGE_HOST` | URL Storage API (default: `http://localhost:5006/`) |
| `EXPERIMENT_HOST` | URL Experiment API (default: `http://localhost:5001/`) |
| `EMAIL_*` | Настройки SMTP для отправки писем активации |
| `CACHES` | Memcached (`PyMemcacheCache`) — в dev отключён |

## Запуск

### Docker (рекомендуется)

```bash
docker-compose up --build
```

Поднимает два контейнера: `server` (Django + Apache) и `database` (PostgreSQL 16).

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

### Production

Создать `robotom/robotom/settings.py` как копию `dev_settings.py` с реальными значениями (DEBUG, SECRET_KEY, DATABASES, ALLOWED_HOSTS и т.д.).

```bash
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

- `STATIC_ROOT` → `robotom/static/`
- `MEDIA_ROOT` → `robotom/media/` (загруженные файлы)
- `RECONSTRUCTION_ROOT` → `robotom/media/reconstructions/` (3D-реконструкции)

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

Старая база работала под Django 1.8. Схема таблиц приложений (`main`, `experiment`) практически не изменилась — добавлен только `on_delete=CASCADE` на уровне Django ORM, PostgreSQL это не хранит отдельно. Поэтому дамп данных можно перелить напрямую.

### Шаг 1. Дамп старой базы

На сервере со старым PostgreSQL 9.4:

```bash
# Бинарный формат (рекомендуется)
pg_dump -h localhost -U postgres -d robotom_users_1 -F c -f robotom_backup.dump

# Или plain SQL
pg_dump -h localhost -U postgres -d robotom_users_1 --encoding=UTF8 > robotom_backup.sql
```

Из старого Docker-контейнера:

```bash
docker exec <old_container> pg_dump -U postgres robotom_users_1 > robotom_backup.sql
```

### Шаг 2. Создать новую базу и восстановить дамп

```bash
psql -h localhost -U postgres -c "CREATE DATABASE robotom_users_1;"

# Из бинарного дампа
pg_restore -h localhost -U postgres -d robotom_users_1 --no-owner --no-acl robotom_backup.dump

# Или из plain SQL
psql -h localhost -U postgres -d robotom_users_1 < robotom_backup.sql
```

### Шаг 3. Применить новые миграции Django

Django определяет, какие миграции уже применены, по таблице `django_migrations` в базе. Запустите:

```bash
python robotom/manage.py migrate --settings=robotom.dev_settings
```

Django пропустит миграции приложений (`main`, `experiment`), уже записанные в базе, и применит только новые системные миграции Django 5.2.

Если возникает ошибка `relation already exists` (таблица уже есть, но запись о миграции отсутствует):

```bash
python robotom/manage.py migrate --fake-initial --settings=robotom.dev_settings
```

> `--fake-initial` помечает `0001_initial`-миграции как выполненные без создания таблиц — только если таблицы уже существуют в базе.

### Шаг 4. Проверка

```bash
# Все миграции должны быть [X]
python robotom/manage.py showmigrations --settings=robotom.dev_settings

# Системная проверка
python robotom/manage.py check --settings=robotom.dev_settings
```

### Через Docker (полный сценарий)

```bash
# 1. Дамп из старого контейнера
docker exec <old_container> pg_dump -U postgres robotom_users_1 > robotom_backup.sql

# 2. Поднять новую БД
docker-compose up -d database

# 3. Восстановить дамп
docker exec -i $(docker-compose ps -q database) \
  psql -U postgres -d robotom_users_1 < robotom_backup.sql

# 4. Применить миграции
docker-compose run --rm server \
  python robotom/manage.py migrate --settings=robotom.dev_settings
```

### Возможные проблемы

| Проблема | Причина | Решение |
|---|---|---|
| `relation already exists` | Таблица есть в дампе и в новой базе | Использовать `--fake-initial` |
| `column ... does not exist` | В Django 5.2 добавились поля в системные таблицы | Запустить `migrate` без `--fake-initial` |
| Пользователи не могут войти | Старые хэши MD5 (удалены из `PASSWORD_HASHERS`) | Отправить пользователям ссылку для сброса пароля через `/accounts/password_reset/` |
| `UnicodeDecodeError` при восстановлении | Дамп не в UTF-8 | Добавить `--encoding=UTF8` при создании дампа |
| `pg_dump: server version mismatch` | Версия `pg_dump` не совпадает с сервером | Использовать `pg_dump` той же версии, что и сервер (9.4) |
