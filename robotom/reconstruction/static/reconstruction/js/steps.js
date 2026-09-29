/* Студия реконструкции — статусы шагов.
 *
 * derive(state) — чистая функция: статусы пяти шагов по состоянию страницы (проверяется node-тестами).
 * Коды: none «—», auto «авто», checked «проверено», stale «устарело», running «идёт…», error «ошибка».
 * Правило устаревания: рамка поля зрения изменена после загрузки (roiDirty) или сессия потеряна (load = 'lost')
 * → шаги 2–4 «устарело», нужна повторная загрузка. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};

    var LABELS = {
        none: '—', auto: 'авто', checked: 'проверено', stale: 'устарело', running: 'идёт…', error: 'ошибка'
    };
    var ORDER = ['fov', 'axis', 'rings', 'run', 'result'];
    var ACTIVE_JOB = ['queued', 'running', 'publishing'];

    function st(code, text, hint) {
        return {code: code, text: text || LABELS[code], hint: hint || ''};
    }

    /**
     * state: {overview: 'loading'|'ready'|'error', roiEdited, load: 'none'|'loading'|'ready'|'error'|'lost',
     *         roiDirty, axis: 'none'|'running'|'auto'|'checked'|'error', ringsChosen, smoothingChosen, runEdited,
     *         job: null | {status}, result: 'unknown'|'loading'|'none'|'ready'|'error'}
     * Шаг 3 «Артефакты» — «проверено», если человек выбрал пресет колец или трогал сглаживание (в том числе выбрал
     * вариант в сравнении), иначе «авто» (значения по умолчанию).
     */
    function derive(s) {
        var ready = s.load === 'ready' && !s.roiDirty;
        var stale = s.load === 'lost' || (s.load === 'ready' && !!s.roiDirty);
        var staleHint = s.load === 'lost' ? 'сессия закрыта — загрузите область снова' :
            'рамка изменена после загрузки — загрузите область снова';
        var out = {};

        if (s.overview === 'loading') out.fov = st('running', null, 'обзор скана');
        else if (s.load === 'loading') out.fov = st('running', null, 'загрузка области');
        else if (s.overview === 'error') out.fov = st('error', null, 'обзор скана не получен');
        else if (s.load === 'error') out.fov = st('error', null, 'загрузка области не удалась');
        else if (s.overview !== 'ready') out.fov = st('none');
        else if (s.roiEdited || s.load === 'ready') out.fov = st('checked');
        else out.fov = st('auto', null, 'предложенная рамка');

        if (stale) out.axis = st('stale', null, staleHint);
        else if (!ready) out.axis = st('none');
        else if (s.axis === 'running') out.axis = st('running', null, 'авто-ось');
        else if (s.axis === 'error') out.axis = st('error');
        else if (s.axis === 'checked') out.axis = st('checked');
        else if (s.axis === 'auto') out.axis = st('auto');
        else out.axis = st('none');

        if (stale) out.rings = st('stale', null, staleHint);
        else if (!ready) out.rings = st('none');
        else if (s.ringsChosen || s.smoothingChosen) out.rings = st('checked');
        else out.rings = st('auto', null, 'кольца и сглаживание по умолчанию');

        var js = s.job && s.job.status;
        if (ACTIVE_JOB.indexOf(js) >= 0) out.run = st('running', null, 'задача реконструкции');
        else if (stale) out.run = st('stale', null, staleHint);
        else if (js === 'error' || js === 'interrupted') out.run = st('error', null, 'последняя задача не выполнена');
        else if (!ready) out.run = st('none');
        else out.run = s.runEdited ? st('checked') : st('auto');

        if (s.result === 'loading') out.result = st('running');
        else if (s.result === 'ready') out.result = st('checked', 'есть');
        else if (s.result === 'error') out.result = st('error');
        else out.result = st('none');
        return out;
    }

    /** Отрисовка статусов в панелях шагов (#step-<имя> .st-status) и сворачивание панелей по заголовку. */
    function StepsView(doc) {
        this.doc = doc || root.document;
        this.panels = {};
        var self = this;
        ORDER.forEach(function (name) {
            var p = self.doc.getElementById('step-' + name);
            if (!p) return;
            self.panels[name] = p;
            var head = p.querySelector('.panel-heading');
            if (head) {
                head.addEventListener('click', function (e) {
                    if (e.target.closest('a, button, input, label')) return;
                    p.classList.toggle('st-collapsed');
                });
            }
        });
    }

    StepsView.prototype.render = function (statuses) {
        var self = this;
        ORDER.forEach(function (name) {
            var p = self.panels[name], s = statuses[name];
            if (!p || !s) return;
            var b = p.querySelector('.st-status');
            if (!b) return;
            b.textContent = s.text;
            b.className = 'st-status st-s-' + s.code;
            b.title = s.hint || '';
            p.classList.toggle('st-step-stale', s.code === 'stale');
        });
    };

    StepsView.prototype.expand = function (name, on) {
        var p = this.panels[name];
        if (p) p.classList.toggle('st-collapsed', on === false);
    };

    S.steps = {LABELS: LABELS, ORDER: ORDER, derive: derive, StepsView: StepsView};
})(typeof window !== 'undefined' ? window : globalThis);
