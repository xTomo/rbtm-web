import logging
import os
import tempfile
import requests
import json
import h5py
import math

from django.contrib import messages
from django.core.files.storage import default_storage
from django.http import HttpResponseBadRequest, HttpResponse
from django.shortcuts import render
from django.conf import settings
from django.contrib.auth.decorators import login_required, user_passes_test
from django.urls import reverse

from requests.exceptions import Timeout


storage_logger = logging.getLogger('storage_logger')


def is_active(user):
    return user.is_active


class ExperimentRecord:
    def __init__(self, record):
        self.experiment_id = record['_id']
        if 'specimen' in record:
            self.specimen = record['specimen']
        else:
            self.specimen = ''
        self.dark_count = record['experiment parameters']['DARK']['count']
        self.dark_exposure = record['experiment parameters']['DARK']['exposure']

        if record['finished']:
            self.finished = u'Завершен'
        else:
            self.finished = u'Не завершен'
        if record['experiment parameters']['advanced']:
            self.advanced = u'Продвинутый'
        else:
            self.advanced = u'Стандартный'
        self.data_angle_step = record['experiment parameters']['DATA']['angle step']
        self.data_count_per_step = record['experiment parameters']['DATA']['count per step']
        self.data_step_count = record['experiment parameters']['DATA']['step count']
        self.data_exposure = record['experiment parameters']['DATA']['exposure']
        self.empty_count = record['experiment parameters']['EMPTY']['count']
        self.empty_exposure = record['experiment parameters']['EMPTY']['exposure']
        self.hdf_host = settings.STORAGE_HDF5_FILE.format(exp_id=self.experiment_id)
        self.datetime = record['datetime']

        raw_tags = record.get('tags', [])
        if isinstance(raw_tags, list):
            self.tags = raw_tags
        elif raw_tags:
            self.tags = [str(raw_tags)]
        else:
            self.tags = []

        self.serial_number = 0  # заполняется в storage_view после сортировки


class FrameRecord:
    def __init__(self, frame):
        self.id = ""
        self.num = "0"
        self.type = ""
        self.date_time = ""
        self.detector_model = ""
        self.exposure = ""
        self.shutter_open = ""
        self.angle_position = ""
        self.current = ""
        self.voltage = ""
        self.horizontal_position = ""
        self.present = ""
        self.mode = ""

        if "_id" in frame:
            if "$oid" in frame['_id']:
                self.id = str(frame["_id"]['$oid'])
            else:
                self.id = str(frame["_id"])

        if "type" in frame:
            self.type = frame["type"]
        if "frame" in frame:
            if "mode" in frame["frame"]:
                self.mode = frame["frame"]["mode"]
            if "number" in frame['frame']:
                self.num = frame["frame"]["number"]
            if "image_data" in frame["frame"]:
                if "datetime" in frame["frame"]["image_data"]:
                    self.date_time = frame["frame"]["image_data"]["datetime"]
                if "detector" in frame["frame"]["image_data"]:
                    if "model" in frame["frame"]["image_data"]["detector"]:
                        self.detector_model = frame["frame"]["image_data"]["detector"]["model"]
                if "exposure" in frame["frame"]["image_data"]:
                    self.exposure = frame["frame"]["image_data"]["exposure"]
            if "shutter" in frame["frame"]:
                if "open" in frame["frame"]["shutter"]:
                    self.shutter_open = frame["frame"]["shutter"]["open"]
            if "object" in frame["frame"]:
                if "angle position" in frame["frame"]["object"]:
                    self.angle_position = frame["frame"]["object"]["angle position"]
                if "horizontal position" in frame["frame"]["object"]:
                    self.horizontal_position = frame["frame"]["object"]["horizontal position"]
                if "present" in frame["frame"]["object"]:
                    if frame["frame"]["object"]["present"]:
                        self.present = u"Да"
                    else:
                        self.present = u"Нет"
            if "X-ray source" in frame["frame"]:
                if "current" in frame["frame"]["X-ray source"]:
                    self.current = frame["frame"]["X-ray source"]["current"]
                if "voltage" in frame["frame"]["X-ray source"]:
                    self.voltage = frame["frame"]["X-ray source"]["voltage"]


