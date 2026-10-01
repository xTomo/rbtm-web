'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'api.js', 'step_smoothing.js', 'step_denoise.js', 'compare.js', 'step_run.js');
const core = S.core;
const C = S.Compare;

function state(over) {
    return Object.assign({
        rings: 'medium', angles: 'first_180', row: 2269, smoothingChosen: false,
        smoothing: {enabled: false, sigma: 1.5, deblur: 'wiener', balance: 0.02, amount: 1.5},
        denoiseChosen: false, denoise: {enabled: false, strength: 2, iterations: 50}
    }, over);
}

// --- варианты и подписи ---------------------------------------------------------------------------------------

test('варианты «Сравнить кольца»: все пресеты при текущем сглаживании', () => {
    assert.deepEqual(C.variants('rings', state()), [
        {rings: 'off', smoothing: null, denoise: null}, {rings: 'weak', smoothing: null, denoise: null},
        {rings: 'medium', smoothing: null, denoise: null}, {rings: 'strong', smoothing: null, denoise: null}]);
    const on = state({smoothing: {enabled: true, sigma: 1.2, deblur: 'unsharp', balance: 0.02, amount: 2}});
    const v = C.variants('rings', on);
    assert.equal(v.length, 4);
    v.forEach((x) => assert.deepEqual(x.smoothing, {sigma: 1.2, deblur: 'unsharp', balance: 0.02, amount: 2}));
});

test('варианты «Сравнить σ»: выкл, 1, 1,5, 2, 2,5, 3, 4 при текущих кольцах и деблюринге (и при выключенном)', () => {
    const v = C.variants('sigma', state({rings: 'strong', smoothing: {enabled: false, sigma: 1.5, deblur: 'wiener',
        balance: 0.05, amount: 1.5}}));
    assert.deepEqual(v.map((x) => x.rings), Array(7).fill('strong'));
    assert.equal(v[0].smoothing, null);
    assert.deepEqual(v.slice(1).map((x) => x.smoothing.sigma), [1, 1.5, 2, 2.5, 3, 4]);
    v.slice(1).forEach((x) => {
        assert.equal(x.smoothing.deblur, 'wiener');
        assert.equal(x.smoothing.balance, 0.05);
    });
});

test('подписи вариантов, метрики, деблюр', () => {
    assert.equal(C.variantLabel('rings', {rings: 'medium'}), 'кольца: средне');
    assert.equal(C.variantLabel('rings', {rings: 'custom'}), 'кольца: custom');
    assert.equal(C.variantLabel('sigma', {rings: 'medium', smoothing: null}), 'без сглаживания');
    assert.equal(C.variantLabel('sigma', {smoothing: {sigma: 1.5, deblur: 'wiener', balance: 0.02}}), 'σ 1,5 · Винер');
    assert.equal(C.variantLabel('sigma', {smoothing: {sigma: 1, deblur: 'unsharp'}}), 'σ 1 · маска');
    assert.equal(C.metricsText({noise: 0.012345, sharpness: 1.0783}), 'шум 0,01235 · резкость ×1,08');
    assert.equal(C.metricsText({noise: 0.5}), 'шум 0,5');
    assert.equal(C.metricsText(null), '');
    assert.equal(C.deblurText({sigma: 1.5, deblur: 'wiener', balance: 0.02}), 'Винер 0,02');
    assert.equal(C.deblurText({sigma: 1.5, deblur: 'unsharp', amount: 1.5}), 'маска 1,5');
    assert.equal(C.deblurText({sigma: 2, deblur: 'none'}), 'без деблюра');
    assert.equal(C.deblurText(null), '');
});

test('isCurrent: выбранный вариант — по сравниваемому параметру', () => {
    const st = state();
    assert.ok(C.isCurrent('rings', {rings: 'medium', smoothing: null}, st));
    assert.ok(!C.isCurrent('rings', {rings: 'off', smoothing: null}, st));
    assert.ok(C.isCurrent('sigma', {rings: 'medium', smoothing: null}, st));             // выключено = «без»
    assert.ok(!C.isCurrent('sigma', {smoothing: {sigma: 1.5, deblur: 'wiener'}}, st));
    const on = state({smoothing: {enabled: true, sigma: 1.5, deblur: 'wiener', balance: 0.02, amount: 1.5}});
    assert.ok(C.isCurrent('sigma', {smoothing: {sigma: 1.5, deblur: 'wiener', balance: 0.02}}, on));
    assert.ok(C.isCurrent('sigma', {smoothing: {sigma: 1.50000001, deblur: 'wiener'}}, on));   // нормализация сервиса
    assert.ok(!C.isCurrent('sigma', {smoothing: {sigma: 1.5, deblur: 'unsharp'}}, on));
    assert.ok(!C.isCurrent('sigma', {smoothing: null}, on));
    assert.ok(!C.isCurrent('rings', null, st));
});

