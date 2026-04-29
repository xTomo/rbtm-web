from django.db import models, migrations


class Migration(migrations.Migration):

    dependencies = [
        ('experiment', '0002_auto_20150521_1023'),
    ]

    operations = [
        migrations.AddField(
            model_name='tomograph',
            name='angle',
            field=models.IntegerField(default=0),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='tomograph',
            name='current',
            field=models.FloatField(default=0),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='tomograph',
            name='exposure',
            field=models.IntegerField(default=0),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='tomograph',
            name='horizontal_shift',
            field=models.FloatField(default=0),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='tomograph',
            name='shutter',
            field=models.CharField(default='closed', max_length=6, choices=[('open', 'open'), ('closed', 'closed')]),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='tomograph',
            name='vertical_shift',
            field=models.FloatField(default=0),
            preserve_default=True,
        ),
        migrations.AddField(
            model_name='tomograph',
            name='voltage',
            field=models.FloatField(default=0),
            preserve_default=True,
        ),
        migrations.AlterField(
            model_name='tomograph',
            name='state',
            field=models.CharField(default='off', max_length=15, choices=[('off', 'off'), ('waiting', 'waiting'), ('experiment', 'experiment'), ('adjustment', 'adjustment')]),
            preserve_default=True,
        ),
    ]
