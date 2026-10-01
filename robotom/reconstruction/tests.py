"""Тесты студии реконструкции: права, белый список и пересылка прокси, страница, кнопка в хранилище.

Сеть не используется: storage — мок ``requests.post``, recon-service — мок ``proxy._http()``.
"""
import json
import os
import re
import shutil
import tempfile
from unittest import mock
from urllib.parse import quote

import requests
from requests.structures import CaseInsensitiveDict

from django.conf import settings
from django.contrib.auth.models import User
from django.core import mail
from django.test import Client, TestCase, override_settings
from django.urls import reverse

from main.models import UserProfile
from reconstruction import proxy, views


EXP_ID = 'exp-1'
SID = '0123456789abcdef' * 2
SERVICE_URL = 'http://recon.test:5560/'
TOKEN = 'secret-token'

#: запросы «просмотра» (ADM/EXP/RES) и «запуска» (ADM/EXP): (метод клиента, путь API)
VIEW_REQUESTS = (
    ('get', 'health'),
    ('get', 'scans/exp-1/info'),
    ('get', 'scans/exp-1/overview'),
    ('get', 'scans/exp-1/outside'),
    ('get', 'scans/exp-1/envelope'),
    ('get', 'scans/exp-1/thumbs'),
    ('get', 'scans/exp-1/sinogram'),
    ('get', 'scans/exp-1/sample/3'),
    ('get', 'jobs'),
    ('get', 'jobs/' + SID),
    ('get', 'jobs/' + SID + '/log'),
    ('get', 'results/exp-1'),
    ('get', 'results/exp-1/slice'),
    ('get', 'results/exp-1/file/obj.4.raw'),
)
RUN_REQUESTS = (
    ('post', 'scans/exp-1/prefetch'),
    ('post', 'sessions'),
    ('get', 'sessions/' + SID),
    ('delete', 'sessions/' + SID),
    ('post', 'sessions/' + SID + '/ping'),
    ('post', 'sessions/' + SID + '/load'),
    ('post', 'sessions/' + SID + '/load/cancel'),
    ('post', 'sessions/' + SID + '/axis/auto'),
    ('post', 'sessions/' + SID + '/axis/scan'),
    ('post', 'sessions/' + SID + '/axis/tilt'),
    ('post', 'sessions/' + SID + '/axis/set'),
    ('post', 'sessions/' + SID + '/recipe'),
    ('post', 'sessions/' + SID + '/estimate'),
    ('post', 'sessions/' + SID + '/compare'),
    ('post', 'sessions/' + SID + '/smoothing/auto'),
    ('get', 'sessions/' + SID + '/slice'),
    ('get', 'sessions/' + SID + '/axis/diff'),
    ('get', 'sessions/' + SID + '/rings/preview'),
    ('get', 'sessions/' + SID + '/repositioning'),
    ('get', 'sessions/' + SID + '/motion'),
    ('post', 'sessions/' + SID + '/motion'),
    ('post', 'jobs'),
    ('post', 'jobs/' + SID + '/cancel'),
)


def _storage_answer(status_code=200, content=b'[]'):
    resp = mock.Mock()
    resp.status_code = status_code
    if isinstance(content, str):
        content = content.encode('utf-8')
    resp.content = content
    return resp


def _storage_experiment(specimen=u'Образец'):
    return _storage_answer(200, json.dumps([{'_id': EXP_ID, 'specimen': specimen}]))


def _upstream(status_code=200, body=b'{"ok": true}', headers=None):
    """Мок ответа requests (stream=True) от recon-service."""
    resp = mock.Mock()
    resp.status_code = status_code
    resp.url = SERVICE_URL + 'x'
    resp.headers = CaseInsensitiveDict({'Content-Type': 'application/json'} if headers is None else headers)
    resp.iter_content = mock.Mock(
        side_effect=lambda size: iter([body[i:i + size] for i in range(0, len(body), size)]))
    return resp


def _body(response):
    if response.streaming:
        return b''.join(response.streaming_content)
    return response.content


