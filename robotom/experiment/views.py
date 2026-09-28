from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.decorators import login_required, user_passes_test
from django.conf import settings
from django.urls import reverse
from django.contrib import messages
from django.contrib.messages import get_messages
from django.http import HttpResponse, JsonResponse

from .models import Tomograph
from requests.exceptions import Timeout
from functools import wraps
from robotom.utils import force_https

import base64
import io
import logging
import requests
import os
import json
import uuid
import time
import datetime

import numpy as np

experiment_logger = logging.getLogger('experiment_logger')

GET_VOLT = 'get-voltage'
GET_CURR = 'get-current'
GET_VERT = 'get-vertical-position'
GET_HOR = 'get-horizontal-position'
GET_ANGL = 'get-angle-position'
GET_SHUT = 'get-shutter-state'
GET_DETECTOR_MODEL = 'get-detector-model'

TOMO_NUM = getattr(settings, 'TOMO_NUM', 1)

_EXPERIMENT_HOST = getattr(settings, 'EXPERIMENT_HOST', 'http://localhost:5001/')
_detector_model_url_tpl = getattr(
    settings,
    'EXPERIMENT_DETECTOR_GET_MODEL',
    _EXPERIMENT_HOST.rstrip('/') + '/tomograph/{}/detector/model',
)
_experiment_get_status_tpl = getattr(
    settings,
    'EXPERIMENT_GET_STATUS',
    _EXPERIMENT_HOST.rstrip('/') + '/tomograph/{}/experiment/status',
)

remote_url_settings = {
        GET_VOLT: settings.EXPERIMENT_SOURCE_GET_VOLT.format(TOMO_NUM),
        GET_CURR: settings.EXPERIMENT_SOURCE_GET_CURR.format(TOMO_NUM),
        GET_VERT: settings.EXPERIMENT_MOTOR_GET_VERT.format(TOMO_NUM),
        GET_HOR: settings.EXPERIMENT_MOTOR_GET_HORIZ.format(TOMO_NUM),
        GET_ANGL: settings.EXPERIMENT_MOTOR_GET_ANGLE.format(TOMO_NUM),
        GET_SHUT: settings.EXPERIMENT_SHUTTER_GET_STATUS.format(TOMO_NUM),
        GET_DETECTOR_MODEL: _detector_model_url_tpl.format(TOMO_NUM),
    }

tomo_path = '../tomograph/{}/'

local_url_settings = {
        'get_voltage_url': tomo_path.format(GET_VOLT),
        'get_current_url': tomo_path.format(GET_CURR),
        'get_vert_url': tomo_path.format(GET_VERT),
        'get_horiz_url': tomo_path.format(GET_HOR),
        'get_angle_url': tomo_path.format(GET_ANGL),
        'get_shutter_url': tomo_path.format(GET_SHUT),
        'get_detector_model_url': tomo_path.format(GET_DETECTOR_MODEL),
    }


def has_experiment_access(user):
    return user.userprofile.is_admin or user.userprofile.is_experimentator


def info_once_only(request, msg):
    storage = get_messages(request)
    if msg not in [m.message for m in storage]:
        messages.info(request, msg)


def _format_backend_error(status_code, content):
    """Пытается извлечь текст ошибки из JSON-тела ответа drivers ({success, error, 'exception message'}).

    Если тело не JSON (например, страница ошибки Werkzeug при HTTP 500),
    возвращает общее сообщение о некорректном ответе, не пытаясь распарсить HTML как JSON.
    """
    try:
        data = json.loads(content)
    except (ValueError, TypeError):
        return u'Модуль "Эксперимент" вернул некорректный ответ (HTTP {})'.format(status_code)

    error = data.get('error') if isinstance(data, dict) else None
    exc_msg = data.get('exception message') if isinstance(data, dict) else None
    if error:
        if exc_msg:
            return u'Модуль "Эксперимент": {} ({})'.format(error, exc_msg)
        return u'Модуль "Эксперимент": {}'.format(error)
    return u'Модуль "Эксперимент" завершил работу с кодом ошибки {}'.format(status_code)