def make_search_query(search_str):
    """Строит MongoDB-запрос для поиска по подстрокам в specimen и tags.
    Слова разделяются пробелами; каждое слово должно встречаться
    хотя бы в одном из полей (AND между словами, OR между полями).
    """
    if not search_str or not search_str.strip():
        return json.dumps({})

    terms = search_str.strip().split()
    conditions = []
    for term in terms:
        conditions.append({'$or': [
            {'specimen': {'$regex': term, '$options': 'i'}},
            {'tags': {'$regex': term, '$options': 'i'}},
        ]})

    if len(conditions) == 1:
        query = conditions[0]
    else:
        query = {'$and': conditions}

    storage_logger.debug(u'Текст запроса к базе {}'.format(json.dumps(query)))
    return json.dumps(query)


def force_https(url):
    return url.replace('http', 'https') if not url.startswith('https') else url


@login_required
@user_passes_test(is_active)
def storage_view(request):
    records = []
    num_pages = 0
    page_size = 50
    to_show = False

    storage_url = request.build_absolute_uri(reverse('storage:index'))

    # force https in urls — kludged until build_absolute_uri not return correct protocol
    host = request.get_host()
    prod = ('127.0.0.1' not in host) and ('localhost' not in host)
    if prod:
        storage_url = force_https(storage_url)
    # end of force https kludge

    # Загружаем все записи; фильтрация по поиску выполняется на клиенте
    info = json.dumps({})
    try:
        answer = requests.post(settings.STORAGE_EXPERIMENTS_GET_HOST, info, timeout=settings.TIMEOUT_DEFAULT)
        if answer.status_code == 200:
            experiments = json.loads(answer.content)
            storage_logger.debug(u'Найденные эксперименты: {}'.format(experiments))
            records = []
            for result in experiments:
                try:
                    record = ExperimentRecord(result)
                    records.append(record)
                except KeyError:
                    storage_logger.warning(u'Неверная запись об эксперименте {}'.format(result))

            # Storage API отдаёт по убыванию времени (новые первые).
            # Нумерация: старейший объект получает №1, новейший — №N.
            # Таблица отображается в исходном порядке (новые вверху).
            total = len(records)
            for i, record in enumerate(records):
                record.serial_number = total - i

            if len(records) == 0:
                messages.error(request, u'Не найдено ни одной записи')
            else:
                to_show = True
            num_pages = int(math.ceil(1.0 * len(records) / page_size))
        else:
            storage_logger.error(u'Не удается найти эксперименты. Код ошибки: {}'.format(answer.status_code))
            messages.error(request, u'Не удается найти эксперименты. Код ошибки: {}'.format(answer.status_code))
    except Timeout as e:
        storage_logger.error(u'Не удается найти эксперименты. Ошибка: {}'.format(str(e)))
        messages.error(request, u'Не удается найти эксперименты. Сервер хранилища не отвечает. Попробуйте позже.')
    except BaseException as e:
        storage_logger.error(u'Не удается найти эксперименты. Ошибка: {}'.format(str(e)))
        messages.error(request,
                       u'Не удается найти эксперименты. Сервер хранилища не отвечает. Попробуйте позже.')

    return render(request, 'storage/storage_index.html', {
        'caption': 'Хранилище',
        'record_range': records,
        'toShowResult': to_show,
        'pages': range(1, num_pages + 1),
        'storage_url': storage_url,
        'page_size': page_size,
    })


