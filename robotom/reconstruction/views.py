"""Студия реконструкции: страница эксперимента и прокси к recon-service (см. ``proxy``).

Права (роли — флаги ``main.UserProfile``, как ``experiment.views.has_experiment_access``):
- просмотр — страница, сканы, задачи, результаты, ``health`` — ADM/EXP/RES;
- «запуск» — интерактивная сессия и всё в ней, постановка и отмена задач — ADM/EXP.
Гость и пользователь без профиля или ролей — 403. Анонимный и неактивный: страница — перенаправление на вход
(как во всём сайте), API — 403 JSON (браузерный fetch не должен получать страницу входа вместо данных).
"""
import hashlib
import json
import logging
import os

import requests
from django.conf import settings
from django.contrib.auth.decorators import login_required, user_passes_test
from django.core.exceptions import PermissionDenied
from django.middleware.csrf import get_token
from django.shortcuts import render
from django.urls import NoReverseMatch, reverse
from django.views.decorators.cache import never_cache

from . import proxy


logger = logging.getLogger('storage_logger.reconstruction')

#: таймаут запроса документа эксперимента в storage, секунды
STORAGE_TIMEOUT = 10

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')


def _profile(user):
    if not user.is_authenticated or not user.is_active:
        return None
    # у пользователя без профиля (например, созданного createsuperuser) ролей нет
    return getattr(user, 'userprofile', None)


def can_view_studio(user):
    """Просмотр студии: ADM, EXP или RES."""
    profile = _profile(user)
    return bool(profile and (profile.is_admin or profile.is_experimentator or profile.is_researcher))


def can_run_studio(user):
    """Загрузка, интерактивная сессия, запуск и отмена задач: ADM или EXP."""
    profile = _profile(user)
    return bool(profile and (profile.is_admin or profile.is_experimentator))


def _is_active(user):
    return user.is_active


def compute_asset_version(static_dir=STATIC_DIR):
    """Короткий хэш содержимого статики студии: имена и байты всех файлов в порядке обхода."""
    digest = hashlib.sha1()
    for root, dirs, files in os.walk(static_dir):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            digest.update(os.path.relpath(path, static_dir).replace(os.sep, '/').encode('utf-8') + b'\0')
            with open(path, 'rb') as f:
                digest.update(f.read())
            digest.update(b'\0')
    return digest.hexdigest()[:10]


_asset_version = None


def asset_version():
    """Версия статики для ``?v=`` (Apache отдаёт JS с кэшем на год): считается один раз на процесс,
    при ``DEBUG`` — на каждый запрос, чтобы правки JS были видны без перезапуска."""
    global _asset_version
    if settings.DEBUG:
        return compute_asset_version()
    if _asset_version is None:
        _asset_version = compute_asset_version()
    return _asset_version


def _fetch_specimen(exp_id):
    """Название образца из документа эксперимента в storage; недоступность storage — не ошибка (None)."""
    try:
        answer = requests.post(settings.STORAGE_EXPERIMENTS_GET_HOST, json.dumps({"_id": exp_id}),
                               timeout=STORAGE_TIMEOUT)
        if answer.status_code != 200:
            logger.warning(u'Студия {}: storage ответил {}'.format(exp_id, answer.status_code))
            return None
        experiments = json.loads(answer.content)
    except (requests.RequestException, ValueError) as e:
        logger.warning(u'Студия {}: не удалось получить эксперимент из storage: {}'.format(exp_id, e))
        return None
    if isinstance(experiments, list) and experiments and isinstance(experiments[0], dict):
        return experiments[0].get('specimen') or None
    return None


def _storage_record_url(exp_id):
    # у страницы записи хранилища шаблон id уже, чем у студии (без «.» и «_»)
    try:
        return reverse('storage:storage_record', kwargs={'storage_record_id': exp_id})
    except NoReverseMatch:
        return None


@never_cache
@login_required
@user_passes_test(_is_active)
def studio_view(request, exp_id):
    if not can_view_studio(request.user):
        raise PermissionDenied
    specimen = _fetch_specimen(exp_id)
    studio_config = {
        'exp_id': exp_id,
        'api_base': reverse('reconstruction:api_root'),
        'can_run': can_run_studio(request.user),
        'user': request.user.get_username(),
        'specimen': specimen,
        'storage_url': _storage_record_url(exp_id),
        'legacy_url': settings.RECONSTRUCTION_URL.format(exp_id=exp_id),
        'full_volume_url': getattr(settings, 'RECON_FULL_VOLUME_URL', ''),
        'csrf_token': get_token(request),
    }
    return render(request, 'reconstruction/studio.html', {
        'caption': u'Студия реконструкции {}'.format(specimen or exp_id),
        'exp_id': exp_id,
        'studio_config': studio_config,
        'asset_version': asset_version(),
    })


def api_proxy(request, path):
    """``/studio/api/<path>`` → recon-service. CSRF — стандартный: фронтенд шлёт ``X-CSRFToken``."""
    user = request.user
    if not user.is_authenticated or not user.is_active:
        return proxy.json_error(403, u'Требуется вход в систему')
    if not can_view_studio(user):
        return proxy.json_error(403, u'Нет доступа к студии реконструкции: нужна роль исследователя, '
                                     u'экспериментатора или администратора')
    rule = proxy.match(request.method, path)
    if rule is None:
        return proxy.json_error(404, u'Запрос не поддерживается: {} /{}'.format(request.method, path))
    if rule.run and not can_run_studio(user):
        return proxy.json_error(403, u'Недостаточно прав: загрузка данных и запуск реконструкции доступны '
                                     u'экспериментатору и администратору')
    return proxy.forward(request, path, rule)
