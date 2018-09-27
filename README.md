# RBTM-Web

**Setup project:**

`pip install -r requirements.txt`

**Run in development mode:**

`set DJANGO_SETTINGS_MODULE=robotom.dev_settings`(Windows shell)

`./robotom/manage.py runserver`

or

`./robotom/manage.py runserver --settings=robotom.dev_settings`

**Run in production mode:**

Create `.robotom/robotom/settings.py` as a copy of `dev_settings.py` with actual production settings

`./robotom/manage.py runserver` 