test('β Винера на логарифмической шкале: ближайшее значение ползунка', () => {
    const B = S.StepSmoothing.BALANCES, ni = S.StepSmoothing.nearestIndex;
    assert.equal(B[ni(B, 0.02)], 0.02);
    assert.equal(B[ni(B, 0.021)], 0.02);
    assert.equal(B[ni(B, 1)], 0.1);
    assert.equal(B[ni(B, 1e-6)], 0.005);
    assert.equal(B[ni(B, 0)], 0.02);           // мусор — значение по умолчанию
});

// --- рецепт ---------------------------------------------------------------------------------------------------

test('recipeBody: блок smoothing — только после правки человеком; выключено — null', () => {
    const body = (st) => S.StepRun.prototype.recipeBody.call({st});
    assert.ok(!('smoothing' in body(state())));                                          // по умолчанию — ключа нет
    assert.equal(body(state({smoothingChosen: true})).smoothing, null);
    assert.deepEqual(body(state({smoothingChosen: true, smoothing: {enabled: true, sigma: 1.7, deblur: 'none',
        balance: 0.02, amount: 1.5}})).smoothing, {sigma: 1.7, deblur: 'none', balance: 0.02, amount: 1.5});
    assert.equal(body(state()).rings, 'medium');
});

// --- модуль без DOM: фрагмент, строка состояния, клавиши ------------------------------------------------------

function fakeCompare(over) {
    const shown = [];
    const self = Object.assign(Object.create(C.prototype), {
        st: state(), res: null, large: -1,
        app: {viewer: {W: 1000, H: 800, views: {}, get(k) { return this.views[k] || null; }, current: () => 'compare'}},
        setLarge(i) { shown.push(i); this.large = i < 0 ? -1 : i; },
        toggleLarge() { shown.push('toggle'); }
    }, over);
    return {self, shown};
}

test('_region: увеличенный «Срез» — видимая часть; вписанный — прежний фрагмент той же строки или null', () => {
    const {self} = fakeCompare();
    const img = {w: 1000, h: 1000, meta: {downsample: 3, region: [0, 0, 3000, 3000]}};
    self.app.viewer.views.slice = {img, fit: true, xf: core.fitTransform(1000, 1000, 1, 1000, 800, 8)};
    assert.equal(self._region(2269), null);
    self.res = {row: 2269, region: [10, 20, 394, 404]};
    assert.deepEqual(self._region(2269), [10, 20, 394, 404]);
    assert.equal(self._region(100), null);                                                // другая строка
    self.app.viewer.views.slice = {img, fit: false, xf: {sx: 4, sy: 4, tx: -1200, ty: -1600}};
    assert.deepEqual(self._region(2269), [1019, 1244, 1531, 1756]);
});

test('_coords: вариант и координаты в полном срезе по плитке мозаики и в «крупно»', () => {
    const {self} = fakeCompare();
    const res = {kind: 'rings', variants: C.variants('rings', state()), region: [100, 200, 484, 584], ds: 1,
        layout: core.mosaicLayout(4, 384, 384)};
    assert.equal(self._coords(res, 10, 20), 'кольца: выкл · срез x 110, y 220');
    assert.equal(self._coords(res, 392 + 5, 7), 'кольца: слабо · срез x 105, y 207');
    assert.equal(self._coords(res, 386, 7), null);                                         // промежуток
    self.large = 3;
    assert.equal(self._coords(res, 5, 6), 'кольца: сильно · срез x 105, y 206');
    res.region = null;
    assert.equal(self._coords(res, 5, 6), 'кольца: сильно · x 5, y 6');
});

test('клавиши: только на виде «Сравнение» и не в полях ввода; Enter — крупно, ← → — листать, Esc — мозаика', () => {
    const prevDoc = globalThis.document;
    globalThis.document = {querySelector: () => null};
    try {
        const {self, shown} = fakeCompare({res: {variants: [1, 2, 3]}});
        const key = (k, target, extra) => {
            let prevented = false;
            self._onKey(Object.assign({key: k, target: target || {tagName: 'BODY'}, preventDefault() { prevented = true; }},
                extra));
            return prevented;
        };
        assert.ok(!key('ArrowRight'));                         // мозаика: стрелки не трогаем
        assert.ok(key('Enter'));
        assert.deepEqual(shown, ['toggle']);
        assert.ok(!key(' ', {tagName: 'BUTTON'}));             // пробел на кнопке в фокусе — действие кнопки
        assert.ok(!key('Enter', {tagName: 'INPUT'}));
        self.large = 1;
        assert.ok(key('ArrowRight'));
        assert.ok(key('ArrowLeft'));
        assert.ok(!key('ArrowLeft', {tagName: 'INPUT'}));      // ползунок σ в фокусе
        assert.ok(!key('ArrowLeft', null, {ctrlKey: true}));
        assert.ok(key('Escape'));
        assert.deepEqual(shown, ['toggle', 2, 1, -1]);
        self.app.viewer.current = () => 'slice';               // на «Срезе» стрелки — ось (step_axis)
        self.large = 1;
        assert.ok(!key('ArrowRight'));
        assert.ok(!key('Enter'));
    } finally {
        if (prevDoc === undefined) delete globalThis.document;
        else globalThis.document = prevDoc;
    }
});