@login_required
@user_passes_test(is_active)
def storage_record_view(request, storage_record_id):
    record = {}
    to_show = True
    try:
        exp_info = json.dumps({"_id": storage_record_id})
        experiment = requests.post(settings.STORAGE_EXPERIMENTS_GET_HOST, exp_info, timeout=settings.TIMEOUT_DEFAULT)
        if experiment.status_code == 200:
            experiment_info = json.loads(experiment.content)
            storage_logger.debug(u'Страница записи: Данные эксперимента: {}'.format(experiment_info))
            if len(experiment_info) == 0:
                messages.error(request, u'Эксперимент с данным идентификатором не найден')
                to_show = False
            else:
                record = ExperimentRecord(experiment_info[0])
        else:
            storage_logger.error(u'Не удается получить эксперимент. Ошибка: {}'.format(experiment.status_code))
            messages.error(request, u'Не удается получить эксперимент. Ошибка: {}'.format(experiment.status_code))
            to_show = False
    except Timeout as e:
        storage_logger.error(u'Не удается получить эксперимент. Ошибка: {}'.format(str(e)))
        messages.error(request, u'Не удается получить эксперимент. Сервер хранилища не отвечает. Попробуйте позже.')
        to_show = False
    except BaseException as e:
        storage_logger.error(u'Не удается получить эксперимент. Ошибка: {}'.format(str(e)))
        messages.error(request, u'Не удается получить эксперимент. Сервер хранилища не отвечает. Попробуйте позже.')
        to_show = False

    frames_list = []

    try:
        frame_info = json.dumps({"exp_id": storage_record_id})
        # storage_logger.debug(u'Страница записи: {}'.format(frame_info))
        frames = requests.post(settings.STORAGE_FRAMES_INFO_HOST, frame_info, timeout=settings.TIMEOUT_DEFAULT)
        if frames.status_code == 200:
            frames_info = json.loads(frames.content)
            storage_logger.debug(u'Страница записи: Список изображений: {}'.format(frames_info))
            frames_list = [FrameRecord(frame) for frame in frames_info]
            frames_list.sort(key=lambda k: k.num, reverse=True)
        else:
            storage_logger.error(
                u'Страница записи: Не удается получить список изображений. Ошибка: {}'.format(frames.status_code))
            messages.error(request, u'Не удается получить список изображений. Ошибка: {}'.format(frames.status_code))
            to_show = False
    except Timeout as e:
        storage_logger.error(u'Страница записи: Не удается получить список изображений. Ошибка: {}'.format(str(e)))
        messages.error(request,
                       u'Не удается получить список изображений. Сервер хранилища не отвечает. Попробуйте позже.')
        to_show = False
    except BaseException as e:
        storage_logger.error(u'Страница записи: Не удается получить список изображений. Ошибка: {}'.format(e))
        messages.error(request,
                       u'Не удается получить список изображений. Сервер хранилища не отвечает. Попробуйте позже.')
        to_show = False

    recon_base_path = '../../reconstruct/{}'
    recon_path = recon_base_path.format(storage_record_id)

    return render(request, 'storage/storage_record.html', {
        'record_id': storage_record_id,
        'recon_path': recon_path,
        'caption': 'Запись хранилища ' + str(storage_record_id),
        'to_show': to_show,
        'info': record,
        'frames_list': frames_list,
    })


