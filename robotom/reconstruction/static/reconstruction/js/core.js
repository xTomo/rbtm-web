/* Студия реконструкции — чистая логика без DOM: декодирование бинарных ответов, гистограмма и окно (LUT),
 * преобразования координат просмотрщика, перетаскивание рамки, рамка поля зрения, форматирование, шина событий.
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

    /** Изображение → RGBA (серое) по окну [lo, hi]. out — Uint8ClampedArray w·h·4 (переиспользуется). */
    core.toRGBA = function (img, lo, hi, out, lut) {
        var n = img.w * img.h, d = img.data, i, g, p;
        if (!out || out.length !== n * 4) out = new Uint8ClampedArray(n * 4);
        if (img.dtype === 'float32') {
            var span = hi - lo, k = span > 0 ? 255 / span : 0;
            for (i = 0, p = 0; i < n; i++, p += 4) {
                var v = d[i];
                g = v === v ? (span > 0 ? (v - lo) * k : (v >= lo ? 255 : 0)) : 0;
                out[p] = out[p + 1] = out[p + 2] = g;       // Uint8ClampedArray сам обрезает и округляет
                out[p + 3] = 255;
            }
            return out;
        }
        lut = core.buildLut(img, lo, hi, lut);
        for (i = 0, p = 0; i < n; i++, p += 4) {
            g = lut[d[i]];
            out[p] = out[p + 1] = out[p + 2] = g;
            out[p + 3] = 255;
        }
        return out;
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

    /** Экранирование для вставки текста в HTML. */
    core.escapeHtml = function (s) {
        return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
        });
    };
})(typeof window !== 'undefined' ? window : globalThis);