def try_request_post(request, address, content, source_page, stream=False):
    result = {'response_dict': None, 'error': None}
    try:
        answer = requests.post(address, content, timeout=settings.TIMEOUT_DEFAULT, stream=stream)
    except Timeout as e:
        messages.warning(request, 'Нет ответа от модуля "Эксперимент".')
        experiment_logger.error(e)
        result['error'] = redirect(reverse(source_page))
        return result
    except requests.RequestException as e:
        experiment_logger.error(e)
        messages.warning(request,
                         '''Ошибка связи с модулем "Эксперимент", невозможно сохранить данные.
                         Возможно, отсутствует подключение к сети.
                         Попробуйте снова через некоторое время или свяжитесь с администратором''')
        result['error'] = redirect(reverse(source_page))
        return result

    if answer.status_code != 200:
        msg = _format_backend_error(answer.status_code, answer.content)
        messages.warning(request, msg)
        experiment_logger.error(msg)
        result['error'] = redirect(reverse(source_page))
        return result

    try:
        result['response_dict'] = json.loads(answer.content)
    except ValueError as e:
        experiment_logger.error(e)
        msg = u'Модуль "Эксперимент" вернул некорректный ответ (HTTP {})'.format(answer.status_code)
        messages.warning(request, msg)
        result['error'] = redirect(reverse(source_page))

    return result


def try_request_get(request, address, source_page=''):
    result = {'response_dict': None, 'error': None}

    def _fail(msg):
        messages.warning(request, msg)
        if source_page:
            result['error'] = redirect(reverse(source_page))
        else:
            result['error'] = msg

    try:
        answer = requests.get(address, timeout=settings.TIMEOUT_DEFAULT)
    except Timeout as e:
        experiment_logger.error(e)
        _fail('Нет ответа от модуля "Эксперимент"')
        return result
    except requests.RequestException as e:
        experiment_logger.error(e)
        _fail('''Ошибка связи с модулем "Эксперимент", невозможно сохранить данные.
                                Возможно, отсутствует подключение к сети.
                                Попробуйте снова через некоторое время или свяжитесь с администратором''')
        return result

    if answer.status_code != 200:
        msg = _format_backend_error(answer.status_code, answer.content)
        experiment_logger.error(msg)
        _fail(msg)
        return result

    try:
        result['response_dict'] = json.loads(answer.content)
    except ValueError as e:
        experiment_logger.error(e)
        _fail(u'Модуль "Эксперимент" вернул некорректный ответ (HTTP {})'.format(answer.status_code))

    return result


def check_result(result, request, tomo, success_msg=''):

    response_dict = result['response_dict']

    if response_dict['success']:
        if success_msg:
            messages.success(request, success_msg)
        tomo.save()
    else:
        experiment_logger.error(u'Модуль "Эксперимент" работает некорректно в данный момент. Попробуйте позже {}'.format(
                    response_dict['error']))
        messages.warning(request,
            u'Модуль "Эксперимент" работает некорректно в данный момент. Попробуйте позже {}'.format(response_dict['error']))


def set_current_state_msg(request, tomo):
    if tomo.state == 'unavailable':
        info_once_only(request, u'Текущее состояние томографа: недоступен')
    elif tomo.state == 'ready':
        info_once_only(request, u'Текущее состояние томографа: ожидание')
    elif tomo.state == 'experiment':
        info_once_only(request, u'Текущее состояние томографа: эксперимент')


def get_current_state(request, tomo):
    try:
        result = try_request_get(request, settings.EXPERIMENT_GET_STATE.format(TOMO_NUM))
        if result['error']:
            tomo.state = 'unavailable'
        else:
            response_dict = result['response_dict']
            tomo.state = response_dict['result']
    except Exception as e:
        tomo.state = 'unavailable'
    tomo.save()


def is_ajax(request):
    return request.headers.get('X-Requested-With') == 'XMLHttpRequest'


def _split_tags(raw_tags):
    """Разбивает теги эксперимента на список строк. Storage допускает как
    строку "тег1, тег2", так и список строк (каждая из которых сама может
    содержать запятые) — см. storage.views.ExperimentRecord."""
    if not raw_tags:
        return []
    if isinstance(raw_tags, (list, tuple)):
        parts = []
        for item in raw_tags:
            parts.extend(str(item).split(','))
    else:
        parts = str(raw_tags).split(',')
    return [t.strip() for t in parts if t.strip()]


