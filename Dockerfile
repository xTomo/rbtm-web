# Базовый образ закреплён вместе с выпуском Debian. Голый тег python:3.12-slim переезжает на каждый новый Debian
# (осенью 2026 он уже на trixie) и обновляется вместе с ним — после каждого такого переезда кэш слоёв не годится
# и образ собирается с нуля (apt, pip). Обновлять базу — сознательно, сменой тега здесь.
FROM python:3.12-slim-trixie

LABEL maintainer="buzmakov"

ENV TZ=Europe/Moscow
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

ENV HTTPS=on

# Без RUN --mount (кэш BuildKit): на сервере docker-compose v1 собирает классическим сборщиком, он этот флаг
# не знает. Слои apt и pip берутся из кэша слоёв, пока не меняются база, список пакетов или requirements.txt.
RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y --no-install-recommends \
        pkg-config \
        apache2 \
        apache2-dev \
        libpq-dev \
        git \
    && rm -rf /var/lib/apt/lists/*

# Зависимости — до копирования кода: правка кода не трогает слои apt и pip.
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

RUN mkdir -p robotom/media && mkdir -p robotom/logs && \
    touch robotom/logs/main.log robotom/logs/experiment.log robotom/logs/storage.log && \
    chown -R www-data:www-data robotom/media robotom/static robotom/logs && \
    chmod -R a+=rwx robotom/media robotom/logs

RUN python robotom/manage.py collectstatic --noinput

COPY apache2-foreground /usr/local/bin/

EXPOSE 80

RUN chmod u+x apache2-foreground
CMD ["apache2-foreground"]
