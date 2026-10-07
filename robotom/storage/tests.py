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


def _frame_doc(oid, number, mode='data', angle=0.0, timestamp=1000.0, current=40.0):
    return {'_id': {'$oid': oid}, 'type': 'frame',
            'frame': {'mode': mode, 'number': str(number).zfill(4),
                      'image_data': {'datetime': '06.10.2026 15:09:00', 'timestamp': timestamp, 'exposure': 10000,
                                     'detector': {'model': 'MH110XC-KK-FA'}},
                      'shutter': {'open': mode != 'dark'},
                      'object': {'angle position': angle, 'present': mode != 'empty'},
                      'X-ray source': {'current': current, 'voltage': 40.0}}}


class FramePayloadTest(TestCase):
    """Кадр для просмотрщика: числа — числами, время — секунды Unix, экспозиция — в секундах."""

    def test_payload(self):
        from storage.views import FrameRecord, frame_payload
        p = frame_payload(FrameRecord(_frame_doc('a1', 7, 'data_check', angle=24.5, timestamp=1234.5)))
        self.assertEqual(p['id'], 'a1')
        self.assertEqual(p['num'], 7)
        self.assertEqual(p['mode'], 'data_check')
        self.assertEqual(p['t'], 1234.5)
        self.assertEqual(p['exposure'], 10.0)
        self.assertEqual(p['angle'], 24.5)
        self.assertIs(p['shutter'], True)
        self.assertEqual(p['detector'], 'MH110XC-KK-FA')

    def test_time_from_datetime_string_and_missing_values(self):
        from storage.views import FrameRecord, frame_payload
        doc = _frame_doc('a2', 3)
        del doc['frame']['image_data']['timestamp']
        doc['frame']['X-ray source']['current'] = 'n/a'
        p = frame_payload(FrameRecord(doc))
        self.assertIsNotNone(p['t'])
        self.assertIsNone(p['current'])
        p = frame_payload(FrameRecord({'_id': 'x', 'frame': {}}))
        self.assertIsNone(p['num'])
        self.assertIsNone(p['t'])
        json.dumps(p)                                   # без NaN и прочего, что JSON не пишет

    def test_size_format(self):
        from storage.views import _format_size
        self.assertEqual(_format_size(int(7.21 * 1024 ** 3)), u'7,2 ГБ')
        self.assertEqual(_format_size(640 * 1024 ** 2), u'640 МБ')
        self.assertEqual(_format_size(None), '')