def update_state_before_run(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        tomo = get_object_or_404(Tomograph, pk=1)
        get_current_state(request, tomo)
        set_current_state_msg(request, tomo)
        result = view(request, *args, **kwargs)
        return result
    return wrapped


@login_required
@user_passes_test(has_experiment_access)
def experiment_view(request):
    return redirect(reverse('experiment:index_interface'))


@login_required
@user_passes_test(has_experiment_access)
def experiment_source_state(request):
    """Прокси к Flask /source/state — возвращает JSON состояния источника.

    Успех (HTTP 200): {"available": true, "on": bool, "busy": bool, "mocked": bool}
      mocked=True означает, что источник работает в режиме заглушки
      (физически не подключён). В этом случае UI блокирует кнопки управления
      и показывает статус «Не управляется».

    Ошибка (HTTP 502) — drivers недоступны, ответили не-200 или вернули
    невалидный/не-объектный JSON: {"available": false, "error": "<текст>"}.
    """
    try:
        answer = requests.get(
            settings.EXPERIMENT_SOURCE_GET_STATE.format(TOMO_NUM),
            timeout=settings.TIMEOUT_DEFAULT,
        )
        if answer.status_code != 200:
            msg = _format_backend_error(answer.status_code, answer.content)
            experiment_logger.error(u'Ошибка получения состояния источника: {}'.format(msg))
            return JsonResponse({'available': False, 'error': msg}, status=502)

        data = json.loads(answer.content)
        if not isinstance(data, dict):
            msg = u'Некорректный ответ drivers (ожидался JSON-объект, получено {})'.format(type(data).__name__)
            experiment_logger.error(u'Ошибка получения состояния источника: {}'.format(msg))
            return JsonResponse({'available': False, 'error': msg}, status=502)
        result = data.get('result', {}) or {}
        return JsonResponse({
            'available': True,
            'on': bool(result.get('on', False)),
            'busy': bool(result.get('busy', False)),
            'mocked': bool(result.get('mocked', False)),
            'warming_status': result.get('warming_status'),
        })
    except (requests.RequestException, ValueError) as e:
        experiment_logger.error(u'Ошибка получения состояния источника: {}'.format(e))
        return JsonResponse({'available': False, 'error': str(e)}, status=502)


@update_state_before_run
@login_required
@user_passes_test(has_experiment_access)
def experiment_control(request):
    """Страница управления томографом: включение/выключение источника + панель узлов."""

    js_urls = {k: request.build_absolute_uri(v) for k, v in local_url_settings.items()}

    host = request.get_host()
    prod = ('127.0.0.1' not in host) and ('localhost' not in host)
    if prod:
        js_urls = {k: force_https(v) for k, v in js_urls.items()}

    js_url_settings = json.dumps(js_urls)

    tomo = get_object_or_404(Tomograph, pk=1)
    result = None
    success_msg = ''
    source_page = 'experiment:index_control'

    if request.method == 'POST':
        if 'source_on' in request.POST:
            result = try_request_get(request, settings.EXPERIMENT_SOURCE_POWER_ON.format(TOMO_NUM), source_page)
            success_msg = u'Команда включения источника отправлена'

        if 'source_off' in request.POST:
            result = try_request_get(request, settings.EXPERIMENT_SOURCE_POWER_OFF.format(TOMO_NUM), source_page)
            success_msg = u'Источник выключен'

        if 'move_hor_submit' in request.POST:
            info = json.dumps(int(request.POST['move_hor']))
            result = try_request_post(request, settings.EXPERIMENT_MOTOR_SET_HORIZ.format(TOMO_NUM), info, source_page)
            success_msg = u'Горизонтальное положение образца изменено'

        if 'move_ver_submit' in request.POST:
            info = json.dumps(int(request.POST['move_ver']))
            result = try_request_post(request, settings.EXPERIMENT_MOTOR_SET_VERT.format(TOMO_NUM), info, source_page)
            success_msg = u'Вертикальное положение образца изменено'

        if 'rotate_submit' in request.POST:
            info = json.dumps(float(request.POST['rotate']))
            result = try_request_post(request, settings.EXPERIMENT_MOTOR_SET_ANGLE.format(TOMO_NUM), info, source_page)
            success_msg = u'Образец повернут'

        if 'reset_submit' in request.POST:
            result = try_request_get(request, settings.EXPERIMENT_MOTOR_RESET_ANGLE.format(TOMO_NUM), source_page)
            success_msg = u'Текущий угол поворота принят за 0'

        if 'text_gate' in request.POST:
            if request.POST.get('gate_state', None) == 'open':
                result = try_request_get(request, settings.EXPERIMENT_SHUTTER_OPEN.format(TOMO_NUM), source_page)
                success_msg = u'Заслонка открыта'
            elif request.POST.get('gate_state', None) == 'close':
                result = try_request_get(request, settings.EXPERIMENT_SHUTTER_CLOSE.format(TOMO_NUM), source_page)
                success_msg = u'Заслонка закрыта'

        if 'experiment_on_voltage' in request.POST:
            info = json.dumps(float(request.POST['voltage']))
            result = try_request_post(request, settings.EXPERIMENT_SOURCE_SET_VOLT.format(TOMO_NUM), info, source_page)
            success_msg = u'Напряжение установлено'

        if 'experiment_on_current' in request.POST:
            info = json.dumps(float(request.POST['current']))
            result = try_request_post(request, settings.EXPERIMENT_SOURCE_SET_CURR.format(TOMO_NUM), info, source_page)
            success_msg = u'Сила тока установлена'

        if 'picture_exposure_submit' in request.POST:
            exposure_sec = request.POST.get('picture_exposure', '')
            return render(request, 'experiment/control.html', {
                'caption': 'Управление томографом',
                'preview': True,
                'exposure_sec': exposure_sec,
                'tomograph': tomo,
                'js_url_settings': js_url_settings,
            })

    if result:
        if is_ajax(request):
            if result['error']:
                error_messages = [str(m) for m in get_messages(request)]
                msg = error_messages[-1] if error_messages else 'Ошибка выполнения команды'
                return JsonResponse({'success': False, 'message': msg})
            response_dict = result['response_dict']
            if response_dict and response_dict.get('success'):
                tomo.save()
                return JsonResponse({'success': True, 'message': success_msg})
            else:
                err_detail = (response_dict or {}).get('error', '')
                msg = 'Ошибка: {}'.format(err_detail) if err_detail else 'Ошибка выполнения команды'
                return JsonResponse({'success': False, 'message': msg})
        else:
            if result['error']:
                return result['error']
            check_result(result, request, tomo, success_msg)

    return render(request, 'experiment/control.html', {
        'caption': 'Управление томографом',
        'tomograph': tomo,
        'js_url_settings': js_url_settings,
    })


@update_state_before_run
@login_required
@user_passes_test(has_experiment_access)
def experiment_adjustment(request):

    js_urls = {k: request.build_absolute_uri(v) for k, v in local_url_settings.items()}

    # force https в URL — костыль, пока build_absolute_uri не возвращает корректный протокол
    host = request.get_host()
    prod = ('127.0.0.1' not in host) and ('localhost' not in host)
    if prod:
        js_urls = {k: force_https(v) for k, v in js_urls.items()}

    js_url_settings = json.dumps(js_urls)

    tomo = get_object_or_404(Tomograph, pk=1)
    result = None
    success_msg = ''
    source_page = 'experiment:index_adjustment'

    if request.method == 'POST':
        if 'move_hor_submit' in request.POST:
            info = json.dumps(int(request.POST['move_hor']))
            result = try_request_post(request, settings.EXPERIMENT_MOTOR_SET_HORIZ.format(TOMO_NUM), info, source_page)
            success_msg = u'Горизонтальное положение образца изменено'

        if 'move_ver_submit' in request.POST:
            info = json.dumps(int(request.POST['move_ver']))
            result = try_request_post(request, settings.EXPERIMENT_MOTOR_SET_VERT.format(TOMO_NUM), info, source_page)
            success_msg = u'Вертикальное положение образца изменено'

        if 'rotate_submit' in request.POST:
            info = json.dumps(float(request.POST['rotate']))
            result = try_request_post(request, settings.EXPERIMENT_MOTOR_SET_ANGLE.format(TOMO_NUM), info, source_page)
            success_msg = u'Образец повернут'

        if 'reset_submit' in request.POST:
            result = try_request_get(request, settings.EXPERIMENT_MOTOR_RESET_ANGLE.format(TOMO_NUM), source_page)
            success_msg = u'Текущий угол поворота принят за 0'

        if 'text_gate' in request.POST:
            if request.POST.get('gate_state', None) == 'open':
                result = try_request_get(request, settings.EXPERIMENT_SHUTTER_OPEN.format(TOMO_NUM), source_page)
                success_msg = u'Заслонка открыта'

            elif request.POST.get('gate_state', None) == 'close':
                result = try_request_get(request, settings.EXPERIMENT_SHUTTER_CLOSE.format(TOMO_NUM), source_page)
                success_msg = u'Заслонка закрыта'

        if 'experiment_on_voltage' in request.POST:
            info = json.dumps(float(request.POST['voltage']))
            result = try_request_post(request, settings.EXPERIMENT_SOURCE_SET_VOLT.format(TOMO_NUM), info, source_page)
            success_msg = u'Напряжение установлено'

        if 'experiment_on_current' in request.POST:
            info = json.dumps(float(request.POST['current']))
            result = try_request_post(request, settings.EXPERIMENT_SOURCE_SET_CURR.format(TOMO_NUM), info, source_page)
            success_msg = u'Сила тока установлена'

        if 'picture_exposure_submit' in request.POST:
            exposure_sec = request.POST.get('picture_exposure', '')
            return render(request, 'experiment/adjustment.html', {
                'caption': 'Эксперимент',
                'preview': True,
                'exposure_sec': exposure_sec,
                'tomograph': tomo,
                'js_url_settings': js_url_settings,
            })

    if result:
        if is_ajax(request):
            if result['error']:
                error_messages = [str(m) for m in get_messages(request)]
                msg = error_messages[-1] if error_messages else 'Ошибка выполнения команды'
                return JsonResponse({'success': False, 'message': msg})
            response_dict = result['response_dict']
            if response_dict and response_dict.get('success'):
                tomo.save()
                return JsonResponse({'success': True, 'message': success_msg})
            else:
                err_detail = (response_dict or {}).get('error', '')
                msg = 'Ошибка: {}'.format(err_detail) if err_detail else 'Ошибка выполнения команды'
                return JsonResponse({'success': False, 'message': msg})
        else:
            if result['error']:
                return result['error']
            check_result(result, request, tomo, success_msg)

    return render(request, 'experiment/adjustment.html', {
        'caption': 'Эксперимент',
        'tomograph': tomo,
        'js_url_settings': js_url_settings,
    })


@login_required
@user_passes_test(has_experiment_access)
def experiment_interface(request):

    tomo = get_object_or_404(Tomograph, pk=1)
    result = None
    success_msg = ''
    source_page = 'experiment:index_interface'

    if request.method == 'POST':

        if 'parameters' in request.POST:
            is_advanced = request.POST.get('mode') == 'advanced'

            try:
                exp_id = uuid.uuid4()
                timestamp = time.time()
                current_datetime = datetime.datetime.now().strftime("%d.%m.%Y %H:%M:%S")
                specimen = request.POST['name']
                tags = request.POST['tags']

                if is_advanced:
                    # Продвинутый режим: единая экспозиция, series_length, empty_period.
                    # В шаблоне поля обоих режимов используют одинаковые name, но
                    # неактивный набор отключён (disabled) через JS и не попадает в POST,
                    # поэтому request.POST[...] всегда берёт значение активного режима.
                    exposure_ms = float(request.POST['exposure_sec']) * 1000.0
                    series_length = int(float(request.POST.get('series_length', 10)))
                    empty_period = int(float(request.POST.get('empty_period', 50)))
                    data_count_per_step = int(float(request.POST.get('data_same', 1)))
                    data_total = int(float(request.POST['data_shots_quantity']))
                    data_angle_step = float(request.POST['data_angle'])

                    experiment_data = json.dumps({
                        'exp_id': str(exp_id),
                        'specimen': specimen,
                        'tags': tags,
                        'timestamp': timestamp,
                        'datetime': current_datetime,
                        'experiment parameters': {
                            'advanced': True,
                            'exposure': exposure_ms,
                            'series_length': series_length,
                            'data_total': data_total,
                            'data_angle_step': data_angle_step,
                            'data_count_per_step': data_count_per_step,
                            'empty_period': empty_period,
                        }
                    })
                else:
                    # Простой режим: одинаковая экспозиция и кол-во для dark/empty
                    de_count = int(float(request.POST['de_quantity']))
                    exposure_ms = float(request.POST['exposure_sec']) * 1000.0
                    data_step_count = int(float(request.POST['data_shots_quantity']))
                    data_angle_step = float(request.POST['data_angle'])
                    data_count_per_step = int(float(request.POST.get('data_same', 1)))

                    experiment_data = json.dumps({
                        'exp_id': str(exp_id),
                        'specimen': specimen,
                        'tags': tags,
                        'timestamp': timestamp,
                        'datetime': current_datetime,
                        'experiment parameters': {
                            'advanced': False,
                            'DARK': {
                                'count': de_count,
                                'exposure': exposure_ms,
                            },
                            'EMPTY': {
                                'count': de_count,
                                'exposure': exposure_ms,
                            },
                            'DATA': {
                                'step count': data_step_count,
                                'exposure': exposure_ms,
                                'angle step': data_angle_step,
                                'count per step': data_count_per_step,
                            }
                        }
                    })
            except (ValueError, KeyError) as e:
                # Некорректные/отсутствующие поля формы (например, exposure_sec='')
                experiment_logger.error(u'Некорректные параметры эксперимента: {}'.format(e))
                messages.error(request, u'Некорректно заполнена форма параметров эксперимента. Проверьте введённые значения.')
                return redirect(reverse(source_page))

            result = try_request_post(request, settings.EXPERIMENT_START.format(TOMO_NUM), experiment_data, source_page)
            success_msg = u'Эксперимент успешно начался'

        if 'turn_down' in request.POST:
            result = try_request_get(request, settings.EXPERIMENT_STOP.format(TOMO_NUM), source_page)
            success_msg = u'Эксперимент окончен'

    if result:
        if result['error']:
            return result['error']
        check_result(result, request, tomo, success_msg)

    get_current_state(request, tomo)
    set_current_state_msg(request, tomo)
    return render(request, 'experiment/interface.html', {
        'caption': 'Эксперимент',
        'tomograph': tomo,
    })


@login_required
@user_passes_test(has_experiment_access)
def experiment_status(request):
    """Прокси к Flask /experiment/status — возвращает JSON статуса эксперимента."""
    try:
        answer = requests.get(
            _experiment_get_status_tpl.format(TOMO_NUM),
            timeout=settings.TIMEOUT_DEFAULT,
        )
        return HttpResponse(
            content=answer.content,
            status=answer.status_code,
            content_type='application/json',
        )
    except Exception as e:
        experiment_logger.error(u'Ошибка получения статуса эксперимента: {}'.format(e))
        return JsonResponse({'success': False, 'error': str(e)}, status=502)


@login_required
@user_passes_test(has_experiment_access)
def experiment_storage_preview(request):
    """
    GET ?exp_id=<uuid> → возвращает URL последнего PNG кадра из Storage.
    Скачивает и кеширует PNG через тот же механизм что frames_downloading.
    """
    import os
    import tempfile
    from django.core.files.storage import default_storage

    exp_id = request.GET.get('exp_id', '').strip()
    if not exp_id:
        return JsonResponse({'success': False, 'error': 'exp_id required'}, status=400)

    try:
        # Получаем список кадров эксперимента из Storage
        frame_info = json.dumps({'exp_id': exp_id})
        frames_resp = requests.post(
            settings.STORAGE_FRAMES_INFO_HOST,
            frame_info,
            timeout=settings.TIMEOUT_DEFAULT,
        )
        if frames_resp.status_code != 200:
            return JsonResponse({'success': False, 'error': 'storage error {}'.format(frames_resp.status_code)}, status=502)

        frames_info = json.loads(frames_resp.content)
        if not frames_info:
            return JsonResponse({'success': False, 'error': 'no frames yet'})

        # Берём последний кадр (storage отдаёт по порядку)
        last_frame = frames_info[-1]
        if '$oid' in last_frame.get('_id', {}):
            frame_id = str(last_frame['_id']['$oid'])
        else:
            frame_id = str(last_frame.get('_id', ''))

        if not frame_id:
            return JsonResponse({'success': False, 'error': 'bad frame id'})

        file_name = frame_id + '.png'
        media_path = os.path.join(settings.MEDIA_ROOT, file_name)
        media_url = settings.MEDIA_URL + file_name

        # Скачиваем если ещё нет в кеше
        if not os.path.exists(media_path):
            png_url = settings.STORAGE_FRAMES_PNG.format(exp_id=exp_id, frame_id=frame_id)
            frame_response = requests.get(png_url, timeout=settings.TIMEOUT_DEFAULT, stream=True)
            if frame_response.status_code == 200:
                temp_file = tempfile.TemporaryFile()
                for block in frame_response.iter_content(1024 * 8):
                    if block:
                        temp_file.write(block)
                default_storage.save(file_name, temp_file)
            else:
                return JsonResponse({'success': False, 'error': 'could not download frame png'}, status=502)

        return JsonResponse({'success': True, 'url': media_url, 'frame_id': frame_id})

    except Exception as e:
        experiment_logger.error(u'Ошибка storage-preview: {}'.format(e))
        return JsonResponse({'success': False, 'error': str(e)}, status=502)


@login_required
@user_passes_test(has_experiment_access)
def get_autocomplete_data(request):
    """Возвращает уникальные/недавние имена образцов, теги и параметры последнего эксперимента."""
    specimens = []
    tags = []
    recent_specimens = []
    recent_tags = []
    last_params = None
    try:
        answer = requests.post(
            settings.STORAGE_EXPERIMENTS_GET_HOST,
            json.dumps({}),
            timeout=settings.TIMEOUT_DEFAULT
        )
        if answer.status_code == 200:
            experiments = json.loads(answer.content)
            seen_specimens = set()
            seen_tags = set()
            seen_recent_specimens = []
            seen_recent_tags = []

            for exp in experiments:
                specimen = exp.get('specimen', '').strip()
                if specimen:
                    seen_specimens.add(specimen)
                    if specimen not in seen_recent_specimens:
                        seen_recent_specimens.append(specimen)

                for t in _split_tags(exp.get('tags', '')):
                    seen_tags.add(t)
                    if t not in seen_recent_tags:
                        seen_recent_tags.append(t)

            specimens = sorted(seen_specimens)
            tags = sorted(seen_tags)
            recent_specimens = seen_recent_specimens[:20]
            recent_tags = seen_recent_tags[:30]

            # Параметры последнего эксперимента
            if experiments:
                last_exp = experiments[0]
                try:
                    ep = last_exp.get('experiment parameters', {})
                    is_adv = ep.get('advanced', False)

                    if is_adv:
                        # Продвинутый режим: плоская структура
                        exp_ms = ep.get('exposure', 0)
                        exp_sec = round(exp_ms / 1000.0, 3) if exp_ms else ''
                        last_params = {
                            'advanced': True,
                            'exposure_sec': exp_sec,
                            'series_length': ep.get('series_length', 10),
                            'data_step_count': ep.get('data_total', ''),
                            'data_angle_step': ep.get('data_angle_step', ''),
                            'data_count_per_step': ep.get('data_count_per_step', 1),
                            'empty_period': ep.get('empty_period', 50),
                            # Для совместимости при переключении в простой режим
                            'dark_count': ep.get('series_length', ''),
                            'dark_exposure_sec': exp_sec,
                            'empty_count': ep.get('series_length', ''),
                            'empty_exposure_sec': exp_sec,
                            'data_exposure_sec': exp_sec,
                        }
                    else:
                        # Простой режим: структура DARK/EMPTY/DATA
                        dark = ep.get('DARK', {})
                        empty = ep.get('EMPTY', {})
                        data = ep.get('DATA', {})
                        dark_exp_sec = round(dark.get('exposure', 0) / 1000.0, 3) if dark.get('exposure') else ''
                        last_params = {
                            'advanced': False,
                            'dark_count': dark.get('count', ''),
                            'dark_exposure_sec': dark_exp_sec,
                            'empty_count': empty.get('count', ''),
                            'empty_exposure_sec': round(empty.get('exposure', 0) / 1000.0, 3) if empty.get('exposure') else '',
                            'data_step_count': data.get('step count', ''),
                            'data_exposure_sec': round(data.get('exposure', 0) / 1000.0, 3) if data.get('exposure') else '',
                            'data_angle_step': data.get('angle step', ''),
                            'data_count_per_step': data.get('count per step', 1),
                            # Для совместимости при переключении в продвинутый режим
                            'exposure_sec': dark_exp_sec,
                            'series_length': dark.get('count', 10),
                            'empty_period': 50,
                        }
                except Exception as e:
                    experiment_logger.error(u'Ошибка разбора параметров последнего эксперимента: {}'.format(e))

    except Exception as e:
        experiment_logger.error(u'Ошибка получения данных автодополнения: {}'.format(e))

    return JsonResponse({
        'specimens': specimens,
        'tags': tags,
        'recent_specimens': recent_specimens,
        'recent_tags': recent_tags,
        'last_params': last_params,
    })


# Коэффициент прореживания кадра по умолчанию (целочисленный, передаётся детектору)
PREVIEW_DOWNSAMPLE = 4


@login_required
@user_passes_test(has_experiment_access)
def get_preview_data(request):
    """
    POST {exposure_sec, downsample?} → запрашивает кадр у детектора
    (детектор делает ресайз и медианную фильтрацию),
    возвращает uint16-данные как base64-строку для быстрого декодирования
    в браузере через Uint16Array.
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
        exposure_sec = float(body.get('exposure_sec', 1.0))
        downsample = int(body.get('downsample', PREVIEW_DOWNSAMPLE))
    except (ValueError, KeyError, json.JSONDecodeError):
        return JsonResponse({'error': 'bad request'}, status=400)

    exposure_ms = exposure_sec * 1000.0
    detector_payload = json.dumps({'exposure_ms': exposure_ms, 'downsample': downsample})

    t0 = time.time()
    try:
        # drivers ждут кадр 2*exposure_ms/1000 + 30 с; берём то же значение как таймаут запроса
        response = requests.post(
            settings.EXPERIMENT_DETECTOR_GET_FRAME_PREVIEW.format(TOMO_NUM),
            detector_payload,
            stream=True,
            timeout=max(settings.TIMEOUT_DEFAULT, 2 * exposure_sec + 30),
        )
        raw = b''.join(response.iter_content(1024 * 8))

        if response.status_code == 409:
            # На этом томографе уже идёт эксперимент — пробрасываем ошибку как есть
            err_msg = 'On this tomograph experiment is running'
            try:
                err_data = json.loads(raw)
                err_msg = err_data.get('error', err_msg)
            except ValueError:
                pass
            experiment_logger.error(u'Не удалось получить кадр: {}'.format(err_msg))
            return JsonResponse({'error': err_msg}, status=409)

        if response.status_code != 200:
            experiment_logger.error(
                u'Не удалось получить кадр, код: {}'.format(response.status_code)
            )
            return JsonResponse({'error': 'detector error {}'.format(response.status_code)}, status=502)
    except requests.RequestException as e:
        experiment_logger.error(u'Ошибка получения кадра: {}'.format(e))
        return JsonResponse({'error': str(e)}, status=502)

    t1 = time.time()
    experiment_logger.info(u'preview: detector request+transfer {:.2f}s, raw={} bytes'.format(
        t1 - t0, len(raw)))

    # Загружаем npz-данные от детектора (уже ресайз + медиана, uint16)
    try:
        npz = np.load(io.BytesIO(raw))
        arr = npz['data']  # uint16, shape (h, w)
        new_h, new_w = int(arr.shape[0]), int(arr.shape[1])
    except Exception as e:
        experiment_logger.error(u'Ошибка декодирования npz: {}'.format(e))
        return JsonResponse({'error': 'npz decode error: {}'.format(str(e))}, status=502)

    t2 = time.time()
    arr_uint16 = arr.astype(np.uint16)
    arr_min = int(arr_uint16.min())
    arr_max = int(arr_uint16.max())

    # Передаём сырые uint16-байты как base64 — браузер декодирует через Uint16Array
    pixels_b64 = base64.b64encode(arr_uint16.tobytes()).decode('ascii')
    t3 = time.time()

    experiment_logger.info(
        u'preview: npz_load={:.3f}s base64={:.3f}s arr={}x{} b64_len={}'.format(
            t2 - t1, t3 - t2, new_w, new_h, len(pixels_b64)))

    return JsonResponse({
        'width': new_w,
        'height': new_h,
        'data_min': arr_min,
        'data_max': arr_max,
        'pixels_b64': pixels_b64,
        'timing': {
            'detector_s': round(t1 - t0, 3),
            'npz_load_s': round(t2 - t1, 3),
            'base64_s':   round(t3 - t2, 3),
            'total_s':    round(t3 - t0, 3),
        },
    })


@login_required
@user_passes_test(has_experiment_access)
def experiment_tomograph(request, value_to_get):

    if value_to_get not in remote_url_settings:
        return HttpResponse(status=404)

    experiment_url = remote_url_settings[value_to_get]
    try:
        requests_response = requests.get(experiment_url, timeout=settings.TIMEOUT_DEFAULT)
    except requests.RequestException as e:
        experiment_logger.error(u'Ошибка запроса к модулю "Эксперимент" ({}): {}'.format(value_to_get, e))
        return JsonResponse({'success': False, 'error': str(e)}, status=502)

    content_type = requests_response.headers.get('Content-Type', 'application/json')
    django_response = HttpResponse(
        content=requests_response.content,
        status=requests_response.status_code,
        content_type=content_type,
    )

    return django_response
