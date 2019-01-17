from django.conf.urls import url
from experiment import views

urlpatterns = [

    url(r'^$', views.experiment_view, name='index'),
    url(r'^adjustment/$', views.experiment_adjustment, name='index_adjustment'),
    url(r'^interface/$', views.experiment_interface, name='index_interface'),
    url(r'^tomograph/(?P<value_to_get>\S+)/$', views.experiment_tomograph, name='index_tomograph'),

]