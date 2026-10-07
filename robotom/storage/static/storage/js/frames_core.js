/* Просмотрщик кадров записи хранилища — чистая логика без DOM: разметка кадров по сериям, фильтр по типу кадра,
 * листание по отфильтрованной последовательности, отклонения параметров от медианы своего режима, слияние списка при
 * живом обновлении. Проверяется node-тестами (robotom/storage/jstests/).
 *
 * Кадр — объект из storage_record_view / frames_json: {id, num, mode, datetime, t, exposure, shutter, angle, current,
 * voltage, detector}. Режимы драйверов: dark, empty, data и data_check — кадры контроля, снятые сразу после вставки
 * пустого пучка на том же угле, что последний кадр проекции перед ней (rbtm-drivers-next experiment.py). */
(function (root) {
    'use strict';
    var F = root.StorageFrames = root.StorageFrames || {};

    F.MODE_NAMES = {dark: 'темновой', empty: 'пустой пучок', data: 'проекция', data_check: 'контроль после вставки'};

    // Фильтры: ключ, подпись кнопки, клавиша, какие режимы входят
    F.FILTERS = [
        {key: 'all', label: 'все', digit: '1', modes: null},
        {key: 'data', label: 'проекции', digit: '2', modes: ['data', 'data_check']},
        {key: 'empty', label: 'пустой пучок', digit: '3', modes: ['empty']},
        {key: 'dark', label: 'темновые', digit: '4', modes: ['dark']}
    ];
    F.filterByKey = function (key) {
        for (var i = 0; i < F.FILTERS.length; i++) {
            if (F.FILTERS[i].key === key) return F.FILTERS[i];
        }
        return F.FILTERS[0];
    };

    function isNum(v) {
        return typeof v === 'number' && isFinite(v);
    }
    F.isNum = isNum;

    function median(values) {
        var s = values.filter(isNum).sort(function (a, b) { return a - b; });
        if (!s.length) return null;
        var m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    F.median = median;

    /* Разметка по порядку кадров (список уже по возрастанию номера):
     *   interval — секунды от предыдущего кадра (по времени съёмки), у первого — null;
     *   series   — номер серии своего режима: непрерывный отрезок кадров одного режима (у пустого пучка 0 — начальная,
     *              k — k-я вставка; у data_check — номер вставки, после которой снят);
     *   inSeries — позиция в серии с 0, seriesLen — длина серии (у последней серии во время съёмки может расти);
     *   anchor   — у data_check: индекс последнего кадра проекции перед вставкой (тот же угол). */
    F.annotate = function (frames) {
        var runs = {};              // режим → число начатых серий
        var runStart = 0;
        var lastData = -1;
        var inserts = 0;            // вставок пустого пучка после начала проекций
        for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            var prev = i > 0 ? frames[i - 1] : null;
            f.index = i;
            f.interval = prev && isNum(f.t) && isNum(prev.t) ? f.t - prev.t : null;
            if (!prev || prev.mode !== f.mode) {
                runs[f.mode] = (runs[f.mode] || 0) + 1;
                runStart = i;
                if (f.mode === 'empty' && lastData >= 0) inserts += 1;
            }
            f.series = runs[f.mode] - 1;
            f.inSeries = i - runStart;
            if (f.mode === 'data') lastData = i;
            f.anchor = f.mode === 'data_check' && lastData >= 0 ? lastData : null;
            if (f.mode === 'data_check') f.series = inserts;
        }
        // длины серий — вторым проходом
        var start = 0;
        for (var j = 1; j <= frames.length; j++) {
            if (j === frames.length || frames[j].mode !== frames[j - 1].mode) {
                for (var k = start; k < j; k++) frames[k].seriesLen = j - start;
                start = j;
            }
        }
        return frames;
    };

    /* Сводка для строки параметров: число кадров по режимам и вставок пустого пучка (по самим кадрам). */
    F.summary = function (frames) {
        var counts = {dark: 0, empty: 0, data: 0, data_check: 0};
        var emptyRuns = [];
        var seenData = false;
        for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            counts[f.mode] = (counts[f.mode] || 0) + 1;
            if (f.mode === 'data') seenData = true;
            if (f.mode === 'empty' && seenData && (i === 0 || frames[i - 1].mode !== 'empty')) emptyRuns.push(0);
            if (f.mode === 'empty' && seenData) emptyRuns[emptyRuns.length - 1] += 1;
        }
        var angles = frames.filter(function (f) { return f.mode === 'data' && isNum(f.angle); })
            .map(function (f) { return f.angle; });
        return {
            total: frames.length,
            counts: counts,
            inserts: emptyRuns.length,
            insertLen: emptyRuns.length ? median(emptyRuns) : null,
            angleMin: angles.length ? Math.min.apply(null, angles) : null,
            angleMax: angles.length ? Math.max.apply(null, angles) : null,
            voltage: median(frames.filter(function (f) { return f.mode === 'data'; }).map(function (f) { return f.voltage; })),
            current: median(frames.filter(function (f) { return f.mode === 'data'; }).map(function (f) { return f.current; })),
            detector: (frames.filter(function (f) { return f.detector; })[0] || {}).detector || ''
        };
    };

    /* Индексы кадров, входящих в фильтр (по возрастанию). */
    F.select = function (frames, filterKey) {
        var modes = F.filterByKey(filterKey).modes;
        var out = [];
        for (var i = 0; i < frames.length; i++) {
            if (!modes || modes.indexOf(frames[i].mode) >= 0) out.push(i);
        }
        return out;
    };

    F.filterOfMode = function (mode) {
        for (var i = 1; i < F.FILTERS.length; i++) {
            if (F.FILTERS[i].modes.indexOf(mode) >= 0) return F.FILTERS[i].key;
        }
        return 'all';
    };

    /* Позиция в списке индексов, ближайшая к кадру idx: сам кадр, иначе ближайший по номеру; при равенстве — более
     * ранний. -1 — список пуст. */
    F.nearestPos = function (list, idx) {
        if (!list.length) return -1;
        var lo = 0, hi = list.length - 1;
        while (lo < hi) {                     // первый элемент >= idx
            var mid = (lo + hi) >> 1;
            if (list[mid] < idx) lo = mid + 1; else hi = mid;
        }
        if (list[lo] === idx) return lo;
        if (list[lo] < idx) return lo;        // все меньше idx
        if (lo === 0) return 0;
        return (idx - list[lo - 1] <= list[lo] - idx) ? lo - 1 : lo;
    };

    /* Шаг по отфильтрованному списку от кадра idx на d позиций; 'first' / 'last' — края. Возвращает индекс кадра. */
    F.step = function (list, idx, d) {
        if (!list.length) return idx;
        if (d === 'first') return list[0];
        if (d === 'last') return list[list.length - 1];
        var p = F.nearestPos(list, idx);
        if (list[p] !== idx && d !== 0) {
            // текущий кадр не в фильтре: первый шаг — на ближайший в нужную сторону
            if (d > 0 && list[p] < idx) p += 1;
            if (d < 0 && list[p] > idx) p -= 1;
            d = d > 0 ? d - 1 : d + 1;
        }
        p = Math.max(0, Math.min(list.length - 1, p + d));
        return list[p];
    };

    /* Та же позиция в соседней серии того же режима (клавиши [ и ]): dir = ±1. null — соседней серии нет. */
    F.seriesJump = function (frames, idx, dir) {
        var f = frames[idx];
        if (!f) return null;
        var target = f.series + dir;
        var best = null;
        for (var i = 0; i < frames.length; i++) {
            var g = frames[i];
            if (g.mode === f.mode && g.series === target) {
                best = i;
                if (g.inSeries >= f.inSeries) break;   // та же позиция или последняя в более короткой серии
            }
        }
        return best;
    };

    /* Кадр контроля ↔ кадр проекции на том же угле перед вставкой (клавиша R). null — пары нет. */
    F.checkPair = function (frames, idx) {
        var f = frames[idx];
        if (!f) return null;
        if (f.mode === 'data_check') return f.anchor;
        if (f.mode === 'data') {
            for (var i = idx + 1; i < frames.length; i++) {
                if (frames[i].mode === 'data') return null;
                if (frames[i].mode === 'data_check' && frames[i].anchor === idx) return i;
            }
        }
        return null;
    };

    // Дорожки графика и пороги отклонений (пороги — предложение плана, подбирать по реальным сканам)
    F.LANES = [
        {key: 'angle', name: 'Угол, °', unit: '°', digits: 2},
        {key: 'current', name: 'Ток, мА', unit: ' мА', digits: 1, rel: 0.02},
        {key: 'voltage', name: 'Напряжение, кВ', unit: ' кВ', digits: 1, rel: 0.02},
        {key: 'exposure', name: 'Экспозиция, с', unit: ' с', digits: 2, rel: 0.01},
        {key: 'interval', name: 'Интервал, с', unit: ' с', digits: 0, times: 3}
    ];

    function modeGroup(mode) {
        return mode === 'data_check' ? 'data' : mode;
    }

    /* Отклонения: ток и напряжение — больше 2 % от медианы своего режима, экспозиция — больше 1 %, интервал — больше
     * чем в 3 раза. Интервал сравнивается только внутри серии (предыдущий кадр того же режима): на смене режима
     * двигатель отводит или возвращает образец, и долгий интервал там ожидаем.
     * Возвращает {byIndex: {idx: {key: {value, median}}}, list: [{idx, key, value, median}]}. */
    F.deviations = function (frames) {
        var byIndex = {};
        var list = [];
        F.LANES.forEach(function (L) {
            if (!L.rel && !L.times) return;
            var groups = {};
            frames.forEach(function (f, i) {
                if (L.key === 'interval' && (i === 0 || frames[i - 1].mode !== f.mode)) return;
                var g = modeGroup(f.mode);
                (groups[g] = groups[g] || []).push(f[L.key]);
            });
            var med = {};
            Object.keys(groups).forEach(function (g) { med[g] = median(groups[g]); });
            frames.forEach(function (f, i) {
                var v = f[L.key];
                var m = med[modeGroup(f.mode)];
                if (!isNum(v) || !isNum(m)) return;
                if (L.key === 'interval' && (i === 0 || frames[i - 1].mode !== f.mode)) return;
                var bad = L.rel ? Math.abs(v - m) > L.rel * Math.abs(m) : (m > 0 && v > L.times * m);
                if (!bad) return;
                (byIndex[i] = byIndex[i] || {})[L.key] = {value: v, median: m};
                list.push({idx: i, key: L.key, value: v, median: m});
            });
        });
        list.sort(function (a, b) { return a.idx - b.idx; });
        return {byIndex: byIndex, list: list};
    };

    /* Новый список кадров при живом обновлении: индекс текущего кадра в новом списке (по id; кадр исчез — ближайший
     * по номеру) и число добавленных кадров. */
    F.remap = function (oldFrames, newFrames, idx) {
        var cur = oldFrames[idx];
        var oldIds = {};
        oldFrames.forEach(function (f) { oldIds[f.id] = true; });
        var added = newFrames.filter(function (f) { return !oldIds[f.id]; }).length;
        var newIdx = 0;
        if (cur) {
            var found = -1;
            for (var i = 0; i < newFrames.length; i++) {
                if (newFrames[i].id === cur.id) { found = i; break; }
            }
            if (found < 0) {
                var best = Infinity;
                newFrames.forEach(function (f, j) {
                    var d = Math.abs((f.num || 0) - (cur.num || 0));
                    if (d < best) { best = d; found = j; }
                });
            }
            newIdx = Math.max(0, found);
        }
        return {idx: newIdx, added: added};
    };

    // --- форматирование ---------------------------------------------------------------------------------------

    F.fmt = function (v, digits) {
        if (!isNum(v)) return '—';
        return v.toFixed(digits).replace('.', ',').replace('-', '−');
    };

    F.fmtInterval = function (s) {
        if (!isNum(s)) return '—';
        if (s < 100) return F.fmt(s, s < 10 ? 1 : 0) + ' с';
        var m = Math.floor(s / 60);
        return m + ' мин ' + Math.round(s - 60 * m) + ' с';
    };

    /* «проекция 123 из 407», «серия 3 из 8 · кадр 2 из 5» */
    F.positionText = function (frames, list, idx, filterKey) {
        var f = frames[idx];
        if (!f) return '';
        var p = list.indexOf(idx);
        var parts = [];
        if (filterKey !== 'all' && p >= 0) {
            parts.push(F.filterByKey(filterKey).label + ': ' + (p + 1) + ' из ' + list.length);
        }
        if (f.mode === 'empty' || f.mode === 'dark') {
            var nSeries = 0;
            frames.forEach(function (g) { if (g.mode === f.mode) nSeries = Math.max(nSeries, g.series + 1); });
            if (nSeries > 1) parts.push(f.series === 0 ? 'начальная серия' : 'вставка ' + f.series + ' из ' + (nSeries - 1));
            parts.push('кадр ' + (f.inSeries + 1) + ' из ' + f.seriesLen + ' в серии');
        }
        if (f.mode === 'data_check') parts.push('после вставки ' + f.series);
        return parts.join(' · ');
    };

})(typeof window !== 'undefined' ? window : globalThis);
