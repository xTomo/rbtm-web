/* Студия реконструкции — шаг 5 «Результат».
 *
 * GET results/<id> (404 — результата движка ещё нет): форма объёма, воксель, дата, кратко рецепт (кольца,
 * сглаживание, углы, ось, строки), путь к полному объёму
 * (dir + '/' + result.volume.file) и ссылки на него и его .hx — через старую раздачу статики (config.full_volume_url +
 * full[].rel из ответа сервиса; сервис полный объём не отдаёт), файлы (ссылки api_base + results/<id>/file/<имя>),
 * история запусков; срезы копии ×4 по осям z/y/x с ползунком — GET results/<id>/slice?axis&i.
 * Объёмный вид (вид «3D», S.View3D): GET results/<id>/volume3d — копия, уменьшенная до ≤ 320³ вокселей, uint8;
 * загружается по первому запросу и после нового результата; плоскость текущего среза рисуется в 3D; окно — своё у
 * вида, при первом показе берётся окно среза, если его меняли. Настройки рендера живут здесь (this.r3d).
 * После завершения задачи — обновить. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var AXES = ['z', 'y', 'x'];
    // оси изображения среза (столбец, строка) для каждой оси сечения — в осях объёма (z, y, x)
    var PLANE = {z: ['x', 'y'], y: ['x', 'z'], x: ['y', 'z']};
    var RINGS = {off: 'выкл', weak: 'слабо', medium: 'средне', strong: 'сильно'};
    var ANGLES = {first_180: 'первые 180°', full_halves: 'все полуобороты (усреднение)'};
    // ось сечения → ось 3D-вида (0 — x, 1 — y, 2 — z)
    var AXIS3D = {x: 0, y: 1, z: 2};
    // общий ползунок «Глубина»/«Порог» по режиму рендера (как в сегментаторе): какой параметр, диапазон, подпись
    var DEPTH_ROWS = {
        soft: {key: 'atten', label: 'Глубина', min: 0.005, max: 0.2, step: 0.005, digits: 3,
            title: 'Насколько далеко луч пробивает объём: меньше — видно глубже и ярче, больше — только поверхность'},
        iso: {key: 'iso', label: 'Порог', min: 0, max: 1, step: 0.01, percent: true,
            title: 'Где проходит оболочка — долей окна контраста (едет вместе с окном)'}
    };

    /** Рецепт результата коротко: [«кольца: средне», «сглаживание σ 2,5», …]. */
    function recipeParts(rc) {
        rc = rc || {};
        var parts = [];
        if (rc.rings && rc.rings.preset) parts.push('кольца: ' + (RINGS[rc.rings.preset] || rc.rings.preset));
        var smooth = core.smoothingText(rc.smoothing);          // выключено (или старый рецепт без блока) — ничего
        if (smooth) parts.push('сглаживание ' + smooth);
        var motionText = core.motionText(rc.motion);             // не компенсировалось (или старый рецепт) — ничего
        if (motionText) parts.push(motionText);
        if (rc.recon && rc.recon.angles) parts.push(ANGLES[rc.recon.angles] || rc.recon.angles);
        if (rc.axis && core.isNum(rc.axis.center_x)) {
            parts.push('ось ' + core.fmtNum(rc.axis.center_x, 2) + ' px, наклон ' + core.fmtNum(rc.axis.tilt_deg || 0, 3) + '°');
        }
        if (rc.recon && rc.recon.slices) parts.push('строки ' + rc.recon.slices[0] + '…' + rc.recon.slices[1]);
        return parts;
    }

    /** Ссылки на полный объём: [{name, href, size}] по ответу results/<id> (full: [{name, rel, size}]) и префиксу
     *  раздачи статики base; без префикса или без файлов — []. */
    function fullVolumeLinks(doc, base) {
        if (!base || !doc || !doc.full || !doc.full.length) return [];
        var b = String(base).replace(/\/+$/, '') + '/';
        return doc.full.map(function (f) {
            return {name: f.name, size: f.size, href: b + String(f.rel).split('/').map(encodeURIComponent).join('/')};
        });
    }

    function StepResult(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.id = app.config.exp_id;
        this.e = {
            info: ui.$('res-info'), view: ui.$('res-view'), axes: ui.$('res-axes'), slider: ui.$('res-slider'),
            index: ui.$('res-index'), n: ui.$('res-n'), sw: ui.$('res-switch'), sub: ui.$('res-sub'),
            v3d: ui.$('res-3d'), info3d: ui.$('res-3d-info'), mode3d: ui.$('res-3d-mode'),
            gamma: ui.$('res-3d-gamma'), gammaVal: ui.$('res-3d-gamma-val'), depth: ui.$('res-3d-depth'),
            depthLabel: ui.$('res-3d-depth-label'), depthVal: ui.$('res-3d-depth-val'), box: ui.$('res-3d-box'),
            slice3d: ui.$('res-3d-slice'), clip: ui.$('res-3d-clip'), clipFlip: ui.$('res-3d-flip'),
            save3d: ui.$('res-3d-save')
        };
        this.view3d = null;         // S.View3D — создаётся при первом показе
        this.vol3d = null;          // {run_id, meta, shape} загруженного объёма
        this.r3d = S.View3D ? S.View3D.defaults() : null;
        this.ch3d = this.api.channel({
            onBusy: function (b) {
                app.viewer.setBusy('result3d', b, 'Объём для 3D…');
            }
        });
        this.axis = 'z';
        this.index = {z: null, y: null, x: null};
        this.n = {z: 0, y: 0, x: 0};
        this.ch = this.api.channel({
            delay: 120,
            onBusy: function (b) {
                app.viewer.setBusy('result', b, 'Срез результата…');
            }
        });
        this._bind();
        this.render();
    }

    StepResult.prototype._bind = function () {
        var self = this, e = this.e, app = this.app;
        if (e.axes) {
            ui.qsa('[data-axis]', e.axes).forEach(function (b) {
                b.addEventListener('click', function () {
                    self.axis = b.getAttribute('data-axis');
                    self._renderControls();
                    self.fetchSlice(true);
                });
            });
        }
        if (e.slider) {
            e.slider.addEventListener('input', function () {
                self.index[self.axis] = parseInt(e.slider.value, 10) || 0;
                if (e.index) e.index.value = self.index[self.axis];
                self.fetchSlice(false);
            });
        }
        if (e.index) {
            e.index.addEventListener('change', function () {
                var v = core.parseNum(e.index.value);
                var n = self.n[self.axis];
                if (!core.isNum(v) || !n) {
                    self._renderControls();
                    return;
                }
                self.index[self.axis] = core.clamp(Math.round(v), 0, n - 1);
                self._renderControls();
                self.fetchSlice(false, true);
            });
        }
        // переключатель «Срез | 3D»: подсвечено то, что сейчас в просмотрщике
        if (e.sw) {
            ui.qsa('[data-res]', e.sw).forEach(function (b) {
                b.addEventListener('click', function () {
                    if (b.getAttribute('data-res') === '3d') self.show3d(true);
                    else if (app.viewer.has('result')) app.showView('result');
                    else self.fetchSlice(true, true);
                });
            });
            app.viewer.on('view', function () {
                self._renderSwitch();
                self._render3d();           // настройки 3D видны только на 3D-виде
            });
        }
        app.jobs.on('finished', function (job) {
            if (job.status !== 'done') return;
            self.load().then(function (ok) {
                if (ok && (app.viewer.current() === 'result' || app.viewer.has('result'))) {
                    self.fetchSlice(app.viewer.current() === 'result', true);
                }
                if (ok && app.viewer.has('volume3d')) self.show3d(app.viewer.current() === 'volume3d');
            });
        });
        this._bind3d();
    };

    StepResult.prototype._bind3d = function () {
        var self = this, e = this.e, r = this.r3d;
        if (!r) return;
        var on = function (el, ev, fn) {
            if (el) el.addEventListener(ev, fn);
        };
        if (e.mode3d) {
            ui.qsa('[data-mode]', e.mode3d).forEach(function (b) {
                b.addEventListener('click', function () {
                    self._set3d({mode: b.getAttribute('data-mode')});
                });
            });
        }
        // палитра — общая для срезов и 3D, выбирается у гистограммы просмотрщика
        r.cmap = self.app.viewer.palette;
        self.app.viewer.on('palette', function (name) {
            self._set3d({cmap: name});
        });
        on(e.gamma, 'input', function () {
            self._set3d({gamma: parseFloat(e.gamma.value) || 1});
        });
        on(e.depth, 'input', function () {
            var row = DEPTH_ROWS[r.mode];
            if (!row) return;
            var p = {};
            p[row.key] = parseFloat(e.depth.value);
            self._set3d(p);
        });
        on(e.box, 'change', function () {
            self._set3d({box: e.box.checked});
        });
        on(e.slice3d, 'change', function () {
            self._set3d({slice: self._slicePlane()});
        });
        // разрез идёт по срезу, выбранному выше (ось z/y/x и номер); при включении остаётся дальняя от глаза
        // половина — срезанная грань видна сразу; ⇄ — другая
        on(e.clip, 'change', function () {
            if (!e.clip.checked) {
                self._set3d({clip: {enabled: false}});
                return;
            }
            var c = self._clipFromSlice() || {axis: r.clip.axis, pos: r.clip.pos};
            var side = self.view3d ? self.view3d.farSide(c.axis, c.pos) : r.clip.side;
            self._set3d({clip: {enabled: true, axis: c.axis, pos: c.pos, side: side}});
        });
        on(e.clipFlip, 'click', function () {
            self._set3d({clip: {side: -r.clip.side}});
        });
        on(e.save3d, 'click', function () {
            self.save3dHtml();
        });
    };

    /** Сохранить 3D-вид в HTML (S.export3d): оболочка с настройками вида → сервис вставляет объём и кладёт файл в
     *  каталог результата → файл скачивается, список файлов обновляется. */
    StepResult.prototype.save3dHtml = function () {
        var self = this, app = this.app, st = this.st, v3 = this.view3d, id = this.id, e = this.e;
        if (!v3 || !this.vol3d || !st.resultDoc || !S.export3d || this._saving3d) return;
        var r = st.resultDoc.result || {}, vol = r.volume || {};
        var title = app.config.specimen || id;
        var lines = ['Эксперимент ' + id, 'Реконструкция ' + core.fmtDate(r.created) +
            (r.run_id ? ' · запуск ' + String(r.run_id).slice(0, 8) : '')];
        var rp = recipeParts(r.recipe);
        if (rp.length) lines.push('Рецепт: ' + rp.join(' · '));
        if (vol.shape) lines.push('Полный объём ' + vol.shape.join(' × ') +
            (core.isNum(vol.voxel_mm) ? ', воксель ' + core.fmtNum(vol.voxel_mm * 1000, 3) + ' мкм' : ''));
        var opts = JSON.parse(JSON.stringify(v3.opts));
        opts.slice = null;
        var state = {title: title, lines: lines, opts: opts, win: v3.win ? v3.win.slice() : null,
            cam: JSON.parse(JSON.stringify(v3.cam)), saved: core.fmtDate(new Date().toISOString()) +
                (app.config.user ? ' · ' + app.config.user : '')};
        this._saving3d = true;
        ui.enable(e.save3d, false, 'Идёт сохранение');
        var what = 'Сохранение 3D-вида';
        S.export3d.collect({title: '3D: ' + title, state: state}).then(function (html) {
            return self.api.postText('results/' + id + '/view3d-html', html, 'text/html; charset=utf-8',
                {max_side: v3.maxSide()}, {what: what});
        }).then(function (res) {
            ui.toast('3D-вид сохранён в папку результата: ' + res.name + ' (' + core.fmtBytes(res.size) + ')', 'success',
                8000);
            var a = root.document.createElement('a');
            a.href = self.api.url('results/' + id + '/file/' + encodeURIComponent(res.name));
            a.download = res.name;
            root.document.body.appendChild(a);
            a.click();
            a.parentNode.removeChild(a);
            return self.load();
        }).catch(function (err) {
            if (err && !err.reported && !err.status) ui.toast(what + ': ' + (err.message || err), 'error', 8000);
        }).then(function () {
            self._saving3d = false;
            ui.enable(e.save3d, true);
        });
    };

    /** Изменить настройки 3D-вида (this.r3d) и передать их виду. */
    StepResult.prototype._set3d = function (patch) {
        var r = this.r3d;
        Object.keys(patch).forEach(function (k) {
            if (k === 'clip') r.clip = Object.assign({}, r.clip, patch.clip);
            else r[k] = patch[k];
        });
        if (this.view3d) this.view3d.set(patch);
        this._render3d();
    };

    /** Плоскость текущего среза в вокселях 3D-объёма или null (выключено, нет объёма или среза). */
    StepResult.prototype._slicePlane = function () {
        if (!this.vol3d || (this.e.slice3d && !this.e.slice3d.checked)) return null;
        var i = this.index[this.axis];
        if (i === null || i === undefined || !this.n[this.axis]) return null;
        return {axis: AXIS3D[this.axis], pos: S.vol3d.slicePosition(i, this.vol3d.meta.downsample || 1)};
    };

    /** Плоскость разреза 3D-вида по текущему срезу: {axis (0 — x, 1 — y, 2 — z), pos — доля стороны объёма} или
     *  null (нет объёма или среза). Не зависит от флажка «плоскость среза». */
    StepResult.prototype._clipFromSlice = function () {
        if (!this.vol3d) return null;
        var i = this.index[this.axis];
        if (i === null || i === undefined || !this.n[this.axis]) return null;
        return S.vol3d.clipFromSlice(AXIS3D[this.axis], i, this.vol3d.meta.downsample || 1, this.vol3d.shape);
    };

    /** Срез сменился: оранжевая плоскость и разрез — туда же (сторона разреза остаётся прежней). */
    StepResult.prototype._syncSlicePlane = function () {
        if (!this.view3d || !this.vol3d) return;
        var patch = {slice: this._slicePlane()};
        var c = this._clipFromSlice();
        if (c) {
            this.r3d.clip = Object.assign({}, this.r3d.clip, c);
            patch.clip = {axis: c.axis, pos: c.pos};
        }
        this.view3d.set(patch);
    };

    /** Показать объём в 3D: запросить (если ещё нет или результат новее) и выбрать вид при select. */
    StepResult.prototype.show3d = function (select) {
        var self = this, app = this.app, st = this.st, id = this.id;
        if (!this.r3d || !st.resultDoc) return;
        if (!this.view3d) {
            this.view3d = new S.View3D(ui.$('sv-stage'), {before: app.viewer.svg});
            this.view3d.set(this.r3d);
        }
        var v3 = this.view3d;
        if (!v3.supported()) {
            ui.toast('3D-вид недоступен: ' + (v3.error || 'нет WebGL2') + '.', 'error', 10000);
            return;
        }
        var runId = st.resultDoc.result && st.resultDoc.result.run_id;
        if (this.vol3d && this.vol3d.run_id === runId && app.viewer.has('volume3d')) {
            if (select) app.showView('volume3d');
            return;
        }
        this.ch3d.run(function (signal) {
            return self.api.getBinary('results/' + id + '/volume3d', {max_side: v3.maxSide()},
                {signal: signal, what: 'Объём для 3D'});
        }, true).then(function (img) {
            if (S.api.isStale(img)) return;
            var m = img.meta || {};
            self.vol3d = {run_id: m.run_id || runId, meta: m, shape: [img.k, img.h, img.w]};
            v3.setVolume(img);
            self._syncSlicePlane();
            var first = !app.viewer.has('volume3d');
            app.viewer.show('volume3d', img, {
                kind: 'volume3d', unit: '1/мм', external: v3, hint: v3.hint,
                // вещество образца — 1–2 % вокселей объёма: верх авто-окна по 99,5 % резал бы его (на a82d2e0a
                // 1,03 при веществе 0,85–1,34 1/мм), а «Максимум» вдоль луча почти всегда выше — берём 99,99 %
                autoPercentiles: [0.5, 99.99],
                label: 'Готовый объём в 3D: ' + img.k + ' × ' + img.h + ' × ' + img.w + ', в ' + (m.binning || '?') +
                    ' раз меньше полного по каждой оси' +
                    (m.voxel_mm ? ', воксель ' + core.fmtNum(m.voxel_mm * 1000, 3) + ' мкм' : '')
            }, {select: !!select});
            // при первом показе — окно среза, если его меняли (материал виден так же)
            var rv = app.viewer.get('result');
            if (first && rv && rv.win && rv.win.user && app.viewer.current() === 'volume3d') {
                app.viewer.setWindow(rv.win.lo, rv.win.hi, true);
            }
            self._render3d();
        }, function () { /* показано */ });
    };

    /** Promise<boolean> — есть ли результат. */
    StepResult.prototype.load = function () {
        var self = this, app = this.app;
        app.set({result: 'loading'});
        return this.api.getJSON('results/' + this.id, null, {expect: [404], what: 'Результат'}).then(function (res) {
            self.st.resultDoc = res;
            self._shapeFromDoc();
            app.set({result: 'ready'});
            self.render();
            return true;
        }, function (err) {
            self.st.resultDoc = null;
            app.set({result: err && err.status === 404 ? 'none' : 'error'});
            self.render();
            return false;
        });
    };

    /** Форма копии с наибольшим биннингом (из неё сервис отдаёт срезы). */
    StepResult.prototype._shapeFromDoc = function () {
        var r = this.st.resultDoc && this.st.resultDoc.result;
        var best = null;
        ((r && r.binned) || []).forEach(function (b) {
            if (b && b.shape && b.shape.length === 3 && (!best || (b.factor || 1) > (best.factor || 1))) best = b;
        });
        if (!best) {
            this.n = {z: 0, y: 0, x: 0};
            this.binning = null;
            return;
        }
        this.binning = best.factor || 1;
        var old = this.n;
        this.n = {z: best.shape[0], y: best.shape[1], x: best.shape[2]};
        var self = this;
        AXES.forEach(function (a) {
            var i = self.index[a];
            if (i === null || old[a] !== self.n[a] || i >= self.n[a]) self.index[a] = Math.floor(self.n[a] / 2);
        });
    };

    StepResult.prototype.fetchSlice = function (select, now) {
        var self = this, app = this.app, id = this.id;
        if (!this.st.resultDoc || !this.n[this.axis]) return;
        var axis = this.axis, i = this.index[axis];
        this._syncSlicePlane();
        this.ch.run(function (signal) {
            return self.api.getBinary('results/' + id + '/slice', {axis: axis, i: i}, {signal: signal, what: 'Срез результата'});
        }, now).then(function (img) {
            if (S.api.isStale(img)) return;
            var m = img.meta || {};
            if (m.n && m.n !== self.n[axis]) {
                self.n[axis] = m.n;
                self._renderControls();
            }
            var ds = m.downsample || 1, bin = m.binning || self.binning || 1, vox = m.voxel_mm;
            var names = PLANE[axis];
            app.viewer.show('result', img, {
                kind: 'result', unit: '1/мм', colormap: true, pixel_mm: vox ? vox * ds : null,
                label: 'Готовый объём (копия ×' + bin + '): срез ' + axis + ' = ' + (m.i !== undefined ? m.i : i) + ' из ' +
                    (m.n || self.n[axis]) + (ds > 1 ? ' · уменьшен ×' + ds : ''),
                coords: function (ix, iy) {
                    var cx = ix * ds, cy = iy * ds;
                    var s = names[0] + ' ' + cx + ', ' + names[1] + ' ' + cy + ' (×' + bin + ')';
                    if (bin > 1) s += ' = ' + (cx * bin) + ', ' + (cy * bin) + ' в полном';
                    if (vox) s += ' · ' + core.fmtNum(cx * vox, 3) + ', ' + core.fmtNum(cy * vox, 3) + ' мм';
                    return s;
                }
            }, {select: !!select || app.viewer.current() === 'result'});
        }, function () { /* показано */ });
    };

    // --- отрисовка --------------------------------------------------------------------------------------------

    StepResult.prototype.render = function () {
        var el = this.e.info, st = this.st;
        if (el) {
            ui.clear(el);
            if (st.result === 'loading' && !st.resultDoc) {
                el.appendChild(ui.el('span', {class: 'text-muted', text: 'Загрузка…'}));
            } else if (!st.resultDoc) {
                el.appendChild(ui.el('p', {class: 'text-muted', text: st.result === 'error' ?
                    'Сведения о результате не получены.' :
                    'Результата реконструкции студией ещё нет (прежние результаты — на старой странице).'}));
            } else {
                this._renderDoc(el, st.resultDoc);
            }
        }
        ui.show(this.e.view, !!(st.resultDoc && this.n[this.axis]));
        this._renderControls();
        this._render3d();
        this._renderSwitch();
    };

    StepResult.prototype._renderSwitch = function () {
        var e = this.e;
        if (!e.sw) return;
        ui.show(e.sw, !!(this.st.resultDoc && this.n[this.axis]));
        var cur = this.app.viewer.current();
        var on = cur === 'result' ? 'slice' : cur === 'volume3d' ? '3d' : null;
        ui.qsa('[data-res]', e.sw).forEach(function (b) {
            var act = b.getAttribute('data-res') === on;
            b.classList.toggle('active', act);
            b.classList.toggle('btn-primary', act);
            b.classList.toggle('btn-default', !act);
            if (b.getAttribute('data-res') === '3d') b.disabled = !S.View3D;
        });
    };

    StepResult.prototype._render3d = function () {
        var e = this.e, r = this.r3d, st = this.st;
        ui.show(e.v3d, !!(r && st.resultDoc && this.n[this.axis] && this.app.viewer.current() === 'volume3d'));
        if (!r) return;
        if (e.mode3d) {
            ui.qsa('[data-mode]', e.mode3d).forEach(function (b) {
                var on = b.getAttribute('data-mode') === r.mode;
                b.classList.toggle('active', on);
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-default', !on);
            });
        }
        if (e.gamma) {
            e.gamma.value = r.gamma;
            ui.text(e.gammaVal, core.fmtNum(r.gamma, 2));
        }
        var row = DEPTH_ROWS[r.mode];
        if (e.depth) {
            e.depth.disabled = !row;
            if (row) {
                e.depth.min = row.min;
                e.depth.max = row.max;
                e.depth.step = row.step;
                e.depth.value = r[row.key];
            }
            e.depth.title = row ? row.title : '«Максимум» не использует ни глубину, ни порог';
            ui.text(e.depthLabel, row ? row.label : 'Глубина');
            ui.text(e.depthVal, !row ? '—' : row.percent ? Math.round(r[row.key] * 100) + ' %' :
                core.fmtNum(r[row.key], row.digits));
        }
        if (e.box) e.box.checked = !!r.box;
        if (e.clip) e.clip.checked = !!r.clip.enabled;
        ui.show(e.save3d, !!this.app.config.can_run);
        var v = this.vol3d;
        ui.text(e.info3d, v ? v.shape.join(' × ') + ' (копия ×' + (v.meta.source_binning || '?') +
            (v.meta.downsample > 1 ? ', уменьшена ещё в ' + v.meta.downsample + ' раза' : '') + ')' : '');
    };

    StepResult.prototype._renderDoc = function (el, doc) {
        var r = doc.result || {}, vol = r.volume || {}, api = this.api, id = this.id;
        var dl = ui.el('dl', {class: 'dl-horizontal st-dl'});
        var row = function (k, v) {
            dl.appendChild(ui.el('dt', {text: k}));
            dl.appendChild(ui.el('dd', null, [v]));
        };
        if (vol.shape) row('Объём', vol.shape.join(' × ') + ' (' + (vol.dtype || 'float32') + ', ' + (vol.units || '1/мм') + ')');
        // копии с биннингом (среднее по кубу b×b×b; по умолчанию одна — ×4, как у ноутбука)
        var copies = (r.binned || []).filter(function (b) {
            return b && b.factor && b.shape;
        }).map(function (b) {
            return '×' + b.factor + ': ' + b.shape.join(' × ');
        });
        if (copies.length) row('Биннинг', copies.join('; '));
        if (core.isNum(vol.voxel_mm)) row('Воксель', core.fmtNum(vol.voxel_mm * 1000, 3) + ' мкм');
        row('Создан', core.fmtDate(r.created));
        var t = r.timings || {};
        if (core.isNum(t.total_s)) row('Считался', core.fmtDuration(t.total_s));
        var parts = recipeParts(r.recipe);
        if (parts.length) row('Рецепт', parts.join(' · '));
        el.appendChild(dl);

        if (r.warnings && r.warnings.length) {
            var ul = ui.el('ul', {class: 'st-warnings'});
            r.warnings.forEach(function (w) {
                ul.appendChild(ui.el('li', {text: w}));
            });
            el.appendChild(ul);
        }

        // путь, файлы и прежние запуски — под раскрытием: нужны редко, а переключатель «Срез объёма | 3D»
        // и ось среза должны быть на виду
        var self = this, nFiles = (doc.files || []).length + (doc.history || []).length;
        var more = ui.el('details', {class: 'st-res-more'}, [ui.el('summary', {text: 'Файлы и прежние запуски' +
            (nFiles ? ' (' + nFiles + ')' : '')})]);
        if (this._moreOpen) more.open = true;
        more.addEventListener('toggle', function () {
            self._moreOpen = more.open;
        });
        // путь к полному объёму (скачивается как раньше, мимо сервиса)
        if (vol.file) {
            var path = String(doc.dir || '').replace(/\/+$/, '') + '/' + vol.file;
            var inp = ui.el('input', {class: 'form-control input-sm st-path', readonly: true, value: path,
                title: 'Путь к полному объёму на сервере'});
            var copy = ui.el('button', {type: 'button', class: 'btn btn-default btn-sm', text: 'Копировать'});
            copy.addEventListener('click', function () {
                inp.select();
                var done = function () {
                    ui.toast('Путь скопирован', 'success', 2000);
                };
                if (root.navigator && root.navigator.clipboard && root.isSecureContext) {
                    root.navigator.clipboard.writeText(path).then(done, function () {
                        if (root.document.execCommand('copy')) done();
                    });
                } else if (root.document.execCommand('copy')) {
                    done();
                }
            });
            more.appendChild(ui.el('div', {class: 'st-label', text: 'Полный объём:'}));
            more.appendChild(ui.el('div', {class: 'input-group input-group-sm st-path-group'}, [
                inp, ui.el('span', {class: 'input-group-btn'}, [copy])
            ]));
            var links = fullVolumeLinks(doc, this.app.config.full_volume_url);
            if (links.length) {
                var ful = ui.el('ul', {class: 'st-files'});
                links.forEach(function (f) {
                    var a = ui.el('a', {href: f.href, text: f.name, download: f.name,
                        title: 'Полный объём — через старую раздачу статики (/reconstruct/static), не через сервис'});
                    ful.appendChild(ui.el('li', null, [a, ui.el('span', {class: 'text-muted', text: ' ' +
                        core.fmtBytes(f.size)})]));
                });
                more.appendChild(ful);
            }
        }

        var files = doc.files || [];
        if (files.length) {
            more.appendChild(ui.el('div', {class: 'st-label', text: 'Файлы:'}));
            var fl = ui.el('ul', {class: 'st-files'});
            files.forEach(function (f) {
                var a = ui.el('a', {href: api.url('results/' + id + '/file/' + encodeURIComponent(f.name)), text: f.name,
                    download: f.name});
                fl.appendChild(ui.el('li', null, [a, ui.el('span', {class: 'text-muted', text: ' ' + core.fmtBytes(f.size)})]));
            });
            more.appendChild(fl);
        }

        var hist = doc.history || [];
        if (hist.length) {
            more.appendChild(ui.el('div', {class: 'st-label', text: 'Прежние запуски:'}));
            var hl = ui.el('ul', {class: 'st-history'});
            hist.forEach(function (h) {
                hl.appendChild(ui.el('li', {text: core.fmtDate(h.created) + ' · запуск ' + String(h.run_id || '').slice(0, 8) +
                    (h.recipe_sha256 ? ' · рецепт ' + String(h.recipe_sha256).slice(0, 8) : '') +
                    (h.has_recipe ? '' : ' (без рецепта)')}));
            });
            more.appendChild(hl);
        }
        el.appendChild(more);
    };

    StepResult.prototype._renderControls = function () {
        var e = this.e, axis = this.axis, n = this.n[axis] || 0;
        if (e.sub) {
            var sh = this.n;
            ui.text(e.sub, this.binning ? 'Срезы копии ×' + this.binning + ' (' + sh.z + ' × ' + sh.y + ' × ' + sh.x + '):' :
                'Срезы копии с биннингом:');
        }
        if (e.axes) {
            ui.qsa('[data-axis]', e.axes).forEach(function (b) {
                var on = b.getAttribute('data-axis') === axis;
                b.classList.toggle('active', on);
                b.classList.toggle('btn-primary', on);
                b.classList.toggle('btn-default', !on);
            });
        }
        var i = this.index[axis];
        if (i === null || i === undefined) i = Math.floor(n / 2);
        if (e.slider) {
            e.slider.min = 0;
            e.slider.max = Math.max(0, n - 1);
            e.slider.value = i;
            e.slider.disabled = !n;
        }
        if (e.index) {
            e.index.min = 0;
            e.index.max = Math.max(0, n - 1);
            e.index.value = n ? i : '';
            e.index.disabled = !n;
        }
        ui.text(e.n, n ? 'из ' + n : '');
    };

    StepResult.fullVolumeLinks = fullVolumeLinks;
    S.StepResult = StepResult;
})(typeof window !== 'undefined' ? window : globalThis);
