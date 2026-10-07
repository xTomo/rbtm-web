/* Студия реконструкции — рецепты: посмотреть, скачать, загрузить из файла, применить к шагам, запустить как есть.
 *
 * Кнопка «Рецепты» в шапке открывает окно: рецепт опубликованного запуска и прежних (GET results/<id> — список,
 * GET results/<id>/recipes/<run> — рецепт, ?download=1 — файлом) и рецепт из файла (recipe.json движка или
 * result.json запуска — рецепт берётся из поля recipe).
 *
 * «Применить» — выставить шаги 1–4 по рецепту. Сначала план (plan — чистая функция): что изменится, когда и что
 * студия не настраивает; в окне — галочки по пунктам. Применение: настройки страницы (кольца, сглаживание, TV 3D,
 * углы, строки, копии, размер пикселя) — сразу; рамка и строка превью — в шаге 1, и если загруженная область
 * другая, её нужно загрузить заново; ось и режим компенсации смещения — в сессии, когда область загружена и
 * авто-ось закончилась (иначе запоздалая авто-ось перезапишет ось рецепта). Ось ставится раньше режима смещения:
 * при ручной оси смена режима ось не трогает (step_axis, событие 'motion'). Сдвиги смещения по кадрам (motion.dx)
 * студия не переносит — в сессии они оцениваются заново тем же движком; у того же скана они совпадают.
 * Рецепт другого скана применять можно, но ось по умолчанию не отмечена: у другого скана она своя.
 *
 * «Запустить как есть» — POST jobs {recipe} без шагов студии (то же, что кнопка «Запустить», но рецепт целиком из
 * файла или истории, со сдвигами смещения по кадрам). Только для рецепта этого скана; сервис проверяет рецепт по
 * скану, несовпадение отпечатка файла — предупреждение задачи. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var RINGS = {off: 'выкл', weak: 'слабо', medium: 'средне', strong: 'сильно'};
    var ANGLES = {first_180: 'первые 180°', full_halves: 'все полуобороты'};
    var MOTION = {auto: 'авто', on: 'вкл', off: 'выкл'};
    var DEFAULTS = {normalization: 'auto', empty_skip_first: 2};
    var RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

    // --- чистые функции ----------------------------------------------------------------------------------------

    /** Рецепт из документа: сам рецепт, result.json запуска или ответ GET results/<id>/recipes/<run> (поле
     *  recipe). Error — если это не рецепт движка. */
    function fromDocument(doc) {
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('это не объект JSON');
        var r = doc.recipe && typeof doc.recipe === 'object' && !Array.isArray(doc.recipe) ? doc.recipe : doc;
        if (!r.input || typeof r.input !== 'object' || !r.recon || typeof r.recon !== 'object' || !r.fov) {
            throw new Error('это не рецепт реконструкции (нет полей input, fov, recon)');
        }
        return r;
    }

    function num(v) {
        var n = Number(v);
        return v !== null && v !== undefined && v !== '' && core.isNum(n) ? n : null;
    }

    /** Значения шагов студии по рецепту. */
    function toState(r) {
        var f = r.fov || {}, ax = r.axis, ps = r.pixel_size || {}, sm = r.smoothing || {}, dn = r.denoise || {};
        var roi = num(f.x0) !== null ? {x0: num(f.x0), x1: num(f.x1), y0: num(f.y0), y1: num(f.y1)} : null;
        var sigma = num(sm.sigma);
        var bin = ((r.outputs || {}).binning || []).map(Number).filter(function (b) {
            return b === 2 || b === 4 || b === 8;
        }).sort(function (a, b) {
            return a - b;
        });
        var sl = (r.recon || {}).slices;
        return {
            roi: roi,
            row: num(f.preview_row),
            pixelMm: num(ps.value_mm),
            pixelSource: ps.source || null,
            pixelUser: ps.user_edited && num(ps.value_mm) ? num(ps.value_mm) : null,
            axis: ax && num(ax.center_x) !== null ? core.manualAxis(num(ax.center_x), num(ax.y_ref) || 0,
                num(ax.tilt_deg) || 0) : null,
            motionMode: (r.motion && MOTION[r.motion.mode]) ? r.motion.mode : 'auto',
            rings: (r.rings && RINGS[r.rings.preset]) ? r.rings.preset : 'medium',
            smoothing: sigma && sigma > 0 ?
                {enabled: true, sigma: sigma, deblur: sm.deblur || 'none', balance: num(sm.balance) || 0.02,
                    amount: num(sm.amount) || 1.5} : {enabled: false},
            denoise: dn.method === 'tv' ?
                {enabled: true, strength: num(dn.strength) || 2, iterations: num(dn.iterations) || 50} :
                {enabled: false},
            angles: ANGLES[(r.recon || {}).angles] ? r.recon.angles : 'first_180',
            slices: Array.isArray(sl) && sl.length === 2 ? [num(sl[0]), num(sl[1])] : null,
            binning: bin.length ? bin : [4]
        };
    }

    function roiText(roi) {
        return roi ? 'x ' + roi.x0 + '…' + roi.x1 + ', y ' + roi.y0 + '…' + roi.y1 : '—';
    }

    function axisText(a, row) {
        if (!a) return 'авто';
        var y = core.isNum(row) ? row : a.y_ref;
        return core.fmtNum(core.centerAt(a, y), 2) + ' px на строке ' + y + ', наклон ' + core.fmtNum(a.tilt_deg, 3) + '°';
    }

    function sameAxis(a, b) {
        if (!a || !b) return !a && !b;
        return Math.abs(core.centerAt(a, b.y_ref) - b.center_x) < 0.005 && Math.abs(a.tilt_deg - b.tilt_deg) < 0.00005;
    }

    function smoothText(sm) {
        return core.smoothingText(sm) || 'выкл';
    }

    function denoiseText(dn) {
        return core.denoiseText(dn) || 'выкл';
    }

    function sameBlock(a, b) {
        return JSON.stringify(a) === JSON.stringify(b);
    }

    /** Сводка рецепта для показа: [[подпись, значение]]. */
    function summary(r) {
        var t = toState(r), inp = r.input || {}, out = [];
        out.push(['Скан', inp.exp_id || '—']);
        if (r.created) out.push(['Создан', core.fmtDate(r.created)]);
        if (r.author) out.push(['Автор', r.author]);
        out.push(['Рамка', roiText(t.roi) + (core.isNum(t.row) ? ' · строка превью ' + t.row : '')]);
        if (core.isNum(t.pixelMm)) {
            out.push(['Пиксель', core.fmtNum(t.pixelMm * 1000, 3) + ' мкм' + (t.pixelSource ? ' (' + t.pixelSource + ')' : '')]);
        }
        out.push(['Ось', r.axis ? axisText(t.axis) + (r.axis.method ? ' · ' + r.axis.method : '') : 'авто при запуске']);
        var mo = r.motion || {};
        out.push(['Смещение', 'режим ' + MOTION[t.motionMode] + (mo.applied ? ', компенсировано' +
            (mo.summary && core.isNum(mo.summary.rms) ? ' (СКО ' + core.fmtNum(mo.summary.rms, 1) + ' px)' : '') : '')]);
        out.push(['Кольца', RINGS[t.rings]]);
        out.push(['Сглаживание', smoothText(t.smoothing)]);
        out.push(['TV 3D', denoiseText(t.denoise)]);
        out.push(['Углы', ANGLES[t.angles]]);
        if (t.slices) out.push(['Строки', t.slices[0] + '…' + t.slices[1] + ' (' + (t.slices[1] - t.slices[0]) + ' срезов)']);
        out.push(['Копии', t.binning.map(function (b) {
            return '×' + b;
        }).join(', ')]);
        notes(r).forEach(function (n) {
            out.push(['Не из студии', n]);
        });
        return out;
    }

    /** Части рецепта, которые студия не настраивает (если они не по умолчанию). */
    function notes(r) {
        var out = [];
        if (r.normalization && r.normalization !== DEFAULTS.normalization) {
            out.push('нормировка «' + r.normalization + '» — в студии всегда «auto»');
        }
        if (core.isNum(r.empty_skip_first) && r.empty_skip_first !== DEFAULTS.empty_skip_first) {
            out.push('пропуск первых пустых: ' + r.empty_skip_first + ' — в студии ' + DEFAULTS.empty_skip_first);
        }
        if (r.recon && r.recon.xy_roi && r.recon.xy_roi.kind) out.push('область в срезе (xy_roi) — студия её не задаёт');
        if (r.repositioning && r.repositioning.shifts) {
            out.push('сдвиги вставок записаны в рецепте — студия считает их заново');
        }
        if (r.motion && r.motion.applied && Array.isArray(r.motion.dx)) {
            out.push('сдвиги смещения по кадрам — студия оценивает заново (у того же скана совпадут)');
        }
        return out;
    }

    /** План применения: что изменится в шагах студии. ctx = {exp_id, motionMode (текущий режим сессии или null)}.
     *  Пункт: {key, label, from, to, changed, when ('now' | 'load' — нужна загрузка области | 'session' — после
     *  загрузки и авто-оси), check (отмечен по умолчанию)}. sameScan — рецепт этого скана. */
    function plan(r, st, ctx) {
        ctx = ctx || {};
        var t = toState(r), items = [], warnings = [];
        var sameScan = !!(r.input && r.input.exp_id === ctx.exp_id);
        if (!sameScan) warnings.push('Рецепт другого скана (' + ((r.input || {}).exp_id || '?') + '): ось у этого скана ' +
            'своя — по умолчанию не применяется; рамку и строки проверьте.');
        var add = function (key, label, from, to, changed, when, check) {
            items.push({key: key, label: label, from: from, to: to, changed: changed, when: when,
                check: changed && check !== false});
        };
        var loaded = st.load === 'ready' && !!st.loadedRoi;
        var roiChanged = !!t.roi && !core.sameRoi(st.roi, t.roi);
        var needLoad = !!t.roi && !(loaded && core.sameRoi(st.loadedRoi, t.roi));
        add('fov', 'Рамка', roiText(st.roi), roiText(t.roi), roiChanged, needLoad ? 'load' : 'now');
        add('row', 'Строка превью', String(st.row), String(t.row), core.isNum(t.row) && t.row !== st.row, 'now');
        var curPx = st.pixelUser || (st.pixelSize ? st.pixelSize.value_mm : null);
        if (t.pixelUser) {
            add('pixel', 'Размер пикселя', core.isNum(curPx) ? core.fmtNum(curPx * 1000, 3) + ' мкм' : '—',
                core.fmtNum(t.pixelUser * 1000, 3) + ' мкм (задан вручную)', !(curPx && Math.abs(curPx - t.pixelUser) < 1e-12),
                'now');
        } else if (core.isNum(t.pixelMm) && core.isNum(curPx) && Math.abs(curPx - t.pixelMm) > 1e-12) {
            warnings.push('Размер пикселя в рецепте ' + core.fmtNum(t.pixelMm * 1000, 3) + ' мкм (' + (t.pixelSource || '?') +
                '), у этого скана ' + core.fmtNum(curPx * 1000, 3) + ' мкм — остаётся найденный для скана.');
        }
        var curAxis = st.axisInfo && st.axisInfo.axis;
        var sessionWhen = needLoad ? 'load' : 'session';
        if (t.axis) {
            add('axis', 'Ось', axisText(curAxis, t.axis.y_ref), axisText(t.axis), !sameAxis(curAxis, t.axis), sessionWhen,
                sameScan);
        }
        // без сессии режим ещё не выбран: новая сессия начинает с 'auto' (сервис, sessions.py)
        var curMotion = ctx.motionMode || null;
        add('motion', 'Компенсация смещения', curMotion ? MOTION[curMotion] : MOTION.auto + ' (по умолчанию)',
            MOTION[t.motionMode], (curMotion || 'auto') !== t.motionMode, sessionWhen);
        add('rings', 'Кольца', RINGS[st.rings] || st.rings, RINGS[t.rings], st.rings !== t.rings, 'now');
        var curSm = core.smoothingBlock(st.smoothing), toSm = core.smoothingBlock(t.smoothing);
        add('smoothing', 'Сглаживание', smoothText(st.smoothing), smoothText(t.smoothing), !sameBlock(curSm, toSm), 'now');
        var curDn = core.denoiseBlock(st.denoise), toDn = core.denoiseBlock(t.denoise);
        add('denoise', 'TV 3D', denoiseText(st.denoise), denoiseText(t.denoise), !sameBlock(curDn, toDn), 'now');
        add('angles', 'Углы', ANGLES[st.angles] || st.angles, ANGLES[t.angles], st.angles !== t.angles, 'now');
        if (t.slices) {
            var cur = st.slices || (st.loadedRoi ? [st.loadedRoi.y0, st.loadedRoi.y1] : null);
            add('slices', 'Строки объёма', cur ? cur[0] + '…' + cur[1] : '—', t.slices[0] + '…' + t.slices[1],
                !cur || cur[0] !== t.slices[0] || cur[1] !== t.slices[1], 'now');
        }
        var curBin = (st.binning || []).slice().sort();
        add('binning', 'Копии', curBin.map(function (b) {
            return '×' + b;
        }).join(', '), t.binning.map(function (b) {
            return '×' + b;
        }).join(', '), curBin.join(',') !== t.binning.join(','), 'now');
        return {sameScan: sameScan, items: items, warnings: warnings, notes: notes(r), needLoad: needLoad, target: t};
    }

    // --- окно рецептов -----------------------------------------------------------------------------------------

    function RecipesPanel(app) {
        var self = this;
        this.app = app;
        this.st = app.state;
        this.api = app.api;
        this.pending = null;            // ось и режим смещения, ждущие загрузки области и авто-оси
        this.btn = ui.$('st-recipes');
        if (this.btn) {
            this.btn.addEventListener('click', function () {
                self.open();
            });
        }
        app.bus.on('state', function () {
            self._tryPending();
        });
        app.bus.on('lost', function () {
            if (self.pending) ui.toast('Сессия закрыта — ось и режим смещения из рецепта не применены.', 'warning');
            self.pending = null;
        });
    }

    RecipesPanel.prototype._rid = function () {
        return this.app.config.exp_id;
    };

    /** Окно: опубликованный запуск, прежние, загрузка из файла. */
    RecipesPanel.prototype.open = function () {
        var self = this, id = this._rid();
        var body = ui.el('div', {class: 'st-recipes'});
        var list = ui.el('div', {class: 'st-recipes-list', text: 'Загрузка списка запусков…'});
        var fileBox = ui.el('div', {class: 'st-recipes-file'});
        body.appendChild(ui.el('div', {class: 'st-label', text: 'Запуски этого скана:'}));
        body.appendChild(list);
        body.appendChild(ui.el('div', {class: 'st-label', text: 'Рецепт из файла (recipe.json или result.json):'}));
        body.appendChild(fileBox);
        var input = ui.el('input', {type: 'file', accept: '.json,application/json', class: 'form-control input-sm',
            id: 'st-recipe-file'});
        fileBox.appendChild(input);
        var fileOut = ui.el('div', {class: 'st-recipes-fileout'});
        fileBox.appendChild(fileOut);
        input.addEventListener('change', function () {
            var f = input.files && input.files[0];
            ui.clear(fileOut);
            if (!f) return;
            self._readFile(f).then(function (r) {
                fileOut.appendChild(self._recipeRow(f.name, r, null));
            }, function (err) {
                fileOut.appendChild(ui.el('div', {class: 'text-danger', text: f.name + ': ' + err.message}));
            });
        });
        this.api.getJSON('results/' + id, null, {quiet: true, expect: [404]}).then(function (doc) {
            ui.clear(list);
            var runs = [];
            if (doc && doc.result) {
                runs.push({run_id: doc.result.run_id || 'current', created: doc.result.created, current: true,
                    has_recipe: (doc.files || []).some(function (f) {
                        return f.name === 'recipe.json';
                    })});
            }
            (doc && doc.history || []).forEach(function (h) {
                runs.push({run_id: h.run_id, created: h.created, current: false, has_recipe: h.has_recipe});
            });
            if (!runs.length) {
                list.appendChild(ui.el('div', {class: 'text-muted', text: 'Запусков движка у скана ещё нет.'}));
                return;
            }
            var ul = ui.el('ul', {class: 'st-recipes-runs'});
            runs.forEach(function (run) {
                ul.appendChild(self._runItem(run));
            });
            list.appendChild(ul);
        }, function (err) {
            ui.clear(list);
            list.appendChild(ui.el('div', {class: 'text-muted', text: err && err.status === 404 ?
                'Запусков движка у скана ещё нет.' : 'Список запусков не получен: ' + S.api.describe(err)}));
        });
        this._list = {};
        return ui.modal({title: 'Рецепты', body: body, large: true, handle: this._list});
    };

    /** Закрыть окно списка рецептов (после «Применить» или поставленной задачи). */
    RecipesPanel.prototype._closeList = function () {
        if (this._list && this._list.close) this._list.close(null);
        this._list = null;
    };

    RecipesPanel.prototype._runItem = function (run) {
        var self = this, id = this._rid();
        var label = core.fmtDate(run.created) + ' · запуск ' + String(run.run_id).slice(0, 8) +
            (run.current ? ' (опубликован)' : '');
        var li = ui.el('li', null, [ui.el('span', {text: label + ' '})]);
        if (!run.has_recipe || !RUN_ID_RE.test(String(run.run_id))) {
            li.appendChild(ui.el('span', {class: 'text-muted', text: '— без рецепта'}));
            return li;
        }
        var key = run.current ? 'current' : run.run_id;
        var load = function () {
            return self.api.getJSON('results/' + id + '/recipes/' + key, null, {what: 'Рецепт запуска'}).then(function (d) {
                return fromDocument(d);
            });
        };
        li.appendChild(this._buttons(load, {
            download: this.api.url('results/' + id + '/recipes/' + key, {download: 1}),
            name: id + '.' + run.run_id + '.recipe.json'
        }));
        return li;
    };

    /** Строка рецепта из файла: имя и кнопки. */
    RecipesPanel.prototype._recipeRow = function (name, r) {
        var div = ui.el('div', {class: 'st-recipes-run'}, [ui.el('span', {text: name + ' — скан ' +
            ((r.input || {}).exp_id || '?') + ' '})]);
        var other = !r.input || r.input.exp_id !== this._rid();
        div.appendChild(this._buttons(function () {
            return Promise.resolve(r);
        }, null, other ? 'Рецепт другого скана — только «Применить»' : null));
        return div;
    };

    /** Кнопки «Посмотреть», «Скачать», «Применить», «Запустить как есть»; get() — Promise рецепта; noRun — почему
     *  «Запустить как есть» недоступно (рецепт другого скана). */
    RecipesPanel.prototype._buttons = function (get, dl, noRun) {
        var self = this, canRun = !!this.app.config.can_run;
        var g = ui.el('span', {class: 'btn-group btn-group-xs st-recipes-btns'});
        var mk = function (text, title, fn, enabled, why) {
            var b = ui.el('button', {type: 'button', class: 'btn btn-default', text: text, title: title});
            b.addEventListener('click', function () {
                get().then(fn, function (err) {
                    if (err && !err.reported) ui.toast('Рецепт: ' + (err.message || S.api.describe(err)), 'error');
                });
            });
            if (enabled === false) ui.enable(b, false, why || 'Доступно экспериментатору и администратору');
            g.appendChild(b);
        };
        mk('Посмотреть', 'Сводка и рецепт целиком (JSON)', function (r) {
            self.view(r);
        });
        if (dl) {
            g.appendChild(ui.el('a', {class: 'btn btn-default', href: dl.download, download: dl.name, text: 'Скачать',
                title: 'recipe.json этого запуска'}));
        }
        mk('Применить', 'Выставить шаги 1–4 по рецепту', function (r) {
            self.apply(r);
        }, canRun);
        mk('Запустить как есть', 'Поставить задачу ровно по этому рецепту, без шагов студии', function (r) {
            self.runAsIs(r);
        }, canRun && !noRun, canRun ? noRun : null);
        return g;
    };

    RecipesPanel.prototype._readFile = function (file) {
        return new Promise(function (resolve, reject) {
            var fr = new root.FileReader();
            fr.onload = function () {
                try {
                    resolve(fromDocument(JSON.parse(String(fr.result))));
                } catch (e) {
                    reject(e instanceof SyntaxError ? new Error('не JSON: ' + e.message) : e);
                }
            };
            fr.onerror = function () {
                reject(new Error('файл не прочитан'));
            };
            fr.readAsText(file, 'utf-8');
        });
    };

    RecipesPanel.prototype.view = function (r) {
        var body = ui.el('div');
        var dl = ui.el('dl', {class: 'dl-horizontal st-dl st-recipe-dl'});
        summary(r).forEach(function (p) {
            dl.appendChild(ui.el('dt', {text: p[0]}));
            dl.appendChild(ui.el('dd', {text: p[1]}));
        });
        body.appendChild(dl);
        var det = ui.el('details', null, [ui.el('summary', {text: 'Рецепт целиком (JSON)'}),
            ui.el('pre', {class: 'st-log', text: JSON.stringify(r, null, 2)})]);
        body.appendChild(det);
        return ui.modal({title: 'Рецепт', body: body, large: true});
    };

    // --- применить ---------------------------------------------------------------------------------------------

    RecipesPanel.prototype.apply = function (r) {
        var self = this, app = this.app;
        var p = plan(r, this.st, {exp_id: this._rid(), motionMode: app.fov && app.fov.motion ? app.fov.motion.mode : null});
        var changed = p.items.filter(function (it) {
            return it.changed;
        });
        if (!changed.length) {
            ui.toast('Шаги студии уже совпадают с рецептом.', 'info');
            return Promise.resolve(false);
        }
        var body = ui.el('div');
        p.warnings.forEach(function (w) {
            body.appendChild(ui.el('div', {class: 'alert alert-warning st-recipe-warn', text: w}));
        });
        var tbl = ui.el('table', {class: 'table table-condensed st-recipe-plan'});
        tbl.appendChild(ui.el('tr', null, [ui.el('th'), ui.el('th', {text: 'Что'}), ui.el('th', {text: 'Сейчас'}),
            ui.el('th', {text: 'По рецепту'})]));
        var boxes = {};
        var WHEN = {load: ' (после загрузки области)', session: ' (в сессии)'};
        changed.forEach(function (it) {
            var cb = ui.el('input', {type: 'checkbox', id: 'st-rp-' + it.key});
            cb.checked = it.check;
            boxes[it.key] = cb;
            tbl.appendChild(ui.el('tr', null, [ui.el('td', null, [cb]),
                ui.el('td', null, [ui.el('label', {for: 'st-rp-' + it.key, text: it.label + (WHEN[it.when] || '')})]),
                ui.el('td', {text: it.from}), ui.el('td', {text: it.to})]));
        });
        body.appendChild(tbl);
        if (p.needLoad) {
            var loaded = this.st.load === 'ready' && !!this.st.loadedRoi;
            body.appendChild(ui.el('p', {class: 'text-muted', text: (loaded ? 'Рамка рецепта отличается от загруженной ' +
                'области' : 'Область ещё не загружена') + ': после применения нажмите «Загрузить область» (шаг 1) — ' +
                'ось и режим смещения применятся, когда область загрузится и авто-ось закончится.'}));
        }
        if (p.notes.length) {
            body.appendChild(ui.el('div', {class: 'st-label', text: 'Не переносится:'}));
            var ul = ui.el('ul', {class: 'st-warnings'});
            p.notes.forEach(function (n) {
                ul.appendChild(ui.el('li', {text: n}));
            });
            body.appendChild(ul);
        }
        return ui.modal({title: 'Применить рецепт', body: body, large: true, buttons: [
            {text: 'Отмена', cls: 'btn-default', value: false},
            {text: 'Применить', cls: 'btn-primary', value: true, focus: true}
        ]}).then(function (ok) {
            if (ok !== true) return false;
            var keys = {};
            Object.keys(boxes).forEach(function (k) {
                if (boxes[k].checked) keys[k] = true;
            });
            self._closeList();
            self.execute(p, keys);
            return true;
        });
    };

    /** Выполнить план по отмеченным пунктам (keys — {ключ: true}). */
    RecipesPanel.prototype.execute = function (p, keys) {
        var app = this.app, st = this.st, t = p.target, bus = app.bus;
        if (keys.rings && app.rings) app.rings.choose(t.rings);
        if (keys.smoothing && app.smoothing) app.smoothing.set(t.smoothing);
        if (keys.denoise && app.denoise) app.denoise.set(t.denoise);
        if (keys.angles) {
            st.angles = t.angles;
            app.set({runEdited: true});
            bus.emit('angles', t.angles);
        }
        if (keys.binning) {
            st.binning = t.binning.slice();
            app.set({runEdited: true});
            bus.emit('recipe-params');
        }
        if (keys.slices && t.slices) {
            st.slices = t.slices.slice();
            app.set({runEdited: true});
            bus.emit('recipe-params');
        }
        if (keys.pixel && t.pixelUser) {
            st.pixelUser = t.pixelUser;
            if (app.fov) app.fov._renderPs();
            bus.emit('recipe-params');
        }
        if (keys.fov && t.roi && st.frame) {
            st.roi = core.clampRoi(t.roi, st.frame.W, st.frame.H);
            if (app.fov) app.fov._roiChanged('recipe', true);
        }
        if ((keys.row || keys.fov) && core.isNum(t.row)) app.setRow(t.row, 'fov');
        if (app.run) app.run.render();
        var pend = {axis: keys.axis ? t.axis : null, motion: keys.motion ? t.motionMode : null};
        if (pend.axis || pend.motion) {
            this.pending = pend;
            if (p.needLoad) {
                ui.toast('Рецепт применён к шагам. Загрузите область (шаг 1) — ось и режим смещения применятся после ' +
                    'загрузки.', 'info', 10000);
            }
            this._tryPending();
        } else {
            ui.toast('Рецепт применён к шагам.', 'success');
        }
    };

    /** Ось и режим смещения — когда область загружена (рамка как в рецепте) и авто-ось не идёт. */
    RecipesPanel.prototype._tryPending = function () {
        var app = this.app, st = this.st, p = this.pending;
        if (!p || this._applying || !app.ready() || st.axis === 'running' || st.axis === 'none') return;
        this.pending = null;
        this._applying = true;
        var self = this;
        if (p.axis && app.axis) app.axis.setManual(p.axis);
        var done = function () {
            self._applying = false;
            ui.toast('Рецепт применён: ось' + (p.motion ? ' и режим смещения' : '') + ' — по рецепту.', 'success');
        };
        var cur = app.fov && app.fov.motion ? app.fov.motion.mode : null;
        if (p.motion && p.motion !== cur && app.fov) {
            app.fov.setMotion(p.motion).then(done, function () {
                self._applying = false;
            });
        } else {
            done();
        }
    };

    // --- запустить как есть ------------------------------------------------------------------------------------

    RecipesPanel.prototype.runAsIs = function (r) {
        var self = this, app = this.app, cfg = app.config, st = this.st;
        if (!r.input || r.input.exp_id !== this._rid()) {
            ui.toast('Это рецепт другого скана — «Запустить как есть» только для рецепта этого скана; используйте ' +
                '«Применить».', 'warning', 8000);
            return Promise.resolve(false);
        }
        if (st.job && S.jobs.isActive(st.job.status)) {
            ui.toast('По этому скану уже идёт задача.', 'warning');
            return Promise.resolve(false);
        }
        var text = 'Задача пойдёт ровно по рецепту (рамка, ось, сдвиги смещения по кадрам — как в нём), без шагов ' +
            'студии.' + (st.result === 'ready' ? ' Опубликованный результат будет заменён новым; рецепт прежнего ' +
            'запуска сохранится в истории.' : '');
        return ui.confirm('Запустить как есть?', text, 'Запустить').then(function (ok) {
            if (!ok) return false;
            return app.api.postJSON('jobs', {recipe: r, name: core.sampleName(cfg.specimen, cfg.exp_id)},
                {expect: [409], what: 'Запуск по рецепту'}).then(function (job) {
                self._closeList();
                app.jobs.track(job);
                var w = (job.warnings || []).join('; ');
                ui.toast('Задача по рецепту поставлена в очередь.' + (w ? ' ' + w : ''), w ? 'warning' : 'success', 8000);
                return true;
            }, function (err) {
                if (err && err.status === 409 && err.body && err.body.job_id) {
                    ui.toast(err.message, 'warning', 8000);
                    app.jobs.track(err.body.job_id);
                }
                return false;
            });
        });
    };

    RecipesPanel.fromDocument = fromDocument;
    RecipesPanel.toState = toState;
    RecipesPanel.summary = summary;
    RecipesPanel.plan = plan;
    RecipesPanel.notes = notes;
    S.RecipesPanel = RecipesPanel;
})(typeof window !== 'undefined' ? window : globalThis);
