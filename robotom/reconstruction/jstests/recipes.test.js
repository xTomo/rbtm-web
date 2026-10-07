'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'recipes.js');
const R = S.RecipesPanel;

const EXP = 'a82d2e0a-ab8e-4ebf-92ff-477bbc97b3e3';

/** Рецепт движка — как full_motion_on/recipe.json скана a82d2e0a (сдвиги по кадрам укорочены). */
function recipe(over) {
    return Object.assign({
        schema: 1, created: '2026-10-07T11:17:00+00:00', author: '',
        input: {exp_id: EXP, format: 'hdf5-v2', fingerprint: 'abc'},
        pixel_size: {value_mm: 0.009, source: 'detector', user_edited: false},
        fov: {x0: 1151, x1: 2881, y0: 167, y1: 2317, preview_row: 1242},
        axis: {center_x: 2049.555088405256, y_ref: 1241.5, tilt_deg: -0.8876794139353338, method: 'auto'},
        repositioning: {enabled: true, shifts: null},
        recon: {slices: [167, 2317], xy_roi: {kind: null}, algorithm: 'FBP', angles: 'first_180'},
        normalization: 'auto',
        rings: {preset: 'medium', params: null, version: 2},
        smoothing: {sigma: null, deblur: 'none', balance: 0.02, amount: 1.5},
        motion: {mode: 'on', applied: true, dx: [0.1, -0.2], fnums: [10, 11], summary: {status: 'inconsistent', rms: 1.81}},
        empty_skip_first: 2,
        denoise: {method: null, strength: 2.0, weight: null, iterations: 50},
        outputs: {full: true, binning: [4], dtype: 'float32'}
    }, over || {});
}

/** Состояние студии после загрузки той же рамки, с авто-осью и настройками по умолчанию. */
function state(over) {
    return Object.assign({
        load: 'ready', roi: {x0: 1151, x1: 2881, y0: 167, y1: 2317}, loadedRoi: {x0: 1151, x1: 2881, y0: 167, y1: 2317},
        row: 1242, pixelSize: {value_mm: 0.009, source: 'detector'}, pixelUser: null,
        axisInfo: {axis: {center_x: 2047.3379, y_ref: 1241.5, tilt_deg: -0.8878, method: 'auto'}},
        rings: 'medium', angles: 'first_180', slices: null, binning: [4],
        smoothing: {enabled: false, sigma: 2.0, deblur: 'none', balance: 0.02, amount: 1.5},
        denoise: {enabled: false, strength: 2, iterations: 50}
    }, over || {});
}

const changed = (p) => p.items.filter((it) => it.changed).map((it) => it.key);
const item = (p, key) => p.items.find((it) => it.key === key);

test('fromDocument: рецепт, result.json и ответ recipes/<run> — один и тот же рецепт; не рецепт — ошибка', () => {
    const r = recipe();
    assert.equal(R.fromDocument(r), r);
    assert.equal(R.fromDocument({schema: 1, run_id: 'x', recipe: r, volume: {}}), r);
    assert.equal(R.fromDocument({exp_id: EXP, run_id: 'x', current: true, recipe: r}), r);
    assert.throws(() => R.fromDocument(null), /не объект/);
    assert.throws(() => R.fromDocument([1]), /не объект/);
    assert.throws(() => R.fromDocument({a: 1}), /не рецепт/);
    assert.throws(() => R.fromDocument({recipe: {input: {}}}), /не рецепт/);
});

test('toState: поля рецепта → настройки шагов (ось — ручная с теми же числами)', () => {
    const t = R.toState(recipe({smoothing: {sigma: 1.5, deblur: 'wiener', balance: 0.03, amount: 1.5},
        denoise: {method: 'tv', strength: 2.5, weight: 0.01, iterations: 40}, outputs: {binning: [8, 2, 3]},
        recon: {slices: [200, 400], angles: 'full_halves'}, rings: {preset: 'strong'}}));
    assert.deepEqual(t.roi, {x0: 1151, x1: 2881, y0: 167, y1: 2317});
    assert.equal(t.row, 1242);
    assert.equal(t.axis.method, 'manual');
    assert.equal(t.axis.y_ref, 1241.5);
    assert.ok(Math.abs(t.axis.center_x - 2049.555) < 0.001 && Math.abs(t.axis.tilt_deg + 0.8877) < 0.0001);
    assert.equal(t.motionMode, 'on');
    assert.equal(t.rings, 'strong');
    assert.deepEqual(t.smoothing, {enabled: true, sigma: 1.5, deblur: 'wiener', balance: 0.03, amount: 1.5});
    assert.deepEqual(t.denoise, {enabled: true, strength: 2.5, iterations: 40});
    assert.equal(t.angles, 'full_halves');
    assert.deepEqual(t.slices, [200, 400]);
    assert.deepEqual(t.binning, [2, 8]);            // ×3 студия не делает
    assert.equal(t.pixelUser, null);                // размер не задан вручную — у скана свой
    const t2 = R.toState(recipe({axis: null, motion: null, rings: {preset: '??'},
        pixel_size: {value_mm: 0.0045, source: 'user', user_edited: true}}));
    assert.equal(t2.axis, null);
    assert.equal(t2.motionMode, 'auto');
    assert.equal(t2.rings, 'medium');
    assert.equal(t2.pixelUser, 0.0045);
    assert.deepEqual(t2.smoothing, {enabled: false});
});

