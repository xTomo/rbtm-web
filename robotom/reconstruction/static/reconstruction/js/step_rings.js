/* Студия реконструкции — шаг 3 «Артефакты»: пресет подавления колец (выкл/слабо/средне/сильно, по умолчанию
 * «средне» — как в ноутбуке 3/61/21) → пересчёт среза с rings=<пресет> (шаг 2 слушает событие 'rings').
 * Кнопка «Сравнить кольца» (все пресеты на фрагменте 1:1) — compare.js; сглаживание проекций — step_smoothing.js.
 * choose(пресет) вызывает и сравнение, когда выбирают плитку. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var ui = S.ui;

    var PRESETS = ['off', 'weak', 'medium', 'strong'];
    var NOTES = {
        off: 'Без подавления колец.',
        weak: 'Слабое: remove_all_stripe snr 4, окна 41/11.',
        medium: 'Среднее (как в ноутбуке): snr 3, окна 61/21.',
        strong: 'Сильное: snr 2, окна 81/31 — может сглаживать мелкие детали.'
    };

    function StepRings(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.group = ui.$('rings-group');
        this.note = ui.$('rings-note');
        if (this.group) {
            ui.qsa('[data-rings]', this.group).forEach(function (b) {
                b.addEventListener('click', function () {
                    self.choose(b.getAttribute('data-rings'));
                });
            });
        }
        this.render();
    }

    StepRings.prototype.choose = function (preset) {
        if (PRESETS.indexOf(preset) < 0) return;
        var changed = this.st.rings !== preset;
        this.st.rings = preset;
        this.app.set({ringsChosen: true});
        this.render();
        if (changed) this.app.bus.emit('rings', preset);
    };

    StepRings.prototype.render = function () {
        var cur = this.st.rings;
        if (this.group) {
            ui.qsa('[data-rings]', this.group).forEach(function (b) {
                var on = b.getAttribute('data-rings') === cur;
                b.classList.toggle('active', on);
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-default', !on);
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
        }
        ui.text(this.note, NOTES[cur] || '');
    };

    S.StepRings = StepRings;
})(typeof window !== 'undefined' ? window : globalThis);
