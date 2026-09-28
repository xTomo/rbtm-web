"""Прокси студии реконструкции к recon-service (rbtm-recon, пакет ``reconservice``).

Браузер ходит только в rbtm-web (``/studio/api/<path>``); сервис доступен лишь из докер-сети и доверяет запросам
с общим токеном. Права проверяет ``views.api_proxy`` (просмотр — ADM/EXP/RES, «запуск» — ADM/EXP) по правилу
белого списка, найденному ``match``; этот модуль — белый список и пересылка.

Белый список (метод, путь без ведущего «/», нужен ли «запуск»):

| Метод        | Путь                                                                  | Запуск |
|--------------|-----------------------------------------------------------------------|--------|
| GET          | ``health``                                                            | нет    |
| GET          | ``scans/<exp>/info|overview|envelope|thumbs|outside|sinogram``        | нет    |
| GET          | ``scans/<exp>/sample/<k>``                                            | нет    |
| POST         | ``sessions``                                                          | да     |
| GET, DELETE  | ``sessions/<sid>``                                                    | да     |
| POST         | ``sessions/<sid>/ping|load|load/cancel|axis/auto|axis/scan|axis/tilt|recipe|estimate`` | да |
| GET          | ``sessions/<sid>/slice|axis/diff|rings/preview|repositioning``        | да     |
| POST         | ``jobs``                                                              | да     |
| GET          | ``jobs``, ``jobs/<id>``, ``jobs/<id>/log``                            | нет    |
| POST         | ``jobs/<id>/cancel``                                                  | да     |
| GET          | ``results/<exp>``, ``results/<exp>/slice``, ``results/<exp>/file/<имя>`` | нет |

``<exp>`` — как ``auth.EXP_ID_RE`` сервиса (буквы, цифры, «.», «_», «-», без «..»), ``<sid>`` и ``<id>`` задачи —
32 шестнадцатеричные цифры (uuid4 hex), ``<имя>`` — один сегмент пути. Остальное (в том числе другой метод для
известного пути) — 404 JSON ``{"error": ...}``.

Пересылка: общий на процесс ``requests.Session`` (пул соединений), тот же метод, query как есть (с повторами
ключей), тело как есть со своим Content-Type, заголовки ``X-Recon-Token`` (``settings.RECON_TOKEN``) и
``X-Recon-User`` (имя пользователя rbtm-web; не ASCII — байты UTF-8), без сжатия (``Accept-Encoding: identity``,
чтобы ``Content-Length`` сервиса оставался верным). Ответ — потоком по 64 КиБ (файлы результата — десятки МБ) со
статусом сервиса как есть и заголовками ``Content-Type``, ``Content-Length``, ``Content-Disposition``,
``X-Shape``, ``X-Dtype``, ``X-Scale``, ``X-Offset``, ``X-Meta`` (см. ``reconservice.binary``), плюс
``Cache-Control: no-store``. Соединение с сервисом закрывается вместе с ответом Django.

Ошибки (JSON ``{"error": ...}``): не задан ``RECON_TOKEN`` или ``RECON_SERVICE_URL`` — 503 без обращения к
сервису; сервис недоступен — 502; не ответил за ``TIMEOUT`` — 504. Ответы 5xx прокси пишет в свой лог
(``storage_logger.reconstruction``) и помечает для Django как уже записанные: иначе ``django.request`` отправлял бы
письмо ``mail_admins`` на каждый опрос страницы, пока сервис лежит.
"""
import collections
import logging
import re
import threading
from urllib.parse import quote

import requests
from requests.adapters import HTTPAdapter

from django.conf import settings
from django.http import JsonResponse, StreamingHttpResponse
from django.http.request import RawPostDataException


logger = logging.getLogger('storage_logger.reconstruction')

TOKEN_HEADER = 'X-Recon-Token'
USER_HEADER = 'X-Recon-User'

#: (соединение, чтение) — чтение с запасом: загрузка обзора и оценки на большом скане идут десятки секунд
TIMEOUT = (5, 300)
CHUNK_SIZE = 64 * 1024

#: заголовки ответа сервиса, которые передаются браузеру
PASS_HEADERS = ('Content-Type', 'Content-Length', 'Content-Disposition',
                'X-Shape', 'X-Dtype', 'X-Scale', 'X-Offset', 'X-Meta')

#: exp_id — как ``auth.EXP_ID_RE`` сервиса; «..» запрещено и внутри (сегмент попадает в пути файлов)
EXP_ID = r'(?![^/]*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}'
#: id сессии и задачи — uuid4 hex
HEX_ID = r'[0-9a-f]{32}'
#: имя файла результата — один сегмент пути, не «.» и не «..»
FILE_NAME = r'(?!\.{1,2}\Z)[^/]+'

Rule = collections.namedtuple('Rule', 'method pattern run audit')
Rule.__doc__ = """Правило белого списка: метод, путь (регулярное выражение), нужен ли «запуск» (ADM/EXP),
писать ли запрос в лог (действия, меняющие состояние; частые опросы и превью не пишутся)."""


def _rule(method, pattern, run=False, audit=False):
    return Rule(method, re.compile(pattern.format(exp=EXP_ID, id=HEX_ID, name=FILE_NAME)), run, audit)


