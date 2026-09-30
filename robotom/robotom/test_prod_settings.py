"""Production-настройки из git (robotom/settings.py) и перенос старого settings.py в .env (tools/settings_to_env.py).

Настройки импортируются в отдельном процессе: в тестовом процессе Django уже настроен на bamboo_settings."""
import json
import os
import subprocess
import sys
import tempfile
from unittest import TestCase

ROBOTOM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(ROBOTOM)
TOOL = os.path.join(REPO, 'tools', 'settings_to_env.py')

_DUMP = """
import json, robotom.settings as s
keys = ['DEBUG', 'SECRET_KEY', 'ALLOWED_HOSTS', 'CSRF_TRUSTED_ORIGINS', 'EMAIL_BACKEND', 'EMAIL_HOST_USER',
        'EMAIL_HOST_PASSWORD', 'DEFAULT_FROM_EMAIL', 'EMAIL_PORT', 'EMAIL_USE_TLS', 'PASSWORD_HASHERS',
        'EXPERIMENT_HOST', 'EXPERIMENT_SHUTTER_OPEN', 'STORAGE_HOST', 'STORAGE_EXPERIMENTS_GET_HOST',
        'RECON_SERVICE_URL', 'RECON_TOKEN', 'RECONSTRUCTION_URL', 'INSTALLED_APPS']
out = {k: getattr(s, k) for k in keys}
out['DB'] = {k: v for k, v in s.DATABASES['default'].items()}
print(json.dumps(out, default=list))
"""

_CLEAN = ('SECRET_KEY', 'EMAIL_HOST_PASSWORD', 'EMAIL_HOST_USER', 'DEFAULT_FROM_EMAIL', 'RECON_TOKEN',
          'RECON_SERVICE_URL', 'STORAGE_HOST', 'EXPERIMENT_HOST', 'RECONSTRUCTION_HOST', 'ALLOWED_HOSTS',
          'CSRF_TRUSTED_ORIGINS', 'DB_HOST', 'DB_PASSWORD', 'DB_NAME', 'DB_USER', 'DJANGO_DEBUG', 'DJANGO_SETTINGS_MODULE')


def _run(code, env_extra=None, args=(), stdin=None):
    env = {k: v for k, v in os.environ.items() if k not in _CLEAN}
    env.update(env_extra or {})
    env['PYTHONPATH'] = ROBOTOM
    return subprocess.run([sys.executable] + (['-c', code] if code else []) + list(args), env=env, cwd=ROBOTOM,
                          capture_output=True, text=True, timeout=120, stdin=stdin)


def _settings(env_extra=None):
    p = _run(_DUMP, env_extra)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


