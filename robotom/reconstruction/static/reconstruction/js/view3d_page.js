/* Сохранённый 3D-вид (отдельный HTML-файл без сети): тот же вид S.View3D, что в студии, и панель управления.
 *
 * Файл собирает студия (export3d.js): в него вставлены core.js, volume3d.js, этот файл и стили, настройки вида на
 * момент сохранения (RBTM_STATE: заголовок, режим, палитра, гамма, глубина/порог, окно, разрез, камера) и объём
 * (RBTM_VOLUME — вставляет сервис реконструкции: {w, h, k, scale, offset, meta, b64}, b64 — uint8 (nz, ny, nx)).
 * Разрез здесь свой: ось и положение ползунком (срезов 2D в файле нет); оранжевая рамка — плоскость разреза.
 * Чистая логика (S.page3d) проверяется node-тестами; страница строится, только если есть document и RBTM_VOLUME. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;

    /** base64 → Uint8Array (браузер — atob, node — Buffer). */
    function b64bytes(b64) {
        if (typeof root.atob === 'function') {
            var bin = root.atob(b64), out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
            return out;
        }
        return new Uint8Array(root.Buffer.from(b64, 'base64'));
    }

    /** Объём из файла → изображение, как ответ volume3d после core.decodeBinary (w = nx, h = ny, k = nz). */
    function decodeVolume(v) {
        var data = b64bytes(v.b64);
        if (data.length !== v.w * v.h * v.k) {
            throw new Error('объём повреждён: ' + data.length + ' байт вместо ' + v.w * v.h * v.k);
        }
        return {w: v.w, h: v.h, k: v.k, data: data, scale: v.scale, offset: v.offset, meta: v.meta || {}};
    }

    /** Гистограмма кодов 0…255. */
    function codeHistogram(data) {
        var h = new Float64Array(256);
        for (var i = 0; i < data.length; i++) h[data[i]]++;
        return h;
    }

    /** Окно по персентилям (p в процентах) гистограммы кодов → физические единицы [lo, hi]. */
    function autoWindow(hist, scale, offset, pLo, pHi) {
        var total = 0, i;
        for (i = 0; i < 256; i++) total += hist[i];
        var at = function (p) {
            var target = total * p / 100, acc = 0;
            for (var j = 0; j < 256; j++) {
                acc += hist[j];
                if (acc >= target) return j;
            }
            return 255;
        };
        var lo = at(pLo), hi = Math.max(at(pHi), lo + 1);
        return [lo * scale + offset, hi * scale + offset];
    }

    S.page3d = {b64bytes: b64bytes, decodeVolume: decodeVolume, codeHistogram: codeHistogram, autoWindow: autoWindow};

    // --- страница ----------------------------------------------------------------------------------------------

    if (!root.document || !root.RBTM_VOLUME) return;
    var doc = root.document;
    var state = root.RBTM_STATE || {};

    function el(tag, attrs, children) {
        var e = doc.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v === null || v === undefined || v === false) return;
            if (k === 'text') e.textContent = String(v);
            else if (k === 'class') e.className = v;
            else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v === true ? '' : String(v));
        });
        (children || []).forEach(function (c) {
            if (c) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
        });
        return e;
    }

    var app = doc.getElementById('v3-app');
    var img;
    try {
        img = decodeVolume(root.RBTM_VOLUME);
    } catch (e) {
        app.textContent = 'Не удалось прочитать объём: ' + e.message;
        return;
    }
    var hist = codeHistogram(img.data);
    var panel = el('aside', {class: 'v3-panel'});
    var stage = el('main', {class: 'sv-stage v3-stage'});
    app.appendChild(panel);
    app.appendChild(stage);

    var view = new S.View3D(stage, {});
    if (!view.supported()) {
        stage.appendChild(el('div', {class: 'v3-error', text: '3D-вид недоступен: ' + (view.error || 'нет WebGL2') +
            '. Откройте файл в Chrome, Edge или Firefox.'}));
    }
    var opts = Object.assign(S.View3D.defaults(), state.opts || {});
    opts.slice = null;
    var win = state.win && state.win.length === 2 ? state.win.slice() : autoWindow(hist, img.scale, img.offset, 0.5, 99.99);

    // --- панель ---
    panel.appendChild(el('h1', {text: state.title || '3D-вид'}));
    (state.lines || []).forEach(function (line) {
        panel.appendChild(el('div', {class: 'v3-line', text: line}));
    });
    var m = img.meta || {};
    panel.appendChild(el('div', {class: 'v3-line', text: 'Объём ' + img.k + ' × ' + img.h + ' × ' + img.w +
        ' (z × y × x)' + (m.binning ? ', в ' + m.binning + ' раз меньше полного по каждой оси' : '') +
        (m.voxel_mm ? ', воксель ' + core.fmtNum(m.voxel_mm * 1000, 3) + ' мкм' : '')}));

    function section(title) {
        var s = el('div', {class: 'v3-sec'}, [el('div', {class: 'v3-sec-title', text: title})]);
        panel.appendChild(s);
        return s;
    }

    function seg(parent, items, current, onPick) {
        var g = el('div', {class: 'v3-seg'});
        var btns = items.map(function (it) {
            var b = el('button', {type: 'button', text: it[1], title: it[2] || null, onclick: function () {
                btns.forEach(function (x) {
                    x.classList.toggle('on', x === b);
                });
                onPick(it[0]);
            }});
            if (it[0] === current) b.classList.add('on');
            g.appendChild(b);
            return b;
        });
        parent.appendChild(g);
        return g;
    }

    function slider(parent, label, min, max, step, value, fmt, onInput) {
        var val = el('span', {class: 'v3-val'});
        var inp = el('input', {type: 'range', min: min, max: max, step: step, value: value});
        var lab = el('span', {class: 'v3-lab', text: label});
        var row = el('label', {class: 'v3-row'}, [lab, inp, val]);
        var show = function () {
            val.textContent = fmt(parseFloat(inp.value));
        };
        inp.addEventListener('input', function () {
            show();
            onInput(parseFloat(inp.value));
        });
        show();
        parent.appendChild(row);
        return {row: row, input: inp, label: lab, show: show};
    }

    function check(parent, label, on, onChange) {
        var c = el('input', {type: 'checkbox'});
        c.checked = !!on;
        c.addEventListener('change', function () {
            onChange(c.checked);
        });
        parent.appendChild(el('label', {class: 'v3-check'}, [c, ' ' + label]));
        return c;
    }

    var sRender = section('Рендер');
    seg(sRender, [['soft', 'Мягкий', 'Максимум вдоль луча, ослабленный пройденным веществом: читается глубина'],
        ['mip', 'Максимум', 'Самый яркий воксель вдоль луча'], ['iso', 'Поверхность', 'Оболочка по порогу']],
    opts.mode, function (mode) {
        opts.mode = mode;
        view.set({mode: mode});
        syncDepth();
    });
    slider(sRender, 'Гамма', 0.3, 2, 0.05, opts.gamma, function (v) {
        return core.fmtNum(v, 2);
    }, function (v) {
        view.set({gamma: v});
    });
    var depth = slider(sRender, 'Глубина', 0.005, 0.2, 0.005, opts.atten, function (v) {
        return opts.mode === 'iso' ? Math.round(v * 100) + ' %' : core.fmtNum(v, 3);
    }, function (v) {
        if (opts.mode === 'iso') view.set({iso: v});
        else view.set({atten: v});
    });

    function syncDepth() {
        var iso = opts.mode === 'iso';
        depth.row.style.display = opts.mode === 'mip' ? 'none' : '';
        depth.label.textContent = iso ? 'Порог' : 'Глубина';
        depth.input.min = iso ? 0 : 0.005;
        depth.input.max = iso ? 1 : 0.2;
        depth.input.step = iso ? 0.01 : 0.005;
        depth.input.value = iso ? view.opts.iso : view.opts.atten;
        depth.show();
    }

    var sWin = section('Окно контраста, 1/мм');
    var hc = el('canvas', {class: 'v3-hist', width: 256, height: 48});
    sWin.appendChild(hc);
    var lo = el('input', {type: 'number', step: 'any', class: 'v3-num'});
    var hi = el('input', {type: 'number', step: 'any', class: 'v3-num'});
    sWin.appendChild(el('div', {class: 'v3-row'}, [lo, ' … ', hi, el('button', {type: 'button', text: 'Авто',
        title: 'Персентили 0,5 и 99,99 % вокселей', onclick: function () {
            setWin(autoWindow(hist, img.scale, img.offset, 0.5, 99.99));
        }})]));
    var pal = el('select', {class: 'v3-sel'});
    (core.PALETTES || [['gray', 'серая']]).forEach(function (p) {
        var o = el('option', {value: p[0], text: p[1]});
        if (p[0] === opts.cmap) o.selected = true;
        pal.appendChild(o);
    });
    pal.addEventListener('change', function () {
        view.set({cmap: pal.value});
    });
    sWin.appendChild(el('label', {class: 'v3-row'}, [el('span', {class: 'v3-lab', text: 'Палитра'}), pal]));
    [lo, hi].forEach(function (inp) {
        inp.addEventListener('change', function () {
            var a = parseFloat(lo.value), b = parseFloat(hi.value);
            if (isFinite(a) && isFinite(b) && b > a) setWin([a, b]);
            else showWin();
        });
    });

    function showWin() {
        lo.value = +win[0].toPrecision(4);
        hi.value = +win[1].toPrecision(4);
        drawHist();
    }

    function setWin(w) {
        win = w;
        view.setWindow(w[0], w[1]);
        showWin();
    }

    function drawHist() {
        var ctx = hc.getContext('2d');
        if (!ctx) return;
        var W = hc.width, H = hc.height, mx = 0, i;
        for (i = 1; i < 255; i++) mx = Math.max(mx, hist[i]);         // края (0 и 255 — обрезанное окном) не в счёт
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#9ab';
        for (i = 0; i < 256; i++) {
            var h = mx > 0 ? Math.min(1, Math.log(1 + hist[i]) / Math.log(1 + mx)) * (H - 2) : 0;
            ctx.fillRect(i, H - h, 1, h);
        }
        ctx.strokeStyle = '#d9534f';
        [win[0], win[1]].forEach(function (v) {
            var x = (v - img.offset) / (img.scale || 1);
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, H);
            ctx.stroke();
        });
    }

    var sCut = section('Разрез');
    var clip = Object.assign({}, opts.clip);
    var axisSel = el('select', {class: 'v3-sel'});
    [['2', 'по z'], ['1', 'по y'], ['0', 'по x']].forEach(function (a) {
        var o = el('option', {value: a[0], text: a[1]});
        if (Number(a[0]) === clip.axis) o.selected = true;
        axisSel.appendChild(o);
    });
    var cutOn = check(sCut, 'включить', clip.enabled, function (on) {
        clip.enabled = on;
        if (on) clip.side = view.farSide(clip.axis, clip.pos);
        applyClip();
    });
    sCut.appendChild(el('label', {class: 'v3-row'}, [el('span', {class: 'v3-lab', text: 'Ось'}), axisSel,
        el('button', {type: 'button', text: '⇄', title: 'Оставить другую половину', onclick: function () {
            clip.side = -clip.side;
            applyClip();
        }})]));
    axisSel.addEventListener('change', function () {
        clip.axis = Number(axisSel.value);
        if (clip.enabled) clip.side = view.farSide(clip.axis, clip.pos);
        applyClip();
    });
    var pos = slider(sCut, 'Положение', 0, 1, 0.001, clip.pos, function (v) {
        var n = [img.w, img.h, img.k][clip.axis];
        return Math.min(n - 1, Math.floor(v * n)) + ' из ' + n;
    }, function (v) {
        clip.pos = v;
        applyClip();
    });

    function applyClip() {
        var dims = [img.w, img.h, img.k];
        view.set({clip: clip, slice: clip.enabled ? {axis: clip.axis, pos: clip.pos * dims[clip.axis]} : null});
        pos.show();
        cutOn.checked = clip.enabled;
    }

    var sShow = section('Показать');
    check(sShow, 'рамка с длинами рёбер', opts.box, function (on) {
        view.set({box: on});
    });
    check(sShow, 'оси (x — красная, y — зелёная, z — синяя)', opts.axes, function (on) {
        view.set({axes: on});
    });
    sShow.appendChild(el('button', {type: 'button', class: 'v3-btn', text: 'Исходный вид', onclick: function () {
        view.fit();
    }}));
    panel.appendChild(el('div', {class: 'v3-hint', text: view.hint}));
    if (state.saved) panel.appendChild(el('div', {class: 'v3-foot', text: 'Сохранено ' + state.saved}));

    // --- старт ---
    view.set(opts);
    view.setWindow(win[0], win[1]);
    view.setVolume(img);
    if (state.cam && state.cam.target) view.cam = state.cam;
    view.activate(true);
    syncDepth();
    showWin();
    applyClip();
})(typeof window !== 'undefined' ? window : globalThis);
