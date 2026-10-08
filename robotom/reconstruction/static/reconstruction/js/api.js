/* Студия реконструкции — запросы к recon-service через прокси Django (config.api_base + путь сервиса).
 *
 * api.getJSON / postJSON / del / getBinary / postBinary / getText → Promise; ошибка — ApiError {status, code, body}.
 * Ошибки показываются всплывающим уведомлением, кроме: отменённых запросов, 409 superseded (запрос устарел),
 * и ожидаемых вызывающим (opts.expect: [статус | код ошибки]) — их обрабатывает вызывающий.
 * Канал (api.channel): новый запрос отменяет предыдущий (AbortController), seq растёт, для правок мышью —
 * задержка (debounce); устаревшие запросы завершаются значением api.STALE. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;

    var STALE = {stale: true};

    function ApiError(status, body, message) {
        this.name = 'ApiError';
        this.status = status;
        this.body = body || null;
        this.code = body && typeof body.error === 'string' ? body.error : null;
        this.message = message || (this.code || ('HTTP ' + status));
        this.silent = false;        // не показывать (устарел, отменён)
        this.reported = false;      // уже показан
    }
    ApiError.prototype = Object.create(Error.prototype);
    ApiError.prototype.constructor = ApiError;

    function isAbort(err) {
        return !!err && (err.name === 'AbortError' || err.aborted === true);
    }

    function isSuperseded(err) {
        return !!err && err.status === 409 && err.code === 'superseded';
    }

    /** Понятный текст ошибки. */
    function describe(err) {
        if (!err) return 'неизвестная ошибка';
        if (err.name !== 'ApiError') {
            if (err.name === 'TypeError') return 'нет связи с сервером (' + err.message + ')';
            return err.message || String(err);
        }
        var b = err.body || {};
        switch (err.code) {
            case 'busy':
                return 'интерактивная сессия занята пользователем ' + (b.owner || '?');
            case 'taken_over':
                return 'сессию перехватил пользователь ' + (b.by || '?') + ' — загрузите область снова';
            case 'not_found':
                return 'сессия закрыта (простой или перезапуск сервиса) — загрузите область снова';
            case 'forbidden':
                return 'сессия принадлежит пользователю ' + (b.owner || '?');
            case 'not_ready':
                return 'область ещё не загружена (состояние сессии: ' + (b.state || '?') + ')';
            case 'cancelled':
                return 'операция отменена';
            case 'acquiring':
                return 'съёмка эксперимента ещё идёт — студия откроет скан после её завершения';
            default:
                if (err.code) return err.code;
                return 'ошибка сервера: HTTP ' + err.status;
        }
    }

    function toast(msg, type, delay) {
        if (typeof root.showToast === 'function') {
            root.showToast(msg, type || 'info', delay);
        } else if (root.console) {
            root.console.log('[' + (type || 'info') + '] ' + msg);
        }
    }

    function expected(err, expect) {
        if (!expect || !expect.length) return false;
        return expect.indexOf(err.status) >= 0 || (err.code !== null && expect.indexOf(err.code) >= 0);
    }

    function Api(config) {
        this.config = config || {};
        this.base = this.config.api_base || '/studio/api/';
        if (this.base.charAt(this.base.length - 1) !== '/') this.base += '/';
    }

    Api.prototype.url = function (path, params) {
        var u = this.base + String(path).replace(/^\/+/, '');
        var qs = [];
        if (params) {
            Object.keys(params).forEach(function (k) {
                var v = params[k];
                if (v === null || v === undefined || v === '') return;
                qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
            });
        }
        return qs.length ? u + '?' + qs.join('&') : u;
    };

    /** Ошибка из ответа (тело JSON {error, ...} или что угодно). */
    function errorFrom(resp) {
        return resp.text().then(function (text) {
            var body = null;
            try {
                body = JSON.parse(text);
            } catch (e) {
                body = null;
            }
            if (body && typeof body !== 'object') body = null;
            var msg = body && body.error ? String(body.error) : ('HTTP ' + resp.status + (resp.statusText ? ' ' +
                resp.statusText : ''));
            return new ApiError(resp.status, body, msg);
        }, function () {
            return new ApiError(resp.status, null, 'HTTP ' + resp.status);
        });
    }

    /**
     * Запрос. opts: method, body (объект → JSON), params, signal, kind ('json' | 'binary' | 'text'),
     * expect (статусы/коды, которые вызывающий обработает сам), quiet (не показывать никакие ошибки).
     */
    Api.prototype.request = function (path, opts) {
        opts = opts || {};
        var self = this;
        var method = opts.method || 'GET';
        var headers = {'Accept': opts.kind === 'binary' ? 'application/octet-stream' : 'application/json'};
        var init = {method: method, headers: headers, credentials: 'same-origin', cache: 'no-store'};
        if (opts.signal) init.signal = opts.signal;
        if (method !== 'GET' && method !== 'HEAD') {
            headers['X-CSRFToken'] = this.config.csrf_token || '';
            if (opts.rawBody !== undefined) {           // тело как есть (HTML-оболочка 3D-вида)
                headers['Content-Type'] = opts.contentType || 'text/plain; charset=utf-8';
                init.body = opts.rawBody;
            } else {
                headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(opts.body === undefined ? {} : opts.body);
            }
        }
        var url = this.url(path, opts.params);
        return Promise.resolve().then(function () {
            return root.fetch(url, init);          // именно root.fetch(...): без this браузер бросит Illegal invocation
        }).then(function (resp) {
            if (!resp.ok) {
                return errorFrom(resp).then(function (err) {
                    throw err;
                });
            }
            if (opts.kind === 'binary') {
                return resp.arrayBuffer().then(function (buf) {
                    try {
                        return core.decodeBinary(buf, function (name) {
                            return resp.headers.get(name);
                        });
                    } catch (e) {
                        throw new ApiError(resp.status, null, 'некорректный бинарный ответ: ' + e.message);
                    }
                });
            }
            if (opts.kind === 'text') return resp.text();
            var ct = resp.headers.get('Content-Type') || '';
            if (ct.indexOf('json') < 0) {
                throw new ApiError(resp.status, null, 'неожиданный ответ сервера (не JSON) — возможно, истёк вход; ' +
                    'обновите страницу');
            }
            return resp.json();
        }).catch(function (err) {
            if (isAbort(err)) {
                err.silent = true;
                throw err;
            }
            if (isSuperseded(err)) {
                err.silent = true;
                throw err;
            }
            if (!opts.quiet && !expected(err, opts.expect)) {
                self.report(err, opts.what);
            }
            throw err;
        });
    };

    /** Показать ошибку (один раз); what — что делали («загрузка области»). */
    Api.prototype.report = function (err, what) {
        if (!err || err.silent || err.reported || isAbort(err) || isSuperseded(err)) return;
        try {
            err.reported = true;
        } catch (e) { /* не объект */ }
        toast((what ? what + ': ' : '') + describe(err), 'error', 8000);
    };

    Api.prototype.getJSON = function (path, params, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'GET', params: params, kind: 'json'}));
    };
    Api.prototype.postJSON = function (path, body, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'POST', body: body, kind: 'json'}));
    };
    Api.prototype.del = function (path, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'DELETE', kind: 'json'}));
    };
    Api.prototype.getBinary = function (path, params, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'GET', params: params, kind: 'binary'}));
    };
    /** POST с телом JSON и бинарным ответом (стопка фрагментов сравнения). */
    Api.prototype.postBinary = function (path, body, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'POST', body: body, kind: 'binary'}));
    };
    /** POST с телом-текстом (contentType) и ответом JSON. */
    Api.prototype.postText = function (path, text, contentType, params, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'POST', rawBody: text, contentType: contentType,
            params: params, kind: 'json'}));
    };
    Api.prototype.getText = function (path, params, opts) {
        return this.request(path, Object.assign({}, opts, {method: 'GET', params: params, kind: 'text'}));
    };

    // --- канал --------------------------------------------------------------------------------------------

    /**
     * Канал «последний выигрывает». run(fn[, now]) — fn(signal, seq) → Promise; результат — Promise значения,
     * либо api.STALE, если запрос вытеснен более новым, отменён или сервис ответил 409 superseded.
     * opts.delay — задержка перед запуском (правки мышью); opts.onBusy(bool) — идёт ли запрос.
     */
    function Channel(opts) {
        opts = opts || {};
        this.delay = opts.delay || 0;
        this.onBusy = opts.onBusy || null;
        this.id = 0;
        this.seq = 0;
        this.ctrl = null;
        this.timer = null;
        this.pendingResolve = null;
        this.busy = false;
    }

    Channel.prototype._setBusy = function (b) {
        if (this.busy === b) return;
        this.busy = b;
        if (this.onBusy) {
            try {
                this.onBusy(b);
            } catch (e) {
                if (root.console) root.console.error(e);
            }
        }
    };

    Channel.prototype._drop = function () {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.pendingResolve) {
            var r = this.pendingResolve;
            this.pendingResolve = null;
            r(STALE);
        }
        if (this.ctrl) {
            this.ctrl.abort();
            this.ctrl = null;
        }
    };

    Channel.prototype.run = function (fn, now) {
        var self = this;
        self._drop();
        var myId = ++self.id;
        self._setBusy(true);
        return new Promise(function (resolve, reject) {
            function go() {
                self.timer = null;
                self.pendingResolve = null;
                if (myId !== self.id) return resolve(STALE);
                var ctrl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
                self.ctrl = ctrl;
                self.seq = core.nextSeq(self.seq);
                var seq = self.seq;
                Promise.resolve().then(function () {
                    return fn(ctrl ? ctrl.signal : undefined, seq);
                }).then(function (v) {
                    if (myId !== self.id) return resolve(STALE);
                    self.ctrl = null;
                    self._setBusy(false);
                    resolve(v);
                }, function (err) {
                    if (myId !== self.id) return resolve(STALE);
                    self.ctrl = null;
                    self._setBusy(false);
                    if (isAbort(err) || isSuperseded(err)) return resolve(STALE);
                    reject(err);
                });
            }
            if (self.delay > 0 && !now) {
                self.pendingResolve = resolve;
                self.timer = setTimeout(go, self.delay);
            } else {
                go();
            }
        });
    };

    /** Отменить отложенный и идущий запросы. */
    Channel.prototype.cancel = function () {
        this.id++;
        this._drop();
        this._setBusy(false);
    };

    Api.prototype.channel = function (opts) {
        return new Channel(opts);
    };

    function isStale(v) {
        return v === STALE;
    }

    S.api = {
        Api: Api,
        ApiError: ApiError,
        Channel: Channel,
        STALE: STALE,
        isStale: isStale,
        isAbort: isAbort,
        isSuperseded: isSuperseded,
        describe: describe,
        toast: toast,
        create: function (config) {
            return new Api(config);
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
