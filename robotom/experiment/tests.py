import json
from unittest import mock

from django.test import TestCase
from django.test import Client, RequestFactory
from django.contrib.auth.models import User
from django.contrib.messages.storage.fallback import FallbackStorage
from django.contrib.sessions.middleware import SessionMiddleware

from experiment import views as experiment_views
from main.models import UserProfile


def _fake_response(status_code=200, content=b'{}', headers=None):
    """Строит мок ответа requests.Response с нужными для views полями."""
    resp = mock.Mock()
    resp.status_code = status_code
    if isinstance(content, str):
        content = content.encode('utf-8')
    resp.content = content
    resp.headers = headers if headers is not None else {'Content-Type': 'application/json'}
    resp.iter_content = mock.Mock(return_value=[content])
    return resp


def _fake_request():
    """Django-запрос с рабочими session/messages, но без реального HTTP-цикла —
    для юнит-тестирования вспомогательных функций (try_request_post/get и т.п.)."""
    rf = RequestFactory()
    request = rf.get('/')
    SessionMiddleware(lambda r: None).process_request(request)
    request.session.save()
    request._messages = FallbackStorage(request)
    return request


# TODO: it may be experiment tests should be in experiment service

class ExpPageTest(TestCase):
    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm', password='exprm')
        self.up_exp = UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm', password='exprm')

    def test_exp_available(self):
        # '/experiment/' всегда редиректит на '/experiment/interface/' (см. experiment_view)
        response = self.c.get('/experiment/')
        self.assertEqual(response.status_code, 302)
        # /experiment/interface/ обёрнут update_state_before_run, который ходит в
        # get_current_state (EXPERIMENT_GET_STATE) — мокаем, чтобы тест не лез в сеть.
        with mock.patch('experiment.views.requests.get', side_effect=_experiment_start_fake_get):
            response = self.c.get('/experiment/interface/')
        self.assertEqual(response.status_code, 200)


class TryRequestHelpersTest(TestCase):
    """Пункт 1: try_request_post/try_request_get должны показывать пользователю
    текст ошибки из JSON-тела ответа drivers, а не-JSON тело (HTML 500) —
    понятным сообщением без 'отсутствует подключение к сети'."""

    def test_post_409_json_error_shown_to_user(self):
        request = _fake_request()
        body = json.dumps({
            'success': False,
            'error': 'On this tomograph experiment is running',
            'exception message': 'RuntimeError: busy',
        })
        with mock.patch('experiment.views.requests.post', return_value=_fake_response(409, body)):
            result = experiment_views.try_request_post(request, 'http://x/', '{}', 'experiment:index_interface')

        self.assertIsNotNone(result['error'])
        rendered = [str(m) for m in request._messages]
        self.assertTrue(any('On this tomograph experiment is running' in m for m in rendered))
        self.assertTrue(any('RuntimeError: busy' in m for m in rendered))

    def test_get_409_json_error_shown_to_user(self):
        request = _fake_request()
        body = json.dumps({'success': False, 'error': 'Could not connect with tomograph'})
        with mock.patch('experiment.views.requests.get', return_value=_fake_response(503, body)):
            result = experiment_views.try_request_get(request, 'http://x/', 'experiment:index_interface')

        self.assertIsNotNone(result['error'])
        rendered = [str(m) for m in request._messages]
        self.assertTrue(any('Could not connect with tomograph' in m for m in rendered))

    def test_post_500_html_body_gives_generic_message_without_network_wording(self):
        request = _fake_request()
        html = b'<html><body><h1>Internal Server Error</h1></body></html>'
        with mock.patch('experiment.views.requests.post', return_value=_fake_response(500, html)):
            result = experiment_views.try_request_post(request, 'http://x/', '{}', 'experiment:index_interface')

        self.assertIsNotNone(result['error'])
        rendered = [str(m) for m in request._messages]
        self.assertTrue(any('HTTP 500' in m for m in rendered))
        self.assertFalse(any('отсутствует подключение к сети' in m for m in rendered))

    def test_get_500_html_body_gives_generic_message_without_network_wording(self):
        request = _fake_request()
        html = b'<html><body><h1>Internal Server Error</h1></body></html>'
        with mock.patch('experiment.views.requests.get', return_value=_fake_response(500, html)):
            result = experiment_views.try_request_get(request, 'http://x/', 'experiment:index_interface')

        self.assertIsNotNone(result['error'])
        rendered = [str(m) for m in request._messages]
        self.assertTrue(any('HTTP 500' in m for m in rendered))
        self.assertFalse(any('отсутствует подключение к сети' in m for m in rendered))


