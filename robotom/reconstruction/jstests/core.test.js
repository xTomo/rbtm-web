// node --test robotom/reconstruction/jstests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js');
const core = S.core;

function headers(h) {
    return (name) => (Object.prototype.hasOwnProperty.call(h, name) ? h[name] : null);
}

function u16buf(values) {
    const a = new Uint16Array(values);
    return a.buffer;
}

// --- декодирование --------------------------------------------------------------------------------------------

test('decodeBinary: uint16 (h, w) с квантованием и X-Meta', () => {
    const buf = u16buf([0, 1, 2, 65535, 10, 20]);
    const img = core.decodeBinary(buf, headers({
        'X-Shape': '2,3', 'X-Dtype': 'uint16', 'X-Scale': '0.5', 'X-Offset': '-1.0',
        'X-Meta': '{"row":7,"downsample":2}'
    }));
    assert.equal(img.w, 3);
    assert.equal(img.h, 2);
    assert.equal(img.k, 1);
    assert.equal(img.dtype, 'uint16');
    assert.ok(img.quantized);
    assert.deepEqual(img.meta, {row: 7, downsample: 2});
    assert.equal(core.valueAt(img, 0, 0), -1);
    assert.equal(core.valueAt(img, 2, 0), 0);            // код 2 · 0,5 − 1
    assert.equal(core.valueAt(img, 0, 1), 65535 * 0.5 - 1);
    assert.ok(Number.isNaN(core.valueAt(img, 3, 0)));
    assert.ok(Number.isNaN(core.valueAt(img, 0, -1)));
});

test('decodeBinary: python repr чисел (экспонента), стопка (k, h, w) и кадр', () => {
    const vals = [];
    for (let i = 0; i < 2 * 2 * 3; i++) vals.push(i);
    const img = core.decodeBinary(u16buf(vals), headers({
        'X-Shape': '2,2,3', 'X-Dtype': 'uint16', 'X-Scale': '1.52587890625e-05', 'X-Offset': '0.0'
    }));
    assert.equal(img.k, 2);
    assert.equal(img.h, 2);
    assert.equal(img.w, 3);
    assert.equal(img.scale, 1.52587890625e-05);
    const f1 = core.frameOf(img, 1);
    assert.equal(f1.data.length, 6);
    assert.equal(f1.data[0], 6);
    assert.equal(f1.index, 1);
    assert.equal(core.frameOf(img, 99).index, 1);        // вне диапазона — последний кадр
});

test('decodeBinary: float32 без X-Scale, uint8, meta битый — пустой', () => {
    const f = new Float32Array([1.5, -2.25, NaN, 4]);
    const img = core.decodeBinary(f.buffer, headers({'X-Shape': '2,2', 'X-Dtype': 'float32', 'X-Meta': '{oops'}));
    assert.equal(img.quantized, false);
    assert.deepEqual(img.meta, {});
    assert.equal(core.valueAt(img, 1, 0), -2.25);
    const b = core.decodeBinary(new Uint8Array([1, 2, 3]).buffer, headers({'X-Shape': '3', 'X-Dtype': 'uint8'}));
    assert.equal(b.w, 3);
    assert.equal(b.h, 1);
    assert.equal(core.valueAt(b, 2, 0), 3);
});

test('decodeBinary: невыровненный вид буфера копируется', () => {
    const raw = new Uint8Array(1 + 4);
    new Uint8Array(new Uint16Array([513, 7]).buffer).forEach((v, i) => { raw[1 + i] = v; });
    const view = raw.subarray(1);                           // byteOffset = 1
    const img = core.decodeBinary(view, headers({'X-Shape': '1,2', 'X-Dtype': 'uint16'}));
    assert.deepEqual(Array.from(img.data), [513, 7]);
});

