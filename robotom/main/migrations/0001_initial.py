from django.db import models, migrations
from django.conf import settings


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='RoleRequest',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('role', models.CharField(default='NONE', max_length=15, verbose_name='Запрос на изменение роли',
                    choices=[('NONE', '-----'), ('ADM', 'Админ'), ('EXP', 'Экспериментатор'), ('RES', 'Исследователь')])),
                ('comment', models.TextField(max_length=300, verbose_name='Комментарий', blank=True)),
            ],
        ),
        migrations.CreateModel(
            name='UserProfile',
            fields=[
                ('id', models.AutoField(verbose_name='ID', serialize=False, auto_created=True, primary_key=True)),
                ('full_name', models.CharField(max_length=100, verbose_name='ФИО')),
                ('is_guest', models.BooleanField(default=True, verbose_name='Гость')),
                ('is_admin', models.BooleanField(default=False, verbose_name='Админ')),
                ('is_experimentator', models.BooleanField(default=False, verbose_name='Экспериментатор')),
                ('is_researcher', models.BooleanField(default=False, verbose_name='Исследователь')),
                ('gender', models.CharField(default='N', max_length=6, verbose_name='Пол',
                    choices=[('F', 'Женский'), ('M', 'Мужской'), ('N', 'Не указан')])),
                ('phone_number', models.CharField(max_length=20, verbose_name='Телефон', blank=True)),
                ('address', models.CharField(max_length=100, verbose_name='Адрес', blank=True)),
                ('work_place', models.CharField(max_length=100, verbose_name='Место учёбы/работы', blank=True)),
                ('degree', models.CharField(max_length=50, verbose_name='Ученая степень', blank=True)),
                ('title', models.CharField(max_length=50, verbose_name='Звание', blank=True)),
                ('activation_key', models.CharField(max_length=50, verbose_name='Ключ активации', blank=True)),
                ('user', models.OneToOneField(to=settings.AUTH_USER_MODEL, on_delete=models.CASCADE)),
            ],
        ),
        migrations.AddField(
            model_name='rolerequest',
            name='user',
            field=models.ForeignKey(to='main.UserProfile', on_delete=models.CASCADE),
            preserve_default=True,
        ),
    ]
