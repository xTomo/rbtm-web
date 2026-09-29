'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'api.js', 'step_smoothing.js', 'compare.js', 'step_run.js');
const core = S.core;
const C = S.Compare;

function state(over) {
    return Object.assign({
        rings: 'medium', angles: 'first_180', row: 2269, smoothingChosen: false,
        smoothing: {enabled: false, sigma: 1.5, deblur: 'wiener', balance: 0.02, amount: 1.5}
    }, over);
}

// --- варианты и подписи ---------------------------------------------------------------------------------------

test('варианты «Сравнить кольца»: все пресеты при текущем сглаживании', () => {
    assert.deepEqual(C.variants('rings', state()), [
        {rings: 'off', smoothing: null}, {rings: 'weak', smoothing: null},
        {rings: 'medium', smoothing: null}, {rings: 'strong', smoothing: null}]);
    const on = state({smoothing: {enabled: true, sigma: 1.2, deblur: 'unsharp', balance: 0.02, amount: 2}});
    const v = C.variants('rings', on);
    assert.equal(v.length, 4);
    v.forEach((x) => assert.deepEqual(x.smoothing, {sigma: 1.2, deblur: 'unsharp', balance: 0.02, amount: 2}));
});

test('варианты «Сравнить σ»: выкл, 0,7, 1, 1,5, 2 при текущих кольцах и деблюринге (и при выключенном)', () => {
    const v = C.variants('sigma', state({rings: 'strong', smoothing: {enabled: false, sigma: 1.5, deblur: 'wiener',
        balance: 0.05, amount: 1.5}}));
    assert.deepEqual(v.map((x) => x.rings), ['strong', 'strong', 'strong', 'strong', 'strong']);
    assert.equal(v[0].smoothing, null);
    assert.deepEqual(v.slice(1).map((x) => x.smoothing.sigma), [0.7, 1, 1.5, 2]);
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