def _studio_config(response):
    m = re.search(r'<script id="studio-config" type="application/json">(.*?)</script>',
                  response.content.decode('utf-8'), re.S)
    assert m, 'нет json_script studio-config'
    return json.loads(m.group(1))


class StudioUsersMixin:
    """Пользователи всех ролей. Флаги как в main.views.manage_requests_view: роль снимает is_guest.
    Вход — force_login, пароли не нужны (хэширование PBKDF2 заметно замедляет тесты)."""

    @classmethod
    def setUpTestData(cls):
        cls.users = {}
        roles = (
            ('guest', {'is_guest': True}),
            ('res', {'is_guest': False, 'is_researcher': True}),
            ('exp', {'is_guest': False, 'is_experimentator': True}),
            ('adm', {'is_guest': False, 'is_admin': True}),
        )
        for name, flags in roles:
            user = User.objects.create_user(username=name)
            UserProfile.objects.create(user=user, **flags)
            cls.users[name] = user
        cls.users['noprofile'] = User.objects.create_user(username='noprofile')
        inactive = User.objects.create_user(username='inactive', is_active=False)
        UserProfile.objects.create(user=inactive, is_guest=False, is_experimentator=True)
        cls.users['inactive'] = inactive

    def login(self, name, client=None):
        client = client or self.client
        client.force_login(self.users[name])
        return client


class ServiceMockMixin:
    """Мок recon-service: ``self.service`` — общий requests.Session прокси."""

    def setUp(self):
        super().setUp()
        patcher = mock.patch('reconstruction.proxy._http')
        self.service = patcher.start().return_value
        self.addCleanup(patcher.stop)
        self.service.request.side_effect = lambda *args, **kwargs: _upstream()

    def api(self, method, path, client=None, **extra):
        client = client or self.client
        url = '/studio/api/' + path
        if method in ('post', 'put', 'patch'):
            return getattr(client, method)(url, data='{}', content_type='application/json', **extra)
        return getattr(client, method)(url, **extra)

    def forwarded(self):
        """(метод, URL, kwargs) единственного запроса к сервису."""
        self.assertEqual(self.service.request.call_count, 1)
        args, kwargs = self.service.request.call_args
        return args[0], args[1], kwargs


# ---------------------------------------------------------------------------------------------------------------
# Страница студии
# ---------------------------------------------------------------------------------------------------------------

class StudioPageAccessTest(StudioUsersMixin, TestCase):
    url = '/studio/exp-1/'

    def get(self):
        with mock.patch('reconstruction.views.requests.post', return_value=_storage_experiment()):
            return self.client.get(self.url)

    def test_anonymous_redirected_to_login(self):
        response = self.get()
        self.assertEqual(response.status_code, 302)
        self.assertIn(settings.LOGIN_URL, response['Location'])

    def test_inactive_redirected_to_login(self):
        self.login('inactive')
        response = self.get()
        self.assertEqual(response.status_code, 302)
        self.assertIn(settings.LOGIN_URL, response['Location'])

    def test_guest_forbidden(self):
        self.login('guest')
        self.assertEqual(self.get().status_code, 403)

    def test_user_without_profile_forbidden(self):
        self.login('noprofile')
        self.assertEqual(self.get().status_code, 403)

    def test_roles_allowed_and_can_run(self):
        for name, can_run in (('res', False), ('exp', True), ('adm', True)):
            with self.subTest(role=name):
                self.login(name)
                response = self.get()
                self.assertEqual(response.status_code, 200)
                self.assertIs(_studio_config(response)['can_run'], can_run)


