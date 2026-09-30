/* Студия реконструкции — шаг 1 «Поле зрения».
 *
 * GET scans/<id>/info (форма, кадры, углы, размер пикселя) и scans/<id>/overview (предложенная рамка в
 * координатах полного кадра, bin, углы выборки); огибающая scans/<id>/envelope (уменьшена в bin раз) с рамкой и
 * линией строки превью; поля x0, x1, y0, y1, строка — синхронно с рамкой; лента углов scans/<id>/thumbs;
 * после правки рамки (задержка 300 мс) — scans/<id>/outside → углы, где объект выходит за рамку.
 * Синограмма строки — scans/<id>/sinogram?row. «Загрузить область» — сессия (session.js), прогресс, отмена.
 * После обзора — POST scans/<id>/prefetch: пока человек выбирает рамку, сервис читает исходный файл (HDD) в кэш ОС.
 * Правка рамки после загрузки — шаги 2–4 «устарело» (roiDirty), нужна повторная загрузка. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var PS_SOURCES = {
        user: 'задан вручную', mongo: 'документ эксперимента', detector: 'модель детектора',
        hdf5: 'метаданные HDF5', 'default': 'значение по умолчанию'
    };
    var LOAD_STAGES = {
        queued: 'в очереди', crop: 'чтение кадров', dark_empty: 'опорные кадры', repositioning: 'сдвиги образца',
        ready: 'готово', canceling: 'отмена…', canceled: 'отменена', error: 'ошибка'
    };
    var FOV_VIEWS = ['envelope', 'sample', 'sinogram'];

    function roiOf(r) {
        return r ? {x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1} : null;
    }

    function StepFov(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.id = app.config.exp_id;
        this.restoring = false;
        this.loadT0 = null;
        this.loadMsg = '';
        this.e = {
            info: ui.$('fov-info'), x0: ui.$('fov-x0'), x1: ui.$('fov-x1'), y0: ui.$('fov-y0'), y1: ui.$('fov-y1'),
            row: ui.$('fov-row'), size: ui.$('fov-size'), outside: ui.$('fov-outside'), ps: ui.$('fov-ps'),
            psSrc: ui.$('fov-ps-src'), psWarn: ui.$('fov-ps-warn'), sino: ui.$('fov-sino'), reset: ui.$('fov-reset'),
            load: ui.$('fov-load'), cancel: ui.$('fov-cancel'), progress: ui.$('fov-progress'),
            loadMsg: ui.$('fov-load-msg'), dirty: ui.$('fov-dirty'), dataWarn: ui.$('fov-data-warn')
        };
        this.dataWarnings = [];
        this.outsideCh = this.api.channel({delay: 300});
        this.sinoCh = this.api.channel({
            onBusy: function (b) {
                app.viewer.setBusy('sino', b, 'Синограмма строки… (≈ 8 с)');
                if (self.e.sino) self.e.sino.classList.toggle('st-busy', b);
            }
        });
        this._bind();
        this._tick = setInterval(function () {
            if (self.st.load === 'loading') self._renderLoad();
        }, 1000);
    }

    // --- запуск -----------------------------------------------------------------------------------------------

    /** Сведения и обзор скана; Promise — обзор применён (или не получен). */
    StepFov.prototype.start = function () {
        var self = this, app = this.app, api = this.api, id = this.id;
        app.set({overview: 'loading'});
        app.viewer.placeholder('envelope', 'Загрузка обзора скана… (первый раз — несколько секунд)');
        app.viewer.select('envelope');
        app.thumbs.message('Миниатюры углов появятся после обзора.');
        api.getJSON('scans/' + id + '/info', null, {what: 'Сведения о скане'}).then(function (info) {
            self.st.info = info;
            if (info.pixel_size && !self.st.pixelSize) self.st.pixelSize = info.pixel_size;
            self._renderInfo();
            self._renderSize();
            self._renderPs();
            app.bus.emit('info', info);
        }, function () {
            ui.text(self.e.info, 'Сведения о скане не получены.');
        });
        return api.getJSON('scans/' + id + '/overview', null, {what: 'Обзор скана'}).then(function (ov) {
            self._applyOverview(ov);
            self._loadEnvelope();
            self._prefetch();
            return ov;
        }, function (err) {
            app.set({overview: 'error'});
            app.viewer.placeholder('envelope', 'Обзор скана не получен: ' + S.api.describe(err));
            app.thumbs.message('');
            return null;
        });
    };

    /** Исходный файл — в кэш ОС, пока выбирается рамка: «Загрузить область» потом дочитывает с диска только остаток.
     *  Только тем, кто может загружать, и пока область не загружена; сервис сам останавливает чтение при загрузке. */
    StepFov.prototype._prefetch = function () {
        var app = this.app;
        if (!app.config.can_run || app.state.load === 'loading' || app.state.load === 'ready') return;
        this.api.postJSON('scans/' + this.id + '/prefetch', {}, {quiet: true}).catch(function () {});
    };

    StepFov.prototype._applyOverview = function (ov) {
        var st = this.st;
        st.ov = ov;
        st.bin = ov.bin || 1;
        st.frame = {H: ov.full_shape[0], W: ov.full_shape[1]};
        if (ov.pixel_size) st.pixelSize = ov.pixel_size;
        var roi = core.clampRoi(ov.roi, st.frame.W, st.frame.H);
        st.roiSuggested = roi;
        st.rowSuggested = core.clampRow(ov.roi.preview_row, roi);
        st.sampleAngles = ov.sample_angles || [];
        // углы, где объект выходит за предложенную рамку, → индексы выборки
        var out = ov.angles_outside || [];
        st.outsideIdx = [];
        st.sampleAngles.forEach(function (a, k) {
            if (out.indexOf(a) >= 0) st.outsideIdx.push(k);
        });
        st.outsideAngles = out.slice();
        this.app.set({overview: 'ready'});
        if (!st.roi) {
            st.roi = roi;
            st.row = null;          // _roiChanged возьмёт предложенную строку и разошлёт событие 'row'
        }
        this._roiChanged('overview', true);
        this._renderOutside();
        this._renderPs();
    };

    StepFov.prototype._loadEnvelope = function () {
        var self = this, app = this.app, id = this.id;
        return this.api.getBinary('scans/' + id + '/envelope', null, {what: 'Огибающая'}).then(function (img) {
            var n = self.st.sampleAngles.length;
            app.viewer.show('envelope', img, self._projDesc('Огибающая max(−ln T) по ' + n + ' углам выборки'));
            if (app.viewer.current() === 'envelope') self._overlayFor('envelope');
            return self._loadThumbs();
        }, function (err) {
            app.viewer.placeholder('envelope', 'Огибающая не получена: ' + S.api.describe(err));
        });
    };

    StepFov.prototype._loadThumbs = function () {
        var self = this, app = this.app;
        app.thumbs.message('Загрузка миниатюр углов…');
        return this.api.getBinary('scans/' + this.id + '/thumbs', null, {what: 'Миниатюры углов'}).then(function (stack) {
            var st = self.st;
            st.thumbsStack = stack;
            var angles = (stack.meta && stack.meta.angles) || st.sampleAngles;
            app.thumbs.setStack(stack, angles, st.bin);
            app.thumbs.setRoi(st.roi);
            app.thumbs.setOutside(st.outsideIdx);
            app.bus.emit('thumbs', stack);
        }, function () {
            app.thumbs.message('Миниатюры углов не получены.');
        });
    };

    /** Описание вида проекции (огибающая, кадр угла): значения −ln T, координаты полного кадра. */
    StepFov.prototype._projDesc = function (label) {
        var bin = this.st.bin;
        return {
            kind: 'proj', unit: '−ln T', label: label,
            coords: function (ix, iy) {
                return 'кадр x ' + (ix * bin) + ', y ' + (iy * bin) + (bin > 1 ? ' (пиксель ×' + bin + ')' : '');
            }
        };
    };

    // --- события ----------------------------------------------------------------------------------------------

    StepFov.prototype._bind = function () {
        var self = this, app = this.app, e = this.e;
        ['x0', 'x1', 'y0', 'y1'].forEach(function (k) {
            if (!e[k]) return;
            e[k].addEventListener('change', function () {
                self._onRoiInput();
            });
        });
        if (e.row) {
            e.row.addEventListener('change', function () {
                var v = core.parseNum(e.row.value);
                if (!core.isNum(v)) v = self.st.row;
                app.setRow(v, 'fov');
            });
        }
        if (e.ps) {
            e.ps.addEventListener('change', function () {
                self._onPsInput();
            });
        }
        if (e.sino) {
            e.sino.addEventListener('click', function () {
                self.sinogram();
            });
        }
        if (e.reset) {
            e.reset.addEventListener('click', function () {
                var st = self.st;
                if (!st.roiSuggested) return;
                st.roi = roiOf(st.roiSuggested);
                self._roiChanged('reset', true);
                app.setRow(st.rowSuggested, 'fov');
            });
        }
        if (e.load) {
            e.load.addEventListener('click', function () {
                self.load();
            });
        }
        if (e.cancel) {
            e.cancel.addEventListener('click', function () {
                app.session.cancelLoad().catch(function () { /* показано */ });
            });
        }

        app.overlay.on('drag', function (id, g) {
            self._onShape(id, g, false);
        });
        app.overlay.on('commit', function (id, g) {
            self._onShape(id, g, true);
        });
        app.thumbs.on('select', function (k) {
            self.showSample(k);
        });
        app.bus.on('view', function (key) {
            if (FOV_VIEWS.indexOf(key) >= 0) self._overlayFor(key);
        });
        app.bus.on('row', function (row) {
            if (e.row) e.row.value = row;       // и после неверного ввода — показать принятое значение
            self._syncOverlay();
        });
        app.bus.on('state', function () {
            self._renderLoad();
        });
        app.session.on('state', function (s) {
            self._onSession(s);
        });
        app.session.on('lost', function (err) {
            self._onLost(err);
        });
    };

    StepFov.prototype._onRoiInput = function () {
        var st = this.st, e = this.e;
        if (!st.frame || !st.roi) return;
        var v = {};
        ['x0', 'x1', 'y0', 'y1'].forEach(function (k) {
            var n = core.parseNum(e[k].value);
            v[k] = core.isNum(n) ? n : st.roi[k];
        });
        st.roi = core.clampRoi(v, st.frame.W, st.frame.H);
        this._roiChanged('input', true);
    };

    StepFov.prototype._onShape = function (id, g, commit) {
        var st = this.st, key = this.app.viewer.current();
        if (!st.frame || !st.roi) return;
        if (key === 'envelope' || key === 'sample') {
            if (id === 'roi') {
                st.roi = core.roiFromImage(g, st.bin, st.frame.W, st.frame.H);
                this._roiChanged('overlay', commit);
            } else if (id === 'row') {
                this.app.setRow(Math.round(g.y * st.bin - 0.5), 'fov');
            }
        } else if (key === 'sinogram' && id === 'roi') {
            st.roi = core.clampRoi({x0: g.x0, x1: g.x1, y0: st.roi.y0, y1: st.roi.y1}, st.frame.W, st.frame.H);
            this._roiChanged('overlay', commit);
        }
    };

    /** Рамка изменилась (st.roi уже новая): поля, наложение, миниатюры, размер, устаревание, проверка выхода. */
    StepFov.prototype._roiChanged = function (source, commit) {
        var st = this.st, app = this.app;
        var roi = st.roi;
        var e = this.e;
        ['x0', 'x1', 'y0', 'y1'].forEach(function (k) {
            if (e[k]) {
                e[k].value = roi[k];
                e[k].max = k.charAt(0) === 'x' ? st.frame.W : st.frame.H;
            }
        });
        if (e.row) {
            e.row.min = roi.y0;
            e.row.max = roi.y1 - 1;
        }
        var row = core.clampRow(st.row === null || st.row === undefined ? st.rowSuggested : st.row, roi);
        app.thumbs.setRoi(roi);
        this._renderSize();
        var dirty = !!(st.loadedRoi && (st.load === 'ready') && !core.sameRoi(roi, st.loadedRoi));
        app.set({roiEdited: !core.sameRoi(roi, st.roiSuggested), roiDirty: dirty});
        if (row !== st.row) app.setRow(row, 'fov');
        else this._syncOverlay();
        app.bus.emit('roi', roi, source);
        if (source !== 'overview' || commit) this._checkOutside();
    };

    StepFov.prototype._checkOutside = function () {
        var self = this, st = this.st, id = this.id;
        var roi = roiOf(st.roi);
        if (!roi) return;
        if (st.roiSuggested && core.sameRoi(roi, st.roiSuggested) && st.ov) {
            // для предложенной рамки ответ уже есть в обзоре
            this.outsideCh.cancel();
            var out = st.ov.angles_outside || [];
            st.outsideAngles = out.slice();
            st.outsideIdx = [];
            (st.sampleAngles || []).forEach(function (a, k) {
                if (out.indexOf(a) >= 0) st.outsideIdx.push(k);
            });
            this._applyOutside();
            return;
        }
        this.outsideCh.run(function (signal) {
            return self.api.getJSON('scans/' + id + '/outside', roi, {signal: signal, what: 'Проверка рамки'});
        }).then(function (res) {
            if (S.api.isStale(res) || !res) return;
            st.outsideIdx = res.indices || [];
            st.outsideAngles = res.angles_outside || [];
            self._applyOutside();
        }, function () { /* показано */ });
    };

    StepFov.prototype._applyOutside = function () {
        this.app.thumbs.setOutside(this.st.outsideIdx);
        this._renderOutside();
        this._syncOverlay();
    };

    StepFov.prototype._onPsInput = function () {
        var st = this.st, e = this.e;
        var v = core.parseNum(e.ps.value);
        if (!(v > 0 && v <= 10)) {
            ui.toast('Размер пикселя: нужно число мм, больше 0 (например 0,00425)', 'warning');
            this._renderPs();
            return;
        }
        var base = st.pixelSize ? st.pixelSize.value_mm : null;
        st.pixelUser = base !== null && Math.abs(v - base) <= 1e-12 ? null : v;
        this._renderPs();
        this.app.bus.emit('recipe-params');
    };

    // --- виды: кадр угла, синограмма, наложение ---------------------------------------------------------------

    StepFov.prototype.showSample = function (k) {
        var st = this.st, app = this.app;
        if (!st.thumbsStack) return;
        var frame = core.frameOf(st.thumbsStack, k);
        var a = st.sampleAngles[k];
        st.sampleK = k;
        var label = 'Кадр угла ' + core.fmtNum(a, 2) + '° (' + (k + 1) + ' из ' + st.thumbsStack.k + '), −ln T';
        app.viewer.show('sample', frame, this._projDesc(label), {select: true});
        app.thumbs.select(k);
        app.bus.emit('sample', k, a);
        this._overlayFor('sample');
    };

    StepFov.prototype.sinogram = function () {
        var self = this, st = this.st, app = this.app, id = this.id;
        if (st.row === null || st.row === undefined) return;
        var row = st.row;
        this.sinoCh.run(function (signal) {
            return self.api.getBinary('scans/' + id + '/sinogram', {row: row}, {signal: signal, what: 'Синограмма'});
        }).then(function (img) {
            if (S.api.isStale(img)) return;
            var angles = (img.meta && img.meta.angles) || [];
            // строк (углов) мало, столбцов тысячи — вытянуть по вертикали, чтобы вид был читаем
            var aspect = Math.max(1, 0.45 * img.w / Math.max(1, img.h));
            st.sinoRow = row;
            app.viewer.show('sinogram', img, {
                kind: 'sino', unit: '−ln T', aspect: aspect,
                label: 'Синограмма строки ' + row + ' (' + img.h + ' углов; рамка — столбцы x0…x1)',
                coords: function (ix, iy) {
                    var a = angles[iy];
                    return 'столбец ' + ix + ', угол ' + (a !== undefined ? core.fmtNum(a, 2) + '°' : '#' + iy);
                }
            }, {select: true});
            self._overlayFor('sinogram');
        }, function () { /* показано */ });
    };

    StepFov.prototype._overlayFor = function (key) {
        var st = this.st, app = this.app, v = app.viewer.get(key);
        if (!v || !v.img || !st.roi || !st.frame || app.viewer.current() !== key) return;
        var roi = st.roi, b = st.bin, min = core.ROI_MIN;
        var label = (roi.x1 - roi.x0) + '×' + (roi.y1 - roi.y0);
        if (key === 'envelope' || key === 'sample') {
            var r = core.roiToImage(roi, b);
            var warn = key === 'sample' && st.outsideIdx.indexOf(st.sampleK) >= 0;
            app.overlay.set([
                {id: 'roi', type: 'rect', x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1,
                    bounds: {x0: 0, y0: 0, x1: st.frame.W / b, y1: st.frame.H / b},
                    minW: min / b, minH: min / b, warn: warn, label: label},
                {id: 'row', type: 'hline', y: (st.row + 0.5) / b, x0: r.x0, x1: r.x1,
                    ymin: (roi.y0 + 0.5) / b, ymax: (roi.y1 - 0.5) / b, label: 'строка ' + st.row}
            ]);
        } else if (key === 'sinogram') {
            app.overlay.set([
                {id: 'roi', type: 'rect', axes: 'x', x0: roi.x0, x1: roi.x1, y0: 0, y1: v.img.h,
                    bounds: {x0: 0, y0: 0, x1: st.frame.W, y1: v.img.h}, minW: min, minH: 0,
                    label: 'x ' + roi.x0 + '…' + roi.x1}
            ]);
        }
    };

    /** Обновить наложение текущего вида шага (без пересоздания — можно во время перетаскивания). */
    StepFov.prototype._syncOverlay = function () {
        var st = this.st, app = this.app, key = app.viewer.current();
        if (FOV_VIEWS.indexOf(key) < 0 || !st.roi) return;
        if (!app.overlay.get('roi')) {
            this._overlayFor(key);
            return;
        }
        var roi = st.roi, b = st.bin;
        var label = (roi.x1 - roi.x0) + '×' + (roi.y1 - roi.y0);
        if (key === 'sinogram') {
            app.overlay.update('roi', {x0: roi.x0, x1: roi.x1, label: 'x ' + roi.x0 + '…' + roi.x1});
            return;
        }
        var r = core.roiToImage(roi, b);
        app.overlay.update('roi', {x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, label: label,
            warn: key === 'sample' && st.outsideIdx.indexOf(st.sampleK) >= 0});
        app.overlay.update('row', {y: (st.row + 0.5) / b, x0: r.x0, x1: r.x1, ymin: (roi.y0 + 0.5) / b,
            ymax: (roi.y1 - 0.5) / b, label: 'строка ' + st.row});
    };

    // --- загрузка области -------------------------------------------------------------------------------------

    StepFov.prototype.load = function () {
        var self = this, st = this.st, app = this.app;
        if (!app.config.can_run || !st.roi) return;
        var roi = {x0: st.roi.x0, x1: st.roi.x1, y0: st.roi.y0, y1: st.roi.y1, preview_row: st.row};
        var ask = Promise.resolve(true);
        if (st.outsideIdx && st.outsideIdx.length) {
            ask = ui.confirm('Объект выходит за рамку',
                'На ' + st.outsideIdx.length + ' из ' + st.sampleAngles.length + ' углов выборки объект выходит за ' +
                'столбцы рамки — на срезах будут артефакты. Всё равно загрузить?', 'Загрузить', 'btn-warning');
        }
        ask.then(function (ok) {
            if (!ok) return;
            self.loadMsg = '';
            ui.enable(self.e.load, false);
            app.session.load(roi).then(function () {
                self._renderLoad();
            }, function (err) {
                if (err && err.silent) {
                    self._renderLoad();
                    return;
                }
                self.loadMsg = 'Загрузка не начата: ' + S.api.describe(err);
                self._renderLoad();
            });
        });
    };

    StepFov.prototype.restoreSession = function () {
        var self = this;
        this.restoring = true;
        return this.app.session.restore().then(function (s) {
            self.restoring = false;
            return s;
        }, function () {
            self.restoring = false;
            return null;
        });
    };

    StepFov.prototype._onSession = function (s) {
        var st = this.st, app = this.app;
        var prev = st.load;
        if (this.restoring && s.roi && st.frame && (s.state === 'ready' || s.state === 'loading')) {
            // открыли страницу заново — рамка и строка загруженной области
            st.roi = core.clampRoi(s.roi, st.frame.W, st.frame.H);
            st.row = core.clampRow(s.roi.preview_row, st.roi);
            this._roiChanged('session', true);
            app.setRow(st.row, 'session');
        }
        if (s.pixel_size && !st.pixelSize) st.pixelSize = s.pixel_size;
        if (s.state === 'loading') {
            if (prev !== 'loading') {
                this.loadT0 = Date.now();
                this.loadMsg = '';
                this.dataWarnings = [];
                st.loadedRoi = null;
                app.set({load: 'loading', roiDirty: false});
                app.bus.emit('load-start');
            }
            st.loadProgress = s.progress;
            st.loadStage = s.stage;
        } else if (s.state === 'ready') {
            var loaded = roiOf(s.roi);
            var fresh = prev !== 'ready' || !core.sameRoi(st.loadedRoi, loaded);
            st.loadedRoi = loaded;
            // предупреждения по данным (проверка контрольных кадров advanced-скана, сдвиги образца)
            this.dataWarnings = (s.warnings || []).slice();
            if (fresh) {
                var took = this.loadT0 ? (Date.now() - this.loadT0) / 1000 : null;
                this.loadMsg = took !== null ? 'Область загружена за ' + core.fmtDuration(took) + '.' : '';
                this.loadT0 = null;
            }
            app.set({load: 'ready', roiDirty: !core.sameRoi(st.roi, loaded)});
            if (fresh) app.bus.emit('loaded', s);
        } else if (s.state === 'error') {
            this.loadT0 = null;
            this.loadMsg = 'Ошибка загрузки: ' + (s.error || 'неизвестная ошибка');
            app.set({load: 'error', roiDirty: false});
        } else if (s.state === 'open') {
            this.loadT0 = null;
            if (s.stage === 'canceled') this.loadMsg = 'Загрузка отменена.';
            if (prev === 'loading' || prev === 'ready') app.set({load: 'none', roiDirty: false});
        }
        this._renderLoad();
    };

    StepFov.prototype._onLost = function (err) {
        var st = this.st, app = this.app;
        var had = st.load === 'ready' || st.load === 'loading';
        this.loadT0 = null;
        this.loadMsg = S.api.describe(err);
        app.set({load: had ? 'lost' : 'none', roiDirty: false});
        if (had) ui.toast('Сессия: ' + S.api.describe(err), 'warning', 10000);
        app.bus.emit('lost', err);
        this._renderLoad();
    };

    // --- отрисовка --------------------------------------------------------------------------------------------

    StepFov.prototype._renderInfo = function () {
        var info = this.st.info;
        if (!info || !this.e.info) return;
        var parts = ['Кадр ' + info.width + '×' + info.height];
        var f = info.frames || {};
        parts.push(info.n_frames + ' кадров (data ' + (f.data || 0) + ', dark ' + (f.dark || 0) + ', empty ' +
            (f.empty || 0) + ')');
        if (info.angles) {
            parts.push('углы ' + core.fmtNum(info.angles.min, 1) + '…' + core.fmtNum(info.angles.max, 1) + '°' +
                (info.angles.step ? ', шаг ' + core.fmtNum(info.angles.step, 3) + '°' : ''));
        }
        if (info.advanced) parts.push('advanced');
        if (info.file_size) parts.push('файл ' + core.fmtBytes(info.file_size));
        ui.text(this.e.info, parts.join(' · '));
    };

    StepFov.prototype._renderSize = function () {
        var st = this.st;
        if (!this.e.size || !st.roi) return;
        var w = st.roi.x1 - st.roi.x0, h = st.roi.y1 - st.roi.y0;
        var txt = 'Область ' + w + '×' + h + ' px';
        if (st.info && st.info.n_frames) {
            txt += ' · кроп ' + core.fmtBytes(core.cropBytes(st.info.n_frames, st.roi)) + ' (' + st.info.n_frames +
                ' кадров × ' + h + ' × ' + w + ' × 2 байта)';
        }
        ui.text(this.e.size, txt);
    };

    StepFov.prototype._renderOutside = function () {
        var st = this.st, el = this.e.outside;
        if (!el) return;
        var n = (st.outsideAngles || []).length;
        if (!st.ov) {
            ui.hide(el);
            return;
        }
        ui.show(el);
        if (!n) {
            el.className = 'st-note text-success';
            ui.text(el, 'Объект в рамке на всех ' + st.sampleAngles.length + ' углах выборки.');
        } else {
            el.className = 'st-note alert alert-danger';
            ui.text(el, 'Объект выходит за рамку на углах: ' + core.fmtAngles(st.outsideAngles) +
                ' (красные миниатюры).');
        }
    };

    StepFov.prototype._renderPs = function () {
        var st = this.st, e = this.e, ps = st.pixelSize;
        if (!e.ps) return;
        if (!ps) {
            e.ps.value = '';
            ui.text(e.psSrc, '');
            ui.hide(e.psWarn);
            return;
        }
        var v = st.pixelUser !== null && st.pixelUser !== undefined ? st.pixelUser : ps.value_mm;
        if (root.document.activeElement !== e.ps) e.ps.value = core.fmtNum(v, 7);
        var src = st.pixelUser ? PS_SOURCES.user + ' (найдено: ' + core.fmtNum(ps.value_mm, 7) + ' мм, ' +
            (PS_SOURCES[ps.source] || ps.source) + ')' : (PS_SOURCES[ps.source] || ps.source);
        ui.text(e.psSrc, '= ' + core.fmtNum(v * 1000, 3) + ' мкм; источник: ' + src);
        var warns = st.pixelUser ? [] : (ps.warnings || []).slice();
        if (!st.pixelUser && ps.source === 'default' && !warns.length) {
            warns.push('размер пикселя не найден — взято значение по умолчанию; проверьте');
        }
        if (warns.length) {
            ui.show(e.psWarn);
            ui.text(e.psWarn, warns.join('; '));
        } else {
            ui.hide(e.psWarn);
        }
    };

    StepFov.prototype._renderLoad = function () {
        var st = this.st, e = this.e, app = this.app;
        var canRun = !!app.config.can_run;
        var loading = st.load === 'loading';
        if (e.load) {
            var ok = canRun && st.overview === 'ready' && !loading && !!st.roi;
            var why = !canRun ? 'Загрузка доступна экспериментатору и администратору' :
                loading ? 'Идёт загрузка' : st.overview !== 'ready' ? 'Нет обзора скана' : '';
            ui.enable(e.load, ok, why);
            var again = st.load === 'ready' && !st.roiDirty;
            e.load.textContent = again ? 'Загрузить заново' : 'Загрузить область';
            e.load.classList.toggle('btn-primary', !again);
            e.load.classList.toggle('btn-default', again);
        }
        ui.show(e.cancel, loading && canRun);
        if (e.cancel) ui.enable(e.cancel, st.loadStage !== 'canceling', 'Отмена уже запрошена');
        ui.show(e.progress, loading);
        if (loading) {
            var stage = LOAD_STAGES[st.loadStage] || st.loadStage || '';
            var sec = this.loadT0 ? Math.round((Date.now() - this.loadT0) / 1000) : null;
            var pct = core.isNum(st.loadProgress) ? Math.round(st.loadProgress * 100) + ' %' : '';
            ui.progress(e.progress, st.loadStage === 'queued' ? null : st.loadProgress,
                [stage, pct, sec !== null ? sec + ' с' : ''].filter(Boolean).join(' · '));
        }
        var dirtyText = '';
        if (st.load === 'ready' && st.roiDirty) {
            dirtyText = 'Рамка изменена после загрузки — шаги 2–4 устарели. Загрузите область заново (или верните рамку).';
        } else if (st.load === 'lost') {
            dirtyText = 'Сессия закрыта — загрузите область снова.';
        }
        ui.show(e.dirty, !!dirtyText);
        ui.text(e.dirty, dirtyText);
        var msg = this.loadMsg;
        if (!msg && st.load === 'ready' && st.loadedRoi && !st.roiDirty) {
            var r = st.loadedRoi;
            msg = 'Загружена область ' + (r.x1 - r.x0) + '×' + (r.y1 - r.y0) + ' (x ' + r.x0 + '…' + r.x1 + ', y ' +
                r.y0 + '…' + r.y1 + ').';
        }
        if (!msg && !canRun) msg = 'Просмотр: загрузка области и запуск доступны экспериментатору и администратору.';
        ui.text(e.loadMsg, msg);
        ui.show(e.loadMsg, !!msg);
        if (e.loadMsg) e.loadMsg.classList.toggle('text-danger', st.load === 'error');
        this._renderDataWarnings();
    };

    /** Предупреждения по данным загруженной области: сбой угла на вставках (контрольные кадры) — красным. */
    StepFov.prototype._renderDataWarnings = function () {
        var el = this.e.dataWarn, st = this.st;
        if (!el) return;
        var list = st.load === 'ready' ? this.dataWarnings : [];
        ui.clear(el);
        ui.show(el, list.length > 0);
        if (!list.length) return;
        var severe = list.some(function (w) {
            return /контрольные кадры|повернулся/.test(w);
        });
        el.classList.toggle('alert-danger', severe);
        el.classList.toggle('alert-warning', !severe);
        el.appendChild(ui.el('strong', {text: severe ? 'Данные сняты со сбоем угла' : 'Предупреждения по данным'}));
        var ul = ui.el('ul', {class: 'st-warnings'});
        list.forEach(function (w) {
            ul.appendChild(ui.el('li', {text: w}));
        });
        el.appendChild(ul);
    };

    S.StepFov = StepFov;
})(typeof window !== 'undefined' ? window : globalThis);
