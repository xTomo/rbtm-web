from django.urls import path, re_path
from reconstruction import proxy, views

app_name = 'reconstruction'

urlpatterns = [
    # префикс API для страницы (reverse → /studio/api/); сам по себе — 404 JSON (нет в белом списке)
    path('api/', views.api_proxy, {'path': ''}, name='api_root'),
    path('api/<path:path>', views.api_proxy, name='api'),

    re_path(r'^(?P<exp_id>' + proxy.EXP_ID + r')/$', views.studio_view, name='studio'),
]