class StudioPageTest(StudioUsersMixin, TestCase):
    def setUp(self):
        self.login('exp')

    def test_config_json_script(self):
        with mock.patch('reconstruction.views.requests.post', return_value=_storage_experiment()) as post:
            response = self.client.get('/studio/exp-1/')
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, 'reconstruction/studio.html')
        post.assert_called_once_with(settings.STORAGE_EXPERIMENTS_GET_HOST, json.dumps({"_id": EXP_ID}), timeout=10)

        config = _studio_config(response)
        self.assertEqual(config, response.context['studio_config'])
        self.assertEqual(set(config), {'exp_id', 'api_base', 'can_run', 'user', 'specimen', 'storage_url',
                                       'legacy_url', 'full_volume_url', 'csrf_token'})
        self.assertEqual(config['exp_id'], EXP_ID)
        self.assertEqual(config['api_base'], '/studio/api/')
        self.assertEqual(config['api_base'], reverse('reconstruction:api_root'))
        self.assertIs(config['can_run'], True)
        self.assertEqual(config['user'], 'exp')
        self.assertEqual(config['specimen'], u'Образец')
        self.assertEqual(config['storage_url'], '/storage/storage_record_exp-1/')
        self.assertEqual(config['legacy_url'], settings.RECONSTRUCTION_URL.format(exp_id=EXP_ID))
        self.assertEqual(config['full_volume_url'], '/reconstruct/static/tomo_data/')
        self.assertTrue(config['csrf_token'])
        self.assertEqual(response.context['exp_id'], EXP_ID)
        self.assertIn(u'Образец', response.context['caption'])

    def test_page_not_cached(self):
        with mock.patch('reconstruction.views.requests.post', return_value=_storage_experiment()):
            response = self.client.get('/studio/exp-1/')
        self.assertIn('no-store', response['Cache-Control'])

    def test_storage_unavailable_page_still_renders(self):
        with mock.patch('reconstruction.views.requests.post', side_effect=requests.ConnectionError('нет сети')):
            response = self.client.get('/studio/exp-1/')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(_studio_config(response)['specimen'])

    def test_storage_bad_answers_give_no_specimen(self):
        for answer in (_storage_answer(500, 'oops'), _storage_answer(200, 'не json'), _storage_answer(200, '[]'),
                       _storage_answer(200, '{}'), _storage_experiment(specimen='')):
            with self.subTest(content=answer.content):
                with mock.patch('reconstruction.views.requests.post', return_value=answer):
                    response = self.client.get('/studio/exp-1/')
                self.assertEqual(response.status_code, 200)
                self.assertIsNone(_studio_config(response)['specimen'])

    def test_storage_timeout(self):
        with mock.patch('reconstruction.views.requests.post', side_effect=requests.Timeout('долго')):
            response = self.client.get('/studio/exp-1/')
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(_studio_config(response)['specimen'])

    def test_exp_id_outside_storage_pattern(self):
        # «.» и «_» допустимы в exp_id сервиса, но не в URL записи хранилища — ссылки на неё нет
        with mock.patch('reconstruction.views.requests.post', return_value=_storage_answer(200, '[]')):
            response = self.client.get('/studio/exp_1.v2/')
        self.assertEqual(response.status_code, 200)
        config = _studio_config(response)
        self.assertEqual(config['exp_id'], 'exp_1.v2')
        self.assertIsNone(config['storage_url'])

    def test_invalid_exp_id_404(self):
        for exp_id in ('a..b', '-abc', '.abc', 'a' * 129, 'a%20b'):
            with self.subTest(exp_id=exp_id):
                self.assertEqual(self.client.get('/studio/{}/'.format(exp_id)).status_code, 404)

    def test_asset_version_in_context(self):
        with mock.patch('reconstruction.views.requests.post', return_value=_storage_experiment()):
            response = self.client.get('/studio/exp-1/')
            self.assertRegex(response.context['asset_version'], r'^[0-9a-f]{10}$')
            with mock.patch.object(views, 'asset_version', return_value='0123abcdef'):
                response = self.client.get('/studio/exp-1/')
        self.assertEqual(response.context['asset_version'], '0123abcdef')


