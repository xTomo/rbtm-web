/* Студия реконструкции — задача реконструкции: строка статуса в шапке (#st-job) и подробности в шаге 4 (#run-job).
 *
 * При открытии страницы — GET jobs?exp_id=<id>&limit=5: идущая задача показывается сразу (браузер можно было
 * закрыть). Опрос GET jobs/<id> раз в 1,5 с (при скрытой вкладке — 5 с), прогресс и стадия, «Отменить»
 * (POST jobs/<id>/cancel), ошибка — первая строка, полный текст под «Подробно» и «Лог» (GET jobs/<id>/log).
 * Шапка: «в очереди», «стадия · 42 % · прошло … · ≈ … осталось» с полосой, «✓ Готово 14:32 (7 мин) · Показать»,
 * «✕ Ошибка 14:32 · Лог», «Отменена 14:32»; законченная задача видна сутки. Остаток — по оценке шага 4,
 * запомненной при запуске (setEstimate); экстраполировать по progress нельзя — доли стадий в нём заданы
 * константами (reconengine/pipeline.py) и не пропорциональны времени.
 *
 * События: 'job' (doc) — состояние задачи; 'finished' (doc) — задача перешла в конечное состояние; 'open'
 * ('step' | 'result') — щелчок по статусу: раскрыть шаг 4 или показать результат. */
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
        this.head = S.ui.$('st-job');
        this.mini = S.ui.$('run-job');
        this.est = {};                  // id задачи → оценка времени при запуске, с
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

    // --- оценка времени при запуске ------------------------------------------------------------------------
    // Оценка шага 4 считается для текущих настроек, а их после запуска можно менять — поэтому она запоминается в
    // момент запуска по id задачи (и в localStorage: переживает перезагрузку страницы).

    var EST_KEY = 'studio.jobEstimate.';

    JobPanel.prototype.setEstimate = function (jobId, totalS) {
        if (!jobId || !(totalS > 0)) return;
        this.est[jobId] = totalS;
        try {
            if (root.localStorage) root.localStorage.setItem(EST_KEY + jobId, String(totalS));
        } catch (e) { /* приватный режим — только в памяти */ }
        this.render();
    };

    JobPanel.prototype.estimateOf = function (jobId) {
        if (!jobId) return null;
        if (this.est[jobId] > 0) return this.est[jobId];
        try {
            var v = root.localStorage ? parseFloat(root.localStorage.getItem(EST_KEY + jobId)) : NaN;
            if (v > 0) {
                this.est[jobId] = v;
                return v;
            }
        } catch (e) { /* нет доступа */ }
        return null;
    };

    /** Сколько осталось, с: оценка при запуске − прошло со старта (без ожидания в очереди); null — оценки нет
     *  или задача не началась; отрицательное — идёт дольше оценки. */
    function remaining(job, estS, now) {
        if (!(estS > 0) || !job || !job.started) return null;
        var e = elapsed(job, now);
        return e === null ? null : estS - e;
    }

    /** Строка «прошло … · осталось ≈ …» для идущей задачи. */
    function timeText(job, estS, now) {
        var e = elapsed(job, now);
        if (e === null || !job.started) return '';
        var s = 'прошло ' + core.fmtDuration(e);
        var r = remaining(job, estS, now);
        if (r === null) return s;
        if (r >= 0) return s + ' · ≈ ' + core.fmtDuration(r) + ' осталось';
        return s + ' · дольше оценки на ' + core.fmtDuration(-r);
    }

    /** Строка статуса в шапке: {state, text, action} или null — показывать нечего (нет задач; закончена больше
     *  суток назад). action: 'step' — раскрыть шаг 4, 'result' — показать результат. */
    function headState(job, estS, now) {
        if (!job) return null;
        now = now || Date.now();
        var st = job.status;
        if (st === 'queued') return {state: 'queued', text: 'В очереди · ждёт GPU', action: 'step'};
        if (isActive(st)) {
            var frac = core.isNum(job.progress) ? job.progress : null;
            var parts = [stageText(job.stage) || statusText(st)];
            if (frac !== null) parts.push(Math.round(frac * 100) + ' %');
            var t = timeText(job, estS, now);
            if (t) parts.push(t);
            if (job.cancel_requested) parts.push('запрошена отмена');
            return {state: 'running', text: parts.join(' · '), frac: frac, action: 'step'};
        }
        var fin = Date.parse(job.finished || '');
        if (!isNaN(fin) && now - fin > 24 * 3600 * 1000) return null;
        var when = job.finished ? ' ' + core.fmtTime(job.finished) : '';
        var dur = elapsed(job, now);
        if (st === 'done') {
            return {state: 'done', text: '✓ Готово' + when + (dur !== null ? ' (' + core.fmtDuration(dur) + ')' : ''),
                action: 'result'};
        }
        if (st === 'error' || st === 'interrupted') {
            return {state: 'error', text: '✕ ' + (st === 'error' ? 'Ошибка' : 'Прервана') + when, action: 'step'};
        }
        return {state: 'canceled', text: 'Отменена' + when, action: 'step'};
    }

    // --- отрисовка ------------------------------------------------------------------------------------------

    JobPanel.prototype.render = function () {
        this._renderHead();
        this._renderStep();
    };

    function badge(status) {
        return S.ui.el('span', {class: 'label label-' + (STATUS_CLS[status] || 'default'), text: statusText(status)});
    }

    /** Строка статуса в шапке страницы: видна на любом шаге; щелчок — к подробностям или к результату. */
    JobPanel.prototype._renderHead = function () {
        var el = this.head, ui = S.ui, self = this;
        if (!el) return;
        ui.clear(el);
        var h = headState(this.job, this.estimateOf(this.job && this.job.id));
        ui.show(el, !!h);
        if (!h) return;
        el.className = 'st-job-head st-jh-' + h.state;
        if (h.state === 'running') {
            var bar = ui.el('span', {class: 'st-jh-bar'}, [ui.el('span', {class: 'st-jh-fill'})]);
            bar.firstChild.style.width = Math.round((h.frac || 0) * 100) + '%';
            el.appendChild(bar);
        }
        el.appendChild(ui.el('span', {class: 'st-jh-text', text: h.text}));
        if (h.action === 'result') el.appendChild(ui.el('span', {class: 'st-jh-link', text: ' · Показать'}));
        if (h.state === 'error') el.appendChild(ui.el('span', {class: 'st-jh-link', text: ' · Лог'}));
        var job = this.job;
        el.title = (job.user ? 'запустил ' + job.user + ' · ' : '') + 'создана ' + core.fmtDate(job.created) +
            (h.action === 'result' ? ' — щелчок: срез готового объёма' : ' — щелчок: подробности в шаге 4');
        if (!el._bound) {
            el._bound = true;
            el.addEventListener('click', function (e) {
                var hs = headState(self.job, self.estimateOf(self.job && self.job.id));
                if (!hs) return;
                if (e.target.closest('.st-jh-link') && hs.state === 'error') {
                    self.showLog();
                    return;
                }
                self.emit('open', hs.action);
            });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    el.click();
                }
            });
        }
    };

    /** Подробности в шаге 4: статус, полоса, время, кнопки, ошибка, предупреждения, прежние задачи. */
    JobPanel.prototype._renderStep = function () {
        var el = this.mini, ui = S.ui, self = this;
        if (!el) return;
        ui.clear(el);
        var job = this.job;
        if (!job) {
            ui.hide(el);
            return;
        }
        ui.show(el);
        var active = isActive(job.status), estS = this.estimateOf(job.id);
        var head = ui.el('div', {class: 'st-rj-head'}, [
            ui.el('span', {text: 'Задача: '}), badge(job.status),
            active && job.stage ? ui.el('span', {class: 'text-muted', text: ' ' + stageText(job.stage)}) : null,
            job.cancel_requested && active ? ui.el('span', {class: 'text-warning', text: ' · запрошена отмена'}) : null
        ]);
        head.title = (job.user ? 'запустил ' + job.user + ' · ' : '') + 'создана ' + core.fmtDate(job.created);
        el.appendChild(head);
        if (active) {
            var bar = ui.el('div', {class: 'progress st-progress st-progress-sm'});
            el.appendChild(bar);
            var frac = job.status === 'queued' ? null : (core.isNum(job.progress) ? job.progress : null);
            ui.progress(bar, frac, frac === null ? (job.status === 'queued' ? 'в очереди' : '') : undefined);
            var t = timeText(job, estS);
            if (t) {
                el.appendChild(ui.el('div', {class: 'st-rj-time text-muted',
                    text: t + (remaining(job, estS) !== null ? ' (по оценке при запуске)' : '')}));
            }
        } else if (job.status === 'done') {
            var dur = elapsed(job);
            var show = ui.el('button', {type: 'button', class: 'btn btn-link btn-xs st-rj-show', text: 'Показать результат'});
            show.addEventListener('click', function () {
                self.emit('open', 'result');
            });
            el.appendChild(ui.el('div', {class: 'st-rj-time'}, [
                'Готово ' + core.fmtDate(job.finished) + (dur !== null ? ' · считалась ' + core.fmtDuration(dur) : ''),
                ' ', show
            ]));
        } else if (job.finished) {
            el.appendChild(ui.el('div', {class: 'st-rj-time text-muted', text: 'Завершена ' + core.fmtDate(job.finished)}));
        }
        if (job.error && (job.status === 'error' || job.status === 'interrupted')) {
            var first = String(job.error).split('\n')[0];
            el.appendChild(ui.el('div', {class: 'alert alert-danger st-rj-error', text: first}));
            if (String(job.error).indexOf('\n') >= 0) {
                el.appendChild(ui.el('details', {class: 'st-rj-more'}, [
                    ui.el('summary', {text: 'Подробно'}), ui.el('pre', {class: 'st-error', text: job.error})
                ]));
            }
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
            var det = ui.el('details', {class: 'st-job-others'}, [
                ui.el('summary', {text: 'Прежние задачи (' + others.length + ')'}), tbl
            ]);
            if (this._othersOpen) det.open = true;
            det.addEventListener('toggle', function () {
                self._othersOpen = det.open;
            });
            el.appendChild(det);
        }
    };

    S.jobs = {
        ACTIVE: ACTIVE, STATUS: STATUS, STAGE: STAGE, isActive: isActive, pollDelay: pollDelay,
        statusText: statusText, stageText: stageText, elapsed: elapsed, remaining: remaining, timeText: timeText,
        headState: headState, JobPanel: JobPanel
    };
})(typeof window !== 'undefined' ? window : globalThis);
