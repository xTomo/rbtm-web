/* Студия реконструкции — панель задачи реконструкции.
 *
 * При открытии страницы — GET jobs?exp_id=<id>&limit=5: идущая задача показывается сразу (браузер можно было
 * закрыть). Опрос GET jobs/<id> раз в 1,5 с (при скрытой вкладке — 5 с), прогресс и стадия, «Отменить»
 * (POST jobs/<id>/cancel), ошибка — текст и «Лог» (GET jobs/<id>/log, текст в модальном окне).
 *
 * События: 'job' (doc) — состояние задачи; 'finished' (doc) — задача перешла в конечное состояние. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;

    var ACTIVE = ['queued', 'running', 'publishing'];
    var STATUS = {
        queued: 'в очереди', running: 'выполняется', publishing: 'перенос в хранилище', done: 'готово',
        error: 'ошибка', canceled: 'отменена', interrupted: 'прервана'
    };
    var STAGE = {
        start: 'запуск', wait_gpu: 'ждёт GPU (занят Jupyter или старой очередью)', crop: 'чтение кадров',
        prepare: 'подготовка: опорные кадры, сдвиги образца, ось', recon: 'реконструкция срезов',
        done: 'завершение', publish: 'перенос результата в хранилище'
    };
    var STATUS_CLS = {
        queued: 'info', running: 'primary', publishing: 'primary', done: 'success', error: 'danger',
        canceled: 'default', interrupted: 'warning'
    };

    function isActive(status) {
        return ACTIVE.indexOf(status) >= 0;
    }

    function pollDelay(hidden) {
        return hidden ? 5000 : 1500;
    }

    function statusText(status) {
        return STATUS[status] || status || '—';
    }

    function stageText(stage) {
        if (!stage) return '';
        return STAGE[stage] || stage;
    }

    /** Длительность задачи: от started (или created) до finished или now, секунды; null — нет данных. */
    function elapsed(job, now) {
        var a = Date.parse(job.started || job.created || '');
        if (isNaN(a)) return null;
        var b = job.finished ? Date.parse(job.finished) : (now || Date.now());
        if (isNaN(b)) return null;
        return Math.max(0, (b - a) / 1000);
    }

    function JobPanel(app) {
        core.Emitter.call(this);
        var self = this;
        this.app = app;
        this.api = app.api;
        this.el = S.ui.$('job-panel');
        this.mini = S.ui.$('run-job');
        this.job = null;
        this.recent = [];
        this._timer = null;
        this._busy = false;
        root.document.addEventListener('visibilitychange', function () {
            if (!root.document.hidden && self.job && isActive(self.job.status)) self._schedule(0);
        });
        this.render();
    }
    core.Emitter.mixin(JobPanel.prototype);

    JobPanel.prototype.loadRecent = function () {
        var self = this;
        return this.api.getJSON('jobs', {exp_id: this.app.config.exp_id, limit: 5}, {what: 'Список задач'})
            .then(function (list) {
                self.recent = Array.isArray(list) ? list : [];
                if (self.recent.length && (!self.job || self.job.id === self.recent[0].id)) {
                    self._set(self.recent[0]);
                    if (isActive(self.job.status)) self._schedule(pollDelay(root.document.hidden));
                } else {
                    self.render();
                }
                return self.recent;
            }, function () {
                self.render();
                return [];
            });
    };

    /** Показать задачу (документ или id) и опрашивать, пока она активна. */
    JobPanel.prototype.track = function (job) {
        if (typeof job === 'string') job = {id: job, _id: job, status: 'queued'};
        this._set(job);
        var known = false;
        for (var i = 0; i < this.recent.length; i++) {
            if (this.recent[i].id === job.id) {
                this.recent[i] = job;
                known = true;
            }
        }
        if (!known) this.recent.unshift(job);
        this.render();
        this._schedule(0);
    };

    JobPanel.prototype._set = function (job) {
        var prev = this.job;
        this.job = job;
        this.render();
        this.emit('job', job);
        if (prev && prev.id === job.id && isActive(prev.status) && !isActive(job.status)) {
            this.emit('finished', job);
        }
    };

    JobPanel.prototype._schedule = function (ms) {
        var self = this;
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(function () {
            self._timer = null;
            self._poll();
        }, ms);
    };

    JobPanel.prototype._poll = function () {
        var self = this, job = this.job;
        if (!job || !job.id) return;
        var id = job.id;
        this.api.getJSON('jobs/' + id, null, {quiet: true}).then(function (doc) {
            if (!self.job || self.job.id !== id) return;
            for (var i = 0; i < self.recent.length; i++) {
                if (self.recent[i].id === id) self.recent[i] = doc;
            }
            self._set(doc);
            if (isActive(doc.status)) self._schedule(pollDelay(root.document.hidden));
        }, function (err) {
            if (!self.job || self.job.id !== id) return;
            if (err && err.status === 404) return;          // задачу удалили — опрос прекращается
            self._schedule(pollDelay(true));                 // сеть или прокси — позже
        });
    };

    JobPanel.prototype.cancel = function () {
        var self = this, job = this.job;
        if (!job || !isActive(job.status)) return;
        S.ui.confirm('Отменить задачу?', 'Реконструкция будет остановлена, недописанные файлы удалены. ' +
            'Прежний результат (если был) останется.', 'Отменить задачу', 'btn-danger').then(function (ok) {
            if (!ok) return;
            self.api.postJSON('jobs/' + job.id + '/cancel', {}, {what: 'Отмена задачи'}).then(function (doc) {
                if (self.job && self.job.id === doc.id) self._set(doc);
                if (isActive(doc.status)) self._schedule(pollDelay(root.document.hidden));
            }, function () { /* показано */ });
        });
    };

    JobPanel.prototype.showLog = function (job) {
        job = job || this.job;
        if (!job) return;
        this.api.getText('jobs/' + job.id + '/log', {lines: 500}, {what: 'Лог задачи'}).then(function (text) {
            S.ui.textWindow('Лог задачи ' + String(job.id).slice(0, 8),
                text && text.trim() ? text : 'Лог пуст: задача ещё не запускалась или её каталог удалён ' +
                    '(после отмены или прерывания).');
        }, function () { /* показано */ });
    };

    // --- отрисовка ------------------------------------------------------------------------------------------

    JobPanel.prototype.render = function () {
        this._renderPanel();
        this._renderMini();
    };

    function badge(status) {
        var e = S.ui.el('span', {class: 'label label-' + (STATUS_CLS[status] || 'default'), text: statusText(status)});
        return e;
    }

    JobPanel.prototype._renderPanel = function () {
        var el = this.el, ui = S.ui, self = this;
        if (!el) return;
        ui.clear(el);
        var job = this.job;
        if (!job) {
            el.appendChild(ui.el('p', {class: 'text-muted', text: 'Задач реконструкции по этому скану не было.'}));
            return;
        }
        var active = isActive(job.status);
        var head = ui.el('div', {class: 'st-job-head'}, [
            badge(job.status),
            ' ',
            ui.el('span', {class: 'st-job-stage', text: active ? stageText(job.stage) : ''}),
            job.cancel_requested && active ? ui.el('span', {class: 'text-warning', text: ' · запрошена отмена'}) : null
        ]);
        el.appendChild(head);
        if (active) {
            var bar = ui.el('div', {class: 'progress st-progress'});
            el.appendChild(bar);
            var frac = job.status === 'queued' ? null : (core.isNum(job.progress) ? job.progress : null);
            ui.progress(bar, frac, frac === null ? (job.status === 'queued' ? 'в очереди' : '') : undefined);
        }
        var dur = elapsed(job);
        var info = [];
        if (job.user) info.push('запустил ' + job.user);
        info.push('создана ' + core.fmtDate(job.created));
        if (dur !== null && job.started) info.push((active ? 'идёт ' : 'длилась ') + core.fmtDuration(dur));
        if (job.finished && !active) info.push('завершена ' + core.fmtDate(job.finished));
        el.appendChild(ui.el('div', {class: 'st-job-info text-muted', text: info.join(' · ')}));
        if (job.error && (job.status === 'error' || job.status === 'interrupted')) {
            el.appendChild(ui.el('pre', {class: 'st-error', text: job.error}));
        }
        if (job.warnings && job.warnings.length) {
            var ul = ui.el('ul', {class: 'st-warnings'});
            job.warnings.forEach(function (w) {
                ul.appendChild(ui.el('li', {text: w}));
            });
            el.appendChild(ul);
        }
        var btns = ui.el('div', {class: 'st-job-btns'});
        if (active && this.app.config.can_run) {
            var cancel = ui.el('button', {type: 'button', class: 'btn btn-danger btn-xs', text: 'Отменить'});
            cancel.addEventListener('click', function () {
                self.cancel();
            });
            if (job.cancel_requested || job.status === 'publishing') {
                ui.enable(cancel, false, job.status === 'publishing' ? 'перенос файлов не прерывается' :
                    'отмена уже запрошена');
            }
            btns.appendChild(cancel);
            btns.appendChild(root.document.createTextNode(' '));
        }
        var logBtn = ui.el('button', {type: 'button', class: 'btn btn-default btn-xs', text: 'Лог'});
        logBtn.addEventListener('click', function () {
            self.showLog();
        });
        btns.appendChild(logBtn);
        el.appendChild(btns);

        var others = this.recent.filter(function (j) {
            return j.id !== job.id;
        });
        if (others.length) {
            var tbl = ui.el('table', {class: 'table table-condensed st-job-list'});
            var tb = ui.el('tbody');
            others.forEach(function (j) {
                var tr = ui.el('tr', {title: 'Показать эту задачу'}, [
                    ui.el('td', {text: core.fmtDate(j.created)}),
                    ui.el('td', null, [badge(j.status)]),
                    ui.el('td', {class: 'text-muted', text: j.user || ''})
                ]);
                tr.addEventListener('click', function () {
                    self.track(j);
                });
                tb.appendChild(tr);
            });
            tbl.appendChild(tb);
            el.appendChild(ui.el('div', {class: 'st-job-others'}, [
                ui.el('div', {class: 'text-muted small', text: 'Прежние задачи:'}), tbl
            ]));
        }
    };

    JobPanel.prototype._renderMini = function () {
        var el = this.mini, ui = S.ui;
        if (!el) return;
        ui.clear(el);
        var job = this.job;
        if (!job) {
            ui.hide(el);
            return;
        }
        ui.show(el);
        var active = isActive(job.status);
        el.appendChild(ui.el('div', null, [
            ui.el('span', {text: 'Задача: '}), badge(job.status),
            active && job.stage ? ui.el('span', {class: 'text-muted', text: ' ' + stageText(job.stage)}) : null
        ]));
        if (active) {
            var bar = ui.el('div', {class: 'progress st-progress st-progress-sm'});
            el.appendChild(bar);
            var frac = job.status === 'queued' ? null : (core.isNum(job.progress) ? job.progress : null);
            ui.progress(bar, frac);
        }
    };

    S.jobs = {
        ACTIVE: ACTIVE, STATUS: STATUS, STAGE: STAGE, isActive: isActive, pollDelay: pollDelay,
        statusText: statusText, stageText: stageText, elapsed: elapsed, JobPanel: JobPanel
    };
})(typeof window !== 'undefined' ? window : globalThis);
