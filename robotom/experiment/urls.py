from django.urls import re_path
from experiment import views

urlpatterns = [

    re_path(r'^$', views.experiment_view, name='index'),
    re_path(r'^adjustment/$', views.experiment_adjustment, name='index_adjustment'),
    re_path(r'^interface/$', views.experiment_interface, name='index_interface'),
    re_path(r'^tomograph/(?P<value_to_get>\S+)/$', views.experiment_tomograph, name='index_tomograph'),

]