class RecordViewerTest(TestCase):
    """Страница записи: шапка с названием образца, кадры для просмотрщика — JSON по возрастанию номера, без копирования
    всех PNG; один PNG — по запросу; список кадров для живого обновления."""

    EXP = {'_id': 'exp-1', 'specimen': 'Atherosclerotic_plaque_Mo_40_40_mono', 'datetime': '06.10.2026 15:09:12',
           'finished': False, 'tags': ['M0_40_40_mono'],
           'experiment parameters': {'advanced': True, 'exposure': 10000, 'series_length': 5, 'data_total': 400,
                                     'data_angle_step': 0.5, 'empty_period': 50}}

    def setUp(self):
        self.user = User.objects.create_user(username='viewer')
        UserProfile.objects.create(user=self.user, is_guest=True)
        self.client.force_login(self.user)

    def frames(self):
        return [_frame_doc('c3', 2, 'empty'), _frame_doc('a1', 0, 'dark'), _frame_doc('b2', 1, 'dark'),
                _frame_doc('d4', 3, 'data', angle=0.5)]

    def get_record(self, experiment=None, size=7 * 1024 ** 3):
        head = _fake_response(200 if size else 404)
        head.headers = {'Content-Length': str(size)} if size else {}
        answers = [_fake_response(200, json.dumps([experiment or self.EXP])),
                   _fake_response(200, json.dumps(self.frames()))]
        with mock.patch('storage.views.requests.post', side_effect=answers), \
                mock.patch('storage.views.requests.head', return_value=head) as head_call:
            response = self.client.get('/storage/storage_record_exp-1/')
        return response, head_call

    def test_header_and_payload(self):
        response, head_call = self.get_record()
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, '<h1>Atherosclerotic_plaque_Mo_40_40_mono</h1>')
        self.assertContains(response, u'не завершён')
        self.assertContains(response, u'продвинутый режим')
        self.assertContains(response, 'M0_40_40_mono')
        self.assertContains(response, u'Скачать HDF5 (7,0 ГБ)')
        self.assertTrue(head_call.call_args[0][0].endswith('/storage/experiments/exp-1.h5'))
        self.assertEqual([f['num'] for f in response.context['frames_payload']], [0, 1, 2, 3])
        self.assertContains(response, 'id="fv-frames"')
        cfg = response.context['viewer_config']
        self.assertFalse(cfg['finished'])
        self.assertEqual(cfg['framesUrl'], '/storage/storage_record_exp-1/frames.json')
        self.assertEqual(cfg['pngUrl'], '/storage/storage_record_exp-1/frame_FRAMEID.png')
        # копирование всех PNG при открытии записи больше не запускается
        self.assertNotContains(response, 'frames_downloading')
        # гость не удаляет
        self.assertNotContains(response, 'del-open')

    def test_size_unknown(self):
        response, _ = self.get_record(size=None)
        self.assertContains(response, u'Скачать HDF5</a>')

    def test_frames_json(self):
        answers = [_fake_response(200, json.dumps([dict(self.EXP, finished=True)])),
                   _fake_response(200, json.dumps(self.frames()))]
        with mock.patch('storage.views.requests.post', side_effect=answers):
            response = self.client.get('/storage/storage_record_exp-1/frames.json')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertTrue(data['finished'])
        self.assertEqual([f['id'] for f in data['frames']], ['a1', 'b2', 'c3', 'd4'])
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_frames_json_storage_down(self):
        with mock.patch('storage.views.requests.post', return_value=_fake_response(500)):
            response = self.client.get('/storage/storage_record_exp-1/frames.json')
        self.assertEqual(response.status_code, 502)
        self.assertIn('error', response.json())

    def test_frame_png_from_storage_not_saved(self):
        png = b'\x89PNG\r\n\x1a\nfake'
        with mock.patch('storage.views.requests.get', return_value=_fake_response(200, png)) as get, \
                mock.patch('storage.views.default_storage.save') as save:
            response = self.client.get('/storage/storage_record_exp-1/frame_abc123.png')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'image/png')
        self.assertEqual(response.content, png)
        self.assertIn('max-age=', response['Cache-Control'])
        self.assertTrue(get.call_args[0][0].endswith('/storage/experiments/exp-1/frames/abc123/png'))
        save.assert_not_called()

    def test_frame_png_from_media(self):
        import os
        import tempfile
        from django.test import override_settings
        with tempfile.TemporaryDirectory() as media:
            with open(os.path.join(media, 'abc123.png'), 'wb') as f:
                f.write(b'cached')
            with override_settings(MEDIA_ROOT=media), mock.patch('storage.views.requests.get') as get:
                response = self.client.get('/storage/storage_record_exp-1/frame_abc123.png')
        self.assertEqual(response.content, b'cached')
        get.assert_not_called()

    def test_frame_png_not_ready(self):
        with mock.patch('storage.views.requests.get', return_value=_fake_response(404)):
            response = self.client.get('/storage/storage_record_exp-1/frame_abc123.png')
        self.assertEqual(response.status_code, 404)
        self.assertIn(u'ещё не готово', response.content.decode('utf-8'))

    def test_frame_png_bad_id_and_login(self):
        from django.test import Client
        self.assertEqual(self.client.get('/storage/storage_record_exp-1/frame_a.b.png').status_code, 404)
        with mock.patch('storage.views.requests.get') as get, mock.patch('storage.views.requests.post') as post:
            self.assertEqual(Client().get('/storage/storage_record_exp-1/frame_abc123.png').status_code, 302)
            self.assertEqual(Client().get('/storage/storage_record_exp-1/frames.json').status_code, 302)
        get.assert_not_called()
        post.assert_not_called()
