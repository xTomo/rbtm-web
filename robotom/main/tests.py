from django.test import TestCase
from django.test import Client
from django.contrib.auth.models import User
from main.models import UserProfile


class LoginTest(TestCase):
    def setUp(self):
        self.u_adm = User.objects.create_user(username='admin', password='admin', email='mailadmin@mail.ru')
        self.up_adm = UserProfile.objects.create(user=self.u_adm, is_admin=True)

        self.u_exp = User.objects.create_user(username='exprm', password='exprm')
        self.up_exp = UserProfile.objects.create(user=self.u_exp, is_experimentator=True)

        self.u_res = User.objects.create_user(username='resch', password='resch')
        self.up_res = UserProfile.objects.create(user=self.u_res, is_researcher=True)

        self.u_gst = User.objects.create_user(username='guest', password='guest')
        self.up_gst = UserProfile.objects.create(user=self.u_gst, is_guest=True)

        self.c = Client()

    def check_login_response(self, data, status_code):
        login_route = '/accounts/login/'
        response = self.c.post(login_route, data)
        self.assertEqual(response.status_code, status_code)

    def test_login_page(self):

        self.check_login_response(data={'username': 'admin', 'password': 'admin'}, status_code=302)
        self.check_login_response(data={'username': 'guest', 'password': 'guest'}, status_code=302)
        self.check_login_response(data={'username': 'guest', 'password': 'wrongpass'}, status_code=200)

    def test_register_ok(self):
        response = self.c.post('/accounts/register/',
                               {'username': 'admin2', 'password1': 'admin2', 'password2': 'admin2',
                                'email': 'mail@mail.ru', 'full_name': 'FIO', u'degree': '', u'title': u'',
                                u'gender': 'N', u'address': '', u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], '/accounts/done/')

    def test_register_existing_user(self):
        response = self.c.post('/accounts/register/',
                               {'username': 'admin', 'password1': 'admin2', 'password2': 'admin2',
                                'email': 'email@mail.ru', 'full_name': 'FIO', u'degree': '', u'title': u'',
                                u'gender': 'N', u'address': '', u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 200)

    def test_register_wrong_pass(self):
        response = self.c.post('/accounts/register/',
                               {'username': 'admin3', 'password1': 'admin2', 'password2': 'not_admin2',
                                'email': 'email@mail.ru', 'full_name': 'FIO', u'degree': '', u'title': u'',
                                u'gender': 'N', u'address': '', u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 200)

    def test_register_wrong_mail(self):
        response = self.c.post('/accounts/register/',
                               {'username': 'admin3', 'password1': 'admin2', 'password2': 'admin2',
                                'email': 'email@mail', 'full_name': 'FIO', u'degree': '', u'title': u'', u'gender': 'N',
                                u'address': '', u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 200)

        response = self.c.post('/accounts/register/',
                               {'username': 'admin3', 'password1': 'admin2', 'password2': 'admin2', 'email': '@mail.ru',
                                'full_name': 'FIO', u'degree': '', u'title': u'', u'gender': 'N', u'address': '',
                                u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 200)

    def test_register_duplicate_mail(self):
        response = self.c.post('/accounts/register/',
                               {'username': 'admin3', 'password1': 'admin2', 'password2': 'admin2',
                                'email': 'mailadmin@mail.ru', 'full_name': 'FIO', u'degree': '', u'title': u'',
                                u'gender': 'N', u'address': '', u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 200)

    def test_register_empty_full_name(self):
        response = self.c.post('/accounts/register/',
                               {'username': 'admin3', 'password1': 'admin2', 'password2': 'admin2',
                                'email': 'email@mail.ru', 'full_name': '', u'degree': '', u'title': u'', u'gender': 'N',
                                u'address': '', u'work_place': '', u'phone_number': ''})
        self.assertEqual(response.status_code, 200)

    def tearDown(self):
        self.up_adm.delete()
        self.u_adm.delete()
        self.up_res.delete()
        self.u_res.delete()
        self.up_gst.delete()
        self.u_gst.delete()
        self.up_exp.delete()
        self.u_exp.delete()


class ExperimentPermissionTest(TestCase):

    def setUp(self):

        self.u_adm = User.objects.create_user(username='admin', password='admin')
        self.up_adm = UserProfile.objects.create(user=self.u_adm, is_admin=True)

        self.u_exp = User.objects.create_user(username='exprm', password='exprm')
        self.up_exp = UserProfile.objects.create(user=self.u_exp, is_experimentator=True)

        self.u_res = User.objects.create_user(username='resch', password='resch')
        self.up_res = UserProfile.objects.create(user=self.u_res, is_researcher=True)

        self.u_gst = User.objects.create_user(username='guest', password='guest')
        self.up_gst = UserProfile.objects.create(user=self.u_gst, is_guest=True)

    def test_exp_perm(self):

        c = Client()

        # not logged in
        response = c.get('/experiment/')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], '/accounts/login/?next=/experiment/')

        # logged as admin
        c.login(username='admin', password='admin')
        response = c.get('/experiment/')
        self.assertEqual(response.status_code, 200)

        # logged as experimenter
        c.login(username='exprm', password='exprm')
        response = c.get('/experiment/')
        self.assertEqual(response.status_code, 200)

        # logged as researcher
        c.login(username='resch', password='resch')
        response = c.get('/experiment/')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], '/accounts/login/?next=/experiment/')

        # logged as guest
        c.login(username='guest', password='guest')
        response = c.get('/experiment/')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], '/accounts/login/?next=/experiment/')

        # logged as guest with wrong password
        c.login(username='guest', password='wrongpass')
        response = c.get('/experiment/')
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], '/accounts/login/?next=/experiment/')

    def tearDown(self):

        self.up_adm.delete()
        self.u_adm.delete()
        self.up_res.delete()
        self.u_res.delete()
        self.up_gst.delete()
        self.u_gst.delete()
        self.up_exp.delete()
        self.u_exp.delete()


