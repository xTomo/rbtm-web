import json
from unittest import mock

from django.test import TestCase
from django.contrib.auth.models import User
from main.models import UserProfile


def _fake_response(status_code=200, content=b'[]'):
    resp = mock.Mock()
    resp.status_code = status_code
    if isinstance(content, str):
        content = content.encode('utf-8')
    resp.content = content
    return resp


# TODO: it may be storage tests should be in storage service

class StorageIndexTest(TestCase):
    def setUp(self):
        self.u_gst = User.objects.create_user(username='guest', password='guest')
        self.up_gst = UserProfile.objects.create(user=self.u_gst, is_guest=True)
        self.client.login(username='guest', password='guest')
    
    def test_login(self):
        response = self.client.get("/storage/")
        self.assertEqual(response.status_code, 200)

    def test_search_empty(self):
        response = self.client.post('/storage/',
                                    {'Specimen': '', 'DarkFromCount': '', 'DarkToCount': '', 'DarkFromExposure': '',
                                     'DarkToExposure': '', 'EmptyFromCount': '', 'EmptyToCount': '',
                                     'EmptyFromExposure': '', 'EmptyToExposure': '', 'Finished': '',
                                     'Advanced': '', 'DataFromExposure': '', 'DataToExposure': '',
                                     'DataFromAngleStep': '', 'DataToAngleStep': '', 'DataFromCountPerStep': '',
                                     'DataToCountPerStep': '', 'DataFromStepCount': '', 'DataToStepCount': ''})
        self.assertEqual(response.status_code, 200)

    def test_search_specimen_empty_result_shows_alert(self):
        # storage_view игнорирует тело POST (фильтрация происходит на клиенте) и
        # всегда запрашивает полный список экспериментов у Storage API — пустой
        # список означает "не найдено ни одной записи".
        with mock.patch('storage.views.requests.post', return_value=_fake_response(200, '[]')):
            response = self.client.post('/storage/',
                                        {'Specimen': 'unreal object!!!___@#', 'DarkFromCount': '', 'DarkToCount': '',
                                         'DarkFromExposure': '',
                                         'DarkToExposure': '', 'EmptyFromCount': '', 'EmptyToCount': '',
                                         'EmptyFromExposure': '', 'EmptyToExposure': '', 'Finished': '',
                                         'Advanced': '', 'DataFromExposure': '', 'DataToExposure': '',
                                         'DataFromAngleStep': '', 'DataToAngleStep': '', 'DataFromCountPerStep': '',
                                         'DataToCountPerStep': '', 'DataFromStepCount': '', 'DataToStepCount': ''})
        self.assertEqual(response.status_code, 200)
        rendered = [str(m) for m in response.context['messages']]
        self.assertTrue(any(u'Не найдено ни одной записи' in m for m in rendered))

    def test_search_non_empty_result_renders_list(self):
        experiments = [{
            '_id': 'exp-1',
            'specimen': 'sample',
            'datetime': '01.01.2024 12:00:00',
            'experiment parameters': {'advanced': False, 'DARK': {}, 'EMPTY': {}, 'DATA': {}},
        }]
        with mock.patch('storage.views.requests.post',
                        return_value=_fake_response(200, json.dumps(experiments))):
            response = self.client.post('/storage/', {'Specimen': 'sample'})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context['toShowResult'])
        self.assertEqual(len(response.context['record_range']), 1)

    def test_record_page_prohibit_symbols(self):
        response = self.client.get('/storage/storage_record_unreal_record/')
        self.assertEqual(response.status_code, 404)
        response = self.client.get('/storage/storage_record_unreal*record/')
        self.assertEqual(response.status_code, 404)
        response = self.client.get('/storage/storage_record_unreal(record/')
        self.assertEqual(response.status_code, 404)
        response = self.client.get('/storage/storage_record_unreal)record/')
        self.assertEqual(response.status_code, 404)
        response = self.client.get('/storage/storage_record_unreal@record/')
        self.assertEqual(response.status_code, 404)

    def test_record_page(self):
        # Storage возвращает пустой список -> запись не найдена, без реального
        # обращения к недоступному в тестах Storage API.
        with mock.patch('storage.views.requests.post', return_value=_fake_response(200, '[]')):
            response = self.client.get('/storage/storage_record_unreal-record/')
        self.assertEqual(response.status_code, 200)

        rendered = [str(m) for m in response.context['messages']]
        self.assertTrue(any(u'не найден' in m for m in rendered))


class ExperimentRecordTest(TestCase):
    """Пункт 8: ExperimentRecord не должен падать на записи без 'datetime',
    и должен уметь разбирать 'tags' как список (как допускает Storage API)."""

    def test_missing_datetime_does_not_crash(self):
        from storage.views import ExperimentRecord
        record = {
            '_id': 'abc123',
            'specimen': 'sample',
            'experiment parameters': {'advanced': False, 'DARK': {}, 'EMPTY': {}, 'DATA': {}},
            # 'datetime' отсутствует в записи
        }
        exp_record = ExperimentRecord(record)
        self.assertEqual(exp_record.datetime, '')

    def test_tags_as_list(self):
        from storage.views import ExperimentRecord
        record = {
            '_id': 'abc124',
            'specimen': 'sample',
            'experiment parameters': {'advanced': False, 'DARK': {}, 'EMPTY': {}, 'DATA': {}},
            'datetime': '01.01.2024 12:00:00',
            'tags': ['tag1, tag2', 'tag3'],
        }
        exp_record = ExperimentRecord(record)
        self.assertEqual(exp_record.tags, ['tag1', 'tag2', 'tag3'])


class FrameDedupSortTest(TestCase):
    """Пункт 8: кадры сортируются численно по номеру, дубли по номеру убираются
    (на случай задвоенных записей в Mongo)."""

    def test_dedup_and_numeric_sort(self):
        from storage.views import FrameRecord, _dedup_and_sort_frames
        frames_raw = [
            {'_id': {'$oid': '1'}, 'frame': {'number': '2'}},
            {'_id': {'$oid': '2'}, 'frame': {'number': '10'}},
            {'_id': {'$oid': '3'}, 'frame': {'number': '2'}},  # дубль по номеру
            {'_id': {'$oid': '4'}, 'frame': {'number': '1'}},
        ]
        frames = [FrameRecord(f) for f in frames_raw]
        result = _dedup_and_sort_frames(frames)
        nums = [int(f.num) for f in result]
        # численно убывающая сортировка, дубль по номеру 2 убран
        self.assertEqual(nums, [10, 2, 1])

    def test_frames_without_number_are_not_deduplicated(self):
        # У кадров без frame.number (например, неполные данные из Mongo) нет
        # ключа для дедупликации по номеру — все они должны остаться, а не
        # схлопнуться в один по общему значению по умолчанию ("0").
        from storage.views import FrameRecord, _dedup_and_sort_frames
        frames_raw = [
            {'_id': {'$oid': '1'}, 'frame': {}},
            {'_id': {'$oid': '2'}, 'frame': {}},
            {'_id': {'$oid': '3'}, 'frame': {'number': '5'}},
        ]
        frames = [FrameRecord(f) for f in frames_raw]
        result = _dedup_and_sort_frames(frames)
        self.assertEqual(len(result), 3)
        self.assertEqual(sorted(f.id for f in result), ['1', '2', '3'])
