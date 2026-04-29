from django.urls import re_path
from storage import views

urlpatterns = [

    re_path(
        r'^$',
        views.storage_view,
        name='index'),

    re_path(
        r'^storage_record_(?P<storage_record_id>[a-zA-Z\d\-]+)/$',
        views.storage_record_view,
        name='storage_record'
    ),

    re_path(
        r'^frames_downloading_(?P<storage_record_id>[a-zA-Z\d\-]+)/$',
        views.frames_downloading,
        name='frames_downloading'
    ),

    re_path(
        r'^delete_experiment_(?P<experiment_id>[a-zA-Z\d\-]+)/$',
        views.delete_experiment,
        name='delete_experiment'
    )
]
