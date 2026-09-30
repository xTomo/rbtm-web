/* Студия реконструкции — шаг 3 «Артефакты»: пресет подавления колец (выкл/слабо/средне/сильно, по умолчанию
 * «средне» — Vo 3/61/21 + БПФ-фильтр полос) → пересчёт среза с rings=<пресет> (шаг 2 слушает событие 'rings').
 * Поправка от колец считается на проекциях без сдвигов кадров (сдвиги после вставок, компенсация смещения), см.
 * reconengine.rings.
 * Кнопка «Сравнить кольца» (все пресеты на фрагменте 1:1) — compare.js; сглаживание проекций — step_smoothing.js.
 * choose(пресет) вызывает и сравнение, когда выбирают плитку. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var ui = S.ui;

    var PRESETS = ['off', 'weak', 'medium', 'strong'];
    var NOTES = {
        off: 'Без подавления колец.',
        weak: 'Слабое: БПФ-фильтр тонких полос (период 50 px) — полные кольца.',
        medium: 'Среднее: Vo (snr 3, окна 61/21) + БПФ-фильтр — и неполные кольца (дуги).',
        strong: 'Сильное: Vo (snr 2, окна 81/31) + БПФ-фильтр шире по углу — может приглушать мелкие детали у оси.'
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
