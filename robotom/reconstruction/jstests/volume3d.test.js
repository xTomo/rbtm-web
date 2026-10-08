'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'volume3d.js');
const V = S.vol3d;
const m4 = V.m4;

function close(a, b, eps, msg) {
    assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || '') + ' ' + a + ' ≠ ' + b);
}

function corners(d) {
    const out = [];
    for (const x of [0, d[0]]) for (const y of [0, d[1]]) for (const z of [0, d[2]]) out.push([x, y, z]);
    return out;
}

test('m4: умножение на единичную, lookAt переводит глаз в начало, цель — на ось −z', () => {
    const a = m4.perspective(0.5, 1.3, 0.1, 10);
    assert.deepEqual(Array.from(m4.multiply(a, m4.identity())), Array.from(a));
    const eye = [1, 2, 3], target = [0.5, -1, 0.2];
    const v = m4.lookAt(eye, target, [0, 0, 1]);
    m4.apply(v, eye).forEach((c) => close(c, 0));
    const t = m4.apply(v, target);
    close(t[0], 0);
    close(t[1], 0);
    assert.ok(t[2] < 0);
});

test('frameMatrices: камера по умолчанию вписывает коробку, центр — в центре экрана, глаз в вокселях согласован', () => {
    for (const dims of [[216, 216, 269], [400, 400, 20], [100, 300, 50]]) {
        for (const aspect of [0.5, 1, 2.2]) {
            const cam = V.defaultCamera(dims, aspect);
            const fm = V.frameMatrices(dims, cam, aspect);
            const c = m4.apply(fm.mvp, [dims[0] / 2, dims[1] / 2, dims[2] / 2]);
            close(c[0], 0, 1e-5, 'центр x');
            close(c[1], 0, 1e-5, 'центр y');
            for (const p of corners(dims)) {
                const q = m4.apply(fm.mvp, p);
                assert.ok(Math.abs(q[0]) <= 1 && Math.abs(q[1]) <= 1 && q[2] > -1 && q[2] < 1,
                    `угол ${p} вне кадра при ${dims}, aspect ${aspect}: ${q}`);
            }
            const eyeWorld = V.eyePosition(cam);
            m4.apply(fm.model, fm.eyeVox).forEach((v, i) => close(v, eyeWorld[i], 1e-5, 'глаз'));
        }
    }
});

test('срез z = 0 (верхняя строка детектора) наверху экрана; поворот без отражения', () => {
    const dims = [100, 100, 100];
    const cam = V.defaultCamera(dims, 1);
    const fm = V.frameMatrices(dims, cam, 1);
    const top = m4.apply(fm.mvp, [50, 50, 0]), bottom = m4.apply(fm.mvp, [50, 50, 100]);
    assert.ok(top[1] > bottom[1]);
    close(top[0], bottom[0], 1e-5);
    // определитель линейной части модели > 0 — образец не зеркалится
    const a = fm.model;
    const det = a[0] * (a[5] * a[10] - a[9] * a[6]) - a[4] * (a[1] * a[10] - a[9] * a[2]) +
        a[8] * (a[1] * a[6] - a[5] * a[2]);
    assert.ok(det > 0);
    // вид сверху: x вправо, y вниз — как срез z в 2D
    const above = {az: -Math.PI / 2, el: 89 * Math.PI / 180, dist: 3, target: [0, 0, 0]};
    const f2 = V.frameMatrices(dims, above, 1);
    const o = m4.apply(f2.mvp, [50, 50, 50]), px = m4.apply(f2.mvp, [60, 50, 50]), py = m4.apply(f2.mvp, [50, 60, 50]);
    assert.ok(px[0] > o[0] + 0.01 && Math.abs(px[1] - o[1]) < 0.01, 'x вправо');
    assert.ok(py[1] < o[1] - 0.01 && Math.abs(py[0] - o[0]) < 0.01, 'y вниз');
});

test('orbit, zoom, pan: пределы и сдвиг цели в плоскости экрана', () => {
    const cam = V.defaultCamera([10, 10, 10], 1);
    const up = V.orbit(cam, 0, 1e6);
    close(up.el, 89 * Math.PI / 180);
    close(V.orbit(cam, 0, -1e6).el, -89 * Math.PI / 180);
    close(V.orbit(cam, 10, 0).az, cam.az - 4 * Math.PI / 180);
    assert.equal(V.zoom(cam, 1e9).dist, 20);
    assert.equal(V.zoom(cam, 1e-9).dist, 0.05);
    const p = V.pan(cam, 30, -20, 600);
    const eye = V.eyePosition(cam);
    const fwd = [cam.target[0] - eye[0], cam.target[1] - eye[1], cam.target[2] - eye[2]];
    const d = [p.target[0] - cam.target[0], p.target[1] - cam.target[1], p.target[2] - cam.target[2]];
    close(d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2], 0, 1e-9, 'сдвиг вдоль взгляда');
    assert.ok(Math.hypot(...d) > 0);
    // точка, бывшая в центре экрана, после сдвига вправо на 30 px уходит вправо
    const before = m4.apply(V.frameMatrices([10, 10, 10], cam, 1).mvp, [5, 5, 5]);
    const after = m4.apply(V.frameMatrices([10, 10, 10], p, 1).mvp, [5, 5, 5]);
    assert.ok(after[0] > before[0] && after[1] > before[1]);
});

