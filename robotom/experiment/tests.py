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
        response = self.c.get('/experiment/')
        self.assertEqual(response.status_code, 200)

    '''def test_search_empty(self):
        self.c.login(username='exprm', password='exprm')
        response = self.c.post('/experiment/interface/',
                                    {
                                        'experiment id': '0536ba11-548a-4e98-92a7-61f126235332',
                                        'specimen': 'test',
                                        'tags': '',
                                        'experiment parameters':
                                            {
                                                'advanced': False,
                                                'DARK':
                                                    {
                                                        'count': 1,
                                                        'exposure': 1000
                                                    },
                                                'EMPTY':
                                                    {
                                                        'count': 1,
                                                        'exposure': 1000
                                                    },
                                                'DATA':
                                                    {
                                                        'step count': 1,
                                                        'exposure': 1000,
                                                        'angle step': 10,
                                                        'count per step': 1
                                                    }
                                            }
                                    })
        self.assertEqual(response.status_code, 200)
   '''


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
