"""Настройки для CI (Bamboo/GitHub Actions). Использует SQLite вместо PostgreSQL."""
from .dev_settings import *  # noqa: F401, F403

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': 'robotom_users',
    },
}

REQUEST_DEBUG = True