test('autoText: итог подбора σ — выбранная, без сглаживания, край шкалы, минимум с допуском', () => {
    const T = S.StepSmoothing.autoText;
    const scores = [{sigma: null, rmse: 0.059, noise: 0.059}, {sigma: 2, rmse: 0.009, noise: 0.0072},
        {sigma: 2.5, rmse: 0.0087, noise: 0.0055}, {sigma: 4, rmse: 0.0104, noise: 0.0029}];
    assert.equal(T(null), '');
    const t = T({row: 1800, sigma: 2, sigma_min: 2.5, at_limit: false, scores});
    assert.ok(t.startsWith('Подбор σ (строка 1800): σ 2 — ошибка среза'), t);
    assert.ok(t.includes('без сглаживания') && t.includes('Точный минимум — σ 2,5'), t);
    assert.ok(T({row: 5, sigma: 4, sigma_min: 4, at_limit: true, scores}).includes('на краю шкалы (σ 4)'));
    assert.ok(!T({row: 5, sigma: 2.5, sigma_min: 2.5, at_limit: false, scores}).includes('минимум'));
    assert.ok(T({row: 5, sigma: null, sigma_min: null, at_limit: false, scores}).includes('сглаживание выключено'));
    assert.equal(S.StepSmoothing.SIGMA_MAX, 4);
});


// --- TV 3D --------------------------------------------------------------------------------------------------------

test('denoiseBlock/Query/Text: выключено — null, {}, пусто; сила округляется; блок рецепта', () => {
    const core = S.core;
    assert.equal(core.denoiseBlock(null), null);
    assert.equal(core.denoiseBlock({enabled: false, strength: 2}), null);
    assert.deepEqual(core.denoiseBlock({enabled: true, strength: 2.04, iterations: 50}),
        {method: 'tv', strength: 2, iterations: 50});
    assert.deepEqual(core.denoiseBlock({method: 'tv', strength: 3, weight: 0.06, iterations: 40}),
        {method: 'tv', strength: 3, iterations: 40});
    assert.equal(core.denoiseBlock({method: null, strength: 2}), null);                  // блок рецепта «выкл.»
    assert.deepEqual(core.denoiseQuery({enabled: true, strength: 2.5}), {tv: 2.5, tv_iter: 50});
    assert.deepEqual(core.denoiseQuery({enabled: false, strength: 2.5}), {});
    assert.equal(core.denoiseText({enabled: true, strength: 2.5}), 'TV 2,5σ');
    assert.equal(core.denoiseText({enabled: false}), '');
});

test('варианты «Сравнить TV»: без TV и 1–4σ при текущих кольцах и сглаживании; в других — текущий TV', () => {
    const st = state({rings: 'weak', smoothing: {enabled: true, sigma: 1, deblur: 'none', balance: 0.02, amount: 1.5},
        denoise: {enabled: true, strength: 3, iterations: 40}});
    const v = C.variants('tv', st);
    assert.deepEqual(v.map((x) => x.denoise && x.denoise.strength), [null, 1, 2, 3, 4]);
    v.forEach((x) => {
        assert.equal(x.rings, 'weak');
        assert.equal(x.smoothing.sigma, 1);
        if (x.denoise) assert.equal(x.denoise.iterations, 40);
    });
    assert.equal(C.variantLabel('tv', v[0]), 'без TV');
    assert.equal(C.variantLabel('tv', v[2]), 'TV 2σ');
    assert.ok(C.isCurrent('tv', v[3], st) && !C.isCurrent('tv', v[2], st) && !C.isCurrent('tv', v[0], st));
    assert.ok(C.isCurrent('tv', v[0], state()));
    C.variants('rings', st).concat(C.variants('sigma', st)).forEach((x) => assert.equal(x.denoise.strength, 3));
});

test('recipeBody: denoise — только после правки; включённый — с силой и строкой превью', () => {
    const body = (st) => S.StepRun.prototype.recipeBody.call({st});
    assert.ok(!('denoise' in body(state())));
    assert.equal(body(state({denoiseChosen: true})).denoise, null);
    const b = body(state({denoiseChosen: true, denoise: {enabled: true, strength: 2.5, iterations: 50}}));
    assert.deepEqual(b.denoise, {method: 'tv', strength: 2.5, iterations: 50});
    assert.equal(b.row, 2269);
});

test('hintText: TV без сглаживания или с сильным — совет σ 1', () => {
    const H = S.StepDenoise.hintText;
    assert.equal(H(state()), '');
    const on = {enabled: true, strength: 2, iterations: 50};
    assert.ok(H(state({denoise: on})).includes('σ 1'));
    assert.ok(H(state({denoise: on, smoothing: {enabled: true, sigma: 3, deblur: 'none'}})).includes('σ 1'));
    assert.equal(H(state({denoise: on, smoothing: {enabled: true, sigma: 1, deblur: 'none'}})), '');
});
