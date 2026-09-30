# Production-настройки rbtm-web (хранятся в git).
#
# Общая часть — dev_settings (приложения, middleware, шаблоны, логи, маршруты Experiment/Storage API, которые
# строятся от *_HOST); здесь только то, чем production отличается. Секреты и всё, что зависит от сервера, приходят
# из окружения контейнера: файл .env рядом с docker-compose.yml (образец — .env.example) подключается к сервису
# server через env_file. У серверных значений есть умолчания для нынешней установки — переменная с тем же именем
# в .env их переопределяет.
#
# Обязательно в .env: SECRET_KEY, EMAIL_HOST_PASSWORD, RECON_TOKEN (пустой SECRET_KEY — Django не обслуживает
# запросы; пустой RECON_TOKEN — студия реконструкции отвечает 503). При сборке образа (collectstatic) .env не нужен.
# Необязательный robotom/local_settings.py (вне git) по-прежнему подключается последним — для срочных правок.

import os


def _env(name, default=''):
    value = os.environ.get(name)
    return default if value is None or value == '' else value


def _env_list(name, default):
    """Список через запятую; пусто — default."""
    value = os.environ.get(name, '')
    items = [v.strip() for v in value.split(',') if v.strip()]
    return items or list(default)


def _env_flag(name, default):
    value = os.environ.get(name)
    if value is None or value == '':
        return default
    return value.strip().lower() not in ('0', 'false', 'no', 'off')


# Адреса сервисов — до импорта общей части: dev_settings строит от них маршруты API
os.environ.setdefault('STORAGE_HOST', 'http://rbtmstorage_server_1:5006/')
os.environ.setdefault('EXPERIMENT_HOST', 'http://10.0.6.86:5001/')
os.environ.setdefault('RECONSTRUCTION_HOST', 'http://10.0.7.153:5550/')
os.environ.setdefault('RECON_SERVICE_URL', 'http://web_reconstructor_1:5560/')

from .dev_settings import *  # noqa: E402,F401,F403

DEBUG = _env_flag('DJANGO_DEBUG', False)

SECRET_KEY = _env('SECRET_KEY')

ALLOWED_HOSTS = _env_list('ALLOWED_HOSTS', [
    '109.234.38.83', 'tomox.ru', 'www.tomox.ru', 'localhost', 'nanotom', '10.0.7.153',
])

# CSRF trusted origins — обязательны в Django 4+ при HTTPS и нестандартных портах
CSRF_TRUSTED_ORIGINS = _env_list('CSRF_TRUSTED_ORIGINS', [
    'http://109.234.38.83', 'https://109.234.38.83', 'http://tomox.ru', 'https://tomox.ru', 'https://www.tomox.ru',
    'http://localhost:5080', 'http://localhost',
])

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.postgresql',
        'NAME': _env('DB_NAME', 'robotom_users'),
        'USER': _env('DB_USER', 'postgres'),
        # тот же пароль, что POSTGRES_PASSWORD сервиса database в docker-compose.yml
        'PASSWORD': _env('DB_PASSWORD', 'postgres'),
        'HOST': _env('DB_HOST', 'database'),
        'PORT': _env('DB_PORT', ''),
    },
}

# MD5 — для старых учётных записей с MD5-хэшами (при входе пароль перехэшируется первым хэшером)
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher',
    'django.contrib.auth.hashers.BCryptSHA256PasswordHasher',
    'django.contrib.auth.hashers.MD5PasswordHasher',
]

# Почта (письма активации): явно SMTP — dev_settings при DEBUG ставит консольный бэкенд
EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
EMAIL_HOST = _env('EMAIL_HOST', 'smtp.gmail.com')
EMAIL_PORT = int(_env('EMAIL_PORT', '587'))
EMAIL_USE_TLS = _env_flag('EMAIL_USE_TLS', True)
EMAIL_HOST_USER = _env('EMAIL_HOST_USER', DEFAULT_FROM_EMAIL)  # noqa: F405 — из dev_settings
EMAIL_HOST_PASSWORD = _env('EMAIL_HOST_PASSWORD')
DEFAULT_FROM_EMAIL = _env('DEFAULT_FROM_EMAIL', EMAIL_HOST_USER)

# Студия реконструкции: RECON_SERVICE_URL и RECON_TOKEN уже прочитаны из окружения в dev_settings

try:
    from robotom.local_settings import *  # noqa: F401,F403
except ImportError:
    pass