test('decodeBinary: ошибки формата', () => {
    const buf = u16buf([1, 2, 3, 4]);
    assert.throws(() => core.decodeBinary(buf, headers({'X-Dtype': 'uint16'})), /X-Shape/);
    assert.throws(() => core.decodeBinary(buf, headers({'X-Shape': '2,2', 'X-Dtype': 'int64'})), /X-Dtype/);
    assert.throws(() => core.decodeBinary(buf, headers({'X-Shape': '3,2', 'X-Dtype': 'uint16'})), /не совпадает/);
    assert.throws(() => core.decodeBinary(buf, headers({'X-Shape': '2,x', 'X-Dtype': 'uint16'})), /X-Shape/);
    assert.throws(() => core.decodeBinary(buf, headers({'X-Shape': '1,1,1,4', 'X-Dtype': 'uint16'})), /размерность/);
    assert.throws(() => core.decodeBinary(buf, headers({
        'X-Shape': '2,2', 'X-Dtype': 'uint16', 'X-Scale': 'nan', 'X-Offset': '0'
    })), /X-Scale/);
});

// --- гистограмма, окно, LUT -----------------------------------------------------------------------------------

function codesImage(codes, scale, offset) {
    return {w: codes.length, h: 1, k: 1, dtype: 'uint16', data: new Uint16Array(codes), scale: scale, offset: offset,
        quantized: true, meta: {}};
}

test('histogram/percentile: коды 0..99, scale 1 — медиана 49,5; physical через scale/offset', () => {
    const codes = [];
    for (let i = 0; i < 100; i++) codes.push(i);
    const h = core.histogram(codesImage(codes, 1, 0));
    assert.equal(h.total, 100);
    assert.ok(Math.abs(core.percentile(h, 50) - 49.5) < 1e-9);
    assert.deepEqual(core.dataRange(h), [-0.5, 99.5]);
    const h2 = core.histogram(codesImage(codes, 0.01, 2));
    assert.ok(Math.abs(core.percentile(h2, 50) - (2 + 0.495)) < 1e-9);
    const w = core.autoWindow(h2);
    assert.ok(w[0] < w[1]);
    assert.ok(w[0] >= 2 - 0.005 && w[1] <= 2 + 0.995);
});

test('autoWindow: постоянное изображение — окно не вырождено', () => {
    const h = core.histogram(codesImage([5, 5, 5, 5], 0.1, 0));
    const w = core.autoWindow(h);
    assert.ok(w[1] > w[0]);
});

test('histogram float32: NaN пропускаются, binHistogram сохраняет сумму', () => {
    const data = new Float32Array([0, 1, 2, 3, NaN, 4, Infinity]);
    const img = {w: 7, h: 1, k: 1, dtype: 'float32', data: data, scale: 1, offset: 0, meta: {}};
    const h = core.histogram(img);
    assert.equal(h.total, 5);
    const r = core.dataRange(h);
    assert.ok(r[0] <= 0 && r[1] >= 4);
    const bins = core.binHistogram(h, 10, r[0], r[1]);
    assert.equal(Array.from(bins).reduce((a, b) => a + b, 0), 5);
});

test('buildLut: монотонна, обрезает за окном, 0 и 255 на краях', () => {
    const img = codesImage([0], 1 / 65535, 0);            // значения 0..1
    const lut = core.buildLut(img, 0.25, 0.75);
    assert.equal(lut.length, 65536);
    assert.equal(lut[0], 0);
    assert.equal(lut[Math.round(0.25 * 65535)], 0);
    assert.equal(lut[Math.round(0.5 * 65535)], 128);
    assert.equal(lut[Math.round(0.75 * 65535)], 255);
    assert.equal(lut[65535], 255);
    for (let c = 1; c < 65536; c += 97) assert.ok(lut[c] >= lut[c - 1]);
    const same = core.buildLut(img, 0.1, 0.2, lut);
    assert.equal(same, lut);                              // массив переиспользуется
});

test('toRGBA: uint16 через LUT и float32 напрямую, альфа 255', () => {
    const img = codesImage([0, 32768, 65535], 1, 0);
    const out = core.toRGBA(img, 0, 65535);
    assert.equal(out.length, 12);
    assert.deepEqual(Array.from(out.slice(0, 4)), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(out.slice(8, 12)), [255, 255, 255, 255]);
    const f = {w: 3, h: 1, dtype: 'float32', data: new Float32Array([-1, 0.5, NaN]), scale: 1, offset: 0};
    const o2 = core.toRGBA(f, 0, 1);
    assert.equal(o2[0], 0);
    assert.equal(o2[4], 128);
    assert.equal(o2[8], 0);
    assert.equal(o2[11], 255);
});