RULES = (
    _rule('GET', r'health'),
    _rule('GET', r'scans/{exp}/(?:info|overview|envelope|thumbs|outside|sinogram)'),
    _rule('GET', r'scans/{exp}/sample/[0-9]{{1,6}}'),

    _rule('POST', r'sessions', run=True, audit=True),
    _rule('GET', r'sessions/{id}', run=True),
    _rule('DELETE', r'sessions/{id}', run=True, audit=True),
    _rule('POST', r'sessions/{id}/(?:load|load/cancel)', run=True, audit=True),
    _rule('POST', r'sessions/{id}/(?:ping|axis/auto|axis/scan|axis/tilt|recipe|estimate)', run=True),
    _rule('GET', r'sessions/{id}/(?:slice|axis/diff|rings/preview|repositioning)', run=True),

    _rule('POST', r'jobs', run=True, audit=True),
    _rule('GET', r'jobs'),
    _rule('GET', r'jobs/{id}'),
    _rule('GET', r'jobs/{id}/log'),
    _rule('POST', r'jobs/{id}/cancel', run=True, audit=True),

    _rule('GET', r'results/{exp}'),
    _rule('GET', r'results/{exp}/slice'),
    _rule('GET', r'results/{exp}/file/{name}'),
)


def match(method, path):
    """Правило белого списка для запроса или None (запрос не поддерживается)."""
    for rule in RULES:
        if rule.method == method and rule.pattern.fullmatch(path):
            return rule
    return None


def _logged(response):
    # 5xx прокси уже записан в наш лог; флаг Django (django.utils.log.log_response) отключает повторную запись
    # в django.request, а с ней и письмо администраторам на каждый запрос
    if response.status_code >= 500:
        response._has_been_logged = True
    return response


def json_error(status, message):
    response = JsonResponse({'error': message}, status=status, json_dumps_params={'ensure_ascii': False})
    response['Cache-Control'] = 'no-store'
    return _logged(response)


_session = None
_session_lock = threading.Lock()


def _http():
    """Общий на процесс ``requests.Session``: соединения с сервисом переиспользуются (пул на потоки mod_wsgi)."""
    global _session
    with _session_lock:
        if _session is None:
            session = requests.Session()
            adapter = HTTPAdapter(pool_connections=2, pool_maxsize=16)
            session.mount('http://', adapter)
            session.mount('https://', adapter)
            _session = session
        return _session


class _Body:
    """Тело ответа сервиса потоком. ``close()`` вызывает WSGI-сервер по окончании ответа (в том числе при обрыве
    со стороны браузера) — соединение возвращается в пул, даже если тело не читалось."""

    def __init__(self, upstream):
        self._upstream = upstream

    def __iter__(self):
        try:
            for chunk in self._upstream.iter_content(CHUNK_SIZE):
                if chunk:
                    yield chunk
        except requests.RequestException as e:
            # статус уже отправлен: обрываем ответ, чтобы браузер не принял обрезанное тело за целое
            logger.error(u'Студия: обрыв ответа сервиса реконструкции {}: {}'.format(self._upstream.url, e))
            raise

    def close(self):
        self._upstream.close()


def _service_settings():
    return getattr(settings, 'RECON_SERVICE_URL', ''), getattr(settings, 'RECON_TOKEN', '')


def forward(request, path, rule):
    """Переслать запрос в recon-service и вернуть его ответ потоком (права уже проверены)."""
    base_url, token = _service_settings()
    if not token or not base_url:
        logger.error(u'Студия: не задан RECON_TOKEN или RECON_SERVICE_URL — запрос {} {} не отправлен'.format(
            request.method, path))
        return json_error(503, u'Студия реконструкции не настроена: в настройках rbtm-web не задан RECON_TOKEN '
                               u'(или RECON_SERVICE_URL)')

    username = request.user.get_username()
    headers = {
        TOKEN_HEADER: token,
        # http.client кодирует str в заголовках как latin-1 — имя не из ASCII передаём байтами UTF-8
        USER_HEADER: username.encode('utf-8'),
        'Accept-Encoding': 'identity',
    }
    data = None
    if request.method not in ('GET', 'HEAD'):
        try:
            data = request.body
        except RawPostDataException:
            # тело уже прочитано как multipart-форма — сервис такие не принимает
            return json_error(400, u'Неподдерживаемый формат тела запроса')
        if request.META.get('CONTENT_TYPE'):
            headers['Content-Type'] = request.META['CONTENT_TYPE']
    params = [(key, value) for key, values in request.GET.lists() for value in values]
    url = base_url.rstrip('/') + '/' + quote(path, safe='/')

    if rule.audit:
        logger.info(u'Студия: {} {} (пользователь {})'.format(request.method, path, username))
    try:
        upstream = _http().request(request.method, url, params=params, data=data, headers=headers,
                                   timeout=TIMEOUT, stream=True, allow_redirects=False)
    except requests.Timeout as e:
        logger.error(u'Студия: сервис реконструкции не ответил вовремя, {} {}: {}'.format(request.method, path, e))
        return json_error(504, u'Сервис реконструкции не ответил вовремя')
    except requests.RequestException as e:
        logger.error(u'Студия: сервис реконструкции недоступен, {} {}: {}'.format(request.method, path, e))
        return json_error(502, u'Сервис реконструкции недоступен')

    if upstream.status_code >= 500:
        logger.warning(u'Студия: сервис реконструкции ответил {} на {} {}'.format(
            upstream.status_code, request.method, path))

    response = StreamingHttpResponse(_Body(upstream), status=upstream.status_code,
                                     content_type=upstream.headers.get('Content-Type'))
    for name in PASS_HEADERS:
        value = upstream.headers.get(name)
        if value is not None:
            response[name] = value
    response['Cache-Control'] = 'no-store'
    return _logged(response)
