/* Студия реконструкции — шаг 3 «Артефакты»: шумоподавление TV 3D после реконструкции.
 *
 * Сервис после FBP прогоняет TV 3D (полная вариация, FGP на GPU): гладкие области выравниваются, края остаются
 * резкими. Вес — сила × σ шума среза строки превью (σ по половинам углов, считает сервис; тот же вес уходит в
 * рецепт). Лучше вместе с лёгким сглаживанием проекций σ 1 без деблюра: края как у σ≈1, шум как у σ≈3.
 * Состояние st.denoise = {enabled, strength, iterations} (по умолчанию выключено, сила 2, 50 итераций). Изменение
 * действующих параметров (core.denoiseBlock) → событие 'denoise': срез пересчитывает шаг 2, оценку — шаг 4. Любая
 * правка ставит st.denoiseChosen: блок уходит в рецепт (null — выключено). «Сравнить TV» — compare.js. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var STRENGTH = {min: 0.5, max: 5, step: 0.5, def: 2};
    var SIGMA_HINT = 1.5;           // сглаживание сильнее — подсказать σ 1

    function StepDenoise(app) {
        this.app = app;
        this.st = app.state;
        this.e = {
            toggle: ui.$('tv-toggle'), strength: ui.$('tv-strength'), strengthVal: ui.$('tv-strength-val'),
            hint: ui.$('tv-hint')
        };
        this._bind();
        this.render();
    }

    StepDenoise.prototype._bind = function () {
        var self = this, e = this.e;
        if (e.toggle) {
            ui.qsa('[data-tv]', e.toggle).forEach(function (b) {
                b.addEventListener('click', function () {
                    self.set({enabled: b.getAttribute('data-tv') === 'on'});
                });
            });
        }
        if (e.strength) {
            e.strength.addEventListener('input', function () {
                var v = core.parseNum(e.strength.value);
                if (core.isNum(v)) self.set({strength: v});
            });
        }
        if (this.app.bus) {
            this.app.bus.on('smoothing', function () {
                self.render();
            });
        }
    };

    /** Изменить параметры (patch — поля st.denoise); 'denoise' — только если изменились действующие. */
    StepDenoise.prototype.set = function (patch) {
        var st = this.st;
        var before = JSON.stringify(core.denoiseBlock(st.denoise));
        var dn = Object.assign({}, st.denoise, patch);
        var s = Number(dn.strength);
        dn.strength = Math.round(core.clamp(core.isNum(s) ? s : STRENGTH.def, STRENGTH.min, STRENGTH.max) * 10) / 10;
        dn.enabled = !!dn.enabled;
        st.denoise = dn;
        this.app.set({denoiseChosen: true});
        this.render();
        if (JSON.stringify(core.denoiseBlock(dn)) !== before) this.app.bus.emit('denoise', dn);
    };

    /** Подсказка: TV включён, а сглаживание проекций сильное или выключено. */
    function hintText(st) {
        if (!st.denoise || !st.denoise.enabled) return '';
        var sm = core.smoothingBlock(st.smoothing);
        if (!sm) return 'Совет: включите сглаживание проекций σ 1 — TV лучше работает после лёгкого сглаживания.';
        if (sm.sigma > SIGMA_HINT) {
            return 'Совет: с TV хватит сглаживания σ 1 — сильное сглаживание размоет края раньше TV.';
        }
        return '';
    }

    StepDenoise.prototype.render = function () {
        var dn = this.st.denoise, e = this.e, on = !!dn.enabled;
        if (e.toggle) {
            ui.qsa('[data-tv]', e.toggle).forEach(function (b) {
                var act = (b.getAttribute('data-tv') === 'on') === on;
                b.classList.toggle('active', act);
                b.classList.toggle('btn-primary', act);
                b.classList.toggle('btn-default', !act);
                b.setAttribute('aria-pressed', act ? 'true' : 'false');
            });
        }
        if (e.strength) {
            e.strength.min = STRENGTH.min;
            e.strength.max = STRENGTH.max;
            e.strength.step = STRENGTH.step;
            e.strength.value = dn.strength;
            ui.enable(e.strength, on, 'Включите шумоподавление');
        }
        ui.text(e.strengthVal, core.fmtFixed(dn.strength, 1) + 'σ');
        ui.text(e.hint, hintText(this.st));
    };

    StepDenoise.STRENGTH = STRENGTH;
    StepDenoise.hintText = hintText;
    S.StepDenoise = StepDenoise;
})(typeof window !== 'undefined' ? window : globalThis);