test('downsampleMean: среднее по блокам в физических значениях', () => {
    const img = {w: 4, h: 2, k: 1, dtype: 'uint16', data: new Uint16Array([0, 2, 4, 6, 2, 4, 6, 8]), scale: 0.5,
        offset: 1, meta: {}};
    const s = core.downsampleMean(img, 2);
    assert.equal(s.w, 2);
    assert.equal(s.h, 1);
    assert.equal(s.dtype, 'float32');
    assert.equal(s.data[0], 2 * 0.5 + 1);                // среднее кодов 0,2,2,4 = 2
    assert.equal(s.data[1], 6 * 0.5 + 1);
});

// --- преобразования -------------------------------------------------------------------------------------------

test('fitTransform: вписывает и центрирует; aspect растягивает по вертикали', () => {
    const xf = core.fitTransform(1000, 500, 1, 516, 516, 8);
    assert.ok(Math.abs(xf.sx - 0.5) < 1e-12);
    assert.equal(xf.sy, xf.sx);
    assert.ok(Math.abs(xf.tx - 8) < 1e-9);
    assert.ok(Math.abs(xf.ty - (516 - 250) / 2) < 1e-9);
    const xa = core.fitTransform(5000, 90, 25, 1016, 1016, 8);
    assert.ok(Math.abs(xa.sy / xa.sx - 25) < 1e-9);
    assert.ok(90 * xa.sy <= 1000 + 1e-9 && 5000 * xa.sx <= 1000 + 1e-9);
});

test('zoomAt: точка под курсором неподвижна, масштаб ограничен', () => {
    const xf = {sx: 2, sy: 2, tx: 10, ty: 20};
    const p = core.toImage(xf, 110, 70);
    const z = core.zoomAt(xf, 1.5, 110, 70, 0.1, 10);
    const p2 = core.toImage(z, 110, 70);
    assert.ok(Math.abs(p.x - p2.x) < 1e-9 && Math.abs(p.y - p2.y) < 1e-9);
    assert.equal(z.sx, 3);
    assert.equal(core.zoomAt(xf, 100, 0, 0, 0.1, 10).sx, 10);
    const one = core.oneToOne({sx: 0.25, sy: 1, tx: 0, ty: 0}, 50, 50);
    assert.equal(one.sx, 1);
    assert.equal(one.sy, 4);                             // вытянутость сохраняется
    const s = core.toScreen(xf, p.x, p.y);
    assert.ok(Math.abs(s.x - 110) < 1e-9 && Math.abs(s.y - 70) < 1e-9);
});

// --- рамка ----------------------------------------------------------------------------------------------------

const B = {x0: 0, y0: 0, x1: 100, y1: 50};

test('dragRect: перенос в границах, размер сохраняется', () => {
    const r = {x0: 10, x1: 30, y0: 5, y1: 15};
    assert.deepEqual(core.dragRect(r, 'move', 5, 5, B, 4, 4), {x0: 15, x1: 35, y0: 10, y1: 20});
    assert.deepEqual(core.dragRect(r, 'move', 500, -500, B, 4, 4), {x0: 80, x1: 100, y0: 0, y1: 10});
});

test('dragRect: края и углы с наименьшим размером и границами', () => {
    const r = {x0: 10, x1: 30, y0: 5, y1: 15};
    assert.deepEqual(core.dragRect(r, 'e', 100, 0, B, 4, 4), {x0: 10, x1: 100, y0: 5, y1: 15});
    assert.deepEqual(core.dragRect(r, 'w', 100, 0, B, 4, 4), {x0: 26, x1: 30, y0: 5, y1: 15});
    assert.deepEqual(core.dragRect(r, 'nw', -50, -50, B, 4, 4), {x0: 0, x1: 30, y0: 0, y1: 15});
    assert.deepEqual(core.dragRect(r, 'se', -100, -100, B, 4, 4), {x0: 10, x1: 14, y0: 5, y1: 9});
    assert.deepEqual(core.dragRect(r, 'n', 3, 2, B, 4, 4), {x0: 10, x1: 30, y0: 7, y1: 15});
    // axes 'x': вертикаль не меняется ни у ручек, ни у переноса
    assert.deepEqual(core.dragRect(r, 'ne', 5, 5, B, 4, 4, 'x'), {x0: 10, x1: 35, y0: 5, y1: 15});
    assert.deepEqual(core.dragRect(r, 'move', 5, 5, B, 4, 4, 'x'), {x0: 15, x1: 35, y0: 5, y1: 15});
});

