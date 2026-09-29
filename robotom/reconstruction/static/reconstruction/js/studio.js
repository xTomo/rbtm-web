/* Студия реконструкции — сборка страницы: конфигурация (#studio-config), общее состояние и шина событий, просмотрщик
 * с наложением, лента углов, панель задачи, сессия, шаги 1–5.
 *
 * Модули (все — в window.Studio, без сборки):
 *   core.js      — чистая логика (декодирование, окно/LUT, преобразования, рамка, форматирование, шина);
 *   api.js       — запросы, каналы «последний выигрывает», уведомления об ошибках;
 *   ui.js        — помощники DOM, модальные окна;
 *   viewer.js    — просмотрщик (canvas, окно/уровень, гистограмма, масштаб/панорама);
 *   overlay.js   — SVG-наложение (рамка, линия);
 *   thumbstrip.js — лента миниатюр углов;
 *   steps.js     — статусы шагов (derive — чистая функция);
 *   session.js   — интерактивная сессия recon-service;
 *   jobs.js      — панель задачи;
 *   step_*.js    — шаги (step_rings + step_smoothing — шаг 3 «Артефакты»);
 *   compare.js   — сравнение вариантов колец и сглаживания на фрагменте среза (вид «Сравнение»).
 *
 * События шины app.bus: 'state' (patch) — изменились поля состояния; 'info' — сведения о скане; 'roi' (roi,
 * источник); 'row' (строка, источник, изменилась ли); 'view' (вид); 'load-start', 'loaded' (сессия), 'lost' —
 * загрузка области; 'axis', 'slice', 'rings', 'smoothing' (действующие параметры сглаживания изменились), 'angles',
 * 'recipe-params'; 'sample' (k, угол); 'compare' (результат сравнения или null). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core, ui = S.ui;

    var VIEW_TITLES = {
        envelope: 'Огибающая', sample: 'Угол', sinogram: 'Синограмма', slice: 'Срез', diff: '0° − 180°',
        compare: 'Сравнение', result: 'Готовый объём'
    };

    function initialState(config) {
        return {
            exp_id: config.exp_id,
            // для статусов шагов (steps.derive)
            overview: 'loading', roiEdited: false, load: 'none', roiDirty: false, axis: 'none', ringsChosen: false,
            smoothingChosen: false, runEdited: false, job: null, result: 'unknown',
            // данные
            info: null, ov: null, bin: 1, frame: null, roi: null, row: null, roiSuggested: null, rowSuggested: null,
            loadedRoi: null, loadProgress: null, loadStage: null, sampleAngles: [], thumbsStack: null, sampleK: -1,
            outsideIdx: [], outsideAngles: [], pixelSize: null, pixelUser: null,
            axisInfo: null, sliceMeta: null, rings: 'medium', angles: 'first_180', slices: null, binning: [4], estimate: null,
            // сглаживание проекций (шаг 3): по умолчанию выключено; σ — при включении
            smoothing: {enabled: false, sigma: 1.5, deblur: 'wiener', balance: 0.02, amount: 1.5},
            resultDoc: null
        };
    }

    function readConfig() {
        var el = ui.$('studio-config');
        if (!el) throw new Error('нет #studio-config');
        var cfg = JSON.parse(el.textContent);
        if (!cfg || !cfg.exp_id) throw new Error('в конфигурации нет exp_id');
        return cfg;
    }

    function fail(msg) {
        var root_ = ui.$('studio');
        if (root_) {
            root_.insertBefore(ui.el('div', {class: 'alert alert-danger', text: 'Студия не запустилась: ' + msg}),
                root_.firstChild);
        }
    }

    function init() {
        var config;
        try {
            config = readConfig();
        } catch (e) {
            fail(e.message);
            return;
        }
        var api = S.api.create(config);
        var app = {config: config, api: api, core: core, ui: ui, bus: new core.Emitter(), state: initialState(config)};
        S.app = app;            // для отладки из консоли

        app.set = function (patch) {
            Object.assign(app.state, patch);
            if (app.stepsView) app.stepsView.render(S.steps.derive(app.state));
            app.bus.emit('state', patch);
        };
        app.sid = function () {
            return app.session ? app.session.sid : null;
        };
        /** Можно ли считать превью: область загружена, рамка не менялась, сессия есть. */
        app.ready = function () {
            return app.state.load === 'ready' && !app.state.roiDirty && !!app.sid();
        };
        /** Строка превью (строка детектора) в пределах рамки; source — кто поменял ('fov', 'axis', 'session'). */
        app.setRow = function (row, source) {
            var st = app.state;
            if (!st.roi) return;
            var r = core.clampRow(row, st.roi);
            var changed = r !== st.row;
            st.row = r;
            app.bus.emit('row', r, source, changed);
        };
        app.showView = function (key) {
            app.viewer.select(key);
        };
        /** Ошибка запроса превью: потеря сессии → 'lost'; not_ready — молча; прочее — уведомление. */
        app.previewError = function (err, what) {
            if (!err || err.silent || S.api.isAbort(err)) return;
            if (app.session.handleError(err)) return;
            if (err.code === 'not_ready') return;
            api.report(err, what);
        };

        renderHeader(config);

        app.viewer = new S.Viewer(ui.$('sv-stage'), {readout: ui.$('sv-readout'), hist: ui.$('sv-hist')});
        app.overlay = new S.Overlay(app.viewer);
        app.thumbs = new S.ThumbStrip(ui.$('st-thumbs'));
        app.stepsView = new S.steps.StepsView();
        app.session = new S.SessionCtl(app);
        app.jobs = new S.jobs.JobPanel(app);

        app.viewer.on('view', function (key) {
            app.overlay.clear();
            app.bus.emit('view', key);
            renderTabs(app);
        });
        app.viewer.on('image', function () {
            renderTabs(app);
        });
        app.bus.on('sample', function () {
            renderTabs(app);
        });
        app.bus.on('thumbs', function () {
            renderTabs(app);
        });
        app.bus.on('state', function () {
            renderTabs(app);
        });
        app.jobs.on('job', function (job) {
            app.set({job: {id: job.id, status: job.status}});
        });
        app.jobs.on('finished', function (job) {
            if (job.status === 'done') ui.toast('Реконструкция завершена, результат опубликован.', 'success', 8000);
            else if (job.status === 'canceled') ui.toast('Задача реконструкции отменена.', 'info');
            else ui.toast('Реконструкция не выполнена: ' + S.jobs.statusText(job.status) + ' — см. панель задачи.', 'error', 10000);
        });
        bindToolbar(app);

        app.fov = new S.StepFov(app);
        app.axis = new S.StepAxis(app);
        app.rings = new S.StepRings(app);
        app.smoothing = new S.StepSmoothing(app);
        app.compare = new S.Compare(app);
        app.run = new S.StepRun(app);
        app.result = new S.StepResult(app);
        app.set({});
        renderTabs(app);

        app.fov.start().then(function (ov) {
            if (ov) return app.fov.restoreSession();
            return null;
        });
        app.jobs.loadRecent();
        app.result.load();
    }

    function renderHeader(cfg) {
        var title = cfg.specimen || cfg.exp_id;
        ui.text(ui.$('st-title'), title);
        ui.text(ui.$('st-expid'), cfg.specimen ? cfg.exp_id : '');
        var storage = ui.$('st-storage-link'), legacy = ui.$('st-legacy-link');
        if (storage) {
            if (cfg.storage_url) storage.href = cfg.storage_url;
            ui.show(storage, !!cfg.storage_url);
        }
        if (legacy) {
            if (cfg.legacy_url) legacy.href = cfg.legacy_url;
            ui.show(legacy, !!cfg.legacy_url);
        }
        ui.show(ui.$('st-sep'), !!(cfg.storage_url && cfg.legacy_url));
        ui.show(ui.$('st-readonly'), !cfg.can_run);
        if (root.document.title !== undefined) root.document.title = 'Студия реконструкции ' + title;
    }

    function bindToolbar(app) {
        var tabs = ui.$('sv-tabs');
        if (tabs) {
            ui.qsa('[data-view]', tabs).forEach(function (b) {
                b.addEventListener('click', function () {
                    var key = b.getAttribute('data-view');
                    if (app.viewer.has(key)) {
                        app.showView(key);
                    } else if (key === 'sample') {
                        app.fov.showSample(app.state.sampleK >= 0 ? app.state.sampleK : 0);
                    } else if (key === 'slice') {
                        app.axis.refreshSlice(true, true);
                    } else if (key === 'sinogram') {
                        app.fov.sinogram();
                    } else if (key === 'result') {
                        app.result.fetchSlice(true, true);
                    }
                });
            });
        }
        var fit = ui.$('sv-fit'), one = ui.$('sv-one');
        if (fit) {
            fit.addEventListener('click', function () {
                app.viewer.fit();
            });
        }
        if (one) {
            one.addEventListener('click', function () {
                app.viewer.oneToOne();
            });
        }
    }

    /** Вкладки видов: доступна — есть изображение (или его можно запросить). */
    function renderTabs(app) {
        var tabs = ui.$('sv-tabs');
        if (!tabs) return;
        var cur = app.viewer.current(), st = app.state;
        ui.qsa('[data-view]', tabs).forEach(function (b) {
            var key = b.getAttribute('data-view');
            var has = app.viewer.has(key);
            var can = has || (key === 'slice' && app.ready()) || (key === 'sinogram' && st.overview === 'ready') ||
                (key === 'sample' && !!st.thumbsStack) || (key === 'result' && st.result === 'ready');
            b.disabled = !can;
            b.classList.toggle('active', key === cur);
            var text = VIEW_TITLES[key] || key;
            if (key === 'sample' && st.sampleK >= 0 && st.sampleAngles[st.sampleK] !== undefined) {
                text += ' ' + core.fmtNum(st.sampleAngles[st.sampleK], 1) + '°';
            }
            b.textContent = text;
        });
    }

    S.initStudio = init;

    if (root.document) {
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
        else init();
    }
})(typeof window !== 'undefined' ? window : globalThis);
