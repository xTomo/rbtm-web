/* Студия реконструкции — шаг 3 «Артефакты»: сглаживание проекций (после подавления колец).
 *
 * Каждая проекция сглаживается гауссом σ по осям детектора, после реконструкции — деблюринг тем же ядром: Винер
 * (β, по умолчанию 0,02) или нерезкая маска (вес a, 1,5); сервис делает всё одним фильтром проекций перед FBP.
 * Состояние st.smoothing = {enabled, sigma, deblur, balance, amount} (по умолчанию выключено, σ 1,5). Изменение
 * действующих параметров (core.smoothingBlock) → событие 'smoothing': срез пересчитывает шаг 2, оценку — шаг 4
 * (задержку и «последний выигрывает» дают их каналы; ползунки дискретные — событие только при смене значения).
 * Любая правка ставит st.smoothingChosen: блок уходит в рецепт (null — выключено), шаг 3 — «проверено»; без правок
 * рецепт берёт значение по умолчанию сервиса (выключено). set(patch) вызывает и сравнение (выбор плитки σ). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var SIGMA_MIN = 0.7, SIGMA_MAX = 2.0, SIGMA_DEFAULT = 1.5;
    // β Винера — на логарифмической шкале: ползунок выбирает номер значения
    var BALANCES = [0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.05, 0.075, 0.1];
    var AMOUNT = {min: 0.5, max: 3, step: 0.1};
    var NOTES = {
        wiener: 'Винер: больше β — меньше шума и звона, но мягче края (по умолчанию 0,02).',
        unsharp: 'Нерезкая маска: больше вес — резче края, но и шум выше (по умолчанию 1,5).',
        none: 'Без деблюринга: только сглаживание — шум ниже, края мягче.'
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
            strengthVal: ui.$('sm-strength-val'), note: ui.$('sm-deblur-note')
        };
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

    StepSmoothing.prototype.render = function () {
        var sm = this.st.smoothing, e = this.e, on = !!sm.enabled;
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
    StepSmoothing.nearestIndex = nearestIndex;
    S.StepSmoothing = StepSmoothing;
})(typeof window !== 'undefined' ? window : globalThis);