test('clampRoi/clampRow/sameRoi/cropBytes/clampSlices', () => {
    const W = 5056, H = 2968;
    assert.deepEqual(core.clampRoi({x0: -5.4, x1: 6000, y0: 10.6, y1: 2000.2}, W, H), {x0: 0, x1: 5056, y0: 11, y1: 2000});
    assert.deepEqual(core.clampRoi({x0: 300, x1: 100, y0: 5, y1: 5}, W, H), {x0: 100, x1: 300, y0: 5, y1: 21});
    assert.deepEqual(core.clampRoi({x0: 5050, x1: 5060, y0: 0, y1: 100}, W, H), {x0: 5040, x1: 5056, y0: 0, y1: 100});
    const roi = {x0: 0, x1: 10, y0: 100, y1: 200};
    assert.equal(core.clampRow(50, roi), 100);
    assert.equal(core.clampRow(250, roi), 199);
    assert.equal(core.clampRow(150.4, roi), 150);
    assert.equal(core.clampRow(NaN, roi), 150);
    assert.ok(core.sameRoi(roi, {x0: 0, x1: 10, y0: 100, y1: 200, preview_row: 3}));
    assert.ok(!core.sameRoi(roi, null));
    assert.equal(core.cropBytes(452, {x0: 0, x1: 3000, y0: 0, y1: 1500}), 452 * 1500 * 3000 * 2);
    assert.deepEqual(core.clampSlices(50, 150, roi), [100, 150]);
    assert.deepEqual(core.clampSlices(180, 120, roi), [120, 180]);
    assert.deepEqual(core.clampSlices(199, 199, roi), [199, 200]);
    assert.deepEqual(core.clampSlices(NaN, NaN, roi), [100, 200]);
});

test('roiToImage/roiFromImage: туда и обратно без потерь, в том числе не кратное bin', () => {
    const W = 5056, H = 2968;
    const roi = {x0: 1001, x1: 4003, y0: 7, y1: 2961};
    const back = core.roiFromImage(core.roiToImage(roi, 4), 4, W, H);
    assert.deepEqual(back, roi);
});

// --- форматирование -------------------------------------------------------------------------------------------

function norm(s) {
    return s.replace(/ | /g, ' ');
}

test('форматирование по-русски', () => {
    assert.equal(core.fmtNum(2528.4567, 2), '2528,46');
    assert.equal(core.fmtNum(null), '—');
    assert.equal(core.fmtFixed(0.5, 3), '0,500');
    assert.equal(norm(core.fmtBytes(0)), '0 байт');
    assert.equal(norm(core.fmtBytes(1536)), '1,5 КБ');
    assert.equal(norm(core.fmtBytes(13.25 * 1024 ** 3)), '13,3 ГБ');
    assert.equal(core.fmtDuration(45), '45 с');
    assert.equal(core.fmtDuration(200), '3 мин 20 с');
    assert.equal(core.fmtDuration(180), '3 мин');
    assert.equal(core.fmtDuration(3900), '1 ч 05 мин');
    assert.equal(core.fmtDuration(-1), '—');
    assert.equal(core.fmtValue(0.012345), '0,01235');
    assert.equal(core.fmtValue(1234.5), '1235');
    assert.match(core.fmtValue(1e-5), /^1,000e-5$/);
    assert.equal(core.fmtAngles([0, 22.5, 45]), '0°, 22,5°, 45°');
    assert.match(core.fmtAngles([1, 2, 3], 2), /всего 3/);
});

test('parseNum: запятая, пробелы, мусор', () => {
    assert.equal(core.parseNum('0,00425'), 0.00425);
    assert.equal(core.parseNum(' 1 234 '), 1234);
    assert.equal(core.parseNum('-3.5e2'), -350);
    assert.equal(core.parseNum(7), 7);
    assert.ok(Number.isNaN(core.parseNum('')));
    assert.ok(Number.isNaN(core.parseNum('abc')));
    assert.ok(Number.isNaN(core.parseNum('1,2,3')));
    assert.ok(Number.isNaN(core.parseNum(null)));
});