class AssetVersionTest(TestCase):
    def test_hash_follows_content_and_names(self):
        static_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, static_dir)
        js_dir = os.path.join(static_dir, 'reconstruction', 'js')
        os.makedirs(js_dir)
        path = os.path.join(js_dir, 'studio.js')
        with open(path, 'wb') as f:
            f.write(b'var a = 1;')
        v1 = views.compute_asset_version(static_dir)
        self.assertRegex(v1, r'^[0-9a-f]{10}$')
        self.assertEqual(v1, views.compute_asset_version(static_dir))

        with open(path, 'wb') as f:
            f.write(b'var a = 2;')
        v2 = views.compute_asset_version(static_dir)
        self.assertNotEqual(v1, v2)

        os.rename(path, os.path.join(js_dir, 'viewer.js'))
        self.assertNotEqual(v2, views.compute_asset_version(static_dir))

    def test_computed_once_per_process_without_debug(self):
        with mock.patch.object(views, '_asset_version', None), \
                mock.patch.object(views, 'compute_asset_version', return_value='abc') as compute:
            with override_settings(DEBUG=False):
                self.assertEqual(views.asset_version(), 'abc')
                self.assertEqual(views.asset_version(), 'abc')
            self.assertEqual(compute.call_count, 1)
            with override_settings(DEBUG=True):
                views.asset_version()
                views.asset_version()
            self.assertEqual(compute.call_count, 3)


# ---------------------------------------------------------------------------------------------------------------
# Прокси: права и белый список
# ---------------------------------------------------------------------------------------------------------------