test('texWindow: окно в единицах текстуры R8 (код / 255)', () => {
    const scale = 0.01, offset = -0.2;
    const w = V.texWindow(-0.2 + 0.01 * 51, -0.2 + 0.01 * 204, scale, offset);
    close(w[0], 51 / 255);
    close(w[1], 204 / 255);
    const deg = V.texWindow(1, 1, scale, offset);
    assert.ok(deg[1] > deg[0]);
});

test('палитры: 256 цветов, известные концы, у перцептивных яркость растёт монотонно', () => {
    const names = V.PALETTES.map((p) => p[0]);
    assert.deepEqual(names, ['gray', 'inferno', 'viridis', 'magma', 'plasma', 'cividis', 'jet']);
    const rgb = (n, i) => Array.from(V.paletteTable(n).subarray(i * 3, i * 3 + 3));
    for (const n of names) assert.equal(V.paletteTable(n).length, 768, n);
    assert.deepEqual(rgb('gray', 0), [0, 0, 0]);
    assert.deepEqual(rgb('gray', 255), [255, 255, 255]);
    assert.deepEqual(rgb('viridis', 0), [68, 1, 84]);          // matplotlib: #440154
    assert.deepEqual(rgb('viridis', 255), [253, 231, 37]);     // #fde725
    assert.deepEqual(rgb('inferno', 0), [0, 0, 4]);
    assert.deepEqual(rgb('jet', 0), [0, 0, 128]);
    assert.deepEqual(rgb('jet', 255), [128, 0, 0]);
    assert.deepEqual(V.paletteTable('нет такой'), V.paletteTable('gray'));
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (const n of ['inferno', 'viridis', 'magma', 'plasma', 'cividis']) {
        for (let i = 8; i < 256; i += 8) assert.ok(lum(rgb(n, i)) > lum(rgb(n, i - 8)), n + ' ' + i);
    }
    // jet немонотонна по яркости: у голубого–жёлтого (≈ 0,375–0,625) ярче, чем у красного конца
    assert.ok(lum(rgb('jet', 160)) > lum(rgb('jet', 255)));
});

test('colorbarTicks: середина шкалы с учётом гаммы', () => {
    const t = V.colorbarTicks(0, 2, 1);
    assert.deepEqual(t.map((x) => x.frac), [1, 0.5, 0]);
    assert.deepEqual(t.map((x) => x.value), [2, 1, 0]);
    close(V.colorbarTicks(0, 1, 2)[1].value, Math.SQRT1_2);
    close(V.colorbarTicks(-1, 1, 0.5)[1].value, -1 + 2 * 0.25);
});

test('clipFromSlice: разрез проходит через центр выбранного среза, доля стороны по своей оси', () => {
    // 3D-объём 96 × 241 × 241 (z, y, x), без доп. уменьшения: срез z = 48 → (48,5)/96
    close(V.clipFromSlice(2, 48, 1, [96, 241, 241]).pos, 48.5 / 96);
    assert.equal(V.clipFromSlice(2, 48, 1, [96, 241, 241]).axis, 2);
    // срез y = 120 копии, 3D уменьшен ещё в 2 раза: (120,5)/2 из 120 вокселей по y
    close(V.clipFromSlice(1, 120, 2, [48, 120, 121]).pos, 60.25 / 120);
    // x — сторона nx
    close(V.clipFromSlice(0, 10, 1, [5, 6, 40]).pos, 10.5 / 40);
    assert.equal(V.clipFromSlice(0, 1000, 1, [5, 6, 40]).pos, 1);
});

test('slicePosition и контуры: срез i копии — центр плоскости в вокселях 3D-объёма', () => {
    assert.equal(V.slicePosition(5, 2), 2.75);
    assert.equal(V.slicePosition(0, 1), 0.5);
    assert.equal(V.boxEdges([2, 3, 4]).length, 72);
    const pl = V.planeEdges([20, 30, 40], 2, 7.5);
    assert.equal(pl.length, 24);
    for (let i = 0; i < 8; i++) assert.equal(pl[i * 3 + 2], 7.5);
    const xs = new Set(), ys = new Set();
    for (let i = 0; i < 8; i++) {
        xs.add(pl[i * 3]);
        ys.add(pl[i * 3 + 1]);
    }
    assert.deepEqual([...xs].sort((a, b) => a - b), [0, 20]);
    assert.deepEqual([...ys].sort((a, b) => a - b), [0, 30]);
    const px = V.planeEdges([20, 30, 40], 0, 3);
    for (let i = 0; i < 8; i++) assert.equal(px[i * 3], 3);
});