test('sampleName: как sample_name сервиса', () => {
    assert.equal(core.sampleName('Образец 1/2: "a"', 'e1'), 'Образец 1_2_ _a_');
    assert.equal(core.sampleName('  ..hidden ', 'e1'), 'hidden');
    assert.equal(core.sampleName('', 'e1'), 'e1');
    assert.equal(core.sampleName(null, 'e1'), 'e1');
    assert.equal(core.sampleName('x'.repeat(150), 'e1').length, 100);
});

test('escapeHtml', () => {
    assert.equal(core.escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

// --- прочее ---------------------------------------------------------------------------------------------------

test('nextSeq: растёт и не меньше Date.now()', () => {
    const a = core.nextSeq(0);
    assert.ok(a >= Date.now() - 5);
    const b = core.nextSeq(a);
    assert.ok(b > a);
    assert.equal(core.nextSeq(Number.MAX_SAFE_INTEGER - 10), Number.MAX_SAFE_INTEGER - 9);
});

test('Emitter: ошибка обработчика не мешает остальным; off', () => {
    const e = new core.Emitter();
    const got = [];
    const orig = console.error;
    console.error = () => {};
    try {
        e.on('x', () => { throw new Error('boom'); });
        const h = (v) => got.push(v);
        e.on('x', h);
        e.emit('x', 1);
        e.off('x', h);
        e.emit('x', 2);
    } finally {
        console.error = orig;
    }
    assert.deepEqual(got, [1]);
});

test('debounce: вызывается один раз с последними аргументами; cancel, flush', (t) => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const calls = [];
    const d = core.debounce((v) => calls.push(v), 100);
    d(1);
    d(2);
    t.mock.timers.tick(99);
    assert.deepEqual(calls, []);
    d(3);
    t.mock.timers.tick(100);
    assert.deepEqual(calls, [3]);
    d(4);
    d.cancel();
    t.mock.timers.tick(200);
    assert.deepEqual(calls, [3]);
    d(5);
    assert.ok(d.pending());
    d.flush();
    assert.deepEqual(calls, [3, 5]);
    assert.ok(!d.pending());
});

// --- ось вращения ---------------------------------------------------------------------------------------------

test('centerAt: как Axis.center_at движка', () => {
    const ax = {center_x: 100, y_ref: 50, tilt_deg: 45, method: 'auto'};
    assert.ok(Math.abs(core.centerAt(ax, 60) - 110) < 1e-9);
    assert.ok(Math.abs(core.centerAt(ax, 50) - 100) < 1e-9);
    assert.equal(core.centerAt({center_x: 7, y_ref: 0, tilt_deg: 0}, 1000), 7);
});

test('nudgeAxis: центр на строке превью и наклон вокруг неё', () => {
    const ax = {center_x: 2268.31, y_ref: 1799.5, tilt_deg: -1.206, method: 'auto'};
    const c0 = core.centerAt(ax, 2269);
    const a1 = core.nudgeAxis(ax, 2269, 'center', 0.25);
    assert.equal(a1.method, 'manual');
    assert.equal(a1.y_ref, 2269);
    assert.ok(Math.abs(a1.center_x - (c0 + 0.25)) < 1e-3);
    assert.equal(a1.tilt_deg, -1.206);
    const a2 = core.nudgeAxis(a1, 2269, 'tilt', 0.01);
    assert.ok(Math.abs(a2.tilt_deg - -1.196) < 1e-9);
    assert.ok(Math.abs(core.centerAt(a2, 2269) - a1.center_x) < 1e-9);   // центр на строке превью не сдвинулся
    // сдвиг на другой строке — та же прямая оси
    const a3 = core.nudgeAxis(a2, 1600, 'center', 0);
    assert.ok(Math.abs(core.centerAt(a3, 2269) - core.centerAt(a2, 2269)) < 2e-3);
});

// --- сглаживание проекций -------------------------------------------------------------------------------------

test('smoothingBlock: выключено — null; состояние и блок рецепта; значения по умолчанию', () => {
    const on = {enabled: true, sigma: 1.5000000000000002, deblur: 'wiener', balance: 0.02, amount: 1.5};
    assert.deepEqual(core.smoothingBlock(on), {sigma: 1.5, deblur: 'wiener', balance: 0.02, amount: 1.5});
    assert.equal(core.smoothingBlock(Object.assign({}, on, {enabled: false})), null);
    assert.equal(core.smoothingBlock(null), null);
    assert.equal(core.smoothingBlock({sigma: null, deblur: 'wiener'}), null);        // блок рецепта «выкл.»
    assert.equal(core.smoothingBlock({sigma: 0}), null);
    // блок рецепта (без enabled), неизвестный метод и пропуски — по умолчанию
    assert.deepEqual(core.smoothingBlock({sigma: 2, deblur: 'lucy'}), {sigma: 2, deblur: 'none', balance: 0.02, amount: 1.5});
    assert.equal(core.smoothingBlock({sigma: 3.5}).deblur, 'none');                   // как smoothing.DEFAULTS сервиса
    assert.deepEqual(core.smoothingBlock({sigma: '0.7', deblur: 'unsharp', amount: 2}),
        {sigma: 0.7, deblur: 'unsharp', balance: 0.02, amount: 2});
});

test('smoothingQuery: параметры среза только при включённом, сила — своего метода', () => {
    const sm = {enabled: true, sigma: 1.5, deblur: 'wiener', balance: 0.03, amount: 2};
    assert.deepEqual(core.smoothingQuery(sm), {smooth: 1.5, deblur: 'wiener', balance: 0.03});
    assert.deepEqual(core.smoothingQuery(Object.assign({}, sm, {deblur: 'unsharp'})), {smooth: 1.5, deblur: 'unsharp', amount: 2});
    assert.deepEqual(core.smoothingQuery(Object.assign({}, sm, {deblur: 'none'})), {smooth: 1.5, deblur: 'none'});
    assert.deepEqual(core.smoothingQuery(Object.assign({}, sm, {enabled: false})), {});
    assert.deepEqual(core.smoothingQuery(undefined), {});
});

test('smoothingText: подписи по-русски; short — без силы; выключено — пусто', () => {
    const sm = {enabled: true, sigma: 1.5, deblur: 'wiener', balance: 0.02, amount: 1.5};
    assert.equal(core.smoothingText(sm), 'σ 1,5 · Винер 0,02');
    assert.equal(core.smoothingText(sm, true), 'σ 1,5 · Винер');
    assert.equal(core.smoothingText({sigma: 1, deblur: 'unsharp', amount: 1.5}), 'σ 1 · маска 1,5');
    assert.equal(core.smoothingText({sigma: 2, deblur: 'none'}), 'σ 2 · без деблюра');
    assert.equal(core.smoothingText({enabled: false, sigma: 1.5}), '');
    assert.equal(core.smoothingText(null), '');
});

// --- мозаика сравнения ----------------------------------------------------------------------------------------

test('mosaicLayout: не больше 4 в ряду, ряды выровнены, промежутки', () => {
    const cols = (k) => {
        const l = core.mosaicLayout(k, 10, 10);
        return [l.cols, l.rows];
    };
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(cols),
        [[1, 1], [2, 1], [3, 1], [4, 1], [3, 2], [3, 2], [4, 2], [4, 2]]);
    const l = core.mosaicLayout(5, 384, 200, {gap: 8});
    assert.equal(l.w, 3 * 384 + 2 * 8);
    assert.equal(l.h, 2 * 200 + 8);
    assert.deepEqual(l.tiles[0], {x: 0, y: 0, w: 384, h: 200});
    assert.deepEqual(l.tiles[2], {x: 2 * 392, y: 0, w: 384, h: 200});
    assert.deepEqual(l.tiles[3], {x: 0, y: 208, w: 384, h: 200});
    assert.deepEqual(l.tiles[4], {x: 392, y: 208, w: 384, h: 200});
    const one = core.mosaicLayout(1, 7, 5, {gap: 8});
    assert.equal(one.w, 7);
    assert.equal(one.h, 5);
    assert.equal(core.mosaicLayout(3, 4, 4, {maxCols: 2, gap: 0}).cols, 2);
});

test('mosaicLayout с размером вида: столбцов — при которых мозаика крупнее', () => {
    const cols = (k, tw, th, vw, vh) => core.mosaicLayout(k, tw, th, {viewW: vw, viewH: vh}).cols;
    assert.equal(cols(4, 384, 384, 1030, 470), 4);          // широкий вид — в ряд
    assert.equal(cols(4, 512, 308, 1030, 470), 2);          // широкие плитки — 2 × 2, а не полосой
    assert.equal(cols(5, 384, 384, 1030, 470), 3);          // 3 и 4 равны (2 ряда) — меньше столбцов: 3 + 2
    assert.equal(cols(4, 384, 384, 500, 900), 2);
    assert.equal(cols(4, 384, 384, 400, 1600), 1);          // высокий узкий вид — столбиком
    assert.equal(cols(8, 100, 100, 5000, 100), 4);          // не больше 4 в ряду
    assert.equal(cols(1, 384, 384, 1030, 470), 1);
});

test('buildMosaic: плитки на своих местах, промежутки — код 0 (низ окна) или NaN у float32', () => {
    // стопка (3, 2, 3): значение = 100·k + 10·y + x
    const k = 3, h = 2, w = 3;
    const data = new Uint16Array(k * h * w);
    for (let i = 0; i < k; i++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[i * h * w + y * w + x] = 100 * i + 10 * y + x + 1;
    const stack = {w, h, k, dtype: 'uint16', data, scale: 0.5, offset: -1, quantized: true, meta: {region: [1, 2, 4, 4]}};
    const lay = core.mosaicLayout(k, w, h, {maxCols: 2, gap: 2});        // 2 + 1
    const m = core.buildMosaic(stack, lay);
    assert.equal(m.w, 2 * 3 + 2);
    assert.equal(m.h, 2 * 2 + 2);
    assert.equal(m.k, 1);
    assert.equal(m.scale, 0.5);
    assert.equal(m.offset, -1);
    assert.deepEqual(m.meta, stack.meta);
    assert.ok(m.data instanceof Uint16Array);
    const at = (x, y) => m.data[y * m.w + x];
    assert.equal(at(0, 0), 1);
    assert.equal(at(2, 1), 13);
    assert.equal(at(3, 0), 0);                        // промежуток
    assert.equal(at(5, 0), 101);                      // плитка 1: x 5…7
    assert.equal(at(7, 1), 113);
    assert.equal(at(0, 4), 201);                      // плитка 2: y 4…5
    assert.equal(at(2, 5), 213);
    assert.equal(at(5, 4), 0);                        // пустое место второго ряда
    const f = core.buildMosaic({w: 1, h: 1, k: 2, dtype: 'float32', data: new Float32Array([1, 2]), scale: 1, offset: 0,
        meta: {}}, core.mosaicLayout(2, 1, 1, {gap: 1}));
    assert.deepEqual(Array.from(f.data).map((v) => (Number.isNaN(v) ? 'NaN' : v)), [1, 'NaN', 2]);
});

test('tileAt: номер плитки, промежуток и вне мозаики — −1', () => {
    const lay = core.mosaicLayout(5, 100, 50, {gap: 8});
    assert.equal(core.tileAt(lay, 0, 0), 0);
    assert.equal(core.tileAt(lay, 99.9, 49.9), 0);
    assert.equal(core.tileAt(lay, 100, 10), -1);       // промежуток
    assert.equal(core.tileAt(lay, 108, 10), 1);
    assert.equal(core.tileAt(lay, 250, 10), 2);
    assert.equal(core.tileAt(lay, 150, 70), 4);        // второй ряд, вторая плитка
    assert.equal(core.tileAt(lay, 150, 55), -1);       // промежуток между рядами
    assert.equal(core.tileAt(lay, 250, 70), -1);       // пустое место второго ряда
    assert.equal(core.tileAt(lay, 400, 10), -1);       // правее мозаики
    assert.equal(core.tileAt(lay, -1, 0), -1);
    assert.equal(core.tileAt(lay, NaN, 0), -1);
    assert.equal(core.tileAt(null, 0, 0), -1);
});

test('visibleRegion: вписанный срез — null; увеличенный — видимая часть в пикселях полного среза', () => {
    const img = {w: 1000, h: 1000, meta: {downsample: 3, region: [0, 0, 3000, 3000]}};
    // вписан в сцену 1000×800 с полями — виден целиком
    const fit = core.fitTransform(1000, 1000, 1, 1000, 800, 8);
    assert.equal(core.visibleRegion(fit, 1000, 800, img), null);
    // масштаб 4: видно 250×200 пикселей изображения с (300, 400) → срез 750×600 с (900, 1200) → ≤ 512 вокруг центра
    const xf = {sx: 4, sy: 4, tx: -1200, ty: -1600};
    assert.deepEqual(core.visibleRegion(xf, 1000, 800, img), [1019, 1244, 1531, 1756]);
    // масштаб 16: 62,5×50 px изображения → 187,5×150 среза; сторона не меньше 128, центр тот же
    const xs = {sx: 16, sy: 16, tx: -16 * 300, ty: -16 * 400};
    assert.deepEqual(core.visibleRegion(xs, 1000, 800, img), [900, 1200, 1088, 1350]);
    const tiny = core.visibleRegion({sx: 100, sy: 100, tx: -100 * 300, ty: -100 * 400}, 1000, 800, img);
    assert.equal(tiny[2] - tiny[0], 128);
    assert.equal(tiny[3] - tiny[1], 128);
    // opts.max/min
    assert.deepEqual(core.visibleRegion(xf, 1000, 800, img, {max: 256}), [1147, 1372, 1403, 1628]);
});

test('visibleRegion: сдвиг среза (meta.region), обрезка краёв, прижим к краю, изображение вне вида', () => {
    // срез — фрагмент [100, 200, 700, 800) без уменьшения
    const img = {w: 600, h: 600, meta: {region: [100, 200, 700, 800]}};
    // видна левая верхняя часть 300×300 изображения (масштаб 2 в сцене 600×600)
    assert.deepEqual(core.visibleRegion({sx: 2, sy: 2, tx: 0, ty: 0}, 600, 600, img), [100, 200, 400, 500]);
    // у правого края видно 100 столбцов: сторона — не меньше 128, область прижимается внутрь покрытия
    assert.deepEqual(core.visibleRegion({sx: 1, sy: 1, tx: -500, ty: 0}, 600, 300, img), [572, 200, 700, 500]);
    // без meta: покрытие — само изображение, ds = 1
    assert.deepEqual(core.visibleRegion({sx: 1, sy: 1, tx: -10, ty: -10}, 50, 50, {w: 100, h: 100}), [0, 0, 100, 100]);
    // изображение ушло из вида — null
    assert.equal(core.visibleRegion({sx: 1, sy: 1, tx: 5000, ty: 0}, 600, 600, img), null);
    // ds = 3, край не кратен: изображение 333 px покрывает 999 столбцов из 1000
    const odd = {w: 333, h: 333, meta: {downsample: 3, region: [0, 0, 1000, 1000]}};
    const r = core.visibleRegion({sx: 4, sy: 4, tx: -4 * 233, ty: 0}, 400, 400, odd);
    assert.equal(r[2], 999);
    assert.equal(r[2] - r[0], 300);
});

test('inputNum: точка для поля type=number', () => {
    assert.equal(core.inputNum(2268.3149, 2), '2268.31');
    assert.equal(core.inputNum(-1.2, 3), '-1.2');
    assert.equal(core.inputNum(NaN, 2), '');
});

test('motionChart: пути графика смещения, разрывы на null, симметричный масштаб', () => {
    const c = core.motionChart([0, 2, -4], [1, null, -4], 100, 20, 0);
    assert.equal(c.max, 4);
    assert.equal(c.zero, 10);
    assert.equal(c.dx, 'M0 10 L50 5 L100 20');
    assert.equal(c.raw, 'M0 7.5 M100 20');                  // null — разрыв линии
    const flat = core.motionChart([0, 0], [], 10, 10);
    assert.equal(flat.max, 1);                                // нулевой сигнал — без деления на ноль
    assert.equal(core.motionChart([], [], 10, 10).dx, '');
});

test('motionText: строка рецепта о компенсации смещения', () => {
    assert.equal(core.motionText(null), '');
    assert.equal(core.motionText({mode: 'auto', applied: false}), '');
    assert.equal(core.motionText({mode: 'auto', applied: true, summary: {rms: 2.27}}),
        'смещение образца компенсировано (СКО 2,3 px)');
    assert.equal(core.motionText({mode: 'on', applied: true}), 'смещение образца компенсировано');
});
