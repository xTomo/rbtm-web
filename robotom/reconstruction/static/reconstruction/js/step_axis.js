/* Студия реконструкции — шаг 2 «Ось вращения» (после загрузки области).
 *
 * POST sessions/<sid>/axis/auto → центр (столбец детектора на строке y_ref), наклон, углы пары 0°/180°
 * (только показ; уточнение сеткой центров — этап 4). Превью среза GET sessions/<sid>/slice?row&rings&angles&seq —
 * канал «последний выигрывает» с задержкой 250 мс; строка превью — в пределах загруженной рамки.
 * Вспомогательный вид «0° − 180°» — GET sessions/<sid>/axis/diff?row&seq. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var RINGS_TEXT = {off: 'без подавления колец', weak: 'кольца: слабо', medium: 'кольца: средне',
        strong: 'кольца: сильно'};
    var ANGLES_TEXT = {first_180: 'первые 180°', full_halves: 'все полуобороты'};
    var PREVIEW_EXPECT = ['not_found', 'taken_over', 'forbidden', 'not_ready'];

    function StepAxis(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.e = {
            info: ui.$('axis-info'), row: ui.$('axis-row'), slice: ui.$('axis-slice'), diff: ui.$('axis-diff'),
            ok: ui.$('axis-ok'), auto: ui.$('axis-auto'), sliceInfo: ui.$('axis-slice-info'),
            pairWarn: ui.$('axis-pair-warn')
        };
        this.sliceCh = this.api.channel({
            delay: 250,
            onBusy: function (b) {
                app.viewer.setBusy('slice', b, 'Срез…');
            }
        });
        this.diffCh = this.api.channel({
            onBusy: function (b) {
                app.viewer.setBusy('diff', b, '0° − 180°…');
            }
        });
        this._bind();
        this.render();
    }

    StepAxis.prototype._bind = function () {
        var self = this, app = this.app, e = this.e, bus = app.bus;
        bus.on('loaded', function (s) {
            if (s && s.axis) {
                // сессия уже знает ось (страницу открыли заново) — не пересчитывать
                self.st.axisInfo = {axis: s.axis};
                app.set({axis: 'auto'});
                self.render();
                self.refreshSlice(true, true);
            } else {
                self.runAuto();
            }
        });
        bus.on('load-start', function () {
            self.reset();
        });
        bus.on('lost', function () {
            self.sliceCh.cancel();
            self.diffCh.cancel();
            self.render();
        });
        bus.on('state', function () {
            self._renderButtons();
        });
        bus.on('row', function (row, source, changed) {
            if (e.row) e.row.value = row;
            if (changed) self.refreshSlice(source === 'axis');
            self._syncDiffOverlay();
        });
        bus.on('rings', function () {
            self.refreshSlice(true);
        });
        bus.on('angles', function () {
            self.refreshSlice(true);
        });
        bus.on('info', function () {
            self.render();
        });
        bus.on('view', function (key) {
            if (key === 'diff') self._diffOverlay();
        });
        if (e.row) {
            e.row.addEventListener('change', function () {
                var v = core.parseNum(e.row.value);
                if (!core.isNum(v)) v = self.st.row;
                var lr = self.st.loadedRoi;
                if (lr) v = core.clamp(Math.round(v), lr.y0, lr.y1 - 1);
                app.setRow(v, 'axis');
            });
        }
        if (e.slice) {
            e.slice.addEventListener('click', function () {
                if (app.viewer.has('slice')) app.showView('slice');
                else self.refreshSlice(true, true);
            });
        }
        if (e.diff) {
            e.diff.addEventListener('click', function () {
                self.diff();
            });
        }
        if (e.ok) {
            e.ok.addEventListener('click', function () {
                if (self.st.axisInfo) app.set({axis: 'checked'});
                self.render();
            });
        }
        if (e.auto) {
            e.auto.addEventListener('click', function () {
                self.runAuto();
            });
        }
    };

    /** Новая загрузка области: прежняя ось и превью больше не относятся к данным. */
    StepAxis.prototype.reset = function () {
        this.sliceCh.cancel();
        this.diffCh.cancel();
        this.st.axisInfo = null;
        this.st.sliceMeta = null;
        this.app.set({axis: 'none'});
        var cur = this.app.viewer.current();
        if ((cur === 'slice' || cur === 'diff') && this.app.viewer.has('envelope')) this.app.showView('envelope');
        this.app.viewer.drop('slice');
        this.app.viewer.drop('diff');
        this.render();
    };

    StepAxis.prototype.runAuto = function () {
        var self = this, app = this.app;
        if (!app.ready()) return;
        var sid = app.sid();
        app.set({axis: 'running'});
        this.render();
        app.viewer.setBusy('axis', true, 'Авто-ось…');
        this.api.postJSON('sessions/' + sid + '/axis/auto', {}, {expect: PREVIEW_EXPECT, what: 'Авто-ось'})
            .then(function (res) {
                app.viewer.setBusy('axis', false);
                if (sid !== app.sid()) return;
                self.st.axisInfo = res;
                app.set({axis: 'auto'});
                self.render();
                self.refreshSlice(true, true);
                app.bus.emit('axis', res);
            }, function (err) {
                app.viewer.setBusy('axis', false);
                if (app.session.handleError(err)) return;
                app.set({axis: err && err.code === 'not_ready' ? 'none' : 'error'});
                if (err && err.code !== 'not_ready') app.api.report(err, 'Авто-ось');
                self.render();
            });
    };

    /** Превью среза текущей строки; select — показать вид «Срез»; now — без задержки. */
    StepAxis.prototype.refreshSlice = function (select, now) {
        var self = this, app = this.app, st = this.st;
        if (!app.ready() || st.axis === 'running') return;
        var sid = app.sid(), row = st.row, rings = st.rings, angles = st.angles;
        this.sliceCh.run(function (signal, seq) {
            return self.api.getBinary('sessions/' + sid + '/slice', {row: row, rings: rings, angles: angles, seq: seq},
                {signal: signal, expect: PREVIEW_EXPECT, what: 'Срез'});
        }, now).then(function (img) {
            if (S.api.isStale(img) || sid !== app.sid()) return;
            st.sliceMeta = img.meta;
            var m = img.meta || {};
            var ds = m.downsample || 1;
            var reg = m.region || [0, 0, img.w * ds, img.h * ds];
            var label = 'Срез строки ' + row + ' · ' + (RINGS_TEXT[rings] || rings) + ' · ' +
                (ANGLES_TEXT[angles] || angles) + (m.n_angles ? ' (' + m.n_angles + ' углов)' : '') +
                (ds > 1 ? ' · уменьшен ×' + ds : '');
            app.viewer.show('slice', img, {
                kind: 'slice', unit: '1/мм', label: label,
                coords: function (ix, iy) {
                    return 'срез x ' + (reg[0] + ix * ds) + ', y ' + (reg[1] + iy * ds);
                }
            }, {select: !!select || app.viewer.current() === 'slice'});
            self._renderSliceInfo();
            app.bus.emit('slice', img);
        }, function (err) {
            app.previewError(err, 'Срез');
        });
    };

    StepAxis.prototype.diff = function () {
        var self = this, app = this.app, st = this.st;
        if (!app.ready()) return;
        var sid = app.sid(), row = st.row;
        this.diffCh.run(function (signal, seq) {
            return self.api.getBinary('sessions/' + sid + '/axis/diff', {row: row, seq: seq},
                {signal: signal, expect: PREVIEW_EXPECT, what: '0° − 180°'});
        }).then(function (img) {
            if (S.api.isStale(img) || sid !== app.sid()) return;
            var lr = st.loadedRoi || {x0: 0, y0: 0};
            var ds = (img.meta && img.meta.downsample) || 1;
            st.diffDs = ds;
            app.viewer.show('diff', img, {
                kind: 'diff', unit: '',
                label: 'Кадр 0° − отражённый кадр 180° при текущей оси: при верной оси контуры гасятся' +
                    (ds > 1 ? ' · уменьшен ×' + ds : ''),
                coords: function (ix, iy) {
                    return 'кадр x ' + (lr.x0 + ix * ds) + ', y ' + (lr.y0 + iy * ds);
                }
            }, {select: true});
            self._diffOverlay();
        }, function (err) {
            app.previewError(err, '0° − 180°');
        });
    };

    /** Линия строки превью на виде «0° − 180°» (только показ). */
    StepAxis.prototype._diffOverlay = function () {
        var app = this.app, st = this.st, v = app.viewer.get('diff');
        if (app.viewer.current() !== 'diff' || !v || !v.img || !st.loadedRoi) return;
        var ds = st.diffDs || 1;
        app.overlay.set([{id: 'row', type: 'hline', editable: false, y: (st.row - st.loadedRoi.y0 + 0.5) / ds,
            x0: 0, x1: v.img.w, label: 'строка ' + st.row}]);
    };

    StepAxis.prototype._syncDiffOverlay = function () {
        var app = this.app, st = this.st;
        if (app.viewer.current() !== 'diff' || !st.loadedRoi || !app.overlay.get('row')) return;
        var ds = st.diffDs || 1;
        app.overlay.update('row', {y: (st.row - st.loadedRoi.y0 + 0.5) / ds, label: 'строка ' + st.row});
    };

    // --- отрисовка --------------------------------------------------------------------------------------------

    StepAxis.prototype.render = function () {
        var st = this.st, e = this.e;
        if (e.info) {
            ui.clear(e.info);
            var a = st.axisInfo && st.axisInfo.axis;
            if (!a) {
                e.info.appendChild(ui.el('span', {class: 'text-muted', text: st.axis === 'running' ?
                    'Поиск оси по паре кадров 0°/180°…' : 'Ось найдётся автоматически после загрузки области.'}));
            } else {
                var dl = ui.el('dl', {class: 'dl-horizontal st-dl'});
                var row = function (k, v) {
                    dl.appendChild(ui.el('dt', {text: k}));
                    dl.appendChild(ui.el('dd', {text: v}));
                };
                row('Центр', core.fmtNum(a.center_x, 2) + ' px (столбец кадра на строке ' + core.fmtNum(a.y_ref, 0) + ')');
                row('Наклон', core.fmtNum(a.tilt_deg, 3) + '°');
                var pair = st.axisInfo.pair;
                if (pair && pair.angles) {
                    row('Пара', core.fmtNum(pair.angles[0], 2) + '° / ' + core.fmtNum(pair.angles[1], 2) + '°');
                }
                if (core.isNum(st.axisInfo.seconds)) row('Поиск', core.fmtNum(st.axisInfo.seconds, 1) + ' с');
                e.info.appendChild(dl);
            }
        }
        var info = st.info;
        if (e.pairWarn) {
            var noPair = info && info.pair_0_180 === false;
            ui.show(e.pairWarn, noPair);
            ui.text(e.pairWarn, noPair ? 'В скане нет пары кадров 0°/180° — авто-ось не найдётся.' : '');
        }
        if (e.row && st.loadedRoi) {
            e.row.min = st.loadedRoi.y0;
            e.row.max = st.loadedRoi.y1 - 1;
        }
        if (e.row && st.row !== null && st.row !== undefined) e.row.value = st.row;
        this._renderSliceInfo();
        this._renderButtons();
    };

    StepAxis.prototype._renderSliceInfo = function () {
        var el = this.e.sliceInfo, m = this.st.sliceMeta;
        if (!el) return;
        if (!m || !this.app.ready()) {
            ui.text(el, '');
            return;
        }
        var t = m.timings || {};
        var parts = ['срез строки ' + m.row];
        if (core.isNum(t.total_s)) parts.push(core.fmtNum(t.total_s, 2) + ' с');
        if (m.n_angles) parts.push(m.n_angles + ' углов');
        if (m.downsample > 1) parts.push('показан уменьшенным ×' + m.downsample);
        ui.text(el, parts.join(' · '));
    };

    StepAxis.prototype._renderButtons = function () {
        var app = this.app, st = this.st, e = this.e;
        var ready = app.ready();
        var why = !app.config.can_run ? 'Доступно экспериментатору и администратору' :
            'Сначала загрузите область (шаг 1)';
        ui.enable(e.row, ready, why);
        ui.enable(e.slice, ready && st.axis !== 'running', why);
        ui.enable(e.diff, ready && st.axis !== 'running', why);
        ui.enable(e.auto, ready && st.axis !== 'running', why);
        ui.enable(e.ok, ready && (st.axis === 'auto'), st.axis === 'checked' ? 'Уже отмечено' : why);
    };

    S.StepAxis = StepAxis;
})(typeof window !== 'undefined' ? window : globalThis);
