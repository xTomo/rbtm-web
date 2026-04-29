from django.urls import include, re_path
from django.conf.urls.static import static
from django.contrib import admin
from django.conf import settings


urlpatterns = [

    re_path('', include('main.urls', namespace='main')),
    re_path(r'^experiment/', include('experiment.urls', namespace='experiment')),
    re_path(r'^storage/', include('storage.urls', namespace='storage')),

    re_path(r'^admin/', admin.site.urls),

    re_path(r'^accounts/', include('django.contrib.auth.urls')),

] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