@override_settings(RECON_SERVICE_URL=SERVICE_URL, RECON_TOKEN=TOKEN)
class ApiAccessTest(StudioUsersMixin, ServiceMockMixin, TestCase):
    def assert_denied(self, requests_list, status_code=403):
        for method, path in requests_list:
            with self.subTest(method=method, path=path):
                response = self.api(method, path)
                self.assertEqual(response.status_code, status_code)
                self.assertIn('error', response.json())
        self.service.request.assert_not_called()

    def assert_forwarded(self, requests_list):
        for method, path in requests_list:
            with self.subTest(method=method, path=path):
                self.service.request.reset_mock()
                response = self.api(method, path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(self.service.request.call_count, 1)
                args = self.service.request.call_args[0]
                self.assertEqual(args, (method.upper(), SERVICE_URL + path))

    def test_anonymous_gets_403_json(self):
        self.assert_denied(VIEW_REQUESTS + RUN_REQUESTS)

    def test_inactive_gets_403_json(self):
        self.login('inactive')
        self.assert_denied(VIEW_REQUESTS + RUN_REQUESTS)

    def test_guest_gets_403_json(self):
        self.login('guest')
        self.assert_denied(VIEW_REQUESTS + RUN_REQUESTS + (('get', 'unknown'),))

    def test_user_without_profile_gets_403(self):
        self.login('noprofile')
        self.assert_denied(VIEW_REQUESTS)

    def test_researcher_views_but_cannot_run(self):
        self.login('res')
        self.assert_forwarded(VIEW_REQUESTS)
        self.service.request.reset_mock()
        self.assert_denied(RUN_REQUESTS)

    def test_experimentator_and_admin_run(self):
        for name in ('exp', 'adm'):
            with self.subTest(role=name):
                self.login(name)
                self.assert_forwarded(VIEW_REQUESTS + RUN_REQUESTS)


@override_settings(RECON_SERVICE_URL=SERVICE_URL, RECON_TOKEN=TOKEN)
class ApiWhitelistTest(StudioUsersMixin, ServiceMockMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.login('adm')

    def assert_not_found(self, requests_list):
        for method, path in requests_list:
            with self.subTest(method=method, path=path):
                response = self.api(method, path)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response['Content-Type'], 'application/json')
                self.assertIn('error', response.json())
        self.service.request.assert_not_called()

    def test_unknown_paths_404(self):
        self.assert_not_found((
            ('get', ''),
            ('get', 'scans/exp-1/secret'),
            ('get', 'scans/exp-1'),
            ('get', 'scans/exp-1/sample/x'),
            ('get', 'scans/a..b/info'),
            ('get', 'scans/-a/info'),
            ('get', 'sessions/' + SID + '/unknown'),
            ('get', 'sessions/' + SID.upper()),
            ('get', 'sessions/123'),
            ('get', 'jobs/not-a-job-id'),
            ('get', 'jobs/' + SID + '/'),
            ('get', 'results/exp-1/file/..'),
            ('get', 'results/exp-1/file/a/b'),
            ('get', 'admin'),
        ))

    def test_wrong_method_404(self):
        self.assert_not_found((
            ('get', 'sessions'),
            ('post', 'health'),
            ('put', 'jobs'),
            ('delete', 'jobs/' + SID),
            ('get', 'jobs/' + SID + '/cancel'),
            ('post', 'sessions/' + SID + '/slice'),
            ('get', 'sessions/' + SID + '/load'),
            ('patch', 'sessions/' + SID),
            ('post', 'results/exp-1'),
        ))

    def test_api_root_reverse(self):
        self.assertEqual(reverse('reconstruction:api_root'), '/studio/api/')
        self.assertEqual(reverse('reconstruction:api', kwargs={'path': 'health'}), '/studio/api/health')


# ---------------------------------------------------------------------------------------------------------------
# Прокси: пересылка
# ---------------------------------------------------------------------------------------------------------------

@override_settings(RECON_SERVICE_URL=SERVICE_URL, RECON_TOKEN=TOKEN)
class ApiForwardTest(StudioUsersMixin, ServiceMockMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.login('exp')

    def test_token_user_and_request_options(self):
        response = self.api('get', 'scans/exp-1/info')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(_body(response)), {'ok': True})
        method, url, kwargs = self.forwarded()
        self.assertEqual((method, url), ('GET', SERVICE_URL + 'scans/exp-1/info'))
        self.assertEqual(kwargs['headers']['X-Recon-Token'], TOKEN)
        self.assertEqual(kwargs['headers']['X-Recon-User'], b'exp')
        self.assertEqual(kwargs['headers']['Accept-Encoding'], 'identity')
        self.assertNotIn('Content-Type', kwargs['headers'])
        self.assertIsNone(kwargs['data'])
        self.assertEqual(kwargs['timeout'], (5, 300))
        self.assertIs(kwargs['stream'], True)
        self.assertIs(kwargs['allow_redirects'], False)

    def test_service_url_without_trailing_slash(self):
        with override_settings(RECON_SERVICE_URL='http://recon.test:5560'):
            self.api('get', 'health')
        self.assertEqual(self.forwarded()[1], 'http://recon.test:5560/health')

    def test_non_ascii_username_as_utf8_bytes(self):
        user = User.objects.create_user(username=u'иван')
        UserProfile.objects.create(user=user, is_guest=False, is_experimentator=True)
        self.client.force_login(user)
        self.api('post', 'sessions')
        self.assertEqual(self.forwarded()[2]['headers']['X-Recon-User'], u'иван'.encode('utf-8'))

    def test_query_with_repeated_keys(self):
        self.api('get', 'sessions/{}/slice?row=5&region=1&region=2&max_px=800'.format(SID))
        params = self.forwarded()[2]['params']
        self.assertEqual(sorted(params), sorted([('row', '5'), ('region', '1'), ('region', '2'), ('max_px', '800')]))
        self.assertEqual([v for k, v in params if k == 'region'], ['1', '2'])

    def test_post_body_and_content_type_as_is(self):
        body = json.dumps({'recipe': {'exp_id': EXP_ID, 'center': 1234.5}, 'name': u'Образец'},
                          ensure_ascii=False).encode('utf-8')
        self.client.post('/studio/api/jobs', data=body, content_type='application/json; charset=utf-8')
        method, url, kwargs = self.forwarded()
        self.assertEqual((method, url), ('POST', SERVICE_URL + 'jobs'))
        self.assertEqual(kwargs['data'], body)
        self.assertEqual(kwargs['headers']['Content-Type'], 'application/json; charset=utf-8')

    def test_empty_post_body(self):
        # как fetch без тела: ни тела, ни Content-Type
        self.client.generic('POST', '/studio/api/sessions/{}/ping'.format(SID), content_type='')
        kwargs = self.forwarded()[2]
        self.assertEqual(kwargs['data'], b'')
        self.assertNotIn('Content-Type', kwargs['headers'])

    def test_delete_forwarded(self):
        self.api('delete', 'sessions/' + SID)
        self.assertEqual(self.forwarded()[:2], ('DELETE', SERVICE_URL + 'sessions/' + SID))

    def test_binary_headers_and_body(self):
        body = bytes(range(256)) * 40
        headers = {
            'Content-Type': 'application/octet-stream',
            'Content-Length': str(len(body)),
            'X-Shape': '80,64',
            'X-Dtype': 'uint16',
            'X-Scale': '0.0001',
            'X-Offset': '-0.5',
            'X-Meta': '{"row":5,"axis":{"center":1234.5}}',
            'Access-Control-Expose-Headers': 'X-Shape',
            'Server': 'gunicorn',
            'Set-Cookie': 'a=b',
        }
        self.service.request.side_effect = lambda *a, **k: _upstream(200, body, headers)
        response = self.api('get', 'sessions/{}/slice?row=5'.format(SID))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(_body(response), body)
        for name in ('Content-Type', 'Content-Length', 'X-Shape', 'X-Dtype', 'X-Scale', 'X-Offset', 'X-Meta'):
            self.assertEqual(response[name], headers[name])
        self.assertEqual(response['Cache-Control'], 'no-store')
        for name in ('Access-Control-Expose-Headers', 'Server'):
            self.assertNotIn(name, response)
        self.assertNotIn('a', response.cookies)

    def test_file_streamed_in_chunks_and_closed(self):
        body = os.urandom(300 * 1024)
        headers = {
            'Content-Type': 'application/octet-stream',
            'Content-Length': str(len(body)),
            'Content-Disposition': "attachment; filename=obj.4.raw",
        }
        upstream = _upstream(200, body, headers)
        self.service.request.side_effect = None
        self.service.request.return_value = upstream
        response = self.api('get', 'results/exp-1/file/obj.4.raw')
        self.assertTrue(response.streaming)
        self.assertEqual(response['Content-Disposition'], headers['Content-Disposition'])
        self.assertEqual(response['Content-Length'], str(len(body)))
        chunks = list(response.streaming_content)
        self.assertEqual(b''.join(chunks), body)
        self.assertEqual(len(chunks), 5)
        upstream.iter_content.assert_called_once_with(64 * 1024)
        upstream.close.assert_called_once_with()

    def test_file_name_quoted(self):
        name = u'Образец 1.4.raw'
        self.api('get', 'results/exp-1/file/' + quote(name))
        self.assertEqual(self.forwarded()[1], SERVICE_URL + 'results/exp-1/file/' + quote(name))

    def test_service_status_passed_as_is(self):
        conflict = json.dumps({'error': 'busy', 'owner': 'other', 'exp_id': EXP_ID}).encode('utf-8')
        for status_code, body in ((409, conflict), (404, b'{"error": "nope"}'), (410, b'{"error": "taken_over"}'),
                                  (201, b'{"id": "x"}'), (500, b'{"error": "boom"}')):
            with self.subTest(status=status_code):
                self.service.request.side_effect = lambda *a, **k: _upstream(status_code, body)
                response = self.api('post', 'sessions')
                self.assertEqual(response.status_code, status_code)
                self.assertEqual(_body(response), body)
                self.assertEqual(response['Content-Type'], 'application/json')

    def test_service_unavailable_502(self):
        self.service.request.side_effect = requests.ConnectionError('Connection refused')
        response = self.api('get', 'jobs')
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {'error': u'Сервис реконструкции недоступен'})
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_service_timeout_504(self):
        for exc in (requests.ReadTimeout('read'), requests.ConnectTimeout('connect')):
            with self.subTest(exc=type(exc).__name__):
                self.service.request.side_effect = exc
                response = self.api('get', 'scans/exp-1/overview')
                self.assertEqual(response.status_code, 504)
                self.assertIn('error', response.json())

    def test_proxy_errors_do_not_mail_admins(self):
        # django.request шлёт mail_admins на каждый 5xx; при лежащем сервисе опрос задач завалил бы почту
        self.service.request.side_effect = requests.ConnectionError('Connection refused')
        self.api('get', 'jobs')
        self.service.request.side_effect = lambda *a, **k: _upstream(500, b'{"error": "boom"}')
        _body(self.api('get', 'jobs'))
        self.assertEqual(mail.outbox, [])

    def test_empty_token_503_without_request(self):
        for path in ('health', 'jobs'):
            with self.subTest(path=path), override_settings(RECON_TOKEN=''):
                response = self.api('get', path)
                self.assertEqual(response.status_code, 503)
                self.assertIn('RECON_TOKEN', response.json()['error'])
        self.service.request.assert_not_called()

    def test_stream_break_raises(self):
        upstream = _upstream(200, b'', {'Content-Type': 'application/octet-stream'})
        upstream.iter_content.side_effect = lambda size: self._broken_stream()
        self.service.request.side_effect = None
        self.service.request.return_value = upstream
        response = self.api('get', 'results/exp-1/file/obj.4.raw')
        with self.assertRaises(requests.ConnectionError):
            b''.join(response.streaming_content)

    @staticmethod
    def _broken_stream():
        yield b'abc'
        raise requests.ConnectionError('обрыв')

    def test_run_actions_logged(self):
        with self.assertLogs('storage_logger.reconstruction', 'INFO') as logs:
            self.api('post', 'jobs')
        self.assertTrue(any('POST jobs' in line and 'exp' in line for line in logs.output))


