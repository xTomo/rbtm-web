/* Студия реконструкции — шаг 4 «Реконструкция».
 *
 * Диапазон срезов [z0, z1) (строки детектора, по умолчанию y0..y1 загруженной рамки), режим углов (first_180 /
 * full_halves), копии с биннингом (×2/×4/×8, хотя бы одна — по ней шаг 5 показывает срезы; по умолчанию ×4);
 * POST sessions/<sid>/recipe {rings, angles, slices, binning, pixel_size_mm?, center/tilt/row — ручная ось,
 * smoothing: {sigma, deblur, balance, amount} | null — только если человек трогал сглаживание} → POST sessions/<sid>/estimate
 * {recipe} → размер объёма, копия ×4, оценка времени. «Запустить» → рецепт заново → POST jobs {recipe, name};
 * дальше задачу ведёт панель задачи (jobs.js). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var SESSION_EXPECT = ['not_found', 'taken_over', 'forbidden', 'not_ready'];
    var TIME_SOURCE = {jobs: 'по последним задачам', preview: 'по превью, с запасом'};

    function StepRun(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.e = {
            z0: ui.$('run-z0'), z1: ui.$('run-z1'), nz: ui.$('run-nz'), angles: ui.$('run-angles'),
            binning: ui.$('run-binning'),
            est: ui.$('run-estimate'), btn: ui.$('run-btn'), hint: ui.$('run-hint')
        };
        this.estCh = this.api.channel({
            delay: 400,
            onBusy: function (b) {
                if (self.e.est) self.e.est.classList.toggle('st-loading', b);
            }
        });
        this.starting = false;
        this._bind();
        this.render();
    }

    StepRun.prototype._bind = function () {
        var self = this, app = this.app, e = this.e, bus = app.bus;
        bus.on('loaded', function () {
            var lr = self.st.loadedRoi;
            if (lr) {
                var z = self.st.slices;
                self.st.slices = z && z[0] >= lr.y0 && z[1] <= lr.y1 && z[0] < z[1] ? z : [lr.y0, lr.y1];
            }
            self.st.estimate = null;
            self.render();
            // рецепт без оси в сессии сам запустил бы авто-ось — ждём событие 'axis' от шага 2
            if (self.st.axis !== 'running') self.estimate();
        });
        bus.on('load-start', function () {
            self.estCh.cancel();
            self.st.estimate = null;
            self.render();
        });
        ['rings', 'smoothing', 'angles', 'recipe-params', 'axis'].forEach(function (ev) {
            bus.on(ev, function () {
                self.estimate();
            });
        });
        bus.on('slice', function () {
            // оценка времени по превью появляется после первого среза
            if (self.st.estimate && !self.st.estimate.time) self.estimate();
        });
        bus.on('state', function () {
            self._renderButtons();
        });
        ['z0', 'z1'].forEach(function (k) {
            if (!e[k]) return;
            e[k].addEventListener('change', function () {
                self._onSlicesInput();
            });
        });
        if (e.angles) {
            ui.qsa('[data-angles]', e.angles).forEach(function (b) {
                b.addEventListener('click', function () {
                    var v = b.getAttribute('data-angles');
                    if (v === self.st.angles) return;
                    self.st.angles = v;
                    app.set({runEdited: true});
                    self.render();
                    bus.emit('angles', v);
                });
            });
        }
        if (e.binning) {
            ui.qsa('[data-binning]', e.binning).forEach(function (b) {
                b.addEventListener('click', function () {
                    self._toggleBinning(parseInt(b.getAttribute('data-binning'), 10));
                });
            });
        }
        if (e.btn) {
            e.btn.addEventListener('click', function () {
                self.run();
            });
        }
    };

    /** Включить/выключить копию ×f; последнюю не выключаем — шагу 5 нужна копия для срезов. */
    StepRun.prototype._toggleBinning = function (f) {
        var cur = (this.st.binning || []).slice(), i = cur.indexOf(f);
        if (i >= 0) {
            if (cur.length === 1) {
                ui.toast('Нужна хотя бы одна копия с биннингом: по ней шаг 5 показывает срезы.', 'info', 4000);
                return;
            }
            cur.splice(i, 1);
        } else {
            cur.push(f);
        }
        this.st.binning = cur.sort(function (a, b) {
            return a - b;
        });
        this.app.set({runEdited: true});
        this.render();
        this.app.bus.emit('recipe-params');
    };

    StepRun.prototype._onSlicesInput = function () {
        var st = this.st, e = this.e;
        var roi = st.loadedRoi || st.roi;
        if (!roi) return;
        var z = st.slices || [roi.y0, roi.y1];
        var z0 = core.parseNum(e.z0.value), z1 = core.parseNum(e.z1.value);
        st.slices = core.clampSlices(core.isNum(z0) ? z0 : z[0], core.isNum(z1) ? z1 : z[1], roi);
        this.app.set({runEdited: true});
        this.render();
        this.estimate();
    };

    /** Тело POST sessions/<sid>/recipe. */
    StepRun.prototype.recipeBody = function () {
        var st = this.st;
        var body = {rings: st.rings, angles: st.angles};
        if (st.slices) body.slices = [st.slices[0], st.slices[1]];
        if (st.binning && st.binning.length) body.binning = st.binning.slice();
        if (st.pixelUser) body.pixel_size_mm = st.pixelUser;
        // сглаживание: ключ есть — выбор человека (provenance 'checked'; null — выключено), нет — значение по умолчанию
        // (выключено, 'auto')
        if (st.smoothingChosen) body.smoothing = core.smoothingBlock(st.smoothing);
        // ручная ось — явно: в сессию она уходит с задержкой (StepAxis._persist), запуск может её опередить
        var ax = st.axisInfo && st.axisInfo.axis;
        if (ax && ax.method === 'manual') {
            body.center = ax.center_x;
            body.tilt = ax.tilt_deg;
            body.row = ax.y_ref;
        }
        return body;
    };

    StepRun.prototype.estimate = function () {
        var self = this, app = this.app, st = this.st;
        if (!app.ready()) {
            this.estCh.cancel();
            this.render();
            return;
        }
        var sid = app.sid(), body = this.recipeBody();
        this.estCh.run(function (signal) {
            return self.api.postJSON('sessions/' + sid + '/recipe', body,
                {signal: signal, expect: SESSION_EXPECT, what: 'Рецепт'}).then(function (recipe) {
                return self.api.postJSON('sessions/' + sid + '/estimate', {recipe: recipe},
                    {signal: signal, expect: SESSION_EXPECT, what: 'Оценка'});
            });
        }).then(function (est) {
            if (S.api.isStale(est) || sid !== app.sid()) return;
            st.estimate = est;
            self.render();
        }, function (err) {
            app.previewError(err, 'Оценка');
        });
    };

    StepRun.prototype.run = function () {
        var self = this, app = this.app, st = this.st, cfg = app.config;
        if (!cfg.can_run || !app.ready() || this.starting) return;
        var ask = Promise.resolve(true);
        if (st.result === 'ready') {
            ask = ui.confirm('Запустить реконструкцию?', 'Опубликованный результат будет заменён новым; рецепт ' +
                'прежнего запуска сохранится в истории.', 'Запустить');
        }
        ask.then(function (ok) {
            if (!ok) return;
            var sid = app.sid();
            self.starting = true;
            self._renderButtons();
            self.api.postJSON('sessions/' + sid + '/recipe', self.recipeBody(), {expect: SESSION_EXPECT, what: 'Рецепт'})
                .then(function (recipe) {
                    return self.api.postJSON('jobs', {recipe: recipe, name: core.sampleName(cfg.specimen, cfg.exp_id)},
                        {expect: [409], what: 'Запуск реконструкции'});
                })
                .then(function (job) {
                    self.starting = false;
                    app.jobs.track(job);
                    ui.toast('Задача поставлена в очередь. Страницу можно закрыть — задача продолжится.', 'success');
                    self._renderButtons();
                }, function (err) {
                    self.starting = false;
                    if (err && err.status === 409 && err.body && err.body.job_id) {
                        ui.toast(err.message, 'warning', 8000);
                        app.jobs.track(err.body.job_id);
                    } else {
                        app.previewError(err, 'Запуск');
                    }
                    self._renderButtons();
                });
        });
    };

    // --- отрисовка --------------------------------------------------------------------------------------------

    StepRun.prototype.render = function () {
        var st = this.st, e = this.e;
        var roi = st.loadedRoi || st.roi;
        var z = st.slices || (roi ? [roi.y0, roi.y1] : null);
        if (z && e.z0 && e.z1) {
            e.z0.value = z[0];
            e.z1.value = z[1];
            if (roi) {
                e.z0.min = roi.y0;
                e.z0.max = roi.y1 - 1;
                e.z1.min = roi.y0 + 1;
                e.z1.max = roi.y1;
            }
            ui.text(e.nz, (z[1] - z[0]) + ' срезов');
        }
        if (e.angles) {
            ui.qsa('[data-angles]', e.angles).forEach(function (b) {
                var on = b.getAttribute('data-angles') === st.angles;
                b.classList.toggle('active', on);
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-default', !on);
            });
        }
        if (e.binning) {
            var sel = st.binning || [];
            ui.qsa('[data-binning]', e.binning).forEach(function (b) {
                var on = sel.indexOf(parseInt(b.getAttribute('data-binning'), 10)) >= 0;
                b.classList.toggle('active', on);
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-default', !on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }
        this._renderEstimate();
        this._renderButtons();
    };

    StepRun.prototype._renderEstimate = function () {
        var el = this.e.est, est = this.st.estimate;
        if (!el) return;
        ui.clear(el);
        if (!this.app.ready()) {
            el.appendChild(ui.el('span', {class: 'text-muted', text: 'Оценка появится после загрузки области.'}));
            return;
        }
        if (!est) {
            el.appendChild(ui.el('span', {class: 'text-muted', text: 'Оценка…'}));
            return;
        }
        var dl = ui.el('dl', {class: 'dl-horizontal st-dl'});
        var row = function (k, v, cls) {
            dl.appendChild(ui.el('dt', {text: k}));
            dl.appendChild(ui.el('dd', {text: v, class: cls || null}));
        };
        var sh = est.volume_shape || [];
        if (sh.length === 3) row('Объём', sh[0] + ' × ' + sh[1] + ' × ' + sh[2] + ' (float32)');
        row('Полный', core.fmtBytes(est.volume_bytes));
        var binned = est.binned_bytes || {};
        Object.keys(binned).sort(function (a, b) {
            return Number(a) - Number(b);
        }).forEach(function (b) {
            row('Копия ×' + b, binned[b] > 0 ? core.fmtBytes(binned[b]) : 'не создаётся: меньше ' + b + ' срезов',
                binned[b] > 0 ? null : 'text-warning');
        });
        if (est.n_angles_used) row('Углов', est.n_angles_used + ' из ' + (est.n_data_frames || '?') + ' data-кадров');
        var t = est.time;
        if (t && core.isNum(t.recon_s)) {
            var total = t.recon_s + (core.isNum(t.prepare_s) ? t.prepare_s : 0);
            row('Время', '≈ ' + core.fmtDuration(total) + ' (' + (TIME_SOURCE[t.source] || t.source || '') + ')');
        } else {
            row('Время', 'оценится после превью среза', 'text-muted');
        }
        el.appendChild(dl);
    };

    StepRun.prototype._renderButtons = function () {
        var app = this.app, st = this.st, e = this.e;
        var active = st.job && S.jobs.isActive(st.job.status);
        var why = '';
        if (!app.config.can_run) why = 'Запуск доступен экспериментатору и администратору.';
        else if (st.load === 'lost') why = 'Сессия закрыта — загрузите область снова (шаг 1).';
        else if (st.load === 'ready' && st.roiDirty) why = 'Рамка изменена — загрузите область заново (шаг 1).';
        else if (st.load !== 'ready') why = 'Сначала загрузите область (шаг 1).';
        else if (active) why = 'По этому скану уже идёт задача.';
        else if (this.starting) why = 'Запуск…';
        ui.enable(e.btn, !why, why);
        ui.enable(e.z0, app.ready());
        ui.enable(e.z1, app.ready());
        ui.text(e.hint, why);
        ui.show(e.hint, !!why);
    };

    S.StepRun = StepRun;
})(typeof window !== 'undefined' ? window : globalThis);
