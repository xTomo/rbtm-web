from django.apps import AppConfig


class ExperimentConfig(AppConfig):
    name = 'experiment'
    verbose_name = 'Эксперимент'

    def ready(self):
        from django.db.models.signals import post_migrate
        post_migrate.connect(_ensure_default_tomograph, sender=self)


def _ensure_default_tomograph(sender, **kwargs):
    """Создаёт единственный объект Tomograph при первом запуске, если его ещё нет."""
    from .models import Tomograph
    if not Tomograph.objects.exists():
        Tomograph.objects.create(state='unavailable')
