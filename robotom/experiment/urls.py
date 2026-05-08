from django.urls import re_path
from experiment import views

app_name = 'experiment'

urlpatterns = [

    re_path(r'^$', views.experiment_view, name='index'),
    re_path(r'^control/$', views.experiment_control, name='index_control'),
    re_path(r'^source/state/$', views.experiment_source_state, name='source_state'),
    re_path(r'^adjustment/$', views.experiment_adjustment, name='index_adjustment'),
    re_path(r'^adjustment/preview-data/$', views.get_preview_data, name='preview_data'),
    re_path(r'^interface/$', views.experiment_interface, name='index_interface'),
    re_path(r'^autocomplete/$', views.get_autocomplete_data, name='autocomplete'),
    re_path(r'^status/$', views.experiment_status, name='status'),
    re_path(r'^last-frame/$', views.experiment_last_frame, name='last_frame'),
    re_path(r'^storage-preview/$', views.experiment_storage_preview, name='storage_preview'),
    re_path(r'^tomograph/(?P<value_to_get>\S+)/$', views.experiment_tomograph, name='index_tomograph'),

]
