/* Просмотрщик кадров на странице записи хранилища (версия 1 — PNG хранилища по одному кадру по запросу).
 * Кадр, ползунок по кадрам выбранного типа с полосой режимов, фильтр (клавиши 1–4), листание клавишами, проигрывание,
 * предзагрузка соседних кадров, график параметров со щелчком к кадру, список отклонений, таблица под раскрытием.
 * Пока эксперимент не завершён — раз в 10 с дописывает новые кадры (frames_json).
 * Логика без DOM — frames_core.js (StorageFrames). */
(function () {
    'use strict';
    var F = window.StorageFrames;
    var cfgEl = document.getElementById('fv-config');
    var framesEl = document.getElementById('fv-frames');
    if (!F || !cfgEl || !framesEl) return;

    var cfg = JSON.parse(cfgEl.textContent);
    var $ = function (id) { return document.getElementById(id); };

    var COLORS = {dark: '#333', empty: '#5bc0de', emptyAlt: '#2a8fb0', data: '#c8c8c8', data_check: '#f0ad4e'};
    var PRELOAD_AHEAD = 5, PRELOAD_BEHIND = 2, CACHE_MAX = 60;
    var SLOW_POLL_AFTER_S = 600, SLOW_POLL_S = 60;

    var st = {
        frames: [],
        list: [],               // индексы кадров выбранного типа
        filter: 'all',
        idx: 0,                 // текущий кадр (индекс в frames)
        anchor: 0,              // кадр, на который пользователь перешёл сам: к нему возвращает обратная смена фильтра
        devs: {byIndex: {}, list: []},
        playing: false,
        finished: !!cfg.finished,
        newCount: 0,
        lastGrowth: Date.now()
    };

    // --- загрузка изображений ---------------------------------------------------------------------------------

    var cache = {};             // id → {img, state: 'loading'|'ok'|'missing'|'error', waiters: []}
    var cacheOrder = [];

    function pngUrl(f) {
        return cfg.pngUrl.replace('FRAMEID', encodeURIComponent(f.id));
    }

    function load(f, cb) {
        var c = cache[f.id];
        if (c && (c.state === 'ok' || c.state === 'loading')) {
            if (c.state === 'ok') { if (cb) cb(c); } else if (cb) c.waiters.push(cb);
            return c;
        }
        c = cache[f.id] = {img: new Image(), state: 'loading', waiters: cb ? [cb] : []};
        cacheOrder.push(f.id);
        while (cacheOrder.length > CACHE_MAX) {
            var old = cacheOrder.shift();
            if (old !== f.id && cache[old] && cache[old].state !== 'loading') delete cache[old];
        }
        c.img.onload = function () { done('ok'); };
        c.img.onerror = function () {
            // 404 — PNG ещё не построен; отличить от прочих ошибок по ответу — отдельным запросом не стоит
            done(st.finished ? 'error' : 'missing');
        };
        c.img.src = pngUrl(f);
        function done(state) {
            c.state = state;
            var w = c.waiters; c.waiters = [];
            w.forEach(function (fn) { fn(c); });
        }
        return c;
    }

    function preload() {
        var p = F.nearestPos(st.list, st.idx);
        if (p < 0) return;
        for (var d = 1; d <= PRELOAD_AHEAD; d++) {
            if (st.list[p + d] != null) load(st.frames[st.list[p + d]]);
        }
        for (var b = 1; b <= PRELOAD_BEHIND; b++) {
            if (st.list[p - b] != null) load(st.frames[st.list[p - b]]);
        }
        // темновые и пустые — короткие серии: загрузить серию целиком
        var f = st.frames[st.idx];
        if (f && (f.mode === 'dark' || f.mode === 'empty')) {
            st.frames.forEach(function (g) { if (g.mode === f.mode && g.series === f.series) load(g); });
        }
    }

    // --- показ кадра ------------------------------------------------------------------------------------------

    var img = $('fv-img'), cap = $('fv-cap'), msg = $('fv-msg');
    var showToken = 0, retryTimer = null;

    function showFrame() {
        var f = st.frames[st.idx];
        var token = ++showToken;
        clearTimeout(retryTimer);
        if (!f) {
            img.removeAttribute('src');
            cap.textContent = '';
            msg.textContent = 'Кадров пока нет';
            msg.style.display = '';
            return;
        }
        msg.style.display = 'none';
        load(f, function (c) {
            if (token !== showToken) return;           // уже ушли на другой кадр
            if (c.state === 'ok') {
                img.src = c.img.src;
                img.style.visibility = '';
                cap.textContent = captionOf(f);        // подпись — показанного кадра
                msg.style.display = 'none';
            } else {
                img.style.visibility = 'hidden';
                cap.textContent = captionOf(f);
                msg.textContent = c.state === 'missing'
                    ? 'Изображение кадра ещё не готово — хранилище строит его после приёма кадра. Повтор через 3 с.'
                    : 'Изображение кадра не получено.';
                msg.style.display = '';
                if (c.state === 'missing') {
                    retryTimer = setTimeout(function () {
                        if (token !== showToken) return;
                        delete cache[f.id];
                        showFrame();
                    }, 3000);
                }
            }
            if (st.playing) schedulePlay();
        });
        preload();
    }

    function captionOf(f) {
        var parts = ['№ ' + f.num, F.MODE_NAMES[f.mode] || f.mode];
        if (F.isNum(f.angle)) parts.push(F.fmt(f.angle, 2) + '°');
        return parts.join(' · ');
    }

    // --- переходы ---------------------------------------------------------------------------------------------

    /* Перейти к кадру idx. Кадр не входит в фильтр — фильтр переключается на его тип (переход из поля номера,
     * графика, таблицы, списка отклонений). */
    function go(idx, opts) {
        opts = opts || {};
        if (idx == null || !st.frames[idx]) return;
        if (st.list.indexOf(idx) < 0) setFilter(F.filterOfMode(st.frames[idx].mode), true);
        st.idx = idx;
        if (!opts.keepAnchor) st.anchor = idx;
        if (!opts.fromFollow) $('fv-follow').checked = false;
        if (st.newCount && idx === st.list[st.list.length - 1]) {      // дошли до последнего — новых больше нет
            st.newCount = 0;
            showNewBadge();
        }
        render();
    }

    function stepBy(d) {
        go(F.step(st.list, st.idx, d));
    }

    function setFilter(key, silent) {
        st.filter = key;
        st.list = F.select(st.frames, key);
        if (!silent) {
            // к кадру, на который пользователь перешёл сам, если он в фильтре; иначе ближайший к нему
            var target = st.list.indexOf(st.anchor) >= 0 ? st.anchor : st.list[F.nearestPos(st.list, st.anchor)];
            if (target != null) st.idx = target;
            render();
        }
    }

    // --- отрисовка --------------------------------------------------------------------------------------------

    function render() {
        var f = st.frames[st.idx];
        if (f && window.history && history.replaceState) {
            try { history.replaceState(null, '', '#frame=' + f.num); } catch (err) { /* file:// и т. п. */ }
        }
        renderFilter();
        renderSlider();
        renderInfo();
        showFrame();
        drawChart();
        renderTableCur();
    }

    function renderFilter() {
        var box = $('fv-filter');
        if (!box.childNodes.length) {
            F.FILTERS.forEach(function (flt) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn btn-default btn-sm';
                b.setAttribute('data-filter', flt.key);
                b.title = 'Показывать: ' + flt.label + ' (клавиша ' + flt.digit + ')';
                b.addEventListener('click', function () { stopPlay(); setFilter(flt.key); });
                box.appendChild(b);
            });
        }
        Array.prototype.forEach.call(box.childNodes, function (b) {
            var flt = F.filterByKey(b.getAttribute('data-filter'));
            var n = F.select(st.frames, flt.key).length;
            b.innerHTML = '<kbd>' + flt.digit + '</kbd> ' + flt.label + ' (' + n + ')';
            b.classList.toggle('active', flt.key === st.filter);
            b.disabled = n === 0;
        });
        $('fv-keys-filter').innerHTML = '<kbd>1</kbd>–<kbd>4</kbd> — фильтр; <kbd>[</kbd> <kbd>]</kbd> — та же позиция ' +
            'в соседней серии пустого пучка; <kbd>R</kbd> — кадр контроля ↔ проекция на том же угле перед вставкой';
    }

    function renderSlider() {
        var s = $('fv-slider');
        s.max = Math.max(0, st.list.length - 1);
        var p = F.nearestPos(st.list, st.idx);
        s.value = Math.max(0, p);
        s.disabled = st.list.length < 2;
        drawBand();
    }

    function drawBand() {
        var cv = $('fv-band');
        var w = cv.clientWidth || 600;
        cv.width = w;
        var ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, w, cv.height);
        var n = st.list.length;
        if (!n) return;
        // ползунок ставит позицию p в точку (p / (n − 1)) ширины дорожки; полоса — те же доли
        for (var p = 0; p < n; p++) {
            var f = st.frames[st.list[p]];
            var x0 = Math.floor(n === 1 ? 0 : (p - 0.5) / (n - 1) * w);
            var x1 = Math.ceil(n === 1 ? w : (p + 0.5) / (n - 1) * w);
            var color = COLORS[f.mode] || '#999';
            if (f.mode === 'empty' && f.series % 2) color = COLORS.emptyAlt;   // соседние серии — разным оттенком
            ctx.fillStyle = color;
            ctx.fillRect(Math.max(0, x0), 0, Math.max(1, Math.min(w, x1) - Math.max(0, x0)), cv.height);
        }
        var legend = [
            ['dark', 'темновые'], ['empty', 'пустой пучок (соседние серии — разным оттенком)'], ['data', 'проекции'],
            ['data_check', 'контроль после вставки (тот же угол)']
        ].filter(function (m) { return st.list.some(function (i) { return st.frames[i].mode === m[0]; }); })
            .map(function (m) {
                return '<span><span class="fv-sw" style="background:' + COLORS[m[0]] + '"></span>' + m[1] + '</span>';
            });
        $('fv-legend').innerHTML = legend.join('');
    }

    function renderInfo() {
        var f = st.frames[st.idx];
        $('fi-num').textContent = f ? '№ ' + f.num + ' · всего ' + st.frames.length : '';
        $('fv-num').value = f ? f.num : '';
        var dev = (f && st.devs.byIndex[st.idx]) || {};
        var rows = !f ? [] : [
            ['Режим', F.MODE_NAMES[f.mode] || f.mode || '—'],
            ['Позиция', F.positionText(st.frames, st.list, st.idx, st.filter) || '—'],
            ['Угол', F.isNum(f.angle) ? F.fmt(f.angle, 2) + '°' : '—'],
            ['Время', f.datetime || '—'],
            ['Интервал', F.fmtInterval(f.interval), dev.interval],
            ['Экспозиция', F.isNum(f.exposure) ? F.fmt(f.exposure, f.exposure < 1 ? 3 : 2) + ' с' : '—', dev.exposure],
            ['Ток', F.isNum(f.current) ? F.fmt(f.current, 1) + ' мА' : '—', dev.current],
            ['Напряжение', F.isNum(f.voltage) ? F.fmt(f.voltage, 1) + ' кВ' : '—', dev.voltage],
            ['Заслонка', f.shutter === true ? 'открыта' : f.shutter === false ? 'закрыта' : '—']
        ];
        var dl = $('fv-info');
        dl.innerHTML = '';
        rows.forEach(function (r) {
            if (r[0] === 'Позиция' && r[1] === '—') return;
            var dt = document.createElement('dt'); dt.textContent = r[0];
            var dd = document.createElement('dd'); dd.textContent = r[1];
            if (r[2]) {
                dd.className = 'fv-warn';
                dd.title = 'медиана режима: ' + F.fmt(r[2].median, 2);
            }
            dl.appendChild(dt); dl.appendChild(dd);
        });
    }

    // --- график параметров ------------------------------------------------------------------------------------

    var chart = $('fv-chart'), tip = $('fv-tip');
    var CL = 130, CR = 12, LANE_H = 46, LANE_GAP = 6, TOP = 6, AXIS_H = 26;
    var lanesShown = [];

    function chartGeom() {
        var w = chart.clientWidth || 800;
        var n = st.frames.length;
        var pw = w - CL - CR;
        return {w: w, n: n, X: function (j) { return CL + (n ? (j + 0.5) / n : 0.5) * pw; }, pw: pw};
    }

    function drawChart() {
        var frames = st.frames;
        lanesShown = F.LANES.filter(function (L) {
            return frames.some(function (f) { return F.isNum(f[L.key]); });
        });
        var h = TOP + lanesShown.length * (LANE_H + LANE_GAP) + AXIS_H;
        chart.style.height = h + 'px';
        var g = chartGeom();
        var dpr = window.devicePixelRatio || 1;
        chart.width = Math.round(g.w * dpr);
        chart.height = Math.round(h * dpr);
        var ctx = chart.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, g.w, h);
        if (!g.n) return;
        var inFilter = {};
        st.list.forEach(function (i) { inFilter[i] = true; });
        var bandW = Math.max(1, g.pw / g.n);

        lanesShown.forEach(function (L, li) {
            var y0 = TOP + li * (LANE_H + LANE_GAP);
            // фон: режимы
            frames.forEach(function (f, j) {
                if (f.mode === 'dark' || f.mode === 'empty' || f.mode === 'data_check') {
                    ctx.fillStyle = f.mode === 'dark' ? 'rgba(0,0,0,.18)' :
                        f.mode === 'empty' ? 'rgba(91,192,222,.25)' : 'rgba(240,173,78,.35)';
                    ctx.fillRect(g.X(j) - bandW / 2, y0, bandW, LANE_H);
                }
            });
            ctx.strokeStyle = '#ddd';
            ctx.strokeRect(CL + 0.5, y0 + 0.5, g.pw - 1, LANE_H - 1);
            var vals = frames.map(function (f) { return f[L.key]; }).filter(F.isNum);
            if (!vals.length) return;
            var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
            if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
            var Y = function (v) { return y0 + LANE_H - 4 - (v - lo) / (hi - lo) * (LANE_H - 8); };
            ctx.fillStyle = '#333';
            ctx.font = '12px Helvetica, Arial, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(L.name, 4, y0 + LANE_H / 2);
            ctx.fillStyle = '#888';
            ctx.font = '10px Helvetica, Arial, sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(F.fmt(hi, L.digits), CL - 4, y0 + 6);
            ctx.fillText(F.fmt(lo, L.digits), CL - 4, y0 + LANE_H - 6);
            ctx.textAlign = 'left';
            // точки: кадры выбранного типа — ярко, остальные — приглушённо
            frames.forEach(function (f, j) {
                var v = f[L.key];
                if (!F.isNum(v)) return;
                var bad = st.devs.byIndex[j] && st.devs.byIndex[j][L.key];
                ctx.fillStyle = bad ? '#d9534f' : (inFilter[j] ? '#337ab7' : 'rgba(51,122,183,.22)');
                var r = bad ? 3 : 1.5;
                ctx.fillRect(g.X(j) - r, Y(v) - r, 2 * r, 2 * r);
            });
        });
        // ось номеров кадров
        var yAxis = TOP + lanesShown.length * (LANE_H + LANE_GAP);
        ctx.fillStyle = '#555';
        ctx.font = '11px Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var stepN = niceStep(g.n);
        for (var j = 0; j < g.n; j += stepN) ctx.fillText(String(frames[j].num), g.X(j), yAxis + 2);
        ctx.fillText('номер кадра', CL + g.pw / 2, yAxis + 14);
        ctx.textAlign = 'left';
        // текущий кадр
        ctx.strokeStyle = '#337ab7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(g.X(st.idx), TOP);
        ctx.lineTo(g.X(st.idx), yAxis);
        ctx.stroke();
        ctx.lineWidth = 1;
    }

    function niceStep(n) {
        var raw = n / 8;
        var steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
        for (var i = 0; i < steps.length; i++) if (steps[i] >= raw) return steps[i];
        return steps[steps.length - 1];
    }

    function chartIndex(e) {
        var r = chart.getBoundingClientRect();
        var g = chartGeom();
        var x = e.clientX - r.left;
        if (x < CL || x > CL + g.pw || !g.n) return -1;
        return Math.max(0, Math.min(g.n - 1, Math.floor((x - CL) / g.pw * g.n)));
    }

    chart.addEventListener('click', function (e) {
        var j = chartIndex(e);
        if (j >= 0) { stopPlay(); go(j); }
    });
    chart.addEventListener('mousemove', function (e) {
        var j = chartIndex(e);
        if (j < 0) { tip.style.display = 'none'; return; }
        var r = chart.getBoundingClientRect();
        var li = Math.floor((e.clientY - r.top - TOP) / (LANE_H + LANE_GAP));
        var L = lanesShown[li];
        var f = st.frames[j];
        var text = '№ ' + f.num + ' · ' + (F.MODE_NAMES[f.mode] || f.mode);
        if (L) text += ' · ' + (L.key === 'interval' ? F.fmtInterval(f[L.key]) : F.fmt(f[L.key], L.digits) + L.unit);
        tip.textContent = text;
        tip.style.display = 'block';
        tip.style.left = Math.min(e.clientX - r.left + 12, r.width - 220) + 'px';
        tip.style.top = (e.clientY - r.top + 12) + 'px';
    });
    chart.addEventListener('mouseleave', function () { tip.style.display = 'none'; });

    // --- отклонения -------------------------------------------------------------------------------------------

    var DEV_TEXT = {
        current: function (d) { return 'ток ' + F.fmt(d.value, 1) + ' мА (обычно ' + F.fmt(d.median, 1) + ')'; },
        voltage: function (d) { return 'напряжение ' + F.fmt(d.value, 1) + ' кВ (обычно ' + F.fmt(d.median, 1) + ')'; },
        exposure: function (d) { return 'экспозиция ' + F.fmt(d.value, 2) + ' с (обычно ' + F.fmt(d.median, 2) + ')'; },
        interval: function (d) {
            return 'пауза перед кадром ' + F.fmtInterval(d.value) + ' (обычно ' + F.fmtInterval(d.median) + ')';
        }
    };

    function renderDevs() {
        var ul = $('fv-devs');
        ul.innerHTML = '';
        var own = {};
        st.list.forEach(function (i) { own[i] = true; });
        var items = st.devs.list.slice().sort(function (a, b) {
            return (own[b.idx] ? 1 : 0) - (own[a.idx] ? 1 : 0) || a.idx - b.idx;   // свой тип — сверху
        });
        $('fv-dev-count').textContent = items.length ? '(' + items.length + ')' : '';
        if (!items.length) {
            var li0 = document.createElement('li');
            li0.className = 'text-muted';
            li0.textContent = 'нет';
            ul.appendChild(li0);
            return;
        }
        items.forEach(function (d) {
            var f = st.frames[d.idx];
            var li = document.createElement('li');
            li.innerHTML = 'кадр <b></b> — <span></span>';
            li.querySelector('b').textContent = f.num;
            li.querySelector('span').textContent = DEV_TEXT[d.key](d) + (own[d.idx] ? '' : ' · ' + F.MODE_NAMES[f.mode]);
            if (!own[d.idx]) li.className = 'fv-dev-other';
            li.addEventListener('click', function () { stopPlay(); go(d.idx); });
            ul.appendChild(li);
        });
    }

    // --- таблица ----------------------------------------------------------------------------------------------

    var tbody = $('fv-tbody');
    var details = document.querySelector('details.fv-table');
    var tableDirty = true;

    function renderTable() {
        if (!details.open) { tableDirty = true; return; }
        tableDirty = false;
        tbody.innerHTML = '';
        var frag = document.createDocumentFragment();
        st.list.forEach(function (i) {
            var f = st.frames[i];
            var dev = st.devs.byIndex[i] || {};
            var cells = [
                [f.num], [F.MODE_NAMES[f.mode] || f.mode], [f.datetime],
                [F.fmtInterval(f.interval), dev.interval],
                [F.isNum(f.exposure) ? F.fmt(f.exposure, 2) + ' с' : '—', dev.exposure],
                [f.shutter === true ? 'открыта' : f.shutter === false ? 'закрыта' : '—'],
                [F.isNum(f.angle) ? F.fmt(f.angle, 2) + '°' : '—'],
                [F.isNum(f.current) ? F.fmt(f.current, 1) + ' мА' : '—', dev.current],
                [F.isNum(f.voltage) ? F.fmt(f.voltage, 1) + ' кВ' : '—', dev.voltage],
                [f.detector || '—']
            ];
            var tr = document.createElement('tr');
            tr.setAttribute('data-idx', i);
            cells.forEach(function (c) {
                var td = document.createElement('td');
                td.textContent = c[0];
                if (c[1]) td.className = 'fv-warn';
                tr.appendChild(td);
            });
            frag.appendChild(tr);
        });
        tbody.appendChild(frag);
        $('fv-table-count').textContent = st.filter === 'all' ? String(st.frames.length)
            : st.list.length + ' из ' + st.frames.length;
        renderTableCur();
    }

    function renderTableCur() {
        if (!details.open) return;
        if (tableDirty) { renderTable(); return; }
        var prev = tbody.querySelector('tr.fv-cur');
        if (prev) prev.classList.remove('fv-cur');
        var tr = tbody.querySelector('tr[data-idx="' + st.idx + '"]');
        if (tr) tr.classList.add('fv-cur');
    }

    details.addEventListener('toggle', function () { if (details.open) renderTable(); });
    tbody.addEventListener('click', function (e) {
        var tr = e.target.closest('tr');
        if (!tr) return;
        stopPlay();
        go(parseInt(tr.getAttribute('data-idx'), 10));
        $('fv-stage').scrollIntoView({behavior: 'smooth', block: 'center'});
    });

    // --- проигрывание -----------------------------------------------------------------------------------------

    var playTimer = null;

    function schedulePlay() {
        clearTimeout(playTimer);
        // следующий кадр — только после того, как текущий показан (не пропускать кадры)
        playTimer = setTimeout(function () {
            if (!st.playing) return;
            var p = F.nearestPos(st.list, st.idx);
            if (p >= st.list.length - 1) { stopPlay(); return; }
            st.idx = st.list[p + 1];
            st.anchor = st.idx;
            render();
        }, 1000 / parseFloat($('fv-fps').value || '5'));
    }

    function startPlay() {
        if (st.list.length < 2) return;
        if (F.nearestPos(st.list, st.idx) >= st.list.length - 1) st.idx = st.list[0];
        st.playing = true;
        $('fv-play').innerHTML = '&#x23F8; пауза';
        $('fv-play').classList.add('active');
        render();
    }

    function stopPlay() {
        st.playing = false;
        clearTimeout(playTimer);
        $('fv-play').innerHTML = '&#x25B6; пуск';
        $('fv-play').classList.remove('active');
    }

    // --- управление -------------------------------------------------------------------------------------------

    Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (b) {
        b.addEventListener('click', function () {
            stopPlay();
            var v = b.getAttribute('data-go');
            stepBy(v === 'first' || v === 'last' ? v : parseInt(v, 10));
        });
    });
    $('fv-play').addEventListener('click', function () { if (st.playing) stopPlay(); else startPlay(); });
    $('fv-slider').addEventListener('input', function () {
        stopPlay();
        var i = st.list[parseInt(this.value, 10)];
        if (i != null) go(i);
    });
    $('fv-num').addEventListener('change', function () {
        var n = parseInt(this.value, 10);
        for (var i = 0; i < st.frames.length; i++) {
            if (st.frames[i].num === n) { stopPlay(); go(i); return; }
        }
        window.showToast && window.showToast('Кадра № ' + this.value + ' нет', 'warning');
    });
    $('fv-follow').addEventListener('change', function () {
        if (this.checked) { stopPlay(); followLast(); }
    });

    document.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
            && !(t.type === 'range' || t.type === 'checkbox')) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        var k = e.key;
        var handled = true;
        if (k === 'ArrowRight') { stopPlay(); stepBy(e.shiftKey ? 10 : 1); }
        else if (k === 'ArrowLeft') { stopPlay(); stepBy(e.shiftKey ? -10 : -1); }
        else if (k === 'PageDown') { stopPlay(); stepBy(10); }
        else if (k === 'PageUp') { stopPlay(); stepBy(-10); }
        else if (k === 'Home') { stopPlay(); stepBy('first'); }
        else if (k === 'End') { stopPlay(); stepBy('last'); }
        else if (k === ' ') { if (st.playing) stopPlay(); else startPlay(); }
        else if (k >= '1' && k <= '4') { stopPlay(); setFilter(F.FILTERS[parseInt(k, 10) - 1].key); }
        else if (k === '[' || k === ']' || k === 'х' || k === 'ъ') {      // х ъ — те же клавиши в русской раскладке
            stopPlay();
            var j = F.seriesJump(st.frames, st.idx, (k === ']' || k === 'ъ') ? 1 : -1);
            if (j != null) go(j);
        }
        else if (k === 'r' || k === 'R' || k === 'к' || k === 'К') {
            stopPlay();
            var pair = F.checkPair(st.frames, st.idx);
            if (pair != null) go(pair, {keepAnchor: false});
        }
        else handled = false;
        if (handled) e.preventDefault();
    });

    window.addEventListener('resize', function () { drawBand(); drawChart(); });

    // --- данные и живое обновление ----------------------------------------------------------------------------

    function setFrames(frames) {
        st.frames = F.annotate(frames);
        st.devs = F.deviations(st.frames);
        st.list = F.select(st.frames, st.filter);
        renderParams();
        renderDevs();
        tableDirty = true;
    }

    function renderParams() {
        var s = F.summary(st.frames);
        $('p-total').textContent = String(s.total);
        $('p-range').textContent = F.isNum(s.angleMin) ? ' (' + F.fmt(s.angleMin, 1) + '–' + F.fmt(s.angleMax, 1) + '°)' : '';
        $('p-inserts').textContent = s.inserts ? ', вставки ' + s.inserts + ' × ' + s.insertLen +
            (s.counts.data_check ? ' + ' + s.counts.data_check + ' кадр. контроля' : '') : '';
        $('p-source').innerHTML = F.isNum(s.voltage) || F.isNum(s.current)
            ? '<b>Источник</b> ' + F.fmt(s.voltage, 0) + ' кВ, ' + F.fmt(s.current, 1) + ' мА' : '';
        $('p-detector').innerHTML = '';
        if (s.detector) {
            var b = document.createElement('b');
            b.textContent = 'Детектор';
            $('p-detector').appendChild(b);
            $('p-detector').appendChild(document.createTextNode(' ' + s.detector));
        }
    }

    function followLast() {
        if (!st.list.length) return;
        go(st.list[st.list.length - 1], {fromFollow: true});
    }

    function setStatus(text, cls, title) {
        var el = $('rec-status');
        if (!el) return;
        el.textContent = text;
        el.className = 'label ' + cls;
        if (title != null) el.title = title;
    }

    var newBadge = null;
    function showNewBadge() {
        if (!newBadge) {
            newBadge = document.createElement('button');
            newBadge.type = 'button';
            newBadge.className = 'btn btn-info btn-xs fv-new';
            newBadge.addEventListener('click', function () {
                st.newCount = 0;
                newBadge.style.display = 'none';
                stopPlay();
                go(st.list[st.list.length - 1]);
            });
            $('fv-follow-wrap').parentNode.insertBefore(newBadge, $('fv-follow-wrap').nextSibling);
        }
        newBadge.textContent = '+' + st.newCount + ' новых';
        newBadge.title = 'Перейти к последнему кадру выбранного типа';
        newBadge.style.display = st.newCount ? '' : 'none';
    }

    var pollTimer = null;
    function poll() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', cfg.framesUrl);
        xhr.onload = function () {
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (err) { data = null; }
            if (xhr.status === 200 && data && data.frames) {
                var r = F.remap(st.frames, data.frames, st.idx);
                setFrames(data.frames);
                st.idx = r.idx;
                if (r.added) {
                    st.lastGrowth = Date.now();
                    setStatus('съёмка идёт', 'label-info', 'Новые кадры приходят; страница дописывает их раз в ' +
                        cfg.pollSeconds + ' с');
                    if ($('fv-follow').checked) {
                        followLast();
                    } else {
                        st.newCount += r.added;
                        showNewBadge();
                        render();
                    }
                }
                if (data.finished) {
                    st.finished = true;
                    setStatus('завершён', 'label-success', '');
                    $('fv-follow-wrap').style.display = 'none';
                    render();
                    return;                                   // опрос больше не нужен
                }
            }
            schedulePoll();
        };
        xhr.onerror = schedulePoll;
        xhr.send();
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        var quiet = (Date.now() - st.lastGrowth) / 1000 > SLOW_POLL_AFTER_S;
        if (quiet) setStatus('не завершён', 'label-warning', 'Хранилище не отметило эксперимент завершённым; новых кадров нет ' +
            'больше 10 мин — съёмка, вероятно, прервана. Страница проверяет раз в минуту.');
        pollTimer = setTimeout(poll, 1000 * (quiet ? SLOW_POLL_S : cfg.pollSeconds));
    }

    // --- старт ------------------------------------------------------------------------------------------------

    setFrames(JSON.parse(framesEl.textContent));
    var m = /[#&]frame=(\d+)/.exec(location.hash);
    var start = 0;
    if (m) {
        st.frames.forEach(function (f, i) { if (f.num === parseInt(m[1], 10)) start = i; });
    }
    st.idx = st.anchor = start;
    if (st.finished) {
        $('fv-follow-wrap').style.display = 'none';
    } else {
        // идущая съёмка: по умолчанию следить за последним кадром
        $('fv-follow').checked = true;
        if (!m && st.list.length) st.idx = st.anchor = st.list[st.list.length - 1];
        st.lastGrowth = Date.now();
        schedulePoll();
    }
    render();
})();
