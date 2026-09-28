/* Студия реконструкции — лента миниатюр углов выборки обзора.
 *
 * Стопка k кадров −ln T (общее окно квантования) уменьшается средним по блокам; на каждой миниатюре — рамка поля
 * зрения; углы, где объект выходит за рамку, — красной рамкой. Щелчок — событие 'select' (k). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;
    var THUMB_W = 96;

    function ThumbStrip(container) {
        core.Emitter.call(this);
        this.el = container;
        this.items = [];
        this.roi = null;         // координаты полного кадра
        this.bin = 1;
        this.outside = {};
        this.selected = -1;
    }
    core.Emitter.mixin(ThumbStrip.prototype);

    ThumbStrip.prototype.message = function (text) {
        this.el.innerHTML = '';
        this.items = [];
        var m = root.document.createElement('div');
        m.className = 'st-thumbs-msg text-muted';
        m.textContent = text;
        this.el.appendChild(m);
    };

    /** stack — стопка (k, h, w) из decodeBinary; angles — углы кадров; bin — биннинг обзора. */
    ThumbStrip.prototype.setStack = function (stack, angles, bin) {
        var self = this, doc = root.document;
        this.el.innerHTML = '';
        this.items = [];
        this.bin = bin || 1;
        var f = Math.max(1, Math.ceil(stack.w / THUMB_W));
        // окно — весь диапазон кодов (стопка квантована общим окном персентилей 0,1…99,9)
        var lo = stack.quantized ? stack.offset : null, hi = stack.quantized ? stack.offset + 65535 * stack.scale : null;
        for (var k = 0; k < stack.k; k++) {
            var small = core.downsampleMean(core.frameOf(stack, k), f);
            if (lo === null) {
                var w = core.autoWindow(core.histogram(small), 0.1, 99.9);
                lo = w[0];
                hi = w[1];
            }
            var canvas = doc.createElement('canvas');
            canvas.width = small.w;
            canvas.height = small.h;
            var ctx = canvas.getContext('2d');
            var id = ctx.createImageData(small.w, small.h);
            core.toRGBA(small, lo, hi, id.data);
            var item = doc.createElement('button');
            item.type = 'button';
            item.className = 'st-thumb';
            var angle = angles && angles[k] !== undefined ? angles[k] : null;
            item.title = angle !== null ? 'Угол ' + core.fmtNum(angle, 2) + '° — показать кадр' : 'Показать кадр';
            var cap = doc.createElement('span');
            cap.className = 'st-thumb-cap';
            cap.textContent = angle !== null ? core.fmtNum(angle, 1) + '°' : String(k);
            item.appendChild(canvas);
            item.appendChild(cap);
            (function (kk) {
                item.addEventListener('click', function () {
                    self.select(kk);
                    self.emit('select', kk);
                });
            })(k);
            this.el.appendChild(item);
            this.items.push({el: item, canvas: canvas, ctx: ctx, imageData: id, f: f, w: small.w, h: small.h});
        }
        this._drawAll();
        this.select(this.selected);
    };

    ThumbStrip.prototype.setRoi = function (roi) {
        this.roi = roi;
        this._drawAll();
    };

    ThumbStrip.prototype.setOutside = function (indices) {
        var o = {};
        (indices || []).forEach(function (i) {
            o[i] = true;
        });
        this.outside = o;
        this._drawAll();
    };

    ThumbStrip.prototype.select = function (k) {
        this.selected = k;
        this.items.forEach(function (it, i) {
            it.el.classList.toggle('st-thumb-sel', i === k);
        });
    };

    ThumbStrip.prototype._drawAll = function () {
        for (var i = 0; i < this.items.length; i++) this._draw(i);
    };

    ThumbStrip.prototype._draw = function (i) {
        var it = this.items[i];
        var out = !!this.outside[i];
        it.el.classList.toggle('st-thumb-out', out);
        it.ctx.putImageData(it.imageData, 0, 0);
        if (!this.roi) return;
        var s = 1 / (this.bin * it.f);
        var x0 = this.roi.x0 * s, x1 = this.roi.x1 * s, y0 = this.roi.y0 * s, y1 = this.roi.y1 * s;
        it.ctx.lineWidth = 1;
        it.ctx.strokeStyle = out ? '#ff3b3b' : '#ffd400';
        it.ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.max(1, Math.round(x1 - x0) - 1),
            Math.max(1, Math.round(y1 - y0) - 1));
    };

    S.ThumbStrip = ThumbStrip;
})(typeof window !== 'undefined' ? window : globalThis);
