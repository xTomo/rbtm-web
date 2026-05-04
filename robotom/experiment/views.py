from django.shortcuts import render, get_object_or_404, redirect
from django.contrib.auth.decorators import login_required, user_passes_test
from django.conf import settings
from django.urls import reverse
from django.contrib import messages
from django.contrib.messages import get_messages
from django.core.files.storage import default_storage
from django.http import HttpResponse, JsonResponse

from .models import Tomograph
from requests.exceptions import Timeout
from functools import wraps

import io
import logging
import hashlib
import random
import requests
import tempfile
import os
import json
import uuid
import time
import datetime

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from PIL import Image

experiment_logger = logging.getLogger('experiment_logger')

GET_VOLT = 'get-voltage'
GET_CURR = 'get-current'
GET_VERT = 'get-vertical-position'
GET_HOR = 'get-horizontal-position'
GET_ANGL = 'get-angle-position'
GET_SHUT = 'get-shutter-state'

TOMO_NUM = 1

remote_url_settings = {
        GET_VOLT: settings.EXPERIMENT_SOURCE_GET_VOLT.format(TOMO_NUM),
        GET_CURR: settings.EXPERIMENT_SOURCE_GET_CURR.format(TOMO_NUM),
        GET_VERT: settings.EXPERIMENT_MOTOR_GET_VERT.format(TOMO_NUM),
        GET_HOR: settings.EXPERIMENT_MOTOR_GET_HORIZ.format(TOMO_NUM),
        GET_ANGL: settings.EXPERIMENT_MOTOR_GET_ANGLE.format(TOMO_NUM),
        GET_SHUT: settings.EXPERIMENT_SHUTTER_GET_STATUS.format(TOMO_NUM),
    }

tomo_path = '../tomograph/{}/'

local_url_settings = {
        'get_voltage_url': tomo_path.format(GET_VOLT),
        'get_current_url': tomo_path.format(GET_CURR),
        'get_vert_url': tomo_path.format(GET_VERT),
        'get_horiz_url': tomo_path.format(GET_HOR),
        'get_angle_url': tomo_path.format(GET_ANGL),
        'get_shutter_url': tomo_path.format(GET_SHUT),
    }


def has_experiment_access(user):
    return user.userprofile.is_admin or user.userprofile.is_experimentator


def info_once_only(request, msg):
    storage = get_messages(request)
    if msg not in [m.message for m in storage]:
        messages.info(request, msg)


def migrations():
    if len(Tomograph.objects.all()) == 0:
        tomo = Tomograph(state='unavailable')
        tomo.save()


def try_request_post(request, address, content, source_page, stream=False):
    result = {'response_dict': None, 'error': None}
    try:
        answer = requests.post(address, content, timeout=settings.TIMEOUT_DEFAULT, stream=stream) 
        result['response_dict'] = json.loads(answer.content)
        if answer.status_code != 200:
            messages.warning(request, u'Модуль "Эксперимент" завершил работу с кодом ошибки {}'.format(answer.status_code))
            experiment_logger.error(u'Модуль "Эксперимент" завершил работу с кодом ошибки {}'.format(answer.status_code))
            result['error'] = redirect(reverse(source_page))
    except Timeout as e:
        messages.warning(request, 'Нет ответа от модуля "Эксперимент".')
        experiment_logger.error(e)
        result['error'] = redirect(reverse(source_page))
    except BaseException as e:
        experiment_logger.error(e)
        messages.warning(request,
                         '''Ошибка связи с модулем "Эксперимент", невозможно сохранить данные.
                         Возможно, отсутствует подключение к сети.
                         Попробуйте снова через некоторое время или свяжитесь с администратором''')
        result['error'] = redirect(reverse(source_page))
    return result


