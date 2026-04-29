FROM python:3.12-slim

MAINTAINER buzmakov

ENV TZ=Europe/Moscow
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

ENV HTTPS=on

RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y --no-install-recommends \
        pkg-config \
        apache2 \
        apache2-dev \
        libpq-dev \
        libhdf5-dev \
        git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /var/www/web/requirements.txt
WORKDIR /var/www/web/

RUN pip install --no-cache-dir -r requirements.txt

# Установить mod_wsgi скомпилированный против Python 3.12 (из pip, а не из apt)
# apt-версия линкуется к системному Python и не видит наши пакеты
RUN pip install --no-cache-dir mod_wsgi && \
    mod_wsgi-express install-module > /etc/apache2/mods-available/wsgi.load && \
    a2enmod wsgi

RUN a2enmod rewrite ssl proxy proxy_http

COPY . /var/www/web/

# setup apache
RUN cp /var/www/web/000-default.conf /etc/apache2/sites-available/

RUN sed -i "s/'HOST': 'localhost'/'HOST': 'database'/" robotom/robotom/settings.py

RUN mkdir -p robotom/media && mkdir -p robotom/logs && \
    touch robotom/logs/main.log robotom/logs/experiment.log robotom/logs/storage.log && \
    chown -R www-data:www-data robotom/media robotom/static robotom/logs && \
    chmod -R a+=rwx robotom/media robotom/logs

RUN python robotom/manage.py collectstatic --noinput

COPY apache2-foreground /usr/local/bin/

EXPOSE 80

CMD ["apache2-foreground"]
