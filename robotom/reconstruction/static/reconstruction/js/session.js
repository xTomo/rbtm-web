/* Студия реконструкции — интерактивная сессия recon-service (одна на сервис, на GPU сессии).
 *
 * Открытие (POST sessions) при занятой другим пользователем сессии — 409 busy: диалог перехвата (force: true).
 * Загрузка области (POST sessions/<sid>/load) → опрос GET sessions/<sid> раз в секунду до ready/error/open,
 * отмена (POST .../load/cancel); пока сессия есть — POST .../ping раз в минуту. Идентификатор сессии хранится в
 * localStorage по exp_id: после перезагрузки страницы загруженная область подхватывается без повторной загрузки;
 * без него (другой браузер, хранилище недоступно) — своя открытая сессия по этому скану находится через /health.
 * Потеря сессии (410 taken_over, 404 not_found, 403 forbidden) — событие 'lost'.
 *
 * События: 'state' (session json) — новое состояние; 'lost' (ошибка) — сессии больше нет. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;

    var POLL_MS = 1000;
    var PING_MS = 60000;
    var SESSION_ERRORS = ['not_found', 'taken_over', 'forbidden'];

    function isSessionError(err) {
        return !!err && [403, 404, 410].indexOf(err.status) >= 0 && SESSION_ERRORS.indexOf(err.code) >= 0;
    }

    function storageGet(key) {
        try {
            return root.localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            if (value === null) root.localStorage.removeItem(key);
            else root.localStorage.setItem(key, value);
        } catch (e) { /* хранилище недоступно — просто не запоминаем */ }
    }

    function SessionCtl(app) {
        core.Emitter.call(this);
        this.app = app;
        this.api = app.api;
        this.expId = app.config.exp_id;
        this.key = 'rbtm.studio.session.' + this.expId;
        this.sid = null;
        this.s = null;
        this._poll = null;
        this._ping = null;
        this._creating = null;
    }
    core.Emitter.mixin(SessionCtl.prototype);

    SessionCtl.isSessionError = isSessionError;
    SessionCtl.prototype.isSessionError = isSessionError;

    SessionCtl.prototype._setSid = function (sid) {
        this.sid = sid;
        storageSet(this.key, sid);
        if (sid) this._startPing();
        else this._stopPing();
    };

    /** Подхватить сессию, сохранённую при прошлом открытии страницы (если она ещё жива); без сохранённой — сессию
     *  этого пользователя по этому скану, открытую в другой вкладке или браузере (_adopt). */
    SessionCtl.prototype.restore = function () {
        var self = this;
        if (!this.app.config.can_run) return Promise.resolve(null);
        var sid = storageGet(this.key);
        var byId = !sid || !/^[0-9a-f]{32}$/.test(sid) ? Promise.resolve(null) :
            this.api.getJSON('sessions/' + sid, null, {quiet: true}).then(function (s) {
                return s && s.exp_id === self.expId && s.state !== 'closed' ? s : null;
            }, function () {
                return null;
            });
        return byId.then(function (s) {
            if (s) return s;
            storageSet(self.key, null);
            return self._adopt();
        }).then(function (s) {
            if (!s) return null;
            self._setSid(s.id);
            self._apply(s);
            if (s.state === 'loading') self._startPoll();
            return s;
        });
    };

    /** Открытая сессия этого пользователя по этому скану по /health: POST sessions вернёт её же (без перехвата).
     *  Чужую или по другому скану не трогаем — её перехват только по кнопке загрузки, с диалогом. */
    SessionCtl.prototype._adopt = function () {
        var self = this, user = this.app.config.user;
        return this.api.getJSON('health', null, {quiet: true}).then(function (h) {
            var cur = h && h.session;
            if (!cur || !cur.active || cur.owner !== user || cur.exp_id !== self.expId) return null;
            return self.api.postJSON('sessions', {exp_id: self.expId}, {quiet: true});
        }).then(function (s) {
            return s && s.id && s.exp_id === self.expId && s.state !== 'closed' ? s : null;
        }, function () {
            return null;
        });
    };

    /** Открыть сессию (или вернуть открытую). При занятости — диалог перехвата. Promise<sid>. */
    SessionCtl.prototype.ensure = function () {
        var self = this;
        if (this.sid) return Promise.resolve(this.sid);
        if (this._creating) return this._creating;
        var body = {exp_id: this.expId};
        var p = this.api.postJSON('sessions', body, {expect: ['busy'], what: 'Открытие сессии'}).catch(function (err) {
            if (!err || err.code !== 'busy') throw err;
            var b = err.body || {};
            var text = 'Интерактивная сессия (GPU) занята: пользователь «' + (b.owner || '?') + '» работает со сканом ' +
                (b.exp_id || '?') + ', последний запрос — ' + core.fmtDuration(b.idle_s) + ' назад. ' +
                'Перехватить сессию? Загруженная им область будет закрыта.';
            return S.ui.confirm('Сессия занята', text, 'Перехватить', 'btn-warning').then(function (ok) {
                if (!ok) {
                    var e = new Error('перехват отменён');
                    e.silent = true;
                    throw e;
                }
                return self.api.postJSON('sessions', {exp_id: self.expId, force: true}, {what: 'Перехват сессии'});
            });
        }).then(function (s) {
            self._creating = null;
            self._setSid(s.id);
            self._apply(s);
            return s.id;
        }, function (err) {
            self._creating = null;
            throw err;
        });
        this._creating = p;
        return p;
    };

    /** Загрузить область roi {x0, x1, y0, y1, preview_row}. */
    SessionCtl.prototype.load = function (roi, retried) {
        var self = this;
        return this.ensure().then(function (sid) {
            return self.api.postJSON('sessions/' + sid + '/load', {roi: roi},
                {expect: SESSION_ERRORS, what: 'Загрузка области'});
        }).then(function (s) {
            self._apply(s);
            self._startPoll();
            return s;
        }, function (err) {
            if (isSessionError(err)) {
                if (err.code === 'not_found' && !retried) {
                    // сессию закрыл уборщик по простою — открыть новую и повторить
                    self._setSid(null);
                    return self.load(roi, true);
                }
                self.lost(err);
            }
            throw err;
        });
    };

    SessionCtl.prototype.cancelLoad = function () {
        var self = this;
        if (!this.sid) return Promise.resolve(null);
        return this.api.postJSON('sessions/' + this.sid + '/load/cancel', {},
            {expect: SESSION_ERRORS, what: 'Отмена загрузки'}).then(function (s) {
            self._apply(s);
            return s;
        }, function (err) {
            if (isSessionError(err)) self.lost(err);
            throw err;
        });
    };

    /** Закрыть сессию (освободить GPU). */
    SessionCtl.prototype.close = function () {
        var sid = this.sid;
        this._stopPoll();
        this._setSid(null);
        this.s = null;
        if (!sid) return Promise.resolve();
        return this.api.del('sessions/' + sid, {quiet: true}).catch(function () {
            return null;
        });
    };

    SessionCtl.prototype._apply = function (s) {
        this.s = s;
        this.emit('state', s);
    };

    SessionCtl.prototype._startPoll = function () {
        var self = this;
        this._stopPoll();
        function tick() {
            self._poll = null;
            if (!self.sid) return;
            var sid = self.sid;
            self.api.getJSON('sessions/' + sid, null, {quiet: true}).then(function (s) {
                if (sid !== self.sid) return;
                self._apply(s);
                if (s.state === 'loading') self._poll = setTimeout(tick, POLL_MS);
            }, function (err) {
                if (sid !== self.sid) return;
                if (isSessionError(err)) {
                    self.lost(err);
                } else {
                    self._poll = setTimeout(tick, POLL_MS * 3);     // сеть или прокси — повторить позже
                }
            });
        }
        this._poll = setTimeout(tick, POLL_MS);
    };

    SessionCtl.prototype._stopPoll = function () {
        if (this._poll) clearTimeout(this._poll);
        this._poll = null;
    };

    SessionCtl.prototype._startPing = function () {
        var self = this;
        if (this._ping) return;
        this._ping = setInterval(function () {
            if (!self.sid) return;
            var sid = self.sid;
            self.api.postJSON('sessions/' + sid + '/ping', {}, {quiet: true}).catch(function (err) {
                if (sid === self.sid && isSessionError(err)) self.lost(err);
            });
        }, PING_MS);
    };

    SessionCtl.prototype._stopPing = function () {
        if (this._ping) clearInterval(this._ping);
        this._ping = null;
    };

    /** Сессии больше нет (перехвачена, закрыта по простою, чужая). */
    SessionCtl.prototype.lost = function (err) {
        if (!this.sid && !this.s) return;
        this._stopPoll();
        this._setSid(null);
        this.s = null;
        this.emit('lost', err);
    };

    /** Для модулей превью: ошибка сессии → 'lost'; true — обработана. */
    SessionCtl.prototype.handleError = function (err) {
        if (isSessionError(err)) {
            this.lost(err);
            return true;
        }
        return false;
    };

    S.SessionCtl = SessionCtl;
})(typeof window !== 'undefined' ? window : globalThis);