def try_request_get(request, address, source_page=''):
    result = {'response_dict': None, 'error': None}
    try:
        answer = requests.get(address, timeout=settings.TIMEOUT_DEFAULT) 
        result['response_dict'] = json.loads(answer.content)
        if answer.status_code != 200:
            messages.warning(request, u'Модуль "Эксперимент" завершил работу с кодом ошибки {}'.format(answer.status_code))
            experiment_logger.error(u'Модуль "Эксперимент" завершил работу с кодом ошибки {}'.format(answer.status_code))
            if source_page:
                result['error'] = redirect(reverse(source_page))
            else:
                result['error'] = u'Модуль "Эксперимент" завершил работу с кодом ошибки {}'.format(answer.status_code)
    except Timeout as e:
        messages.warning(request, 'Нет ответа от модуля "Эксперимент"')
        experiment_logger.error(e)
        if source_page:
            result['error'] = redirect(reverse(source_page))
        else:
            result['error'] = 'Нет ответа от модуля "Эксперимент"'

    except BaseException as e:
        experiment_logger.error(e)
        messages.warning(request,
                         '''Ошибка связи с модулем "Эксперимент", невозможно сохранить данные.
                         Возможно, отсутствует подключение к сети.
                         Попробуйте снова через некоторое время или свяжитесь с администратором''')
        if source_page:
            result['error'] = redirect(reverse(source_page))
        else:
            result['error'] = '''Ошибка связи с модулем "Эксперимент", невозможно сохранить данные.
                                Возможно, отсутствует подключение к сети.
                                Попробуйте снова через некоторое время или свяжитесь с администратором'''


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
    except BaseException as e:
        tomo.state = 'unavailable'
    tomo.save()


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

    migrations()

    tomo = get_object_or_404(Tomograph, pk=1)
    result = None
    success_msg = ''
    source_page = 'experiment:index'

    if request.method == 'POST':
        if 'on_exp' in request.POST:
            success_msg = u'Томограф включен'
            result = try_request_get(request, settings.EXPERIMENT_SOURCE_POWER_ON.format(TOMO_NUM), source_page)

        if 'of_exp' in request.POST:
            success_msg = u'Томограф выключен'
            result = try_request_get(request, settings.EXPERIMENT_SOURCE_POWER_OFF.format(TOMO_NUM), source_page)

    if result:
        if result['error']:
            return result['error']
        check_result(result, request, tomo, success_msg)

    get_current_state(request, tomo)
    set_current_state_msg(request, tomo)
    return render(request, 'experiment/start.html', {
        'caption': 'Эксперимент',
        'tomograph': tomo,
    })