test('plan того же скана: меняются ось и режим смещения — в сессии, без загрузки области', () => {
    const p = R.plan(recipe(), state(), {exp_id: EXP, motionMode: 'auto'});
    assert.equal(p.sameScan, true);
    assert.equal(p.needLoad, false);
    assert.deepEqual(changed(p), ['axis', 'motion']);       // строки по умолчанию — y0..y1 рамки, как в рецепте
    assert.equal(item(p, 'axis').when, 'session');
    assert.equal(item(p, 'axis').check, true);
    assert.equal(item(p, 'motion').from, 'авто');
    assert.equal(item(p, 'motion').to, 'вкл');
    assert.deepEqual(p.warnings, []);
    // уже как в рецепте — менять нечего
    const st = state({axisInfo: {axis: R.toState(recipe()).axis}, slices: [167, 2317]});
    assert.deepEqual(changed(R.plan(recipe(), st, {exp_id: EXP, motionMode: 'on'})), []);
});

test('plan: другая рамка или область не загружена — ось и смещение после загрузки области', () => {
    const r = recipe({fov: {x0: 1000, x1: 3000, y0: 100, y1: 2400, preview_row: 1300}});
    const p = R.plan(r, state(), {exp_id: EXP, motionMode: 'auto'});
    assert.equal(p.needLoad, true);
    assert.equal(item(p, 'fov').changed, true);
    assert.equal(item(p, 'fov').when, 'load');
    assert.equal(item(p, 'axis').when, 'load');
    assert.equal(item(p, 'motion').when, 'load');
    assert.equal(item(p, 'row').changed, true);
    const p2 = R.plan(recipe(), state({load: 'none', loadedRoi: null, axisInfo: null}), {exp_id: EXP});
    assert.equal(p2.needLoad, true);
    assert.equal(item(p2, 'fov').when, 'load');
    assert.equal(item(p2, 'fov').changed, false);           // рамка та же — только загрузить
    assert.equal(item(p2, 'motion').changed, true);         // сессии нет: по умолчанию авто, в рецепте вкл
    assert.match(item(p2, 'motion').from, /по умолчанию/);
    const p3 = R.plan(recipe({motion: {mode: 'auto', applied: false}}), state({load: 'none', loadedRoi: null}),
        {exp_id: EXP});
    assert.equal(item(p3, 'motion').changed, false);
});

test('plan рецепта другого скана: ось по умолчанию не отмечена, предупреждение', () => {
    const r = recipe({input: {exp_id: 'другой-скан', fingerprint: 'x'}});
    const p = R.plan(r, state(), {exp_id: EXP, motionMode: 'auto'});
    assert.equal(p.sameScan, false);
    assert.equal(item(p, 'axis').changed, true);
    assert.equal(item(p, 'axis').check, false);
    assert.equal(item(p, 'motion').check, true);
    assert.ok(p.warnings.some((w) => /другого скана/.test(w)));
});

test('plan: настройки страницы и размер пикселя', () => {
    const r = recipe({rings: {preset: 'weak'}, smoothing: {sigma: 1, deblur: 'none', balance: 0.02, amount: 1.5},
        denoise: {method: 'tv', strength: 2, iterations: 50}, recon: {slices: [500, 600], angles: 'full_halves'},
        outputs: {binning: [2, 4]}, pixel_size: {value_mm: 0.00425, source: 'user', user_edited: true}});
    const p = R.plan(r, state(), {exp_id: EXP, motionMode: 'on'});
    assert.deepEqual(changed(p), ['pixel', 'axis', 'rings', 'smoothing', 'denoise', 'angles', 'slices', 'binning']);
    assert.ok(item(p, 'pixel').to.indexOf('4,25') === 0 || item(p, 'pixel').to.indexOf('4.25') === 0);
    // размер найден по детектору, у скана другой — не применяется, но предупреждение есть
    const p2 = R.plan(recipe({pixel_size: {value_mm: 0.00425, source: 'detector', user_edited: false}}), state(),
        {exp_id: EXP});
    assert.equal(item(p2, 'pixel'), undefined);
    assert.ok(p2.warnings.some((w) => /Размер пикселя/.test(w)));
});

test('notes и summary: что студия не переносит; сводка для показа', () => {
    const r = recipe({normalization: 'air', empty_skip_first: 0, repositioning: {enabled: true, shifts: {sx: [0], sy: [0]}}});
    const n = R.notes(r);
    assert.equal(n.length, 4);
    assert.ok(n.some((s) => /нормировка/.test(s)) && n.some((s) => /сдвиги смещения по кадрам/.test(s)));
    assert.deepEqual(R.notes(recipe({motion: {mode: 'auto', applied: false}})), []);
    const sm = Object.fromEntries(R.summary(recipe()));
    assert.equal(sm['Скан'], EXP);
    assert.match(sm['Смещение'], /режим вкл, компенсировано \(СКО 1[,.]8 px\)/);
    assert.match(sm['Ось'], /на строке 1241\.5, наклон -0[,.]888°/);
    assert.equal(sm['Кольца'], 'средне');
    assert.equal(sm['Копии'], '×4');
});
