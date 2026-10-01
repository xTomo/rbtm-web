/* Студия реконструкции — сравнение вариантов колец и сглаживания на фрагменте среза 1:1 (вид «Сравнение»).
 *
 * POST sessions/<sid>/compare {row, center, tilt, angles, region | null, size, variants: [{rings, smoothing}], max_px,
 * seq} → стопка uint16 (k, th, tw) с одним общим окном; X-Meta: region, variants (нормализованные), metrics
 * [{noise (1/мм, шум среза по половинам углов), sharpness (относительно варианта 0)}], timings, downsample. Канал
 * «последний выигрывает». «Сравнить кольца» — пресеты off/weak/medium/strong при текущем сглаживании; «Сравнить σ» —
 * без сглаживания и σ 1 / 1,5 / 2 / 2,5 / 3 / 4 при текущих кольцах и деблюринге.
 * Фрагмент: вид «Срез» увеличен (видна часть среза) — видимая часть в пикселях полного среза (core.visibleRegion,
 * сторона 128…512 вокруг её центра); иначе фрагмент прошлого сравнения той же строки, а в первый раз region: null
 * (сервис выберет квадрат 384 с краями по срезу первого варианта).
 * Показ: плитки собираются в одно изображение-мозаику (core.buildMosaic, промежутки — низ общего окна), так что у
 * просмотрщика остаются масштаб, панорама и окно (авто-окно — по всем плиткам, без промежутков); рамки, названия
 * вариантов и метрики — наложением. Щелчок по плитке — применить вариант (пресет колец или сглаживание); «крупно»
 * (Enter/пробел или кнопка) — одна плитка на весь вид, ← → листают варианты на том же месте (размер тот же — масштаб
 * и сдвиг сохраняются), Esc — мозаика. Клавиши действуют только на виде «Сравнение» (стрелки оси — на «Срезе»). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var PREVIEW_EXPECT = ['not_found', 'taken_over', 'forbidden', 'not_ready'];
    var RINGS = ['off', 'weak', 'medium', 'strong'];
    var RINGS_TEXT = {off: 'кольца: выкл', weak: 'кольца: слабо', medium: 'кольца: средне', strong: 'кольца: сильно'};
    var SIGMAS = [null, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0];
    var TITLES = {rings: 'Сравнение колец', sigma: 'Сравнение σ'};
    var SIZE = 384, MAX_PX = 1400;
    var LAYOUT = {maxCols: 4, gap: 8};
    var REGION = {min: 128, max: 512};
    var CLICK_MS = 250;         // выбор по щелчку откладывается: двойной щелчок — «вписать», а не выбор
    var CLICK_SLOP = 4;         // px экрана: сдвиг больше — это была панорама, а не щелчок

    // --- чистые помощники (node-тесты) ---------------------------------------------------------------------------

    /** Варианты сравнения kind ('rings' | 'sigma') при состоянии st: [{rings, smoothing: блок | null}]. */
    function variants(kind, st) {
        if (kind === 'rings') {
            var sm = core.smoothingBlock(st.smoothing);
            return RINGS.map(function (p) {
                return {rings: p, smoothing: sm};
            });
        }
        var cur = st.smoothing || {};
        return SIGMAS.map(function (s) {
            return {rings: st.rings, smoothing: s === null ? null : core.smoothingBlock({sigma: s, deblur: cur.deblur,
                balance: cur.balance, amount: cur.amount})};
        });
    }

    /** Название варианта по сравниваемому параметру: «кольца: средне», «σ 1,5 · Винер», «без сглаживания». */
    function variantLabel(kind, v) {
        if (!v) return '';
        if (kind === 'rings') return RINGS_TEXT[v.rings] || ('кольца: ' + v.rings);
        return core.smoothingText(v.smoothing, true) || 'без сглаживания';
    }

    /** «шум 0,01234 · резкость ×1,08». */
    function metricsText(m) {
        if (!m) return '';
        var parts = [];
        if (core.isNum(m.noise)) parts.push('шум ' + core.fmtValue(m.noise));
        if (core.isNum(m.sharpness)) parts.push('резкость ×' + core.fmtFixed(m.sharpness, 2));
        return parts.join(' · ');
    }

    /** Совпадает ли вариант с текущим выбором по сравниваемому параметру (рамка «выбрано»). */
    function isCurrent(kind, v, st) {
        if (!v) return false;
        if (kind === 'rings') return v.rings === st.rings;
        var a = core.smoothingBlock(v.smoothing), b = core.smoothingBlock(st.smoothing);
        if (!a || !b) return !a && !b;
        return a.sigma === b.sigma && a.deblur === b.deblur;
    }

    /** Деблюринг блока для подписи: «Винер 0,02», «маска 1,5», «без деблюра». */
    function deblurText(block) {
        var t = core.smoothingText(block);
        return t ? t.replace(/^σ [^·]*· /, '') : '';
    }

    function plural(n, one, few, many) {
        var a = n % 10, b = n % 100;
        if (a === 1 && b !== 11) return one;
        if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
        return many;
    }

    // --- модуль -------------------------------------------------------------------------------------------------

    function Compare(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.res = null;            // последний результат (см. _accept)
        this.large = -1;            // «крупно»: номер показываемой плитки; −1 — мозаика
        this.running = null;        // вид идущего сравнения ('rings' | 'sigma')
        this._down = null;
        this._ptr = null;
        this._clickTimer = null;
        this.e = {
            buttons: ui.qsa('[data-compare]'), panel: ui.$('cmp-panel'), info: ui.$('cmp-info'),
            show: ui.$('cmp-show'), largeBtn: ui.$('cmp-large')
        };
        this.ch = this.api.channel({
            onBusy: function (b) {
                app.viewer.setBusy('compare', b, 'Сравнение…');
                if (!b) self.running = null;
                self._renderButtons();
            }
        });
        this._bind();
        this.render();
    }

    Compare.prototype._bind = function () {
        var self = this, app = this.app, bus = app.bus, e = this.e, stage = app.viewer.stage;
        e.buttons.forEach(function (b) {
            b.addEventListener('click', function () {
                b.blur();           // Enter/пробел дальше — «крупно», а не повторное нажатие кнопки
                self.run(b.getAttribute('data-compare'));
            });
        });
        if (e.show) {
            e.show.addEventListener('click', function () {
                if (app.viewer.has('compare')) app.showView('compare');
            });
        }
        if (e.largeBtn) {
            e.largeBtn.addEventListener('click', function () {
                e.largeBtn.blur();
                self.toggleLarge();
            });
        }
        bus.on('view', function (key) {
            if (key === 'compare') self._overlay();
            self._renderPanel();
        });
        // выбор варианта (щелчком или в шаге 3) — перерисовать рамку «выбрано»
        ['rings', 'smoothing'].forEach(function (ev) {
            bus.on(ev, function () {
                self._overlay();
            });
        });
        bus.on('state', function () {
            self.render();
        });
        bus.on('row', function () {
            self._renderPanel();
        });
        bus.on('load-start', function () {
            self.reset();
        });
        bus.on('lost', function () {
            self.ch.cancel();
            self.render();
        });
        root.document.addEventListener('keydown', function (ev) {
            self._onKey(ev);
        });
        stage.addEventListener('pointerdown', function (ev) {
            self._down = ev.button === 0 ? {x: ev.clientX, y: ev.clientY} : null;
        });
        stage.addEventListener('pointermove', function (ev) {
            self._ptr = {x: ev.clientX, y: ev.clientY};
        });
        stage.addEventListener('pointerleave', function () {
            self._ptr = null;
        });
        stage.addEventListener('click', function (ev) {
            self._onClick(ev);
        });
        stage.addEventListener('dblclick', function () {
            self._cancelClick();
        });
    };

    Compare.prototype._canRun = function () {
        var app = this.app, st = this.st;
        return !!app.config.can_run && app.ready() && st.axis !== 'running' && st.row !== null && st.row !== undefined;
    };

    /** Сравнить варианты kind ('rings' | 'sigma') на фрагменте среза строки превью. */
    Compare.prototype.run = function (kind) {
        var self = this, app = this.app, st = this.st;
        if (!TITLES[kind] || !this._canRun()) return;
        var sid = app.sid(), row = st.row, vars = variants(kind, st);
        var body = app.axis.axisParams(row, {row: row, angles: st.angles, region: this._region(row), size: SIZE,
            variants: vars, max_px: MAX_PX});
        this.running = kind;
        this.ch.run(function (signal, seq) {
            body.seq = seq;
            return self.api.postBinary('sessions/' + sid + '/compare', body,
                {signal: signal, expect: PREVIEW_EXPECT, what: 'Сравнение'});
        }).then(function (stack) {
            if (S.api.isStale(stack) || sid !== app.sid()) return;
            self._accept(kind, stack, vars, body);
        }, function (err) {
            app.previewError(err, 'Сравнение');
        });
        this._renderButtons();
    };

    /** Фрагмент: видимая часть увеличенного «Среза», иначе прежний фрагмент той же строки, иначе null (сервис). */
    Compare.prototype._region = function (row) {
        var v = this.app.viewer, sv = v.get('slice');
        if (sv && sv.img && sv.xf && !sv.fit) {
            var r = core.visibleRegion(sv.xf, v.W, v.H, sv.img, REGION);
            if (r) return r;
        }
        var prev = this.res;
        return prev && prev.row === row && prev.region ? prev.region.slice() : null;
    };

    Compare.prototype._accept = function (kind, stack, requested, body) {
        var m = stack.meta || {}, k = stack.k, v = this.app.viewer;
        // столбцов — сколько лучше для размера вида (поля вписывания — по 8 px)
        var layout = core.mosaicLayout(k, stack.w, stack.h, {maxCols: LAYOUT.maxCols, gap: LAYOUT.gap,
            viewW: v.W - 16, viewH: v.H - 16});
        this.res = {
            kind: kind, stack: stack, meta: m, row: body.row, center: body.center, tilt: body.tilt,
            variants: m.variants && m.variants.length === k ? m.variants : requested.slice(0, k),
            metrics: m.metrics || [], region: m.region && m.region.length === 4 ? m.region : null,
            ds: m.downsample > 0 ? m.downsample : 1, layout: layout, mosaic: core.buildMosaic(stack, layout),
            hist: core.histogram(stack)         // авто-окно — по всем плиткам (без промежутков мозаики)
        };
        this.large = -1;
        this._cancelClick();
        this._show(true);
        this.app.bus.emit('compare', this.res);
    };

    /** Показать мозаику или «крупную» плитку в виде 'compare'. */
    Compare.prototype._show = function (select) {
        var self = this, res = this.res, app = this.app;
        if (!res) return;
        var img = this.large >= 0 ? core.frameOf(res.stack, this.large) : res.mosaic;
        app.viewer.show('compare', img, {
            kind: 'compare', unit: '1/мм', label: this._caption(),
            coords: function (ix, iy) {
                return self._coords(res, ix, iy);
            },
            inside: function (ix, iy) {
                return self.large >= 0 || core.tileAt(res.layout, ix, iy) >= 0;
            }
        }, {select: !!select || app.viewer.current() === 'compare', hist: res.hist});
        this._overlay();
        this._renderPanel();
    };

    /** Строка состояния: вариант и координаты в полном срезе. */
    Compare.prototype._coords = function (res, ix, iy) {
        var i = this.large >= 0 ? this.large : core.tileAt(res.layout, ix, iy);
        if (i < 0) return null;
        var t = this.large >= 0 ? {x: 0, y: 0} : res.layout.tiles[i];
        var lx = ix - t.x, ly = iy - t.y, name = variantLabel(res.kind, res.variants[i]);
        if (!res.region) return name + ' · x ' + lx + ', y ' + ly;
        return name + ' · срез x ' + (res.region[0] + lx * res.ds) + ', y ' + (res.region[1] + ly * res.ds);
    };

    Compare.prototype._caption = function () {
        var res = this.res, v0 = res.variants[0] || {}, i = this.large;
        if (i >= 0) {
            // «крупно»: подпись плитки при увеличении может уйти из вида — вариант и метрики здесь
            var m = metricsText(res.metrics[i]);
            return TITLES[res.kind] + ': ' + variantLabel(res.kind, res.variants[i]) + ' (' + (i + 1) + ' из ' +
                res.variants.length + ')' + (m ? ' · ' + m : '') + ' · ← → — листать, Esc — мозаика';
        }
        var parts = [TITLES[res.kind], 'строка ' + res.row];
        if (res.kind === 'rings') {
            parts.push(core.smoothingText(v0.smoothing) || 'без сглаживания');
        } else {
            parts.push(RINGS_TEXT[v0.rings] || '');
            var sm = null;
            res.variants.forEach(function (v) {
                if (!sm && v && v.smoothing) sm = v.smoothing;
            });
            if (sm) parts.push(deblurText(sm));
        }
        var r = res.region;
        if (r) parts.push('фрагмент ' + (r[2] - r[0]) + '×' + (r[3] - r[1]) + (res.ds > 1 ? ', уменьшен ×' + res.ds : ', 1:1'));
        parts.push('щелчок — выбрать, Enter — крупно');
        return parts.join(' · ');
    };

    /** Рамки плиток с названием и метриками; выбранный сейчас вариант — зелёная рамка и «✓». */
    Compare.prototype._overlay = function () {
        var self = this, res = this.res, app = this.app;
        if (!res || app.viewer.current() !== 'compare') return;
        var idx = this.large >= 0 ? [this.large] : res.variants.map(function (v, i) {
            return i;
        });
        app.overlay.set(idx.map(function (i) {
            var t = self.large >= 0 ? {x: 0, y: 0, w: res.stack.w, h: res.stack.h} : res.layout.tiles[i];
            var sel = isCurrent(res.kind, res.variants[i], self.st);
            return {id: 'tile' + i, type: 'rect', editable: false, cls: 'ov-tile', sel: sel, labelInside: 'bottom',
                x0: t.x, y0: t.y, x1: t.x + t.w, y1: t.y + t.h,
                label: (sel ? '✓ ' : '') + variantLabel(res.kind, res.variants[i]) +
                    (self.large >= 0 ? ' (' + (i + 1) + ' из ' + res.variants.length + ')' : ''),
                label2: metricsText(res.metrics[i])};
        }));
    };

    // --- «крупно» ----------------------------------------------------------------------------------------------

    /** i — номер плитки (по кругу), −1 — мозаика. */
    Compare.prototype.setLarge = function (i) {
        if (!this.res) return;
        var k = this.res.variants.length;
        this.large = i < 0 || !k ? -1 : ((i % k) + k) % k;
        this._show(true);
    };

    Compare.prototype.toggleLarge = function () {
        if (!this.res) return;
        this.setLarge(this.large >= 0 ? -1 : this._focusIndex());
    };

    /** Плитка для «крупно»: под курсором, иначе выбранный сейчас вариант, иначе первая. */
    Compare.prototype._focusIndex = function () {
        var res = this.res, app = this.app, st = this.st;
        if (this._ptr && app.viewer.current() === 'compare') {
            var p = app.viewer.clientToImage(this._ptr.x, this._ptr.y);
            var i = p ? core.tileAt(res.layout, p.x, p.y) : -1;
            if (i >= 0) return i;
        }
        for (var j = 0; j < res.variants.length; j++) {
            if (isCurrent(res.kind, res.variants[j], st)) return j;
        }
        return 0;
    };

    // --- выбор варианта ----------------------------------------------------------------------------------------

    /** Применить вариант i: пресет колец или сглаживание (σ, деблюр) — шаги 2 и 4 пересчитают срез и оценку. */
    Compare.prototype.apply = function (i) {
        var res = this.res, app = this.app;
        var v = res && res.variants[i];
        if (!v) return;
        var name = variantLabel(res.kind, v);
        if (isCurrent(res.kind, v, this.st)) {
            ui.toast('Уже выбрано: ' + name, 'info', 2500);
            return;
        }
        if (res.kind === 'rings') {
            app.rings.choose(v.rings);
        } else {
            var b = core.smoothingBlock(v.smoothing);
            if (!b) {
                app.smoothing.set({enabled: false});
            } else {
                var patch = {enabled: true, sigma: b.sigma, deblur: b.deblur};
                if (b.deblur === 'wiener' && core.isNum(v.smoothing.balance)) patch.balance = v.smoothing.balance;
                if (b.deblur === 'unsharp' && core.isNum(v.smoothing.amount)) patch.amount = v.smoothing.amount;
                app.smoothing.set(patch);
            }
        }
        var sm = res.kind === 'sigma' ? core.smoothingText(v.smoothing) : '';
        var full = sm ? 'сглаживание ' + sm : name;
        ui.toast('Выбрано: ' + full + ' — срез и оценка пересчитываются.', 'success', 3000);
    };

    Compare.prototype._onClick = function (ev) {
        var d = this._down, res = this.res, app = this.app, self = this;
        this._down = null;
        if (!d || !res || app.viewer.current() !== 'compare') return;
        if (Math.abs(ev.clientX - d.x) > CLICK_SLOP || Math.abs(ev.clientY - d.y) > CLICK_SLOP) return;
        if (ev.detail > 1) {                // второй щелчок двойного — это «вписать»
            this._cancelClick();
            return;
        }
        var p = app.viewer.clientToImage(ev.clientX, ev.clientY), i = -1;
        if (p && this.large >= 0) {
            if (p.x >= 0 && p.y >= 0 && p.x < res.stack.w && p.y < res.stack.h) i = this.large;
        } else if (p) {
            i = core.tileAt(res.layout, p.x, p.y);
        }
        if (i < 0) return;
        this._cancelClick();
        this._clickTimer = setTimeout(function () {
            self._clickTimer = null;
            if (self.res === res) self.apply(i);
        }, CLICK_MS);
    };

    Compare.prototype._cancelClick = function () {
        if (this._clickTimer) clearTimeout(this._clickTimer);
        this._clickTimer = null;
    };

    /** Enter/пробел — «крупно» ↔ мозаика, ← → — листать в «крупно», Esc — мозаика. Только на виде «Сравнение» и не
     *  в полях ввода (стрелки оси действуют на «Срезе» и «0° − 180°» — не пересекаются). */
    Compare.prototype._onKey = function (ev) {
        if (!this.res || this.app.viewer.current() !== 'compare') return;
        if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
        var t = ev.target, tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        if (root.document.querySelector('.modal.in')) return;
        var key = ev.key;
        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return;   // у элемента в фокусе своё действие
            ev.preventDefault();
            this.toggleLarge();
        } else if (key === 'Escape' && this.large >= 0) {
            ev.preventDefault();
            this.setLarge(-1);
        } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && this.large >= 0) {
            ev.preventDefault();
            this.setLarge(this.large + (key === 'ArrowLeft' ? -1 : 1));
        }
    };

    /** Новая загрузка области: прежнее сравнение к данным не относится. */
    Compare.prototype.reset = function () {
        var v = this.app.viewer;
        this.ch.cancel();
        this._cancelClick();
        this.res = null;
        this.large = -1;
        if (v.current() === 'compare' && v.has('envelope')) this.app.showView('envelope');
        v.drop('compare');
        this.app.bus.emit('compare', null);
        this.render();
    };

    // --- отрисовка ------------------------------------------------------------------------------------------------

    Compare.prototype.render = function () {
        this._renderButtons();
        this._renderPanel();
    };

    Compare.prototype._renderButtons = function () {
        var app = this.app, ok = this._canRun(), running = this.running;
        var why = !app.config.can_run ? 'Доступно экспериментатору и администратору' :
            !app.ready() ? 'Сначала загрузите область (шаг 1)' : 'Идёт поиск оси';
        this.e.buttons.forEach(function (b) {
            ui.enable(b, ok, why);
            b.classList.toggle('st-busy', running === b.getAttribute('data-compare'));
        });
    };

    Compare.prototype._renderPanel = function () {
        var res = this.res, e = this.e, st = this.st;
        ui.show(e.panel, !!res);
        if (!res) return;
        var n = res.variants.length, r = res.region, t = res.meta.timings || {};
        var parts = [TITLES[res.kind] + ': ' + n + ' ' + plural(n, 'вариант', 'варианта', 'вариантов'),
            'строка ' + res.row];
        if (r) parts.push('фрагмент ' + (r[2] - r[0]) + '×' + (r[3] - r[1]) + ' (x ' + r[0] + '…' + r[2] + ', y ' + r[1] +
            '…' + r[3] + ')');
        if (core.isNum(t.total_s)) parts.push(core.fmtNum(t.total_s, 1) + ' с');
        var stale = [];
        if (st.row !== res.row) stale.push('строка превью');
        var now = this.app.axis.axisParams(res.row, {});
        if (now.center !== res.center || now.tilt !== res.tilt) stale.push('ось');
        if (stale.length) parts.push('с тех пор изменились ' + stale.join(' и ') + ' — сравните заново');
        ui.text(e.info, parts.join(' · '));
        ui.text(e.largeBtn, this.large >= 0 ? 'Мозаика' : 'Крупно');
    };

    Compare.variants = variants;
    Compare.variantLabel = variantLabel;
    Compare.metricsText = metricsText;
    Compare.isCurrent = isCurrent;
    Compare.deblurText = deblurText;
    S.Compare = Compare;
})(typeof window !== 'undefined' ? window : globalThis);
