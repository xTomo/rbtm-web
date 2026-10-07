'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'volume3d.js');
const core = S.core;

test('scaleBar: круглая длина 1–2–5·10ⁿ, ближайшая к цели; подпись в мкм или мм', () => {
    // 9 мкм на пиксель экрана, цель 120 px → 1,08 мм; ближайшая круглая — 1 мм (111 px)
    let s = core.scaleBar(0.009, 120, 240);
    assert.equal(s.mm, 1);
    assert.ok(Math.abs(s.px - 1 / 0.009) < 1e-9);
    assert.equal(s.label, '1 мм');
    // 0,425 мкм/px · 120 = 51 мкм → 50 мкм
    s = core.scaleBar(0.000425, 120, 240);
    assert.ok(Math.abs(s.mm - 0.05) < 1e-12);
    assert.equal(s.label, '50 мкм');
    // 20 мкм/px · 120 = 2,4 мм → 2 мм
    assert.equal(core.scaleBar(0.02, 120, 240).label, '2 мм');
    assert.ok(core.scaleBar(0.02, 120, 240).px <= 240);
    assert.equal(core.scaleBar(0, 120), null);
    assert.equal(core.scaleBar(NaN, 120), null);
});

test('histAxis: окно ± 20 %, весь диапазон по запросу (с окном внутри)', () => {
    let a = core.histAxis(0, 1, [-5, 5], false);
    assert.ok(Math.abs(a[0] + 0.2) < 1e-12 && Math.abs(a[1] - 1.2) < 1e-12);
    a = core.histAxis(0, 1, [-5, 5], true);
    assert.ok(a[0] < -5 && a[1] > 5);
    a = core.histAxis(-1, 20, [-5, 5], true);           // окно шире данных — ось включает окно
    assert.ok(a[0] < -5 && a[1] > 20);
    a = core.histAxis(3, 3, null, false);               // вырожденное окно — ось не вырождена
    assert.ok(a[1] > a[0]);
});

test('toRGBA с палитрой: уровень окна — индекс таблицы; без палитры — серое как раньше', () => {
    const img = {w: 3, h: 1, dtype: 'float32', data: new Float32Array([0, 0.5, 1]), scale: 1, offset: 0};
    const pal = core.paletteTable('viridis');
    const out = core.toRGBA(img, 0, 1, null, null, pal);
    assert.deepEqual(Array.from(out.subarray(0, 3)), Array.from(pal.subarray(0, 3)));
    assert.deepEqual(Array.from(out.subarray(8, 11)), Array.from(pal.subarray(765, 768)));
    const q = 128 * 3;                                    // 0,5 · 255 = 127,5 → 128
    assert.deepEqual(Array.from(out.subarray(4, 7)), Array.from(pal.subarray(q, q + 3)));
    const gray = core.toRGBA(img, 0, 1);
    assert.deepEqual(Array.from(gray.subarray(4, 7)), [128, 128, 128]);
    // коды uint16 через LUT — тот же цвет
    const u16 = {w: 1, h: 1, dtype: 'uint16', data: new Uint16Array([65535]), scale: 1 / 65535, offset: 0};
    assert.deepEqual(Array.from(core.toRGBA(u16, 0, 1, null, null, pal).subarray(0, 3)),
        Array.from(pal.subarray(765, 768)));
});

test('edgeLabelPlacement: три подписи у ближнего угла, снаружи от центра рамки', () => {
    const V = S.vol3d;
    const dims = [100, 80, 120];
    const cam = V.defaultCamera(dims, 1.5);
    const fm = V.frameMatrices(dims, cam, 1.5);
    const W = 900, H = 600;
    const p = V.edgeLabelPlacement(dims, fm.mvp, W, H);
    assert.equal(p.length, 3);
    const c = V.m4.apply(fm.mvp, [50, 40, 60]);
    const cx = (c[0] + 1) / 2 * W, cy = (1 - c[1]) / 2 * H;
    for (const q of p) {
        assert.ok(q.x > 0 && q.x < W && q.y > 0 && q.y < H, 'в кадре');
        assert.ok(Math.hypot(q.x - cx, q.y - cy) > 20, 'не в центре рамки');
    }
});