# TODO: route w/o user check?
def frames_downloading(request, storage_record_id):
    try:
        frame_request = json.dumps({"exp_id": storage_record_id})
        storage_logger.debug(u'Получение изображений: Запрос списка изображений {}'.format(frame_request))
        frames = requests.post(settings.STORAGE_FRAMES_INFO_HOST, frame_request, timeout=settings.TIMEOUT_DEFAULT)
        if frames.status_code == 200:
            frames_info = json.loads(frames.content)
            storage_logger.debug(u'Получение изображений: Список изображений: {}'.format(frames_info))
            frames_list = [FrameRecord(frame) for frame in frames_info]
        else:
            storage_logger.error(
                u'Получение изображений: Не удается получить список изображений. Ошибка: {}'.format(frames.status_code))
            messages.error(request, u'Не удается получить список изображений. Ошибка: {}'.format(frames.status_code))
            return HttpResponseBadRequest(u'Ошибкa {} при получении списка изображений'.format(frames.status_code),
                                          content_type='text/plain')
    except Timeout as e:
        storage_logger.error(
            u'Получение изображений: Не удается получить список изображений. Ошибка: {}'.format(str(e)))
        messages.error(request,
                       u'Не удается получить список изображений. Сервер хранилища не отвечает. Попробуйте позже.')
        return HttpResponseBadRequest(u"Не удалось получить список изображений. Истекло время ожидания ответа",
                                      content_type='text/plain')
    except BaseException as e:
        storage_logger.error(
            u'Получение изображений: Не удается получить список изображений. Ошибка: {}'.format(e))
        messages.error(request,
                       u'Не удается получить список изображений. Сервер хранилища не отвечает. Попробуйте позже.')
        return HttpResponseBadRequest(u'Не удалось получить список изображений. Сервер хранилища не отвечает.',
                                      content_type='text/plain')

    for frame in frames_list:
        file_name = frame.id + '.png'
        if not os.path.exists(os.path.join(settings.MEDIA_ROOT, file_name)):
            try:
                storage_logger.debug(
                    u'Получение изображений: Запрос на получение изображения номер {}'.format(frame.id))
                frame_response = requests.get(settings.STORAGE_FRAMES_PNG.format(exp_id=storage_record_id, frame_id=frame.id),
                                              timeout=settings.TIMEOUT_DEFAULT, stream=True)
                if frame_response.status_code == 200:
                    temp_file = tempfile.TemporaryFile()
                    for block in frame_response.iter_content(1024 * 8):
                        if not block:
                            break
                        temp_file.write(block)
                    # default_storage.save() expects a path relative to MEDIA_ROOT, not absolute
                    default_storage.save(file_name, temp_file)
                else:
                    storage_logger.error(u'Не удается получить изображениe {}. Ошибка: {}'.format(
                        frame.num, frame_response.status_code))
                    return HttpResponseBadRequest(
                        u'Ошибкa {} при получении изображения'.format(frame_response.status_code),
                        content_type='text/plain')
            except Timeout as e:
                storage_logger.error(
                    u'Получение изображений: Не удается получить изображения. Ошибка: {}'.format(str(e)))
                return HttpResponseBadRequest(
                    u'Не удалось получить изображение номер {}. Истекло время ожидания ответа'.format(frame.num),
                    content_type='text/plain')
            except BaseException as e:
                storage_logger.error(
                    u'Получение изображений: Не удается получить изображения. Ошибка: {}'.format(str(e)))
                return HttpResponseBadRequest(
                    u'Не удалось получить изображение номер {}. Сервер хранилища не отвечает.'.format(frame.num),
                    content_type='text/plain')

    return HttpResponse(u'Изображения получены успешно', content_type='text/plain')


# TODO: route w/o user check?
def delete_experiment(request, experiment_id):
    try:
        storage_logger.debug(u'Удаление эксперимента: {}'.format(experiment_id))
        response = requests.delete(settings.STORAGE_EXPERIMENTS_HOST + '/' + experiment_id, timeout=settings.TIMEOUT_DEFAULT)

        if response.status_code == 200:
            response_content = json.loads(response.content)
            storage_logger.debug(u'Удаление эксперимента: Результат: {}'.format(response_content))
            result = response_content[u'deleted']

            if result != u'success':
                storage_logger.error(u'Удаление эксперимента: сервер не смог удалить эксперимент')
                return HttpResponseBadRequest(u'Не удается удалить эксперимент.', content_type='text/plain')
            else:
                return HttpResponse(u'Эксперимент {} успешно удален'.format(experiment_id))
        else:
            storage_logger.error(
                u'Удаление эксперимента: Не удается удалить эксперимент. response.status_code: {}'.format(
                    response.status_code))
            return HttpResponseBadRequest(
                u'Не удается удалить эксперимент. Ошибка {}'.format(response.status_code),
                content_type='text/plain')
    except Timeout as e:
        storage_logger.error(
            u'Удаление эксперимента: Не удается удалить эксперимент. Ошибка: {}'.format(str(e)))
        return HttpResponseBadRequest(
            u'Не удается удалить эксперимент. Истекло время ожидания ответа',
            content_type='text/plain')
    except BaseException as e:
        storage_logger.error(
            u'Удаление эксперимента: Не удается удалить эксперимент. Ошибка: {}'.format(str(e)))
        return HttpResponseBadRequest(
            u'Не удается удалить эксперимент.',
            content_type='text/plain')
