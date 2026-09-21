from unittest import skip
from django.test import TestCase
from django.contrib.auth.models import User
from main.models import UserProfile


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

    def test_search_specimen(self):
        self.client.login(username='guest', password='guest')
        response = self.client.post('/storage/',
                                    {'Specimen': 'unreal object!!!___@#', 'DarkFromCount': '', 'DarkToCount': '',
                                     'DarkFromExposure': '',
                                     'DarkToExposure': '', 'EmptyFromCount': '', 'EmptyToCount': '',
                                     'EmptyFromExposure': '', 'EmptyToExposure': '', 'Finished': '',
                                     'Advanced': '', 'DataFromExposure': '', 'DataToExposure': '',
                                     'DataFromAngleStep': '', 'DataToAngleStep': '', 'DataFromCountPerStep': '',
                                     'DataToCountPerStep': '', 'DataFromStepCount': '', 'DataToStepCount': ''})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(b"alert alert-danger" in response.content)

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
        response = self.client.get('/storage/storage_record_unreal-record/')
        self.assertEqual(response.status_code, 200)

        self.assertTrue(b"alert alert-danger" in response.content)


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
