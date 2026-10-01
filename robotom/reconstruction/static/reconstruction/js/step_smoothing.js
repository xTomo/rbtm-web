/* Студия реконструкции — шаг 3 «Артефакты»: сглаживание проекций (после подавления колец).
 *
 * Каждая проекция сглаживается гауссом σ по осям детектора; по желанию после реконструкции — деблюринг тем же
 * ядром: Винер (β, 0,02) или нерезкая маска (вес a, 1,5); сервис делает всё одним фильтром проекций перед FBP.
 * По умолчанию деблюра нет: на шумных сканах он возвращает частоты, где шум сильнее сигнала (разбор 01.10.2026).
 * «Подобрать σ» — POST sessions/<sid>/smoothing/auto (оценка ошибки среза по половинам углов при σ 0…4 и текущем
 * деблюре на фрагменте: видимая часть увеличенного «Среза» или квадрат 512 с краями); ответ включает
 * сглаживание с выбранной σ (или выключает, если без него лучше) и пишет итог под кнопкой.
 * Состояние st.smoothing = {enabled, sigma, deblur, balance, amount} (по умолчанию выключено, σ 2). Изменение
 * действующих параметров (core.smoothingBlock) → событие 'smoothing': срез пересчитывает шаг 2, оценку — шаг 4
 * (задержку и «последний выигрывает» дают их каналы; ползунки дискретные — событие только при смене значения).
 * Любая правка ставит st.smoothingChosen: блок уходит в рецепт (null — выключено), шаг 3 — «проверено»; без правок
 * рецепт берёт значение по умолчанию сервиса (выключено). set(patch) вызывает и сравнение (выбор плитки σ). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var SIGMA_MIN = 0.7, SIGMA_MAX = 4.0, SIGMA_DEFAULT = 2.0;
    var PREVIEW_EXPECT = ['not_found', 'taken_over', 'forbidden', 'not_ready'];
    var AUTO_REGION = {min: 256, max: 768};
    // β Винера — на логарифмической шкале: ползунок выбирает номер значения
    var BALANCES = [0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.1];
    var AMOUNT = {min: 0.5, max: 3, step: 0.1};
    var NOTES = {
        wiener: 'Винер: возвращает резкость, но и шум на тех же частотах — для малошумных сканов; больше β — ' +
            'меньше шума и звона (0,02 — как в «Марсе»).',
        unsharp: 'Нерезкая маска: больше вес — резче края, но и шум выше (по умолчанию 1,5).',
        none: 'Без деблюринга (по умолчанию): только сглаживание — на шумных сканах лучший вариант.'
    };

    /** Номер ближайшего (в логарифме) значения списка. */
    function nearestIndex(list, v) {
        if (!(v > 0)) v = 0.02;
        var best = 0;
        for (var i = 1; i < list.length; i++) {
            if (Math.abs(Math.log(list[i] / v)) < Math.abs(Math.log(list[best] / v))) best = i;
        }
        return best;
    }

    /** Итог подбора σ (ответ smoothing/auto): «Подбор σ (строка 1800): σ 2 — ошибка среза 0,009 против 0,059 без
     *  сглаживания, шум 0,0072 1/мм.» и пояснение, если минимум на краю шкалы или взята σ меньше минимума. */
    function autoText(res) {
        if (!res || !res.scores || !res.scores.length) return '';
        var off = res.scores[0], pick = null;
        res.scores.forEach(function (s) {
            if (s.sigma === res.sigma) pick = s;
        });
        var row = core.isNum(res.row) ? ' (строка ' + res.row + ')' : '';
        if (res.sigma === null || res.sigma === undefined || !pick) {
            return 'Подбор σ' + row + ': без сглаживания ошибка наименьшая — сглаживание выключено.';
        }
        var s = 'Подбор σ' + row + ': σ ' + core.fmtNum(res.sigma, 2) + ' — ошибка среза ' + core.fmtValue(pick.rmse) +
            ' против ' + core.fmtValue(off.rmse) + ' без сглаживания, шум ' + core.fmtValue(pick.noise) + ' 1/мм.';
        if (res.at_limit) {
            s += ' Минимум — на краю шкалы (σ ' + core.fmtNum(res.sigma_min, 2) + '): данные очень шумные.';
        } else if (core.isNum(res.sigma_min) && res.sigma_min !== res.sigma) {
            s += ' Точный минимум — σ ' + core.fmtNum(res.sigma_min, 2) + ', но выигрыш меньше 5 % — взята σ меньше ' +
                '(резче).';
        }
        return s;
    }

    /** Сегментная группа кнопок: активна кнопка со значением cur атрибута attr. */
    function segment(group, attr, cur) {
        if (!group) return;
        ui.qsa('[' + attr + ']', group).forEach(function (b) {
            var on = b.getAttribute(attr) === cur;
            b.classList.toggle('active', on);
            b.classList.toggle('btn-primary', on);
            b.classList.toggle('btn-default', !on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function StepSmoothing(app) {
        this.app = app;
        this.st = app.state;
        this.e = {
            toggle: ui.$('sm-toggle'), sigma: ui.$('sm-sigma'), sigmaVal: ui.$('sm-sigma-val'), deblur: ui.$('sm-deblur'),
            strengthRow: ui.$('sm-strength-row'), strength: ui.$('sm-strength'), strengthLabel: ui.$('sm-strength-label'),
            strengthVal: ui.$('sm-strength-val'), note: ui.$('sm-deblur-note'), auto: ui.$('sm-auto'),
            autoNote: ui.$('sm-auto-note')
        };
        var self = this;
        this.autoRes = null;            // последний ответ smoothing/auto
        this.autoRunning = false;
        this.ch = app.api && app.api.channel ? app.api.channel({
            onBusy: function (b) {
                self.autoRunning = b;
                if (app.viewer) app.viewer.setBusy('smooth-auto', b, 'Подбор σ…');
                self.render();
            }
        }) : null;
        this._bind();
        this.render();
    }

    StepSmoothing.prototype._bind = function () {
        var self = this, e = this.e;
        if (e.toggle) {
            ui.qsa('[data-smooth]', e.toggle).forEach(function (b) {
                b.addEventListener('click', function () {
                    self.set({enabled: b.getAttribute('data-smooth') === 'on'});
                });
            });
        }
        if (e.sigma) {
            e.sigma.addEventListener('input', function () {
                var v = core.parseNum(e.sigma.value);
                if (core.isNum(v)) self.set({sigma: v});
            });
        }
        if (e.deblur) {
            ui.qsa('[data-deblur]', e.deblur).forEach(function (b) {
                b.addEventListener('click', function () {
                    self.set({deblur: b.getAttribute('data-deblur')});
                });
            });
        }
        if (e.auto) {
            e.auto.addEventListener('click', function () {
                self.auto();
            });
        }
        if (this.app.bus) {
            this.app.bus.on('load-start', function () {
                self.autoRes = null;
                self.render();
            });
            this.app.bus.on('state', function () {
                self.render();
            });
        }
        if (e.strength) {
            e.strength.addEventListener('input', function () {
                var v = core.parseNum(e.strength.value);
                if (!core.isNum(v)) return;
                if (self.st.smoothing.deblur === 'wiener') {
                    self.set({balance: BALANCES[core.clamp(Math.round(v), 0, BALANCES.length - 1)]});
                } else if (self.st.smoothing.deblur === 'unsharp') {
                    self.set({amount: Math.round(core.clamp(v, AMOUNT.min, AMOUNT.max) * 10) / 10});
                }
            });
        }
    };

    /** Изменить параметры (patch — поля st.smoothing); 'smoothing' — только если изменились действующие. */
    StepSmoothing.prototype.set = function (patch) {
        var st = this.st;
        var before = JSON.stringify(core.smoothingBlock(st.smoothing));
        var sm = Object.assign({}, st.smoothing, patch);
        var sigma = Number(sm.sigma);
        sm.sigma = Math.round(core.clamp(core.isNum(sigma) ? sigma : SIGMA_DEFAULT, SIGMA_MIN, SIGMA_MAX) * 100) / 100;
        sm.enabled = !!sm.enabled;
        st.smoothing = sm;
        this.app.set({smoothingChosen: true});
        this.render();
        if (JSON.stringify(core.smoothingBlock(sm)) !== before) this.app.bus.emit('smoothing', sm);
    };

    StepSmoothing.prototype._canAuto = function () {
        var app = this.app, st = this.st;
        return !!(app.config && app.config.can_run) && !!app.ready && app.ready() && st.axis !== 'running' &&
            st.row !== null && st.row !== undefined;
    };

    /** Фрагмент подбора: видимая часть увеличенного «Среза» (256…768 px), иначе null — выберет сервис. */
    StepSmoothing.prototype._region = function () {
        var v = this.app.viewer, sv = v && v.get ? v.get('slice') : null;
        if (sv && sv.img && sv.xf && !sv.fit) return core.visibleRegion(sv.xf, v.W, v.H, sv.img, AUTO_REGION) || null;
        return null;
    };

    /** Подобрать σ при текущих кольцах и деблюре; итог включает сглаживание с ней (или выключает). */
    StepSmoothing.prototype.auto = function () {
        var self = this, app = this.app, st = this.st;
        if (!this.ch || !this._canAuto()) return;
        var sid = app.sid(), row = st.row, sm = st.smoothing;
        var body = app.axis.axisParams(row, {row: row, angles: st.angles, rings: st.rings, region: this._region(),
            smoothing: {deblur: sm.deblur, balance: sm.balance, amount: sm.amount}});
        this.ch.run(function (signal, seq) {
            body.seq = seq;
            return app.api.postJSON('sessions/' + sid + '/smoothing/auto', body,
                {signal: signal, expect: PREVIEW_EXPECT, what: 'Подбор σ'});
        }).then(function (res) {
            if (S.api.isStale(res) || sid !== app.sid()) return;
            self.autoRes = res;
            if (res.sigma === null || res.sigma === undefined) self.set({enabled: false});
            else self.set({enabled: true, sigma: res.sigma});
            self.render();
        }, function (err) {
            app.previewError(err, 'Подбор σ');
        });
        this.render();
    };

    StepSmoothing.prototype.render = function () {
        var sm = this.st.smoothing, e = this.e, on = !!sm.enabled;
        if (e.auto) {
            ui.enable(e.auto, !this.autoRunning && this._canAuto(),
                this.autoRunning ? 'Подбор идёт' : 'Нужны загруженная область и ось');
        }
        ui.text(e.autoNote, autoText(this.autoRes));
        segment(e.toggle, 'data-smooth', on ? 'on' : 'off');
        if (e.sigma) {
            e.sigma.value = sm.sigma;
            ui.enable(e.sigma, on, 'Включите сглаживание');
        }
        ui.text(e.sigmaVal, core.fmtFixed(sm.sigma, 1));
        segment(e.deblur, 'data-deblur', sm.deblur);
        var wiener = sm.deblur === 'wiener', unsharp = sm.deblur === 'unsharp';
        ui.show(e.strengthRow, wiener || unsharp);
        if (e.strength && wiener) {
            e.strength.min = 0;
            e.strength.max = BALANCES.length - 1;
            e.strength.step = 1;
            e.strength.value = nearestIndex(BALANCES, sm.balance);
            e.strength.title = 'β — регуляризация Винера: 0,005…0,1';
        } else if (e.strength && unsharp) {
            e.strength.min = AMOUNT.min;
            e.strength.max = AMOUNT.max;
            e.strength.step = AMOUNT.step;
            e.strength.value = sm.amount;
            e.strength.title = 'Вес нерезкой маски: 0,5…3';
        }
        ui.text(e.strengthLabel, wiener ? 'β' : 'вес');
        ui.text(e.strengthVal, wiener ? core.fmtNum(sm.balance, 4) : core.fmtFixed(sm.amount, 1));
        ui.text(e.note, NOTES[sm.deblur] || '');
    };

    StepSmoothing.BALANCES = BALANCES;
    StepSmoothing.SIGMA_MAX = SIGMA_MAX;
    StepSmoothing.autoText = autoText;
    StepSmoothing.nearestIndex = nearestIndex;
    S.StepSmoothing = StepSmoothing;
})(typeof window !== 'undefined' ? window : globalThis);