class HttpSessionTest(TestCase):
    def test_one_session_per_process(self):
        self.assertIsInstance(proxy._http(), requests.Session)
        self.assertIs(proxy._http(), proxy._http())


@override_settings(RECON_SERVICE_URL=SERVICE_URL, RECON_TOKEN=TOKEN)
class ApiCsrfTest(StudioUsersMixin, ServiceMockMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.csrf_client = self.login('exp', Client(enforce_csrf_checks=True))

    def test_unsafe_methods_without_token_forbidden(self):
        for method, path in (('post', 'jobs'), ('post', 'sessions'), ('delete', 'sessions/' + SID)):
            with self.subTest(method=method, path=path):
                self.assertEqual(self.api(method, path, client=self.csrf_client).status_code, 403)
        self.service.request.assert_not_called()

    def test_get_does_not_need_token(self):
        self.assertEqual(self.api('get', 'jobs', client=self.csrf_client).status_code, 200)

    def test_token_from_page_config_passes(self):
        with mock.patch('reconstruction.views.requests.post', return_value=_storage_experiment()):
            page = self.csrf_client.get('/studio/exp-1/')
        token = _studio_config(page)['csrf_token']
        self.service.request.side_effect = lambda *a, **k: _upstream(201, b'{"id": "job"}')
        response = self.api('post', 'jobs', client=self.csrf_client, HTTP_X_CSRFTOKEN=token)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.forwarded()[:2], ('POST', SERVICE_URL + 'jobs'))


