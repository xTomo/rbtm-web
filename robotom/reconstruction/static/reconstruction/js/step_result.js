/* Студия реконструкции — шаг 5 «Результат».
 *
 * GET results/<id> (404 — результата движка ещё нет): форма объёма, воксель, дата, кратко рецепт (кольца,
 * сглаживание, углы, ось, строки), путь к полному объёму
 * (dir + '/' + result.volume.file — скачивается как раньше), файлы (ссылки api_base + results/<id>/file/<имя>),
 * история запусков; срезы копии ×4 по осям z/y/x с ползунком — GET results/<id>/slice?axis&i.
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

    function StepResult(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.id = app.config.exp_id;
        this.e = {
            info: ui.$('res-info'), view: ui.$('res-view'), axes: ui.$('res-axes'), slider: ui.$('res-slider'),
            index: ui.$('res-index'), n: ui.$('res-n'), show: ui.$('res-show'), sub: ui.$('res-sub')
        };
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
        if (e.show) {
            e.show.addEventListener('click', function () {
                if (app.viewer.has('result')) app.showView('result');
                else self.fetchSlice(true, true);
            });
        }
        app.jobs.on('finished', function (job) {
            if (job.status !== 'done') return;
            self.load().then(function (ok) {
                if (ok && (app.viewer.current() === 'result' || app.viewer.has('result'))) {
                    self.fetchSlice(app.viewer.current() === 'result', true);
                }
            });
        });
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
                kind: 'result', unit: '1/мм',
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
        var rc = r.recipe || {};
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
        if (parts.length) row('Рецепт', parts.join(' · '));
        el.appendChild(dl);

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
            el.appendChild(ui.el('div', {class: 'st-label', text: 'Полный объём:'}));
            el.appendChild(ui.el('div', {class: 'input-group input-group-sm st-path-group'}, [
                inp, ui.el('span', {class: 'input-group-btn'}, [copy])
            ]));
        }

        if (r.warnings && r.warnings.length) {
            var ul = ui.el('ul', {class: 'st-warnings'});
            r.warnings.forEach(function (w) {
                ul.appendChild(ui.el('li', {text: w}));
            });
            el.appendChild(ul);
        }

        var files = doc.files || [];
        if (files.length) {
            el.appendChild(ui.el('div', {class: 'st-label', text: 'Файлы:'}));
            var fl = ui.el('ul', {class: 'st-files'});
            files.forEach(function (f) {
                var a = ui.el('a', {href: api.url('results/' + id + '/file/' + encodeURIComponent(f.name)), text: f.name,
                    download: f.name});
                fl.appendChild(ui.el('li', null, [a, ui.el('span', {class: 'text-muted', text: ' ' + core.fmtBytes(f.size)})]));
            });
            el.appendChild(fl);
        }

        var hist = doc.history || [];
        if (hist.length) {
            el.appendChild(ui.el('div', {class: 'st-label', text: 'Прежние запуски:'}));
            var hl = ui.el('ul', {class: 'st-history'});
            hist.forEach(function (h) {
                hl.appendChild(ui.el('li', {text: core.fmtDate(h.created) + ' · запуск ' + String(h.run_id || '').slice(0, 8) +
                    (h.recipe_sha256 ? ' · рецепт ' + String(h.recipe_sha256).slice(0, 8) : '') +
                    (h.has_recipe ? '' : ' (без рецепта)')}));
            });
            el.appendChild(hl);
        }
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

    S.StepResult = StepResult;
})(typeof window !== 'undefined' ? window : globalThis);
