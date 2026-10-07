/* Студия реконструкции — просмотрщик изображений (canvas).
 *
 * Изображения — из бинарных ответов (core.decodeBinary): коды uint16 + scale/offset, окно/уровень через LUT на
 * 65536 записей. Несколько «видов» (огибающая, угол, синограмма, срез, …): у каждого своё изображение, окно и
 * масштаб; при новой картинке того же вида окно сохраняется, если пользователь его менял, масштаб — если размер
 * тот же. Масштаб колесом вокруг курсора, панорама перетаскиванием, двойной щелчок — вписать.
 * Гистограмма с двумя ручками окна. Значение под курсором — в физических единицах вида.
 *
 * Внешний вид (desc.external — объект с activate(on), setWindow(lo, hi), fit(), например S.View3D): изображение
 * хранится здесь ради гистограммы и окна, а рисует и обрабатывает мышь он сам (свой canvas поверх); 2D-холст на это
 * время скрыт, масштаб и панорама просмотрщика не работают, в строке состояния — desc.hint.
 *
 * События: 'transform' (xf) — изменилось преобразование текущего вида; 'view' (key) — сменился вид;
 * 'image' (key) — у вида новое изображение (или вид удалён); 'window' (lo, hi) — окно. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;
    var SVGNS = 'http://www.w3.org/2000/svg';
    var MAX_SCALE = 64;

    function el(tag, cls) {
        var e = root.document.createElement(tag);
        if (cls) e.className = cls;
        return e;
    }

    /**
     * desc вида: {kind, unit, label, aspect (высота пикселя / ширина, по умолчанию 1),
     *            coords(ix, iy) → строка координат для строки состояния или null,
     *            inside(ix, iy) → false — точка не данные (промежуток мозаики): без значения под курсором,
     *            external — внешний вид (см. заголовок), hint — подсказка в строке состояния для него,
     *            autoPercentiles — [нижний, верхний] перцентили авто-окна, по умолчанию 0,5 и 99,5}
     */
    function Viewer(stage, opts) {
        core.Emitter.call(this);
        opts = opts || {};
        this.stage = stage;
        this.readout = opts.readout || null;
        this.hint = opts.hint === undefined ?
            'колесо — масштаб, перетаскивание — сдвиг, двойной щелчок — вписать' : opts.hint;
        this.canvas = el('canvas', 'sv-canvas');
        this.ctx = this.canvas.getContext('2d');
        this.svg = root.document.createElementNS(SVGNS, 'svg');
        this.svg.setAttribute('class', 'sv-overlay');
        this.caption = el('div', 'sv-caption hidden');
        this.msg = el('div', 'sv-msg');
        this.busyEl = el('div', 'sv-busy hidden');
        stage.appendChild(this.canvas);
        stage.appendChild(this.svg);
        stage.appendChild(this.caption);
        stage.appendChild(this.msg);
        stage.appendChild(this.busyEl);
        this.views = {};
        this.key = null;
        this.W = 0;
        this.H = 0;
        this.dpr = 1;
        this._lut = new Uint8Array(65536);
        this._raf = 0;
        this._busy = {};
        this._pan = null;
        this._lastPointer = null;
        this._ext = null;           // внешний вид текущего вида (desc.external) или null
        this.hist = opts.hist ? new Histogram(opts.hist, this) : null;
        this._bind();
        this._resize();
    }
    core.Emitter.mixin(Viewer.prototype);

    // --- виды -----------------------------------------------------------------------------------------------

    Viewer.prototype.has = function (key) {
        return !!(this.views[key] && this.views[key].img);
    };

    Viewer.prototype.get = function (key) {
        return this.views[key || this.key] || null;
    };

    Viewer.prototype.current = function () {
        return this.key;
    };

    /** Показать (или заменить) изображение вида key. Текущий вид не меняется, если opts.select не задан.
     *  opts: select, fit (вписать заново), resetWindow, hist — готовая гистограмма (core.histogram) вместо гистограммы
     *  изображения: авто-окно по ней (у мозаики и «крупно» сравнения — по всем плиткам, без промежутков). */
    Viewer.prototype.show = function (key, img, desc, opts) {
        opts = opts || {};
        desc = desc || {};
        var v = this.views[key];
        if (!v) v = this.views[key] = {key: key, img: null, win: null, xf: null, fit: true};
        var prev = v.img;
        var aspect = desc.aspect > 0 ? desc.aspect : 1;
        var sameSize = prev && prev.w === img.w && prev.h === img.h && v.aspect === aspect;
        v.img = img;
        v.desc = desc;
        v.aspect = aspect;
        v.hist = opts.hist || core.histogram(img);
        v.range = core.dataRange(v.hist);
        var keep = v.win && v.win.user && v.kind === desc.kind && !opts.resetWindow;
        if (!keep) {
            var ap = desc.autoPercentiles;
            var w = core.autoWindow(v.hist, ap && ap[0], ap && ap[1]);
            v.win = {lo: w[0], hi: w[1], user: false};
        }
        v.kind = desc.kind;
        if (!sameSize || !v.xf || opts.fit) {
            v.fit = true;
            v.xf = null;
        }
        v.dirty = true;
        if (opts.select || this.key === null) {
            this.select(key);
        } else if (this.key === key) {
            this._activate(v);
        }
        this.emit('image', key);
        return v;
    };

    /** Удалить вид (например, срез после перезагрузки области). */
    Viewer.prototype.drop = function (key) {
        delete this.views[key];
        if (this.key === key) this.select(key);
        this.emit('image', key);
    };

    Viewer.prototype.select = function (key) {
        var changed = this.key !== key;
        this.key = key;
        var v = this.views[key];
        this._activate(v || null);
        if (changed) this.emit('view', key);
    };

    Viewer.prototype._activate = function (v) {
        var ext = v && v.img && v.desc && v.desc.external || null;
        if (this._ext && this._ext !== ext) this._ext.activate(false);
        this._ext = ext;
        this.canvas.classList.toggle('hidden', !!ext);
        if (ext) {
            ext.activate(true);
            if (v.win) ext.setWindow(v.win.lo, v.win.hi);     // не ждать первого кадра (_draw)
        }
        if (v && v.img) {
            if (v.fit || !v.xf) this._fitView(v);
            this.msg.classList.add('hidden');
            this.stage.classList.add('sv-has-image');
        } else {
            this.msg.classList.remove('hidden');
            this.msg.textContent = (v && v.placeholder) || 'Нет изображения';
            this.stage.classList.remove('sv-has-image');
        }
        this._setCaption(v && v.img && v.desc ? v.desc.label : '');
        if (this.hist) this.hist.update(v && v.img ? v : null);
        this._schedule();
        this.emit('transform', this.xf());
        this._refreshReadout();
    };

    /** Текст-заглушка вида без изображения («Загрузка обзора…»). */
    Viewer.prototype.placeholder = function (key, text) {
        var v = this.views[key];
        if (!v) v = this.views[key] = {key: key, img: null, win: null, xf: null, fit: true};
        v.placeholder = text;
        if (this.key === key && !v.img) this._activate(v);
    };

    /** Подпись вида (левый верхний угол). */
    Viewer.prototype.setLabel = function (key, label) {
        var v = this.views[key];
        if (!v || !v.desc) return;
        v.desc.label = label;
        if (this.key === key) this._setCaption(label);
    };

    Viewer.prototype._setCaption = function (text) {
        this.caption.textContent = text || '';
        this.caption.classList.toggle('hidden', !text);
    };

    // --- преобразование -------------------------------------------------------------------------------------

    Viewer.prototype.xf = function () {
        var v = this.views[this.key];
        return v && v.img && v.xf ? v.xf : null;
    };

    Viewer.prototype._fitXf = function (v) {
        return core.fitTransform(v.img.w, v.img.h, v.aspect, this.W, this.H, 8);
    };

    Viewer.prototype._fitView = function (v) {
        v.xf = this._fitXf(v);
        v.fit = true;
    };

    Viewer.prototype.fit = function () {
        if (this._ext) {
            this._ext.fit();
            return;
        }
        var v = this.views[this.key];
        if (!v || !v.img) return;
        this._fitView(v);
        this._changed();
    };

    Viewer.prototype.oneToOne = function () {
        var v = this.views[this.key];
        if (!v || !v.img || this._ext) return;
        var c = this._lastPointer || {x: this.W / 2, y: this.H / 2};
        v.xf = core.oneToOne(v.xf, c.x, c.y);
        v.fit = false;
        this._changed();
    };

    Viewer.prototype._limits = function (v) {
        var fs = this._fitXf(v).sx;
        return [Math.min(fs / 4, 1), Math.max(MAX_SCALE, fs * 4)];
    };

    Viewer.prototype.zoomAt = function (factor, mx, my) {
        var v = this.views[this.key];
        if (!v || !v.img) return;
        var lim = this._limits(v);
        v.xf = core.zoomAt(v.xf, factor, mx, my, lim[0], lim[1]);
        v.fit = false;
        this._changed();
    };

    Viewer.prototype._changed = function () {
        this._schedule();
        this.emit('transform', this.xf());
        this._refreshReadout();
    };

    /** Клиентские координаты → координаты изображения текущего вида (null без изображения). */
    Viewer.prototype.clientToImage = function (cx, cy) {
        var xf = this.xf();
        if (!xf) return null;
        var r = this.stage.getBoundingClientRect();
        return core.toImage(xf, cx - r.left, cy - r.top);
    };

    // --- окно -----------------------------------------------------------------------------------------------

    Viewer.prototype.getWindow = function () {
        var v = this.views[this.key];
        return v && v.win ? {lo: v.win.lo, hi: v.win.hi, user: v.win.user} : null;
    };

    Viewer.prototype.setWindow = function (lo, hi, user) {
        var v = this.views[this.key];
        if (!v || !v.img || !core.isNum(lo) || !core.isNum(hi)) return;
        if (!(hi > lo)) hi = lo + Math.max(Math.abs(lo) * 1e-6, 1e-12);
        v.win = {lo: lo, hi: hi, user: user !== false};
        v.dirty = true;
        this._schedule();
        if (this.hist) this.hist.update(v);
        this.emit('window', lo, hi);
    };

    Viewer.prototype.autoWindow = function () {
        var v = this.views[this.key];
        if (!v || !v.img) return;
        var ap = v.desc && v.desc.autoPercentiles;
        var w = core.autoWindow(v.hist, ap && ap[0], ap && ap[1]);
        this.setWindow(w[0], w[1], false);
    };

    // --- отрисовка ------------------------------------------------------------------------------------------

    Viewer.prototype._schedule = function () {
        var self = this;
        if (self._raf) return;
        var raf = root.requestAnimationFrame || function (f) {
            return setTimeout(f, 16);
        };
        self._raf = raf(function () {
            self._raf = 0;
            self._draw();
        });
    };

    Viewer.prototype._render = function (v) {
        var img = v.img;
        if (!v.canvas) v.canvas = el('canvas');
        if (v.canvas.width !== img.w || v.canvas.height !== img.h) {
            v.canvas.width = img.w;
            v.canvas.height = img.h;
            v.imageData = null;
        }
        var cctx = v.canvas.getContext('2d');
        if (!v.imageData) v.imageData = cctx.createImageData(img.w, img.h);
        core.toRGBA(img, v.win.lo, v.win.hi, v.imageData.data, img.dtype === 'uint16' ? this._lut : null);
        cctx.putImageData(v.imageData, 0, 0);
        v.dirty = false;
    };

    Viewer.prototype._draw = function () {
        var ctx = this.ctx, c = this.canvas;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        var v = this.views[this.key];
        if (!v || !v.img || !v.xf) return;
        if (this._ext) {
            this._ext.setWindow(v.win.lo, v.win.hi);
            v.dirty = false;
            return;
        }
        if (v.dirty) this._render(v);
        var d = this.dpr, xf = v.xf;
        // сглаживание — только при уменьшении; при увеличении видны пиксели
        ctx.imageSmoothingEnabled = Math.min(xf.sx, xf.sy) < 1;
        ctx.setTransform(xf.sx * d, 0, 0, xf.sy * d, xf.tx * d, xf.ty * d);
        ctx.drawImage(v.canvas, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    };

    Viewer.prototype._resize = function () {
        var W = this.stage.clientWidth, H = this.stage.clientHeight;
        var dpr = root.devicePixelRatio || 1;
        if (W === this.W && H === this.H && dpr === this.dpr) return;
        this.W = W;
        this.H = H;
        this.dpr = dpr;
        this.canvas.width = Math.max(1, Math.round(W * dpr));
        this.canvas.height = Math.max(1, Math.round(H * dpr));
        this.svg.setAttribute('width', W);
        this.svg.setAttribute('height', H);
        var self = this;
        Object.keys(this.views).forEach(function (k) {
            var v = self.views[k];
            if (v.img && v.fit) self._fitView(v);
        });
        this._changed();
        if (this.hist) this.hist.draw();
    };

    // --- ввод -----------------------------------------------------------------------------------------------

    Viewer.prototype._bind = function () {
        var self = this, stage = this.stage;

        stage.addEventListener('wheel', function (e) {
            if (!self.xf() || self._ext) return;
            e.preventDefault();
            var r = stage.getBoundingClientRect();
            var dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
            dy = core.clamp(dy, -600, 600);
            self.zoomAt(Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, {passive: false});

        stage.addEventListener('pointerdown', function (e) {
            if (!self.xf() || self._ext) return;
            if (e.button !== 0 && e.button !== 1) return;
            if (e.target && e.target.closest && e.target.closest('[data-handle]')) return;   // ручки наложения
            // без preventDefault для левой кнопки: иначе поле ввода не теряет фокус и не шлёт change;
            // для средней — нужен (иначе браузер включает автопрокрутку)
            if (e.button === 1) e.preventDefault();
            self._pan = {id: e.pointerId, x: e.clientX, y: e.clientY};
            try {
                stage.setPointerCapture(e.pointerId);
            } catch (err) { /* указатель уже отпущен */ }
            stage.classList.add('sv-panning');
        });

        stage.addEventListener('pointermove', function (e) {
            var r = stage.getBoundingClientRect();
            self._lastPointer = {x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY};
            var p = self._pan;
            if (p && p.id === e.pointerId) {
                var v = self.views[self.key];
                if (v && v.xf) {
                    v.xf = {sx: v.xf.sx, sy: v.xf.sy, tx: v.xf.tx + e.clientX - p.x, ty: v.xf.ty + e.clientY - p.y};
                    v.fit = false;
                    p.x = e.clientX;
                    p.y = e.clientY;
                    self._changed();
                }
                return;
            }
            self._refreshReadout();
        });

        function endPan(e) {
            if (self._pan && self._pan.id === e.pointerId) {
                self._pan = null;
                stage.classList.remove('sv-panning');
                try {
                    stage.releasePointerCapture(e.pointerId);
                } catch (err) { /* уже отпущен */ }
            }
        }
        stage.addEventListener('pointerup', endPan);
        stage.addEventListener('pointercancel', endPan);
        stage.addEventListener('pointerleave', function () {
            if (!self._pan) {
                self._lastPointer = null;
                self._refreshReadout();
            }
        });
        stage.addEventListener('dblclick', function (e) {
            if (e.target && e.target.closest && e.target.closest('[data-handle]')) return;
            if (self._ext) return;          // внешний вид сам обрабатывает двойной щелчок
            self.fit();
        });

        if (typeof root.ResizeObserver === 'function') {
            this._ro = new root.ResizeObserver(function () {
                self._resize();
            });
            this._ro.observe(stage);
        } else {
            root.addEventListener('resize', function () {
                self._resize();
            });
        }
    };

    /** Строка состояния: координаты и значение под курсором. */
    Viewer.prototype._refreshReadout = function () {
        if (!this.readout) return;
        var v = this.views[this.key], p = this._lastPointer;
        var hint = v && v.img ? (this._ext ? v.desc.hint || '' : this.hint) : '';
        this.readout.classList.toggle('sv-hint', true);
        if (this._ext) {
            this.readout.textContent = hint;
            return;
        }
        if (!v || !v.img || !v.xf || !p) {
            this.readout.textContent = hint;
            return;
        }
        var q = core.toImage(v.xf, p.x, p.y);
        var ix = Math.floor(q.x), iy = Math.floor(q.y);
        if (ix < 0 || iy < 0 || ix >= v.img.w || iy >= v.img.h || (v.desc && v.desc.inside && !v.desc.inside(ix, iy))) {
            this.readout.textContent = hint;
            return;
        }
        this.readout.classList.remove('sv-hint');
        var parts = [];
        var c = v.desc && v.desc.coords ? v.desc.coords(ix, iy) : null;
        parts.push(c || ('x ' + ix + ', y ' + iy));
        var val = core.valueAt(v.img, ix, iy);
        parts.push('значение ' + core.fmtValue(val) + (v.desc && v.desc.unit ? ' ' + v.desc.unit : ''));
        this.readout.textContent = parts.join(' · ');
    };

    // --- занятость ------------------------------------------------------------------------------------------

    /** Индикатор «идёт запрос»: source — кто (несколько источников одновременно). */
    Viewer.prototype.setBusy = function (source, on, text) {
        if (on) this._busy[source] = text || 'Загрузка…';
        else delete this._busy[source];
        var keys = Object.keys(this._busy);
        this.busyEl.classList.toggle('hidden', !keys.length);
        this.busyEl.textContent = keys.length ? this._busy[keys[keys.length - 1]] : '';
    };

    // --- гистограмма ----------------------------------------------------------------------------------------

    function Histogram(container, viewer) {
        var self = this;
        this.viewer = viewer;
        this.v = null;
        container.classList.add('sv-hist');
        this.plot = el('div', 'sv-hist-plot');
        this.canvas = el('canvas');
        this.hLo = el('div', 'sv-hh sv-hh-lo');
        this.hHi = el('div', 'sv-hh sv-hh-hi');
        this.hLo.title = 'Нижняя граница окна';
        this.hHi.title = 'Верхняя граница окна';
        this.plot.appendChild(this.canvas);
        this.plot.appendChild(this.hLo);
        this.plot.appendChild(this.hHi);
        var ctl = el('div', 'sv-hist-ctl');
        this.inLo = el('input', 'form-control input-sm sv-win-in');
        this.inHi = el('input', 'form-control input-sm sv-win-in');
        this.inLo.title = 'Нижняя граница окна';
        this.inHi.title = 'Верхняя граница окна';
        this.unit = el('span', 'sv-unit text-muted');
        this.autoBtn = el('button', 'btn btn-default btn-xs');
        this.autoBtn.type = 'button';
        this.autoBtn.textContent = 'Авто';
        this.autoBtn.title = 'Окно по персентилям 0,5 и 99,5 %';
        var dash = el('span', 'sv-dash');
        dash.textContent = '–';
        ctl.appendChild(this.inLo);
        ctl.appendChild(dash);
        ctl.appendChild(this.inHi);
        ctl.appendChild(this.unit);
        ctl.appendChild(this.autoBtn);
        container.appendChild(this.plot);
        container.appendChild(ctl);

        this.autoBtn.addEventListener('click', function () {
            viewer.autoWindow();
        });
        function onInput() {
            if (!self.v) return;
            var lo = core.parseNum(self.inLo.value), hi = core.parseNum(self.inHi.value);
            if (!core.isNum(lo)) lo = self.v.win.lo;
            if (!core.isNum(hi)) hi = self.v.win.hi;
            if (hi > lo) viewer.setWindow(lo, hi, true);
            else self.update(self.v);
        }
        this.inLo.addEventListener('change', onInput);
        this.inHi.addEventListener('change', onInput);
        this._dragHandle(this.hLo, 'lo');
        this._dragHandle(this.hHi, 'hi');
        if (typeof root.ResizeObserver === 'function') {
            new root.ResizeObserver(function () {
                self.draw();
            }).observe(this.plot);
        }
    }

    Histogram.prototype._range = function () {
        var v = this.v;
        var r = v.range;
        return r[1] > r[0] ? r : [r[0], r[0] + 1];
    };

    Histogram.prototype._dragHandle = function (h, which) {
        var self = this;
        h.addEventListener('pointerdown', function (e) {
            if (!self.v) return;
            e.stopPropagation();
            try {
                h.setPointerCapture(e.pointerId);
            } catch (err) { /* уже отпущен */ }
            h.classList.add('sv-hh-drag');
            function move(ev) {
                var r = self.plot.getBoundingClientRect();
                var rg = self._range();
                var frac = core.clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
                var val = rg[0] + frac * (rg[1] - rg[0]);
                var eps = (rg[1] - rg[0]) / 1000;
                var w = self.v.win;
                if (which === 'lo') self.viewer.setWindow(Math.min(val, w.hi - eps), w.hi, true);
                else self.viewer.setWindow(w.lo, Math.max(val, w.lo + eps), true);
            }
            function up(ev) {
                h.classList.remove('sv-hh-drag');
                h.removeEventListener('pointermove', move);
                h.removeEventListener('pointerup', up);
                h.removeEventListener('pointercancel', up);
                try {
                    h.releasePointerCapture(ev.pointerId);
                } catch (err) { /* уже отпущен */ }
            }
            h.addEventListener('pointermove', move);
            h.addEventListener('pointerup', up);
            h.addEventListener('pointercancel', up);
        });
    };

    Histogram.prototype.update = function (v) {
        this.v = v;
        var on = !!(v && v.img);
        this.inLo.disabled = this.inHi.disabled = this.autoBtn.disabled = !on;
        this.hLo.classList.toggle('hidden', !on);
        this.hHi.classList.toggle('hidden', !on);
        if (!on) {
            this.inLo.value = this.inHi.value = '';
            this.unit.textContent = '';
        } else {
            if (root.document.activeElement !== this.inLo) this.inLo.value = core.fmtValue(v.win.lo);
            if (root.document.activeElement !== this.inHi) this.inHi.value = core.fmtValue(v.win.hi);
            this.unit.textContent = v.desc && v.desc.unit ? v.desc.unit : '';
            var ap = (v.desc && v.desc.autoPercentiles) || [0.5, 99.5];
            this.autoBtn.title = 'Окно по персентилям ' + core.fmtNum(ap[0], 2) + ' и ' + core.fmtNum(ap[1], 2) + ' %';
        }
        this.draw();
    };

    Histogram.prototype.draw = function () {
        var c = this.canvas, W = this.plot.clientWidth, H = this.plot.clientHeight;
        var dpr = root.devicePixelRatio || 1;
        if (!W || !H) return;
        if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
            c.width = Math.round(W * dpr);
            c.height = Math.round(H * dpr);
        }
        var ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        var v = this.v;
        if (!v || !v.img) return;
        var rg = this._range();
        var n = Math.max(16, Math.min(512, Math.floor(W)));
        var bins = core.binHistogram(v.hist, n, rg[0], rg[1]);
        var max = 0;
        for (var i = 0; i < n; i++) if (bins[i] > max) max = bins[i];
        var lmax = Math.log(1 + max) || 1;
        var span = rg[1] - rg[0];
        var xLo = (v.win.lo - rg[0]) / span * W, xHi = (v.win.hi - rg[0]) / span * W;
        // окно — подсветка
        ctx.fillStyle = 'rgba(66, 139, 202, 0.12)';
        ctx.fillRect(core.clamp(xLo, 0, W), 0, core.clamp(xHi, 0, W) - core.clamp(xLo, 0, W), H);
        ctx.fillStyle = '#777';
        var bw = W / n;
        for (var j = 0; j < n; j++) {
            if (!bins[j]) continue;
            var bh = Math.log(1 + bins[j]) / lmax * (H - 2);
            ctx.fillRect(j * bw, H - bh, Math.max(1, bw), bh);
        }
        this.hLo.style.left = core.clamp(xLo, 0, W) + 'px';
        this.hHi.style.left = core.clamp(xHi, 0, W) + 'px';
    };

    S.Viewer = Viewer;
})(typeof window !== 'undefined' ? window : globalThis);