class ProdSettingsTests(TestCase):
    def test_defaults_and_secrets_from_env(self):
        s = _settings({'SECRET_KEY': 'k' * 50, 'EMAIL_HOST_PASSWORD': 'mail-pass', 'RECON_TOKEN': 't' * 43})
        self.assertFalse(s['DEBUG'])
        self.assertEqual(s['SECRET_KEY'], 'k' * 50)
        self.assertEqual(s['EMAIL_HOST_PASSWORD'], 'mail-pass')
        self.assertEqual(s['RECON_TOKEN'], 't' * 43)
        # SMTP явно: dev_settings при DEBUG ставит консольный бэкенд
        self.assertEqual(s['EMAIL_BACKEND'], 'django.core.mail.backends.smtp.EmailBackend')
        self.assertEqual(s['DEFAULT_FROM_EMAIL'], s['EMAIL_HOST_USER'])
        self.assertIn('django.contrib.auth.hashers.MD5PasswordHasher', s['PASSWORD_HASHERS'])
        # маршруты API построены от прод-адресов (dev_settings читает *_HOST из окружения)
        self.assertEqual(s['EXPERIMENT_HOST'], 'http://10.0.6.86:5001/')
        self.assertTrue(s['EXPERIMENT_SHUTTER_OPEN'].startswith('http://10.0.6.86:5001/tomograph/'))
        self.assertEqual(s['STORAGE_EXPERIMENTS_GET_HOST'], 'http://rbtmstorage_server_1:5006/storage/experiments/get')
        self.assertEqual(s['RECON_SERVICE_URL'], 'http://web_reconstructor_1:5560/')
        self.assertIn('tomox.ru', s['ALLOWED_HOSTS'])
        self.assertIn('reconstruction', s['INSTALLED_APPS'])
        self.assertEqual((s['DB']['HOST'], s['DB']['NAME'], s['DB']['PASSWORD']), ('database', 'robotom_users', 'postgres'))

    def test_env_overrides(self):
        s = _settings({'EXPERIMENT_HOST': 'http://10.0.0.5:5001/', 'ALLOWED_HOSTS': 'a.example, b.example',
                       'DB_HOST': 'db2', 'DJANGO_DEBUG': '1', 'EMAIL_HOST_USER': 'x@example.com'})
        self.assertTrue(s['EXPERIMENT_SHUTTER_OPEN'].startswith('http://10.0.0.5:5001/'))
        self.assertEqual(s['ALLOWED_HOSTS'], ['a.example', 'b.example'])
        self.assertEqual(s['DB']['HOST'], 'db2')
        self.assertTrue(s['DEBUG'])
        self.assertEqual(s['DEFAULT_FROM_EMAIL'], 'x@example.com')

    def test_missing_secret_key_does_not_break_import(self):
        # при сборке образа (collectstatic) .env нет — импорт настроек не должен падать
        s = _settings()
        self.assertEqual(s['SECRET_KEY'], '')


_OLD = """
from urllib.parse import urljoin
import os
DEBUG = False
SECRET_KEY = 'old-secret-key'
EMAIL_HOST_USER = 'robotomproject@gmail.com'
EMAIL_HOST_PASSWORD = 'old-mail-pass'
DEFAULT_FROM_EMAIL = 'robotomproject@gmail.com'
ALLOWED_HOSTS = ['109.234.38.83', 'tomox.ru', 'www.tomox.ru', 'localhost', 'nanotom', '10.0.7.153']
EXPERIMENT_HOST = 'http://10.0.6.99:5001/'
DATABASES = {'default': {'ENGINE': 'x', 'NAME': 'robotom_users', 'USER': 'postgres', 'PASSWORD': 'postgres',
                         'HOST': os.environ.get('DB_HOST', 'database'), 'PORT': ''}}
try:
    from robotom.local_settings import *
except BaseException:
    pass
"""


class SettingsToEnvTests(TestCase):
    def test_moves_secrets_and_changed_values_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.path.join(tmp, 'settings.py')
            with open(old, 'w', encoding='utf-8') as fh:
                fh.write(_OLD)
            p = _run(None, args=[TOOL, old])
        self.assertEqual(p.returncode, 0, p.stderr)
        lines = dict(l.split('=', 1) for l in p.stdout.splitlines() if l and not l.startswith('#'))
        self.assertEqual(lines, {'SECRET_KEY': 'old-secret-key', 'EMAIL_HOST_PASSWORD': 'old-mail-pass',
                                 'EXPERIMENT_HOST': 'http://10.0.6.99:5001/'})
        self.assertIn('записаны ключи: SECRET_KEY, EMAIL_HOST_PASSWORD, EXPERIMENT_HOST', p.stderr)
        self.assertNotIn('old-secret-key', p.stderr)

    def test_warns_about_risky_characters(self):
        with tempfile.TemporaryDirectory() as tmp:
            old = os.path.join(tmp, 'settings.py')
            with open(old, 'w', encoding='utf-8') as fh:
                fh.write(_OLD.replace("'old-secret-key'", "'a$b#c'"))
            p = _run(None, args=[TOOL, old])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('ВНИМАНИЕ: SECRET_KEY', p.stderr)
