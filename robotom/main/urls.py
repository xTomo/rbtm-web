from django.urls import re_path
from django.conf import settings
from main import views
from django.conf.urls.static import static
from django.contrib.staticfiles.urls import staticfiles_urlpatterns


urlpatterns = [

    re_path(r'^$', views.index, name='index'),
    re_path(r'^group1/', views.group1, name='group_1'),
    re_path(r'^group2/', views.group2, name='group_2'),
    re_path(r'^group3/', views.group3, name='group_3'),

    re_path(r'^accounts/profile/$', views.profile_view, name='profile'),
    re_path(r'^accounts/confirm/(?P<activation_key>[0-9A-Za-z]+)/$', views.confirm_view,
        name='registration_confirm'),

    re_path(r'^accounts/register/$', views.registration_view, name='register'),
    re_path(r'^accounts/done/$', views.done_view, name='done'),
    re_path(r'^accounts/login/$', views.login_view, name='login'),
    re_path(r'^role_request/$', views.role_request_view, name='role_request'),
    re_path(r'^manage_requests/$', views.manage_requests_view, name='manage_requests'),

]


if settings.DEBUG:
    if settings.MEDIA_ROOT:
        urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

urlpatterns += staticfiles_urlpatterns()