class ExperimentSourceStateTest(TestCase):
    """Пункт 2: experiment_source_state должен превращать не-200 ответ drivers
    в JSON {available: false, error} с кодом 502, а не в 200 {on: false}."""

    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm2', password='exprm2')
        UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm2', password='exprm2')

    def test_503_becomes_502_json(self):
        body = json.dumps({'success': False, 'error': 'Could not connect with tomograph'})
        with mock.patch('experiment.views.requests.get', return_value=_fake_response(503, body)):
            response = self.c.get('/experiment/source/state/')

        self.assertEqual(response.status_code, 502)
        data = json.loads(response.content)
        self.assertFalse(data['available'])
        self.assertIn('error', data)

    def test_200_non_dict_json_becomes_502(self):
        # drivers вернули 200 с валидным JSON, но не объектом (например, список) —
        # data.get('result', ...) упал бы с AttributeError вместо понятной ошибки.
        body = json.dumps(['not', 'a', 'dict'])
        with mock.patch('experiment.views.requests.get', return_value=_fake_response(200, body)):
            response = self.c.get('/experiment/source/state/')

        self.assertEqual(response.status_code, 502)
        data = json.loads(response.content)
        self.assertFalse(data['available'])
        self.assertIn('error', data)


class ExperimentTomographTest(TestCase):
    """Пункт 3: неизвестный ключ -> 404, requests.RequestException -> 502 JSON,
    отсутствие Content-Type в ответе drivers -> application/json по умолчанию."""

    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm3', password='exprm3')
        UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm3', password='exprm3')

    def test_unknown_key_returns_404(self):
        response = self.c.get('/experiment/tomograph/not-a-real-key/')
        self.assertEqual(response.status_code, 404)

    def test_connection_error_returns_502_json(self):
        import requests as requests_lib
        with mock.patch('experiment.views.requests.get',
                        side_effect=requests_lib.exceptions.ConnectionError('refused')):
            response = self.c.get('/experiment/tomograph/{}/'.format(experiment_views.GET_VOLT))

        self.assertEqual(response.status_code, 502)
        data = json.loads(response.content)
        self.assertFalse(data['success'])

    def test_missing_content_type_defaults_to_json(self):
        with mock.patch('experiment.views.requests.get',
                        return_value=_fake_response(200, '{"success": true}', headers={})):
            response = self.c.get('/experiment/tomograph/{}/'.format(experiment_views.GET_VOLT))

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'application/json')


class GetPreviewDataTest(TestCase):
    """Пункт 4: 409 от drivers должен пробрасываться как 409 с текстом error,
    а не превращаться в 502 'detector error 409'; таймаут = max(TIMEOUT_DEFAULT, 2*exposure_sec+30)."""

    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm4', password='exprm4')
        UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm4', password='exprm4')

    def test_409_passthrough(self):
        body = json.dumps({'success': False, 'error': 'On this tomograph experiment is running'})
        with mock.patch('experiment.views.requests.post', return_value=_fake_response(409, body)):
            response = self.c.post(
                '/experiment/adjustment/preview-data/',
                data=json.dumps({'exposure_sec': 1.0}),
                content_type='application/json',
            )

        self.assertEqual(response.status_code, 409)
        data = json.loads(response.content)
        self.assertIn('On this tomograph experiment is running', data['error'])

    def test_timeout_uses_double_exposure_plus_30(self):
        body = json.dumps({'success': False, 'error': 'busy'})
        with mock.patch('experiment.views.requests.post', return_value=_fake_response(409, body)) as mocked_post:
            self.c.post(
                '/experiment/adjustment/preview-data/',
                data=json.dumps({'exposure_sec': 50.0}),
                content_type='application/json',
            )
        # timeout = max(TIMEOUT_DEFAULT, 2*exposure_sec + 30) = max(120, 130) = 130
        self.assertEqual(mocked_post.call_args.kwargs['timeout'], 130)


def _experiment_start_fake_get(*args, **kwargs):
    # get_current_state опрашивает EXPERIMENT_GET_STATE после сохранения параметров
    return _fake_response(200, json.dumps({'success': True, 'result': 'ready'}))