@update_state_before_run
@login_required
@user_passes_test(has_experiment_access)
def experiment_adjustment(request):

    migrations()

    js_urls = {k: request.build_absolute_uri(v) for k, v in local_url_settings.items()}

    # force https in urls — kludged until build_absolute_uri not return correct protocol
    host = request.get_host()
    prod = ('127.0.0.1' not in host) and ('localhost' not in host)
    if prod:
        js_urls = {k: force_https(v) for k, v in js_urls.items()}
    # end of force https kludge

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

    migrations()

    tomo = get_object_or_404(Tomograph, pk=1)
    result = None
    success_msg = ''
    source_page = 'experiment:index_interface'

    if request.method == 'POST':

        if 'parameters' in request.POST:
            exp_id = uuid.uuid4()
            timestamp = time.time()
            current_datetime = datetime.datetime.now().strftime("%d.%m.%Y %H:%M:%S")

            is_advanced = request.POST.get('mode') == 'advanced'

            # Экспозиции вводятся в секундах, переводим в миллисекунды
            if is_advanced:
                dark_count = int(float(request.POST['dark_quantity']))
                dark_exposure_ms = float(request.POST['dark_exposure_sec']) * 1000.0
                empty_count = int(float(request.POST['empty_quantity']))
                empty_exposure_ms = float(request.POST['empty_exposure_sec']) * 1000.0
                data_exposure_ms = float(request.POST['data_exposure_sec']) * 1000.0
            else:
                de_count = int(float(request.POST['de_quantity']))
                exposure_ms = float(request.POST['exposure_sec']) * 1000.0
                dark_count = de_count
                dark_exposure_ms = exposure_ms
                empty_count = de_count
                empty_exposure_ms = exposure_ms
                data_exposure_ms = exposure_ms

            experiment_data = json.dumps({
                'exp_id': str(exp_id),
                'specimen': request.POST['name'],
                'tags': request.POST['tags'],
                'timestamp': timestamp,
                'datetime': current_datetime,
                'experiment parameters':
                    {
                        'advanced': is_advanced,
                        'DARK':
                            {
                                'count': dark_count,
                                'exposure': dark_exposure_ms,
                            },
                        'EMPTY':
                            {
                                'count': empty_count,
                                'exposure': empty_exposure_ms,
                            },
                        'DATA':
                            {
                                'step count': int(float(request.POST['data_shots_quantity'])),
                                'exposure': data_exposure_ms,
                                'angle step': float(request.POST['data_angle']),
                                'count per step': int(float(request.POST['data_same']))
                            }
                    }
            })
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

                raw_tags = exp.get('tags', '')
                if raw_tags:
                    for t in raw_tags.split(','):
                        t = t.strip()
                        if t:
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
                    dark = ep.get('DARK', {})
                    empty = ep.get('EMPTY', {})
                    data = ep.get('DATA', {})
                    last_params = {
                        'advanced': ep.get('advanced', False),
                        'dark_count': dark.get('count', ''),
                        'dark_exposure_sec': round(dark.get('exposure', 0) / 1000.0, 3) if dark.get('exposure') else '',
                        'empty_count': empty.get('count', ''),
                        'empty_exposure_sec': round(empty.get('exposure', 0) / 1000.0, 3) if empty.get('exposure') else '',
                        'data_step_count': data.get('step count', ''),
                        'data_exposure_sec': round(data.get('exposure', 0) / 1000.0, 3) if data.get('exposure') else '',
                        'data_angle_step': data.get('angle step', ''),
                        'data_count_per_step': data.get('count per step', ''),
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


# Preview thumbnail size — must match make_preview_data() defaults in rbtm-drivers-next.
PREVIEW_MAX_WIDTH = 1200
PREVIEW_MAX_HEIGHT = 800


def _median_filter_3x3(arr):
    """Fast 3×3 median filter using numpy sliding_window_view (no scipy needed)."""
    h, w = arr.shape
    padded = np.pad(arr, 1, mode='edge')
    windows = sliding_window_view(padded, (3, 3))  # shape (h, w, 3, 3)
    return np.median(windows.reshape(h, w, 9), axis=2).astype(arr.dtype)


@login_required
@user_passes_test(has_experiment_access)
def get_preview_data(request):
    """
    POST с exposure_ms → запрашивает кадр у детектора,
    уменьшает изображение, применяет медианный фильтр 3×3,
    возвращает плоский массив uint16-значений и размеры (JSON).
    """
    if request.method != 'POST':
        return JsonResponse({'error': 'POST required'}, status=405)

    try:
        body = json.loads(request.body)
        exposure_sec = float(body.get('exposure_sec', 1.0))
    except (ValueError, KeyError, json.JSONDecodeError):
        return JsonResponse({'error': 'bad request'}, status=400)

    exposure_ms = exposure_sec * 1000.0
    data = json.dumps(exposure_ms)

    try:
        response = requests.post(
            settings.EXPERIMENT_DETECTOR_GET_FRAME_PREVIEW.format(TOMO_NUM),
            data,
            stream=True,
            timeout=max(settings.TIMEOUT_DEFAULT, exposure_sec + 30),
        )
        if response.status_code != 200:
            experiment_logger.error(
                u'Не удалось получить кадр, код: {}'.format(response.status_code)
            )
            return JsonResponse({'error': 'detector error {}'.format(response.status_code)}, status=502)

        raw = b''.join(response.iter_content(1024 * 8))
    except Exception as e:
        experiment_logger.error(u'Ошибка получения кадра: {}'.format(e))
        return JsonResponse({'error': str(e)}, status=502)

    # Загружаем npz-данные от детектора (уже ресайз + медиана)
    try:
        npz = np.load(io.BytesIO(raw))
        arr = npz['data'].astype(np.float32)
        new_h, new_w = arr.shape[:2]
    except Exception as e:
        experiment_logger.error(u'Ошибка декодирования npz: {}'.format(e))
        return JsonResponse({'error': 'npz decode error: {}'.format(str(e))}, status=502)

    arr_min = float(arr.min())
    arr_max = float(arr.max())

    # Нормализуем в 0–65535 (uint16) для передачи в браузер
    if arr_max > arr_min:
        arr_norm = ((arr - arr_min) / (arr_max - arr_min) * 65535).astype(np.uint16)
    else:
        arr_norm = np.zeros_like(arr, dtype=np.uint16)

    return JsonResponse({
        'width': int(new_w),
        'height': int(new_h),
        'data_min': arr_min,
        'data_max': arr_max,
        'pixels': arr_norm.flatten().tolist(),
    })


@login_required
@user_passes_test(has_experiment_access)
def experiment_tomograph(request, value_to_get):

    experiment_url = remote_url_settings[value_to_get]
    requests_response = requests.get(experiment_url, timeout=settings.TIMEOUT_DEFAULT)

    django_response = HttpResponse(
        content=requests_response.content,
        status=requests_response.status_code,
        content_type=requests_response.headers['Content-Type']
    )

    return django_response


def force_https(url):
    return url.replace('http', 'https') if not url.startswith('https') else url
