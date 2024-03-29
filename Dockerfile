FROM ubuntu:bionic

MAINTAINER buzmakov

ENV TZ=Europe/Moscow
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

ENV HTTPS=on

RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
    apt-get install -y pkg-config python python-pip python-dev apache2 libapache2-mod-wsgi libpq-dev libaugeas0 git libhdf5-dev 
    # apt-get build-dep -y python-h5py && \
    # rm -rf /var/lib/apt/lists/*

# RUN DEBIAN_FRONTEND=noninteractive apt-get update && \
#     apt-get -y install build-essential python-dev && \
#     apt-get build-dep -y python-h5py && \
#     rm -rf /var/lib/apt/lists/*

COPY requirements.txt /var/www/web/requirements.txt
WORKDIR /var/www/web/

RUN pip install -r requirements.txt

RUN a2enmod rewrite ssl proxy proxy_http

COPY . /var/www/web/

# setup apache
RUN cp /var/www/web/000-default.conf /etc/apache2/sites-available/

RUN sed -i "s/'HOST': 'localhost'/'HOST': 'database'/" robotom/robotom/settings.py

RUN mkdir -p robotom/media && mkdir -p robotom/logs && \
    touch robotom/logs/main.log robotom/logs/experiment.log robotom/logs/storage.log && \
    chown -R www-data:www-data robotom/media robotom/static robotom/logs && \
    chmod -R a+=rwx robotom/media robotom/logs
#	touch robotom/rest.log && chown www-data:www-data robotom/rest.log

RUN robotom/manage.py collectstatic --noinput

# ENV APACHE_RUN_USER www-data
# ENV APACHE_RUN_GROUP www-data
# ENV APACHE_LOG_DIR /var/log/apache2

COPY apache2-foreground /usr/local/bin/

EXPOSE 80
CMD ["apache2-foreground"]

