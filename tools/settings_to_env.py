#!/usr/bin/env python3
"""Перенос значений из старого production settings.py (не из git) в .env для нового settings.py из git.

    python3 tools/settings_to_env.py <старый settings.py> >> .env

Печатает строки KEY=value: секреты (SECRET_KEY, EMAIL_HOST_PASSWORD) и те серверные значения, которые отличаются
от умолчаний нового robotom/robotom/settings.py. В терминал не печатает (чтобы секреты не остались в истории
экрана) — только в перенаправленный вывод; в stderr — имена записанных ключей и предупреждения. Django не нужен:
старый файл исполняется как обычный Python (``robotom.local_settings`` подменяется пустым модулем).
RECON_TOKEN в старом файле не было — его строка берётся из rbtm-recon/web/.env (см. .env.example)."""
import argparse
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROBOTOM = os.path.join(os.path.dirname(HERE), 'robotom')

#: значения, небезопасные в .env для docker-compose (v2 подставляет $…, v1 не снимает кавычки)
_RISKY = set('$"\'#\\ ')


def _load_old(path):
    sys.modules.setdefault('robotom.local_settings', types.ModuleType('robotom.local_settings'))
    ns = {'__file__': os.path.abspath(path), '__name__': 'old_settings'}
    with open(path, encoding='utf-8') as fh:
        exec(compile(fh.read(), path, 'exec'), ns)  # noqa: S102 — свой файл настроек
    return ns


def _load_new_defaults():
    """Умолчания нового settings.py: импорт при окружении без переопределений."""
    saved = {k: os.environ.pop(k) for k in list(os.environ) if k in _KEYS or k in _HOSTS}
    sys.path.insert(0, ROBOTOM)
    try:
        for name in ('robotom.settings', 'robotom.dev_settings'):
            sys.modules.pop(name, None)
        import importlib  # noqa: WPS433
        mod = importlib.import_module('robotom.settings')
        return {k: getattr(mod, k) for k in dir(mod) if k.isupper()}
    finally:
        sys.path.remove(ROBOTOM)
        for k in ('STORAGE_HOST', 'EXPERIMENT_HOST', 'RECONSTRUCTION_HOST', 'RECON_SERVICE_URL'):
            os.environ.pop(k, None)
        os.environ.update(saved)


#: (переменная .env, как достать из настроек)
_KEYS = {
    'SECRET_KEY': lambda s: s.get('SECRET_KEY'),
    'EMAIL_HOST_PASSWORD': lambda s: s.get('EMAIL_HOST_PASSWORD'),
    'EMAIL_HOST_USER': lambda s: s.get('EMAIL_HOST_USER'),
    'DEFAULT_FROM_EMAIL': lambda s: s.get('DEFAULT_FROM_EMAIL'),
    'EMAIL_HOST': lambda s: s.get('EMAIL_HOST'),
    'EMAIL_PORT': lambda s: s.get('EMAIL_PORT'),
    'EMAIL_USE_TLS': lambda s: s.get('EMAIL_USE_TLS'),
    'DB_NAME': lambda s: s['DATABASES']['default'].get('NAME'),
    'DB_USER': lambda s: s['DATABASES']['default'].get('USER'),
    'DB_PASSWORD': lambda s: s['DATABASES']['default'].get('PASSWORD'),
    'DB_HOST': lambda s: s['DATABASES']['default'].get('HOST'),
    'DB_PORT': lambda s: s['DATABASES']['default'].get('PORT'),
    'ALLOWED_HOSTS': lambda s: s.get('ALLOWED_HOSTS'),
    'CSRF_TRUSTED_ORIGINS': lambda s: s.get('CSRF_TRUSTED_ORIGINS'),
}
_HOSTS = ('STORAGE_HOST', 'EXPERIMENT_HOST', 'RECONSTRUCTION_HOST', 'STORAGE_PUBLIC_HOST')
_ALWAYS = ('SECRET_KEY', 'EMAIL_HOST_PASSWORD')


def _fmt(value):
    if isinstance(value, (list, tuple)):
        return ','.join(str(v) for v in value)
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return '' if value is None else str(value)


def build_lines(old, new):
    lines, notes = [], []
    for key, get in _KEYS.items():
        try:
            val = get(old)
        except (KeyError, TypeError):
            val = None
        if val is None:
            continue
        default = None
        try:
            default = get(new)
        except (KeyError, TypeError):
            pass
        if key not in _ALWAYS and _fmt(val) == _fmt(default):
            continue
        lines.append((key, _fmt(val)))
    for key in _HOSTS:
        if key in old and _fmt(old[key]) != _fmt(new.get(key)):
            lines.append((key, _fmt(old[key])))
    for key, val in lines:
        if set(val) & _RISKY:
            notes.append('{}: в значении есть символы {} — проверьте строку в .env (docker-compose v2 подставляет '
                         '$…; при необходимости сгенерируйте новое значение)'.format(
                             key, ''.join(sorted(set(val) & _RISKY))))
        if key in _ALWAYS and not val:
            notes.append('{}: в старом файле пусто — заполните вручную'.format(key))
    return lines, notes


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('old_settings', help='старый production settings.py')
    ap.add_argument('--force-tty', action='store_true', help='печатать в терминал (секреты будут видны)')
    args = ap.parse_args(argv)
    if sys.stdout.isatty() and not args.force_tty:
        print('Вывод содержит секреты — перенаправьте его в файл: python3 tools/settings_to_env.py {} >> .env'.format(
            args.old_settings), file=sys.stderr)
        return 2
    old = _load_old(args.old_settings)
    new = _load_new_defaults()
    lines, notes = build_lines(old, new)
    print('# перенесено из {} (tools/settings_to_env.py)'.format(os.path.basename(args.old_settings)))
    for key, val in lines:
        print('{}={}'.format(key, val))
    print('записаны ключи: ' + ', '.join(k for k, _ in lines), file=sys.stderr)
    for n in notes:
        print('ВНИМАНИЕ: ' + n, file=sys.stderr)
    print('Не забудьте RECON_TOKEN (тот же, что в rbtm-recon/web/.env) и chmod 600 .env', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