class RoleRequestCancelTest(TestCase):
    """Пункт 12: POST 'cancel' на /role_request/ не должен падать с 500
    (new_request не был определён в ветке cancel)."""

    def setUp(self):
        self.u_gst = User.objects.create_user(username='guest_cancel', password='guest_cancel')
        self.up_gst = UserProfile.objects.create(user=self.u_gst, is_guest=True)
        self.c = Client()
        self.c.login(username='guest_cancel', password='guest_cancel')

    def test_cancel_redirects_to_profile(self):
        response = self.c.post('/role_request/', {'cancel': '1', 'role': 'RES', 'comment': ''})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response['Location'].endswith('/accounts/profile/'))


class AcceptRoleRequestTest(TestCase):
    """Пункт 13: принятие заявки на роль сохраняет роль в UserProfile напрямую,
    без обращения к несуществующему STORAGE_ALT_USER_HOST."""

    def setUp(self):
        from main.models import RoleRequest

        self.u_adm = User.objects.create_user(username='admin_accept', password='admin_accept')
        self.up_adm = UserProfile.objects.create(user=self.u_adm, is_admin=True)
        self.u_adm.is_staff = True
        self.u_adm.is_superuser = True
        self.u_adm.save()

        self.u_gst = User.objects.create_user(username='guest_accept', password='guest_accept',
                                              email='guest_accept@mail.ru')
        self.up_gst = UserProfile.objects.create(user=self.u_gst, is_guest=True)
        self.role_request = RoleRequest.objects.create(user=self.up_gst, role='RES')

        self.c = Client()
        self.c.login(username='admin_accept', password='admin_accept')

    def test_accept_saves_role_without_network_call(self):
        response = self.c.post('/manage_requests/', {
            'request_id': self.role_request.pk,
            'accept': '1',
        })
        self.assertEqual(response.status_code, 200)
        self.up_gst.refresh_from_db()
        self.assertTrue(self.up_gst.is_researcher)
        self.assertFalse(self.up_gst.is_guest)