# ---------------------------------------------------------------------------------------------------------------
# Кнопка на странице записи хранилища
# ---------------------------------------------------------------------------------------------------------------

class StorageRecordStudioButtonTest(StudioUsersMixin, TestCase):
    def get_record(self, exp_id='exp-1'):
        experiment = [{'_id': exp_id, 'specimen': 'sample',
                       'experiment parameters': {'advanced': False, 'DARK': {}, 'EMPTY': {}, 'DATA': {}}}]
        answers = [_storage_answer(200, json.dumps(experiment)), _storage_answer(200, '[]')]
        with mock.patch('storage.views.requests.post', side_effect=answers):
            return self.client.get('/storage/storage_record_{}/'.format(exp_id))

    def test_button_for_studio_roles(self):
        for name in ('res', 'exp', 'adm'):
            with self.subTest(role=name):
                self.login(name)
                response = self.get_record()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.context['studio_url'], '/studio/exp-1/')
                self.assertContains(response, 'href="/studio/exp-1/"')
                self.assertContains(response, u'Студия реконструкции')
                self.assertContains(response, u'Перейти к реконструкции')

    def test_no_button_for_guest(self):
        self.login('guest')
        response = self.get_record()
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.context['studio_url'])
        self.assertNotContains(response, '/studio/')
        self.assertContains(response, u'Перейти к реконструкции')