class ExperimentInterfaceParamsTest(TestCase):
    """Пункт 5: парсинг полей формы параметров эксперимента не должен приводить к 500,
    и должен собирать данные с корректными типами для выбранного режима."""

    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm6', password='exprm6')
        UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm6', password='exprm6')

    def test_empty_exposure_does_not_crash(self):
        response = self.c.post('/experiment/interface/', {
            'parameters': '1',
            'mode': 'simple',
            'name': 'sample',
            'tags': '',
            'de_quantity': '3',
            'exposure_sec': '',
            'data_shots_quantity': '10',
            'data_angle': '1.0',
            'data_same': '1',
        })
        self.assertEqual(response.status_code, 302)
        # experiment_interface вызывает get_current_state (EXPERIMENT_GET_STATE) на
        # каждый GET — мокаем, чтобы тест не лез в сеть с таймаутом 120с.
        with mock.patch('experiment.views.requests.get', side_effect=_experiment_start_fake_get):
            response = self.c.get('/experiment/interface/')
        rendered = [str(m) for m in response.context['messages']]
        self.assertTrue(any(rendered), 'ожидалось сообщение об ошибке формы')

    def test_missing_field_does_not_crash(self):
        response = self.c.post('/experiment/interface/', {
            'parameters': '1',
            'mode': 'simple',
            'name': 'sample',
            'tags': '',
            # de_quantity отсутствует
            'exposure_sec': '1.5',
            'data_shots_quantity': '10',
            'data_angle': '1.0',
            'data_same': '1',
        })
        self.assertEqual(response.status_code, 302)

    def test_simple_mode_payload_types(self):
        with mock.patch('experiment.views.requests.post') as mocked_post, \
             mock.patch('experiment.views.requests.get', side_effect=_experiment_start_fake_get):
            mocked_post.return_value = _fake_response(200, json.dumps({'success': True}))
            self.c.post('/experiment/interface/', {
                'parameters': '1',
                'mode': 'simple',
                'name': 'sample',
                'tags': 'a, b',
                'de_quantity': '3',
                'exposure_sec': '1.5',
                'data_shots_quantity': '10',
                'data_angle': '0.5',
                'data_same': '2',
            })

        sent_body = json.loads(mocked_post.call_args[0][1])
        params = sent_body['experiment parameters']
        self.assertFalse(params['advanced'])
        self.assertIsInstance(params['DARK']['count'], int)
        self.assertEqual(params['DARK']['count'], 3)
        self.assertIsInstance(params['DARK']['exposure'], float)
        self.assertEqual(params['DARK']['exposure'], 1500.0)
        self.assertIsInstance(params['DATA']['angle step'], float)
        self.assertEqual(params['DATA']['angle step'], 0.5)
        self.assertIsInstance(params['DATA']['count per step'], int)
        self.assertEqual(params['DATA']['count per step'], 2)

    def test_advanced_mode_payload_types(self):
        with mock.patch('experiment.views.requests.post') as mocked_post, \
             mock.patch('experiment.views.requests.get', side_effect=_experiment_start_fake_get):
            mocked_post.return_value = _fake_response(200, json.dumps({'success': True}))
            self.c.post('/experiment/interface/', {
                'parameters': '1',
                'mode': 'advanced',
                'name': 'sample',
                'tags': '',
                'exposure_sec': '2.0',
                'series_length': '10',
                'empty_period': '50',
                'data_shots_quantity': '500',
                'data_angle': '0.36',
                'data_same': '1',
            })

        sent_body = json.loads(mocked_post.call_args[0][1])
        params = sent_body['experiment parameters']
        self.assertTrue(params['advanced'])
        self.assertIsInstance(params['exposure'], float)
        self.assertEqual(params['exposure'], 2000.0)
        self.assertIsInstance(params['series_length'], int)
        self.assertEqual(params['series_length'], 10)


class ExperimentStatusProxyTest(TestCase):
    """Пункт 11: passthrough-проверка проксирования /experiment/status/ —
    JSON с result из 10 полей (включая last_frame_at) отдаётся как есть."""

    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm7', password='exprm7')
        UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm7', password='exprm7')

    def test_status_proxy_passthrough(self):
        result = {
            'running': True,
            'exp_id': 'abc-123',
            'frame_num': 5,
            'total_frames': 10,
            'progress_pct': 50,
            'current_mode': 'data',
            'current_angle': 12.5,
            'elapsed_sec': 30,
            'last_frame_at': 1700000000.0,
            'timeline': [{'mode': 'data', 'count': 5}],
        }
        body = json.dumps({'success': True, 'result': result})
        with mock.patch('experiment.views.requests.get', return_value=_fake_response(200, body)):
            response = self.c.get('/experiment/status/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Type'], 'application/json')
        data = json.loads(response.content)
        self.assertEqual(data['result'], result)
        self.assertIn('last_frame_at', data['result'])


class AutocompleteTagsTest(TestCase):
    """Пункт 8: get_autocomplete_data должен разбирать 'tags' как список,
    а не только как строку (Storage API допускает оба варианта)."""

    def setUp(self):
        self.u_exp = User.objects.create_user(username='exprm8', password='exprm8')
        UserProfile.objects.create(user=self.u_exp, is_experimentator=True)
        self.c = Client()
        self.c.login(username='exprm8', password='exprm8')

    def test_tags_list_is_parsed(self):
        experiments = [{
            'specimen': 'sample',
            'tags': ['tag1, tag2', 'tag3'],
            'experiment parameters': {'advanced': False, 'DARK': {}, 'EMPTY': {}, 'DATA': {}},
        }]
        with mock.patch('experiment.views.requests.post',
                        return_value=_fake_response(200, json.dumps(experiments))):
            response = self.c.get('/experiment/autocomplete/')

        data = json.loads(response.content)
        self.assertEqual(sorted(data['tags']), ['tag1', 'tag2', 'tag3'])
