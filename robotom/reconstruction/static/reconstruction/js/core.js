/* Студия реконструкции — чистая логика без DOM: декодирование бинарных ответов, гистограмма и окно (LUT),
 * преобразования координат просмотрщика, перетаскивание рамки, рамка поля зрения, параметры сглаживания, мозаика
 * сравнения вариантов и видимая область среза, форматирование, шина событий.
 * Загружается первым; проверяется node-тестами (robotom/reconstruction/jstests/). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core = {};

    // --- мелочи -------------------------------------------------------------------------------------------

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }
    core.clamp = clamp;

    function isNum(v) {
        return typeof v === 'number' && isFinite(v);
    }
    core.isNum = isNum;

    /** seq для «последний запрос выигрывает»: растёт и между перезагрузками страницы (сервис помнит
     *  последний seq канала сессии, меньший он сразу отвергает). */
    core.nextSeq = function (last) {
        return Math.max((last || 0) + 1, Date.now());
    };

    /** Отложенный вызов: повторный вызов переносит срок; .cancel(), .flush(). */
    core.debounce = function (fn, ms) {
        var timer = null, args = null, self = null;
        function run() {
            timer = null;
            var a = args;
            args = null;
            fn.apply(self, a);
        }
        function d() {
            args = arguments;
            self = this;
            if (timer) clearTimeout(timer);
            timer = setTimeout(run, ms);
        }
        d.cancel = function () {
            if (timer) clearTimeout(timer);
            timer = null;
            args = null;
        };
        d.flush = function () {
            if (timer) {
                clearTimeout(timer);
                run();
            }
        };
        d.pending = function () {
            return timer !== null;
        };
        return d;
    };

    // --- шина событий ---------------------------------------------------------------------------------------

    function Emitter() {
        this._handlers = {};
    }
    Emitter.prototype.on = function (ev, fn) {
        (this._handlers[ev] = this._handlers[ev] || []).push(fn);
        return this;
    };
    Emitter.prototype.off = function (ev, fn) {
        var list = this._handlers[ev];
        if (!list) return this;
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        return this;
    };
    Emitter.prototype.emit = function (ev) {
        var list = (this._handlers[ev] || []).slice();
        var args = Array.prototype.slice.call(arguments, 1);
        for (var i = 0; i < list.length; i++) {
            try {
                list[i].apply(this, args);
            } catch (e) {
                // ошибка одного обработчика не должна ломать остальные
                if (root.console) root.console.error('Studio: обработчик «' + ev + '»:', e);
            }
        }
        return this;
    };
    /** Подмешать методы шины в объект (конструктор должен вызвать Emitter.call(this)). */
    Emitter.mixin = function (proto) {
        proto.on = Emitter.prototype.on;
        proto.off = Emitter.prototype.off;
        proto.emit = Emitter.prototype.emit;
    };
    core.Emitter = Emitter;

    // --- бинарные ответы ------------------------------------------------------------------------------------

    var DTYPES = {uint16: root.Uint16Array, float32: root.Float32Array, uint8: root.Uint8Array};
    var LITTLE_ENDIAN = new root.Uint8Array(new root.Uint16Array([1]).buffer)[0] === 1;

    /** Типизированный массив little-endian из ArrayBuffer или вида на него (с выравниванием и порядком байт). */
    function typedFrom(buf, Ctor, count) {
        var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset,
            buf.byteLength);
        var size = Ctor.BYTES_PER_ELEMENT;
        if (size === 1) return new Ctor(bytes.buffer, bytes.byteOffset, count);
        if (LITTLE_ENDIAN) {
            if (bytes.byteOffset % size === 0) return new Ctor(bytes.buffer, bytes.byteOffset, count);
            return new Ctor(bytes.slice().buffer, 0, count);            // невыровненный вид — копия
        }
        var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var out = new Ctor(count), i;
        if (Ctor === Float32Array) {
            for (i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
        } else {
            for (i = 0; i < count; i++) out[i] = dv.getUint16(i * 2, true);
        }
        return out;
    }

    /**
     * Бинарный ответ сервиса (см. reconservice/binary.py) → изображение:
     * {w, h, k, dtype, data, scale, offset, quantized, meta}; значение = код · scale + offset.
     * getHeader(name) → строка или null. Стопка (k, h, w) — k > 1, кадр — frameOf(img, i).
     */
    core.decodeBinary = function (buffer, getHeader) {
        var shapeStr = getHeader('X-Shape');
        if (!shapeStr) throw new Error('в ответе нет заголовка X-Shape');
        var shape = String(shapeStr).split(',').filter(function (s) {
            return s.trim() !== '';
        }).map(function (s) {
            return Number(s.trim());
        });
        if (!shape.length || shape.some(function (n) {
            return !(n >= 0) || Math.floor(n) !== n;
        })) {
            throw new Error('некорректный X-Shape: ' + shapeStr);
        }
        var dtype = String(getHeader('X-Dtype') || '').trim();
        var Ctor = DTYPES[dtype];
        if (!Ctor) throw new Error('неподдерживаемый X-Dtype: ' + dtype);
        var count = shape.reduce(function (a, b) {
            return a * b;
        }, 1);
        var byteLength = buffer.byteLength;
        if (byteLength !== count * Ctor.BYTES_PER_ELEMENT) {
            throw new Error('размер ответа ' + byteLength + ' байт не совпадает с X-Shape ' + shapeStr + ' (' + dtype + ')');
        }
        var k, h, w;
        if (shape.length === 3) {
            k = shape[0]; h = shape[1]; w = shape[2];
        } else if (shape.length === 2) {
            k = 1; h = shape[0]; w = shape[1];
        } else if (shape.length === 1) {
            k = 1; h = 1; w = shape[0];
        } else {
            throw new Error('неподдерживаемая размерность X-Shape: ' + shapeStr);
        }
        var scale = 1, offset = 0, quantized = false;
        var sc = getHeader('X-Scale');
        if (sc !== null && sc !== undefined && String(sc).trim() !== '') {
            scale = parseFloat(sc);
            offset = parseFloat(getHeader('X-Offset') || '0');
            if (!isNum(scale) || !isNum(offset)) throw new Error('некорректные X-Scale/X-Offset: ' + sc);
            quantized = true;
        }
        var meta = {};
        var m = getHeader('X-Meta');
        if (m) {
            try {
                meta = JSON.parse(m) || {};
            } catch (e) {
                meta = {};
            }
        }
        return {
            w: w, h: h, k: k, shape: shape, dtype: dtype, data: typedFrom(buffer, Ctor, count),
            scale: scale, offset: offset, quantized: quantized, meta: meta
        };
    };

    /** Кадр i стопки (без копирования данных). */
    core.frameOf = function (img, i) {
        var n = img.w * img.h;
        i = clamp(i | 0, 0, img.k - 1);
        return {
            w: img.w, h: img.h, k: 1, shape: [img.h, img.w], dtype: img.dtype,
            data: img.data.subarray(i * n, (i + 1) * n),
            scale: img.scale, offset: img.offset, quantized: img.quantized, meta: img.meta, index: i
        };
    };

    /** Физическое значение пикселя (ix, iy) — NaN вне изображения. */
    core.valueAt = function (img, ix, iy) {
        ix = Math.floor(ix);
        iy = Math.floor(iy);
        if (!img || ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) return NaN;
        var c = img.data[iy * img.w + ix];
        return img.dtype === 'float32' ? c : c * img.scale + img.offset;
    };

    /** Уменьшение в f раз средним по блокам f×f → изображение float32 в физических значениях. */
    core.downsampleMean = function (img, f) {
        f = Math.max(1, f | 0);
        var w2 = Math.max(1, Math.floor(img.w / f)), h2 = Math.max(1, Math.floor(img.h / f));
        var fx = Math.min(f, img.w), fy = Math.min(f, img.h);
        var out = new Float32Array(w2 * h2);
        var d = img.data, W = img.w, conv = img.dtype !== 'float32';
        var sc = conv ? img.scale : 1, of = conv ? img.offset : 0;
        for (var y = 0; y < h2; y++) {
            for (var x = 0; x < w2; x++) {
                var s = 0, n = 0;
                for (var yy = y * fy; yy < y * fy + fy; yy++) {
                    var row = yy * W;
                    for (var xx = x * fx; xx < x * fx + fx; xx++) {
                        var v = d[row + xx];
                        if (v === v) {           // NaN пропускается
                            s += v;
                            n++;
                        }
                    }
                }
                out[y * w2 + x] = n ? (s / n) * sc + of : NaN;
            }
        }
        return {w: w2, h: h2, k: 1, shape: [h2, w2], dtype: 'float32', data: out, scale: 1, offset: 0,
            quantized: false, meta: img.meta, factor: f};
    };

    // --- гистограмма и окно ---------------------------------------------------------------------------------

    var FLOAT_BINS = 4096;

    /**
     * Гистограмма в физических значениях: {counts, v0, dv, total}: корзина i — [v0 + i·dv, v0 + (i+1)·dv).
     * uint16/uint8 — корзина на код (точные персентили), float32 — FLOAT_BINS корзин по [min, max].
     */
    core.histogram = function (img) {
        var d = img.data, n = d.length, i, counts;
        if (img.dtype === 'uint16' || img.dtype === 'uint8') {
            counts = new Uint32Array(img.dtype === 'uint16' ? 65536 : 256);
            for (i = 0; i < n; i++) counts[d[i]]++;
            var dv = img.scale > 0 ? img.scale : 1;
            return {counts: counts, v0: img.offset - dv / 2, dv: dv, total: n};
        }
        var lo = Infinity, hi = -Infinity, fin = 0, v;
        for (i = 0; i < n; i++) {
            v = d[i];
            if (v === v && v !== Infinity && v !== -Infinity) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
                fin++;
            }
        }
        if (!fin) {
            lo = 0;
            hi = 1;
        } else if (!(hi > lo)) {
            hi = lo + 1;
        }
        counts = new Uint32Array(FLOAT_BINS);
        var step = (hi - lo) / FLOAT_BINS;
        for (i = 0; i < n; i++) {
            v = d[i];
            if (v === v && v !== Infinity && v !== -Infinity) {
                var b = Math.floor((v - lo) / step);
                counts[b >= FLOAT_BINS ? FLOAT_BINS - 1 : b]++;
            }
        }
        return {counts: counts, v0: lo, dv: step, total: fin};
    };

    /** Персентиль p (0..100) по гистограмме, с линейной интерполяцией внутри корзины. */
    core.percentile = function (hist, p) {
        var c = hist.counts, n = c.length;
        if (!hist.total) return hist.v0;
        var target = clamp(p, 0, 100) / 100 * hist.total, cum = 0;
        for (var i = 0; i < n; i++) {
            var ci = c[i];
            if (ci && cum + ci >= target) {
                var frac = ci ? (target - cum) / ci : 0;
                return hist.v0 + (i + frac) * hist.dv;
            }
            cum += ci;
        }
        return hist.v0 + n * hist.dv;
    };

    /** Диапазон данных [начало первой непустой корзины, конец последней]. */
    core.dataRange = function (hist) {
        var c = hist.counts, a = 0, b = c.length - 1;
        while (a < c.length && !c[a]) a++;
        while (b >= 0 && !c[b]) b--;
        if (a > b) return [hist.v0, hist.v0 + hist.dv];
        return [hist.v0 + a * hist.dv, hist.v0 + (b + 1) * hist.dv];
    };

    /** Авто-окно: персентили 0,5 и 99,5 (не вырожденное). */
    core.autoWindow = function (hist, pLo, pHi) {
        var lo = core.percentile(hist, pLo === undefined ? 0.5 : pLo);
        var hi = core.percentile(hist, pHi === undefined ? 99.5 : pHi);
        if (!(hi > lo)) {
            var r = core.dataRange(hist);
            lo = r[0];
            hi = r[1] > r[0] ? r[1] : r[0] + hist.dv;
        }
        return [lo, hi];
    };

    /** Сгруппировать гистограмму в nOut корзин на [vmin, vmax] (для рисования). */
    core.binHistogram = function (hist, nOut, vmin, vmax) {
        var out = new Float64Array(nOut), c = hist.counts, span = vmax - vmin;
        if (!(span > 0)) return out;
        for (var i = 0; i < c.length; i++) {
            if (!c[i]) continue;
            var v = hist.v0 + (i + 0.5) * hist.dv;
            var j = Math.floor((v - vmin) / span * nOut);
            if (j >= 0 && j < nOut) out[j] += c[i];
            else if (j === nOut && v <= vmax) out[nOut - 1] += c[i];
        }
        return out;
    };

    /** LUT код → яркость 0..255 для окна [lo, hi] (uint16 — 65536 записей, uint8 — 256). */
    core.buildLut = function (img, lo, hi, lut) {
        var n = img.dtype === 'uint8' ? 256 : 65536;
        if (!lut || lut.length !== n) lut = new Uint8Array(n);
        var sc = img.scale, of = img.offset, span = hi - lo;
        if (!(span > 0)) {
            for (var j = 0; j < n; j++) lut[j] = (j * sc + of) >= lo ? 255 : 0;
            return lut;
        }
        var k = 255 / span;
        for (var c = 0; c < n; c++) {
            var t = ((c * sc + of) - lo) * k;
            lut[c] = t <= 0 ? 0 : t >= 255 ? 255 : (t + 0.5) | 0;
        }
        return lut;
    };

    /** Изображение → RGBA по окну [lo, hi]: серое или через палитру pal (core.paletteTable, 256 · 3 RGB; уровень
     *  0..255 — индекс). out — Uint8ClampedArray w·h·4 (переиспользуется). */
    core.toRGBA = function (img, lo, hi, out, lut, pal) {
        var n = img.w * img.h, d = img.data, i, g, p, q;
        if (!out || out.length !== n * 4) out = new Uint8ClampedArray(n * 4);
        if (img.dtype === 'float32') {
            var span = hi - lo, k = span > 0 ? 255 / span : 0;
            for (i = 0, p = 0; i < n; i++, p += 4) {
                var v = d[i];
                g = v === v ? (span > 0 ? (v - lo) * k : (v >= lo ? 255 : 0)) : 0;
                if (pal) {
                    q = (g <= 0 ? 0 : g >= 255 ? 255 : (g + 0.5) | 0) * 3;
                    out[p] = pal[q];
                    out[p + 1] = pal[q + 1];
                    out[p + 2] = pal[q + 2];
                } else {
                    out[p] = out[p + 1] = out[p + 2] = g;   // Uint8ClampedArray сам обрезает и округляет
                }
                out[p + 3] = 255;
            }
            return out;
        }
        lut = core.buildLut(img, lo, hi, lut);
        for (i = 0, p = 0; i < n; i++, p += 4) {
            g = lut[d[i]];
            if (pal) {
                q = g * 3;
                out[p] = pal[q];
                out[p + 1] = pal[q + 1];
                out[p + 2] = pal[q + 2];
            } else {
                out[p] = out[p + 1] = out[p + 2] = g;
            }
            out[p + 3] = 255;
        }
        return out;
    };

    /** Масштабная шкала: «круглая» длина 1, 2 или 5 · 10ⁿ мм, у которой на экране ближе всего к target пикселей (и
     *  не больше maxPx). mmPerScreenPx — мм на пиксель экрана. → {mm, px, label} или null (масштаб неизвестен). */
    core.scaleBar = function (mmPerScreenPx, target, maxPx) {
        if (!(mmPerScreenPx > 0) || !isFinite(mmPerScreenPx)) return null;
        target = target || 120;
        maxPx = maxPx || target * 2;
        var best = null;
        var e0 = Math.floor(Math.log(target * mmPerScreenPx) / Math.LN10);
        for (var e = e0 - 1; e <= e0 + 1; e++) {
            [1, 2, 5].forEach(function (m) {
                var mm = m * Math.pow(10, e), px = mm / mmPerScreenPx;
                if (px <= maxPx && (!best || Math.abs(Math.log(px / target)) < Math.abs(Math.log(best.px / target)))) {
                    best = {mm: mm, px: px};
                }
            });
        }
        if (!best) return null;
        var mm = best.mm;
        best.label = mm >= 1 ? core.fmtNum(mm, 3) + ' мм' : core.fmtNum(Math.round(mm * 1e6) / 1e3, 3) + ' мкм';
        return best;
    };

    /** Ось гистограммы: окно [lo, hi] плюс по margin его ширины с каждой стороны — ручки окна не упираются в края, и
     *  их можно тянуть дальше; full — весь диапазон данных dataRange, расширенный до окна. */
    core.histAxis = function (lo, hi, dataRange, full, margin) {
        margin = margin === undefined ? 0.2 : margin;
        var a, b;
        if (full && dataRange) {
            a = Math.min(dataRange[0], lo);
            b = Math.max(dataRange[1], hi);
            var m = (b - a) * 0.03;
            a -= m;
            b += m;
        } else {
            var w = hi - lo;
            if (!(w > 0)) w = Math.max(Math.abs(lo) * 1e-3, 1e-9);
            a = lo - w * margin;
            b = hi + w * margin;
        }
        return [a, b > a ? b : a + 1];
    };

    // --- преобразование просмотрщика ------------------------------------------------------------------------
    // xf = {sx, sy, tx, ty}: экран (CSS px) = изображение · s + t; sy = sx · aspect (пиксель может быть
    // вытянут по вертикали — синограмма из 90 строк на 5000 столбцов).

    core.fitTransform = function (imgW, imgH, aspect, viewW, viewH, pad) {
        aspect = aspect > 0 ? aspect : 1;
        pad = pad === undefined ? 8 : pad;
        var aw = Math.max(1, viewW - 2 * pad), ah = Math.max(1, viewH - 2 * pad);
        var s = Math.min(aw / Math.max(1, imgW), ah / Math.max(1e-9, imgH * aspect));
        if (!(s > 0) || !isFinite(s)) s = 1;
        return {sx: s, sy: s * aspect, tx: (viewW - imgW * s) / 2, ty: (viewH - imgH * s * aspect) / 2};
    };

    /** Масштаб в factor раз вокруг точки экрана (mx, my); sx ограничен [minS, maxS]. */
    core.zoomAt = function (xf, factor, mx, my, minS, maxS) {
        var s = clamp(xf.sx * factor, minS, maxS);
        var f = s / xf.sx;
        return {sx: s, sy: xf.sy * f, tx: mx - (mx - xf.tx) * f, ty: my - (my - xf.ty) * f};
    };

    /** 1:1 (sx = 1) вокруг точки экрана. */
    core.oneToOne = function (xf, mx, my) {
        return core.zoomAt(xf, 1 / xf.sx, mx, my, 1, 1);
    };

    core.toImage = function (xf, x, y) {
        return {x: (x - xf.tx) / xf.sx, y: (y - xf.ty) / xf.sy};
    };

    core.toScreen = function (xf, ix, iy) {
        return {x: ix * xf.sx + xf.tx, y: iy * xf.sy + xf.ty};
    };

    // --- рамка --------------------------------------------------------------------------------------------

    var HANDLES = {
        n: {y0: 1}, s: {y1: 1}, w: {x0: 1}, e: {x1: 1},
        nw: {x0: 1, y0: 1}, ne: {x1: 1, y0: 1}, sw: {x0: 1, y1: 1}, se: {x1: 1, y1: 1}
    };
    core.RECT_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    /**
     * Новая рамка при перетаскивании ручки handle ('n', 'se', …, 'move') на (dx, dy) от исходной r.
     * b — границы {x0, y0, x1, y1}; minW, minH — наименьший размер; axes 'x' — только по горизонтали.
     */
    core.dragRect = function (r, handle, dx, dy, b, minW, minH, axes) {
        if (axes === 'x') dy = 0;
        minW = minW || 0;
        minH = minH || 0;
        var w = r.x1 - r.x0, h = r.y1 - r.y0;
        if (handle === 'move') {
            var nx0 = clamp(r.x0 + dx, b.x0, b.x1 - w), ny0 = clamp(r.y0 + dy, b.y0, b.y1 - h);
            return {x0: nx0, x1: nx0 + w, y0: ny0, y1: ny0 + h};
        }
        var hd = HANDLES[handle] || {};
        var o = {x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1};
        if (hd.x0) o.x0 = clamp(r.x0 + dx, b.x0, r.x1 - minW);
        if (hd.x1) o.x1 = clamp(r.x1 + dx, r.x0 + minW, b.x1);
        if (axes !== 'x') {
            if (hd.y0) o.y0 = clamp(r.y0 + dy, b.y0, r.y1 - minH);
            if (hd.y1) o.y1 = clamp(r.y1 + dy, r.y0 + minH, b.y1);
        }
        return o;
    };

    // --- поле зрения (координаты полного кадра, полуоткрытые [x0, x1) × [y0, y1)) -----------------------------

    core.ROI_MIN = 16;

    /** Рамка в кадре W×H: целые, внутри кадра, не меньше minSize. */
    core.clampRoi = function (roi, W, H, minSize) {
        minSize = Math.min(minSize || core.ROI_MIN, W, H);
        var x0 = Math.round(roi.x0), x1 = Math.round(roi.x1), y0 = Math.round(roi.y0), y1 = Math.round(roi.y1);
        if (!isNum(x0)) x0 = 0;
        if (!isNum(x1)) x1 = W;
        if (!isNum(y0)) y0 = 0;
        if (!isNum(y1)) y1 = H;
        if (x1 < x0) { var t = x0; x0 = x1; x1 = t; }
        if (y1 < y0) { var u = y0; y0 = y1; y1 = u; }
        x0 = clamp(x0, 0, W - minSize);
        x1 = clamp(x1, x0 + minSize, W);
        y0 = clamp(y0, 0, H - minSize);
        y1 = clamp(y1, y0 + minSize, H);
        return {x0: x0, x1: x1, y0: y0, y1: y1};
    };

    /** Строка превью внутри рамки: [y0, y1 − 1]. */
    core.clampRow = function (row, roi) {
        var r = Math.round(row);
        if (!isNum(r)) r = Math.floor((roi.y0 + roi.y1) / 2);
        return clamp(r, roi.y0, roi.y1 - 1);
    };

    core.sameRoi = function (a, b) {
        return !!(a && b && a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1);
    };

    /** Чем рамка cur отличается от загруженной loaded: «x0 1850 → 1857, x1 2760 → 2759»; '' — ничем. */
    core.roiDiffText = function (loaded, cur) {
        if (!loaded || !cur) return '';
        return ['x0', 'x1', 'y0', 'y1'].filter(function (k) {
            return loaded[k] !== cur[k];
        }).map(function (k) {
            return k + ' ' + loaded[k] + ' → ' + cur[k];
        }).join(', ');
    };

    /** Рамка полного кадра → координаты изображения, уменьшенного в bin раз. */
    core.roiToImage = function (roi, bin) {
        return {x0: roi.x0 / bin, x1: roi.x1 / bin, y0: roi.y0 / bin, y1: roi.y1 / bin};
    };

    /** Рамка на изображении (уменьшенном в bin раз) → рамка полного кадра (целые, в кадре). */
    core.roiFromImage = function (r, bin, W, H, minSize) {
        return core.clampRoi({x0: r.x0 * bin, x1: r.x1 * bin, y0: r.y0 * bin, y1: r.y1 * bin}, W, H, minSize);
    };

    /** Байт кропа: все кадры × h × w × 2 (uint16). */
    core.cropBytes = function (nFrames, roi) {
        return nFrames * (roi.y1 - roi.y0) * (roi.x1 - roi.x0) * 2;
    };

    /** Диапазон срезов [z0, z1) внутри [y0, y1) рамки, не пустой. */
    core.clampSlices = function (z0, z1, roi) {
        z0 = Math.round(z0);
        z1 = Math.round(z1);
        if (!isNum(z0)) z0 = roi.y0;
        if (!isNum(z1)) z1 = roi.y1;
        if (z1 < z0) { var t = z0; z0 = z1; z1 = t; }
        z0 = clamp(z0, roi.y0, roi.y1 - 1);
        z1 = clamp(z1, z0 + 1, roi.y1);
        return [z0, z1];
    };

    // --- ось вращения -------------------------------------------------------------------------------------

    /** Столбец оси на строке детектора y — как ``Axis.center_at`` движка: center_x + tan(tilt) · (y − y_ref). */
    core.centerAt = function (axis, y) {
        return axis.center_x + Math.tan(axis.tilt_deg * Math.PI / 180) * (y - axis.y_ref);
    };

    /** Ось, заданная вручную: центр на строке row и наклон (округлены до 0,001 px и 0,0001°). */
    core.manualAxis = function (center, row, tilt) {
        return {center_x: Math.round(center * 1000) / 1000, y_ref: row,
            tilt_deg: Math.round(tilt * 10000) / 10000, method: 'manual'};
    };

    /** Сдвиг ручной оси: kind 'center' — центр на строке row на step px, 'tilt' — наклон на step° вокруг
     *  строки row (центр на ней не меняется). */
    core.nudgeAxis = function (axis, row, kind, step) {
        var c = core.centerAt(axis, row), t = axis.tilt_deg;
        if (kind === 'center') c += step;
        else t += step;
        return core.manualAxis(c, row, t);
    };

    /** Число для value поля type=number (десятичная точка, без хвоста нулей). */
    core.inputNum = function (v, digits) {
        if (!isNum(v)) return '';
        return String(Number(v.toFixed(digits)));
    };

    // --- сглаживание проекций (блок рецепта smoothing) ---------------------------------------------------------

    var DEBLUR = {wiener: 'Винер', unsharp: 'маска', none: 'без деблюра'};
    core.DEBLUR_TEXT = DEBLUR;

    /**
     * Действующие параметры сглаживания из состояния страницы {enabled, sigma, deblur, balance, amount} или из блока
     * рецепта {sigma, deblur, balance, amount}: {sigma (до 0,01), deblur, balance, amount} или null — выключено
     * (enabled = false, σ нет или ≤ 0). Неизвестный или пустой deblur — 'none' (как smoothing.DEFAULTS сервиса).
     */
    core.smoothingBlock = function (sm) {
        if (!sm || sm.enabled === false) return null;
        var sigma = Number(sm.sigma);
        if (sm.sigma === null || sm.sigma === undefined || !isNum(sigma) || sigma <= 0) return null;
        return {
            sigma: Math.round(sigma * 100) / 100,
            deblur: DEBLUR[sm.deblur] ? sm.deblur : 'none',
            balance: isNum(sm.balance) ? sm.balance : 0.02,
            amount: isNum(sm.amount) ? sm.amount : 1.5
        };
    };

    /** Параметры запроса среза: {} — выключено; иначе smooth, deblur и сила деблюра своего метода
     *  (balance — Винер, amount — маска). */
    core.smoothingQuery = function (sm) {
        var b = core.smoothingBlock(sm);
        if (!b) return {};
        var q = {smooth: b.sigma, deblur: b.deblur};
        if (b.deblur === 'wiener') q.balance = b.balance;
        else if (b.deblur === 'unsharp') q.amount = b.amount;
        return q;
    };

    /** Подпись: «σ 1,5 · Винер 0,02», «σ 1 · маска 1,5», «σ 2 · без деблюра»; short — без силы деблюра;
     *  выключено — ''. */
    core.smoothingText = function (sm, short) {
        var b = core.smoothingBlock(sm);
        if (!b) return '';
        var s = 'σ ' + core.fmtNum(b.sigma, 2) + ' · ' + DEBLUR[b.deblur];
        if (!short && b.deblur === 'wiener') s += ' ' + core.fmtNum(b.balance, 4);
        else if (!short && b.deblur === 'unsharp') s += ' ' + core.fmtNum(b.amount, 2);
        return s;
    };

    // --- шумоподавление TV 3D после реконструкции (блок рецепта denoise) ---------------------------------------

    /** Действующие параметры TV из состояния {enabled, strength, iterations} или блока рецепта {method, strength,
     *  iterations}: {method: 'tv', strength (до 0,1), iterations} или null — выключено. Вес считает сервис. */
    core.denoiseBlock = function (dn) {
        if (!dn || dn.enabled === false) return null;
        if (dn.enabled === undefined && dn.method !== 'tv') return null;
        var s = Number(dn.strength);
        if (!isNum(s) || s <= 0) return null;
        var it = Number(dn.iterations);
        return {method: 'tv', strength: Math.round(s * 10) / 10, iterations: isNum(it) && it > 0 ? Math.round(it) : 50};
    };

    /** Параметры запроса среза: {} — выключено; иначе tv (сила) и tv_iter. */
    core.denoiseQuery = function (dn) {
        var b = core.denoiseBlock(dn);
        return b ? {tv: b.strength, tv_iter: b.iterations} : {};
    };

    /** Подпись: «TV 2σ»; выключено — ''. */
    core.denoiseText = function (dn) {
        var b = core.denoiseBlock(dn);
        return b ? 'TV ' + core.fmtNum(b.strength, 1) + 'σ' : '';
    };

    // --- сравнение вариантов: мозаика фрагментов ---------------------------------------------------------------

    /**
     * Раскладка k плиток tw×th: не больше maxCols (4) в ряду, промежуток gap (8 px). Без размера вида — ряды
     * выровнены (5 → 3 + 2, 7 → 4 + 3); с opts.viewW × opts.viewH — число столбцов, при котором мозаика, вписанная в
     * вид, крупнее всего (при равенстве — меньше столбцов): широкие плитки идут 2 × 2, а не полосой.
     * → {cols, rows, gap, tw, th, w, h, tiles: [{x, y, w, h}]} — координаты в пикселях мозаики.
     */
    core.mosaicLayout = function (k, tw, th, opts) {
        opts = opts || {};
        var maxCols = Math.max(1, opts.maxCols || 4), gap = opts.gap === undefined ? 8 : Math.max(0, opts.gap);
        k = Math.max(0, k | 0);
        var rows = Math.max(1, Math.ceil(k / maxCols));
        var cols = Math.max(1, Math.ceil(k / rows));
        if (opts.viewW > 0 && opts.viewH > 0 && k > 1) {
            var best = 0;
            for (var c = 1; c <= Math.min(k, maxCols); c++) {
                var r = Math.ceil(k / c);
                var s = Math.min(opts.viewW / (c * tw + (c - 1) * gap), opts.viewH / (r * th + (r - 1) * gap));
                if (s > best * (1 + 1e-3)) {
                    best = s;
                    cols = c;
                }
            }
        }
        rows = Math.max(1, Math.ceil(k / cols));
        var tiles = [];
        for (var i = 0; i < k; i++) {
            tiles.push({x: (i % cols) * (tw + gap), y: Math.floor(i / cols) * (th + gap), w: tw, h: th});
        }
        return {cols: cols, rows: rows, gap: gap, tw: tw, th: th, w: cols * tw + (cols - 1) * gap,
            h: rows * th + (rows - 1) * gap, tiles: tiles};
    };

    /**
     * Мозаика из стопки (k, h, w) по раскладке mosaicLayout(k, w, h): одно изображение с тем же типом, scale/offset и
     * meta; промежутки — fill (по умолчанию код 0 = низ общего окна квантования, у float32 — NaN).
     */
    core.buildMosaic = function (stack, layout, fill) {
        var Ctor = stack.data.constructor;
        var out = new Ctor(layout.w * layout.h);
        if (fill === undefined) fill = stack.dtype === 'float32' ? NaN : 0;
        if (fill !== 0) out.fill(fill);
        var tw = stack.w, th = stack.h, n = tw * th;
        var k = Math.min(stack.k || 1, layout.tiles.length);
        for (var i = 0; i < k; i++) {
            var t = layout.tiles[i];
            for (var y = 0; y < th; y++) {
                var src = i * n + y * tw;
                out.set(stack.data.subarray(src, src + tw), (t.y + y) * layout.w + t.x);
            }
        }
        return {w: layout.w, h: layout.h, k: 1, shape: [layout.h, layout.w], dtype: stack.dtype, data: out,
            scale: stack.scale, offset: stack.offset, quantized: stack.quantized, meta: stack.meta};
    };

    /** Номер плитки под точкой мозаики (x, y) или −1 (промежуток, вне мозаики). */
    core.tileAt = function (layout, x, y) {
        if (!layout || !isNum(x) || !isNum(y)) return -1;
        for (var i = 0; i < layout.tiles.length; i++) {
            var t = layout.tiles[i];
            if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) return i;
        }
        return -1;
    };

    /**
     * Видимая часть изображения среза в пикселях полного среза: [x0, y0, x1, y1] (целые) или null — изображение
     * видно целиком (или не видно вовсе). xf — преобразование вида, viewW×viewH — размер сцены (CSS px); img —
     * {w, h, meta: {downsample, region}}: пиксель ix изображения — столбцы среза region[0] + ix·ds … + ds (края,
     * не кратные ds, сервис отбрасывает). Сторона — в [opts.min (128), opts.max (512)] вокруг центра видимой части,
     * область не выходит за покрытие изображения.
     */
    core.visibleRegion = function (xf, viewW, viewH, img, opts) {
        opts = opts || {};
        var maxS = opts.max || 512, minS = opts.min || 128;
        if (!xf || !img || !(img.w > 0) || !(img.h > 0) || !(xf.sx > 0) || !(xf.sy > 0)) return null;
        var m = img.meta || {}, ds = m.downsample > 0 ? m.downsample : 1;
        var reg = m.region && m.region.length === 4 ? m.region : [0, 0, img.w * ds, img.h * ds];
        var ix0 = Math.max(0, -xf.tx / xf.sx), ix1 = Math.min(img.w, (viewW - xf.tx) / xf.sx);
        var iy0 = Math.max(0, -xf.ty / xf.sy), iy1 = Math.min(img.h, (viewH - xf.ty) / xf.sy);
        if (!(ix1 > ix0) || !(iy1 > iy0)) return null;
        var eps = 1e-6;
        if (ix0 <= eps && iy0 <= eps && ix1 >= img.w - eps && iy1 >= img.h - eps) return null;
        function span(a0, a1, b0, b1) {
            var lo = b0 + a0 * ds, hi = b0 + a1 * ds, len = b1 - b0;
            var side = clamp(Math.round(hi - lo), Math.min(minS, len), Math.min(maxS, len));
            var s0 = clamp(Math.round((lo + hi) / 2 - side / 2), b0, b1 - side);
            return [s0, s0 + side];
        }
        var x = span(ix0, ix1, reg[0], Math.min(reg[2], reg[0] + img.w * ds));
        var y = span(iy0, iy1, reg[1], Math.min(reg[3], reg[1] + img.h * ds));
        return [x[0], y[0], x[1], y[1]];
    };

    // --- форматирование -----------------------------------------------------------------------------------

    /** Число по-русски (десятичная запятая), digits знаков после запятой максимум; null/NaN — «—». */
    core.fmtNum = function (v, digits, grouping) {
        if (!isNum(v)) return '—';
        return v.toLocaleString('ru-RU', {
            maximumFractionDigits: digits === undefined ? 2 : digits,
            minimumFractionDigits: 0,
            useGrouping: !!grouping
        });
    };

    /** Фиксированное число знаков. */
    core.fmtFixed = function (v, digits) {
        if (!isNum(v)) return '—';
        return v.toLocaleString('ru-RU', {
            maximumFractionDigits: digits, minimumFractionDigits: digits, useGrouping: false
        });
    };

    /** Значение пикселя: 4 значащие цифры (разумно и для 1/мм, и для −ln T). */
    core.fmtValue = function (v) {
        if (!isNum(v)) return '—';
        var a = Math.abs(v);
        if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(3).replace('.', ',');
        return v.toLocaleString('ru-RU', {maximumSignificantDigits: 4, useGrouping: false});
    };

    var BYTE_UNITS = ['байт', 'КБ', 'МБ', 'ГБ', 'ТБ'];

    /** Байты: «812 МБ», «12,3 ГБ» (степени 1024). */
    core.fmtBytes = function (b) {
        if (!isNum(b) || b < 0) return '—';
        var i = 0;
        while (b >= 1024 && i < BYTE_UNITS.length - 1) {
            b /= 1024;
            i++;
        }
        var digits = i === 0 ? 0 : b < 10 ? 2 : b < 100 ? 1 : 0;
        return core.fmtNum(b, digits) + ' ' + BYTE_UNITS[i];
    };

    /** Длительность: «45 с», «3 мин 20 с», «1 ч 05 мин». */
    core.fmtDuration = function (s) {
        if (!isNum(s) || s < 0) return '—';
        s = Math.round(s);
        if (s < 60) return s + ' с';
        var m = Math.floor(s / 60), sec = s % 60;
        if (m < 60) return m + ' мин' + (sec ? ' ' + sec + ' с' : '');
        var h = Math.floor(m / 60), mm = m % 60;
        return h + ' ч ' + (mm < 10 ? '0' : '') + mm + ' мин';
    };

    /** Дата ISO 8601 → «28.09.2026, 14:05» (местное время); некорректная — как есть. */
    core.fmtDate = function (iso) {
        if (!iso) return '—';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    };

    /** Время ISO 8601 → «14:05» (местное); сегодняшняя дата не пишется, другая — «07.10 14:05». */
    core.fmtTime = function (iso, now) {
        var d = new Date(iso);
        if (!iso || isNaN(d.getTime())) return '';
        var t = d.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
        var n = now ? new Date(now) : new Date();
        if (d.toDateString() === n.toDateString()) return t;
        return d.toLocaleDateString('ru-RU', {day: '2-digit', month: '2-digit'}) + ' ' + t;
    };

    /** Число из поля ввода: допускает запятую и пробелы; пустое или мусор — NaN. */
    core.parseNum = function (str) {
        if (typeof str === 'number') return str;
        if (str === null || str === undefined) return NaN;
        var s = String(str).replace(/[\s ]/g, '').replace(',', '.');
        if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return NaN;
        return parseFloat(s);
    };

    /** Список углов: «0°, 22,5°, 45°». */
    core.fmtAngles = function (list, max) {
        max = max || 12;
        var parts = list.slice(0, max).map(function (a) {
            return core.fmtNum(a, 1) + '°';
        });
        if (list.length > max) parts.push('… (всего ' + list.length + ')');
        return parts.join(', ');
    };

    /** Имя образца для файлов объёма (как sample_name сервиса): без / \ : * ? " < > |, без точки в начале,
     *  до 100 символов; пустое — exp_id. */
    core.sampleName = function (specimen, expId) {
        var s = specimen === null || specimen === undefined ? '' : String(specimen);
        s = s.replace(/[\x00-\x1f\/\\:*?"<>|]/g, '_').trim().replace(/^\.+/, '').trim();
        if (s.length > 100) s = s.slice(0, 100).trim();
        return s || expId;
    };

    // --- смещение образца (motion) -----------------------------------------------------------------------------

    /** Мини-график смещения в прямоугольнике w×h: пути SVG 'd' для dx (сглаженное) и raw (по кадрам, null — разрыв)
     *  по порядку кадров; масштаб симметричный от нуля, общий для обоих; zero — y нулевой линии. */
    core.motionChart = function (dx, raw, w, h, pad) {
        dx = dx || [];
        raw = raw || [];
        pad = pad === undefined ? 3 : pad;
        var m = 0;
        dx.concat(raw).forEach(function (v) {
            if (isNum(v)) m = Math.max(m, Math.abs(v));
        });
        m = m || 1;
        var n = Math.max(dx.length, raw.length);
        function X(i) {
            return n > 1 ? i * w / (n - 1) : w / 2;
        }
        function Y(v) {
            return h / 2 - v * (h / 2 - pad) / m;
        }
        function r2(v) {
            return Math.round(v * 100) / 100;
        }
        function path(arr) {
            var d = [], pen = false;
            arr.forEach(function (v, i) {
                if (!isNum(v)) {
                    pen = false;
                    return;
                }
                d.push((pen ? 'L' : 'M') + r2(X(i)) + ' ' + r2(Y(v)));
                pen = true;
            });
            return d.join(' ');
        }
        return {dx: path(dx), raw: path(raw), zero: r2(Y(0)), max: m};
    };

    /** Строка о смещении образца для рецепта (шаг 5): '' — выключено или не компенсировалось. */
    core.motionText = function (block) {
        if (!block || !block.applied) return '';
        var s = block.summary || {};
        return 'смещение образца компенсировано' + (isNum(s.rms) ? ' (СКО ' + core.fmtNum(s.rms, 1) + ' px)' : '');
    };

    /** Экранирование для вставки текста в HTML. */
    core.escapeHtml = function (s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
        });
    };

    // --- палитры -----------------------------------------------------------------------------------------------
    // Палитры: серая; перцептивно равномерные из matplotlib (палитры BIDS, CC0) — яркость растёт монотонно, ложных
    // границ нет, cividis различима и при дальтонизме; jet — привычная, но с ложными границами на голубом и жёлтом
    // (Borland, Taylor, IEEE CG&A 2007). Таблицы — 256 цветов RGB8 из matplotlib 3.10 (scratchpad make_palettes.py).
    core.PALETTES = [['gray', 'серая'], ['inferno', 'inferno'], ['viridis', 'viridis'], ['magma', 'magma'],
        ['plasma', 'plasma'], ['cividis', 'cividis'], ['jet', 'jet']];
    var PALETTE_HEX = {
        inferno: '00000401000501010601010802010a02020c02020e03021004031204031405041706041907051b08051d09061f0a07220b07240c08260d08290e092b10092d110a30120a32140b34150b37160b39180c3c190c3e1b0c411c0c431e0c451f0c48210c4a230c4c240c4f260c51280b53290b552b0b572d0b592f0a5b310a5c320a5e340a5f3609613809623909633b09643d09653e0966400a67420a68440a68450a69470b6a490b6a4a0c6b4c0c6b4d0d6c4f0d6c510e6c520e6d540f6d550f6d57106e59106e5a116e5c126e5d126e5f136e61136e62146e64156e65156e67166e69166e6a176e6c186e6d186e6f196e71196e721a6e741a6e751b6e771c6d781c6d7a1d6d7c1d6d7d1e6d7f1e6c801f6c82206c84206b85216b87216b88226a8a226a8c23698d23698f24699025689225689326679526679727669827669a28659b29649d29649f2a63a02a63a22b62a32c61a52c60a62d60a82e5fa92e5eab2f5ead305dae305cb0315bb1325ab3325ab43359b63458b73557b93556ba3655bc3754bd3853bf3952c03a51c13a50c33b4fc43c4ec63d4dc73e4cc83f4bca404acb4149cc4248ce4347cf4446d04545d24644d34743d44842d54a41d74b3fd84c3ed94d3dda4e3cdb503bdd513ade5238df5337e05536e15635e25734e35933e45a31e55c30e65d2fe75e2ee8602de9612bea632aeb6429eb6628ec6726ed6925ee6a24ef6c23ef6e21f06f20f1711ff1731df2741cf3761bf37819f47918f57b17f57d15f67e14f68013f78212f78410f8850ff8870ef8890cf98b0bf98c0af98e09fa9008fa9207fa9407fb9606fb9706fb9906fb9b06fb9d07fc9f07fca108fca309fca50afca60cfca80dfcaa0ffcac11fcae12fcb014fcb216fcb418fbb61afbb81dfbba1ffbbc21fbbe23fac026fac228fac42afac62df9c72ff9c932f9cb35f8cd37f8cf3af7d13df7d340f6d543f6d746f5d949f5db4cf4dd4ff4df53f4e156f3e35af3e55df2e661f2e865f2ea69f1ec6df1ed71f1ef75f1f179f2f27df2f482f3f586f3f68af4f88ef5f992f6fa96f8fb9af9fc9dfafda1fcffa4',
        viridis: '44015444025645045745055946075a46085c460a5d460b5e470d60470e6147106347116447136548146748166848176948186a481a6c481b6d481c6e481d6f481f70482071482173482374482475482576482677482878482979472a7a472c7a472d7b472e7c472f7d46307e46327e46337f463480453581453781453882443983443a83443b84433d84433e85423f854240864241864142874144874045884046883f47883f48893e49893e4a893e4c8a3d4d8a3d4e8a3c4f8a3c508b3b518b3b528b3a538b3a548c39558c39568c38588c38598c375a8c375b8d365c8d365d8d355e8d355f8d34608d34618d33628d33638d32648e32658e31668e31678e31688e30698e306a8e2f6b8e2f6c8e2e6d8e2e6e8e2e6f8e2d708e2d718e2c718e2c728e2c738e2b748e2b758e2a768e2a778e2a788e29798e297a8e297b8e287c8e287d8e277e8e277f8e27808e26818e26828e26828e25838e25848e25858e24868e24878e23888e23898e238a8d228b8d228c8d228d8d218e8d218f8d21908d21918c20928c20928c20938c1f948c1f958b1f968b1f978b1f988b1f998a1f9a8a1e9b8a1e9c891e9d891f9e891f9f881fa0881fa1881fa1871fa28720a38620a48621a58521a68522a78522a88423a98324aa8325ab8225ac8226ad8127ad8128ae8029af7f2ab07f2cb17e2db27d2eb37c2fb47c31b57b32b67a34b67935b77937b87838b9773aba763bbb753dbc743fbc7340bd7242be7144bf7046c06f48c16e4ac16d4cc26c4ec36b50c46a52c56954c56856c66758c7655ac8645cc8635ec96260ca6063cb5f65cb5e67cc5c69cd5b6ccd5a6ece5870cf5773d05675d05477d1537ad1517cd2507fd34e81d34d84d44b86d54989d5488bd6468ed64590d74393d74195d84098d83e9bd93c9dd93ba0da39a2da37a5db36a8db34aadc32addc30b0dd2fb2dd2db5de2bb8de29bade28bddf26c0df25c2df23c5e021c8e020cae11fcde11dd0e11cd2e21bd5e21ad8e219dae319dde318dfe318e2e418e5e419e7e419eae51aece51befe51cf1e51df4e61ef6e620f8e621fbe723fde725',
        magma: '00000401000501010601010802010902020b02020d03030f03031204041405041606051806051a07061c08071e0907200a08220b09240c09260d0a290e0b2b100b2d110c2f120d31130d34140e36150e38160f3b180f3d19103f1a10421c10441d11471e114920114b21114e22115024125325125527125829115a2a115c2c115f2d11612f116331116533106734106936106b38106c390f6e3b0f703d0f713f0f72400f74420f75440f764510774710784910784a10794c117a4e117b4f127b51127c52137c54137d56147d57157e59157e5a167e5c167f5d177f5f187f601880621980641a80651a80671b80681c816a1c816b1d816d1d816e1e81701f81721f817320817521817621817822817922827b23827c23827e24828025828125818326818426818627818827818928818b29818c29818e2a81902a81912b81932b80942c80962c80982d80992d809b2e7f9c2e7f9e2f7fa02f7fa1307ea3307ea5317ea6317da8327daa337dab337cad347cae347bb0357bb2357bb3367ab5367ab73779b83779ba3878bc3978bd3977bf3a77c03a76c23b75c43c75c53c74c73d73c83e73ca3e72cc3f71cd4071cf4070d0416fd2426fd3436ed5446dd6456cd8456cd9466bdb476adc4869de4968df4a68e04c67e24d66e34e65e44f64e55064e75263e85362e95462ea5661eb5760ec5860ed5a5fee5b5eef5d5ef05f5ef1605df2625df2645cf3655cf4675cf4695cf56b5cf66c5cf66e5cf7705cf7725cf8745cf8765cf9785df9795df97b5dfa7d5efa7f5efa815ffb835ffb8560fb8761fc8961fc8a62fc8c63fc8e64fc9065fd9266fd9467fd9668fd9869fd9a6afd9b6bfe9d6cfe9f6dfea16efea36ffea571fea772fea973feaa74feac76feae77feb078feb27afeb47bfeb67cfeb77efeb97ffebb81febd82febf84fec185fec287fec488fec68afec88cfeca8dfecc8ffecd90fecf92fed194fed395fed597fed799fed89afdda9cfddc9efddea0fde0a1fde2a3fde3a5fde5a7fde7a9fde9aafdebacfcecaefceeb0fcf0b2fcf2b4fcf4b6fcf6b8fcf7b9fcf9bbfcfbbdfcfdbf',
        plasma: '0d088710078813078916078a19068c1b068d1d068e20068f2206902406912605912805922a05932c05942e05952f059631059733059735049837049938049a3a049a3c049b3e049c3f049c41049d43039e44039e46039f48039f4903a04b03a14c02a14e02a25002a25102a35302a35502a45601a45801a45901a55b01a55c01a65e01a66001a66100a76300a76400a76600a76700a86900a86a00a86c00a86e00a86f00a87100a87201a87401a87501a87701a87801a87a02a87b02a87d03a87e03a88004a88104a78305a78405a78606a68707a68808a68a09a58b0aa58d0ba58e0ca48f0da4910ea3920fa39410a29511a19613a19814a099159f9a169f9c179e9d189d9e199da01a9ca11b9ba21d9aa31e9aa51f99a62098a72197a82296aa2395ab2494ac2694ad2793ae2892b02991b12a90b22b8fb32c8eb42e8db52f8cb6308bb7318ab83289ba3388bb3488bc3587bd3786be3885bf3984c03a83c13b82c23c81c33d80c43e7fc5407ec6417dc7427cc8437bc9447aca457acb4679cc4778cc4977cd4a76ce4b75cf4c74d04d73d14e72d24f71d35171d45270d5536fd5546ed6556dd7566cd8576bd9586ada5a6ada5b69db5c68dc5d67dd5e66de5f65de6164df6263e06363e16462e26561e26660e3685fe4695ee56a5de56b5de66c5ce76e5be76f5ae87059e97158e97257ea7457eb7556eb7655ec7754ed7953ed7a52ee7b51ef7c51ef7e50f07f4ff0804ef1814df1834cf2844bf3854bf3874af48849f48948f58b47f58c46f68d45f68f44f79044f79143f79342f89441f89540f9973ff9983ef99a3efa9b3dfa9c3cfa9e3bfb9f3afba139fba238fca338fca537fca636fca835fca934fdab33fdac33fdae32fdaf31fdb130fdb22ffdb42ffdb52efeb72dfeb82cfeba2cfebb2bfebd2afebe2afec029fdc229fdc328fdc527fdc627fdc827fdca26fdcb26fccd25fcce25fcd025fcd225fbd324fbd524fbd724fad824fada24f9dc24f9dd25f8df25f8e125f7e225f7e425f6e626f6e826f5e926f5eb27f4ed27f3ee27f3f027f2f227f1f426f1f525f0f724f0f921',
        cividis: '00224e00234f00245100255300255400265600275800285900285b00295d002a5f002a61002b62002c64002c66002d68002e6a002e6c002f6d00306f0030700031700031710132710533710833700c34700f357012357014367016377018376f1a386f1c396f1e3a6f203a6f213b6e233c6e243c6e263d6e273e6e293f6e2a3f6d2b406d2d416d2e416d2f426d31436d32436d33446d34456c35456c36466c38476c39486c3a486c3b496c3c4a6c3d4a6c3e4b6c3f4c6c404c6c414d6c424e6c434e6c444f6c45506c46516c47516c48526c49536c4a536c4b546c4c556c4d556c4e566c4f576c50576c51586d52596d535a6d545a6d555b6d555c6d565c6d575d6d585e6d595e6e5a5f6e5b606e5c616e5d616e5e626e5e636f5f636f60646f61656f62656f636670646770656870656870666970676a71686a71696b716a6c716b6d726c6d726c6e726d6f726e6f736f70737071737172747272747273747374757474757575757676767777767777777878777979777a7a787b7a787c7b787d7c787e7c787e7d787f7e78807f78817f788280798381798482798582798683798784788885788985788a86788b87788c88788d88788e89788f8a78908b78918b78928c78928d78938e78948e77958f779690779791779892779992779a93769b94769c95769d95769e96769f9775a09875a19975a29975a39a74a49b74a59c74a69c74a79d73a89e73a99f73aaa073aba072aca172ada272aea371afa471b0a571b1a570b3a670b4a76fb5a86fb6a96fb7a96eb8aa6eb9ab6dbaac6dbbad6dbcae6cbdae6cbeaf6bbfb06bc0b16ac1b26ac2b369c3b369c4b468c5b568c6b667c7b767c8b866c9b965cbb965ccba64cdbb63cebc63cfbd62d0be62d1bf61d2c060d3c05fd4c15fd5c25ed6c35dd7c45cd9c55cdac65bdbc75adcc859ddc858dec958dfca57e0cb56e1cc55e2cd54e4ce53e5cf52e6d051e7d150e8d24fe9d34eead34cebd44bedd54aeed649efd748f0d846f1d945f2da44f3db42f5dc41f6dd3ff7de3ef8df3cf9e03afbe138fce236fde334fee434fee535fee636fee838'
    };

    /** jet как в MATLAB: x ∈ [0, 1] → [r, g, b] ∈ [0, 1]. */
    core.jet = function (x) {
        var c = function (k) {
            return core.clamp(1.5 - Math.abs(4 * x - k), 0, 1);
        };
        return [c(3), c(2), c(1)];
    };

    var paletteCache = {};

    /** Таблица палитры: Uint8Array(256 · 3), RGB от низа окна к верху; неизвестное имя — серая. Таблица общая
     *  (кэш) — не менять. */
    core.paletteTable = function (name) {
        name = PALETTE_HEX[name] || name === 'jet' ? name : 'gray';
        if (paletteCache[name]) return paletteCache[name];
        var out = new Uint8Array(768), i;
        var hex = PALETTE_HEX[name];
        if (hex) {
            for (i = 0; i < 768; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        } else {
            for (i = 0; i < 256; i++) {
                var c = name === 'jet' ? core.jet(i / 255) : [i / 255, i / 255, i / 255];
                out[i * 3] = Math.round(c[0] * 255);
                out[i * 3 + 1] = Math.round(c[1] * 255);
                out[i * 3 + 2] = Math.round(c[2] * 255);
            }
        }
        paletteCache[name] = out;
        return out;
    };

    /** Палитра с таким именем есть. */
    core.hasPalette = function (name) {
        return core.PALETTES.some(function (p) {
            return p[0] === name;
        });
    };

})(typeof window !== 'undefined' ? window : globalThis);
