// Логика просмотрщика кадров записи хранилища: `node --test robotom/storage/jstests/`
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require(path.join(__dirname, '..', 'static', 'storage', 'js', 'frames_core.js'));
const F = globalThis.StorageFrames;

/* Продвинутый режим как у драйверов: dark ×s, empty ×s, затем по углам data; после каждых period углов (кроме
 * последнего) — empty ×s и data_check на том же угле. Время — 12 с на кадр, на смене режима 30 с. */
function advanced({s = 2, total = 6, period = 2, step = 0.5} = {}) {
    const frames = [];
    let t = 1000, num = 0;
    const add = (mode, angle) => {
        const prev = frames[frames.length - 1];
        t += prev && prev.mode !== mode ? 30 : 12;
        frames.push({id: 'f' + num, num: num++, mode, t, angle, exposure: 10, current: 40, voltage: 40,
            shutter: mode !== 'dark', detector: 'MH110XC-KK-FA', datetime: ''});
    };
    for (let i = 0; i < s; i++) add('dark', 0);
    for (let i = 0; i < s; i++) add('empty', 0);
    for (let p = 0; p < total; p++) {
        add('data', p * step);
        if (p !== total - 1 && (p + 1) % period === 0) {
            for (let i = 0; i < s; i++) add('empty', p * step);
            add('data_check', p * step);
        }
    }
    return F.annotate(frames);
}

test('счёт кадров как у драйверов и сводка', () => {
    // 2 + 2 + 6 + 2 вставки × 2 + 2 контроля = 16
    const fr = advanced();
    assert.equal(fr.length, 16);
    const s = F.summary(fr);
    assert.deepEqual(s.counts, {dark: 2, empty: 6, data: 6, data_check: 2});
    assert.equal(s.inserts, 2);
    assert.equal(s.insertLen, 2);
    assert.equal(s.angleMin, 0);
    assert.equal(s.angleMax, 2.5);
});

test('a82d2e0a по описанию режима: 452 кадра, проекции с контролем 407, пустых 40', () => {
    const fr = advanced({s: 5, total: 400, period: 50});
    assert.equal(fr.length, 452);
    assert.equal(F.select(fr, 'data').length, 407);
    assert.equal(F.select(fr, 'empty').length, 40);
    assert.equal(F.select(fr, 'dark').length, 5);
    assert.equal(F.summary(fr).inserts, 7);
});

test('серии пустого пучка и контроль после вставки', () => {
    const fr = advanced();
    const empties = fr.filter(f => f.mode === 'empty');
    assert.deepEqual(empties.map(f => f.series), [0, 0, 1, 1, 2, 2]);
    assert.deepEqual(empties.map(f => f.inSeries), [0, 1, 0, 1, 0, 1]);
    const checks = fr.filter(f => f.mode === 'data_check');
    assert.deepEqual(checks.map(f => f.series), [1, 2]);
    // контроль — на угле последней проекции перед вставкой
    checks.forEach(c => assert.equal(fr[c.anchor].angle, c.angle));
    assert.equal(F.checkPair(fr, checks[0].index), checks[0].anchor);
    assert.equal(F.checkPair(fr, checks[0].anchor), checks[0].index);
    assert.equal(F.checkPair(fr, 4), null);                // первая проекция: вставки после неё нет
});

test('интервал — от предыдущего кадра, у первого нет', () => {
    const fr = advanced();
    assert.equal(fr[0].interval, null);
    assert.equal(fr[1].interval, 12);
    assert.equal(fr[2].interval, 30);                      // смена режима
});

test('ближайшая позиция в фильтре: сам кадр, иначе ближайший, при равенстве — ранний', () => {
    const list = [2, 3, 10, 11];
    assert.equal(F.nearestPos(list, 10), 2);
    assert.equal(F.nearestPos(list, 5), 1);
    assert.equal(F.nearestPos(list, 8), 2);
    assert.equal(F.nearestPos(list, 0), 0);
    assert.equal(F.nearestPos(list, 50), 3);
    assert.equal(F.nearestPos([4, 8], 6), 0);             // равенство — более ранний
    assert.equal(F.nearestPos([], 3), -1);
});

test('шаг по фильтру: соседний кадр того же типа, края, кадр вне фильтра', () => {
    const list = [2, 3, 10, 11];
    assert.equal(F.step(list, 3, 1), 10);
    assert.equal(F.step(list, 3, -1), 2);
    assert.equal(F.step(list, 2, -10), 2);
    assert.equal(F.step(list, 3, 10), 11);
    assert.equal(F.step(list, 3, 'first'), 2);
    assert.equal(F.step(list, 3, 'last'), 11);
    // текущий кадр 5 не в фильтре: вперёд — 10, назад — 3
    assert.equal(F.step(list, 5, 1), 10);
    assert.equal(F.step(list, 5, -1), 3);
    assert.equal(F.step(list, 5, 2), 11);
});

test('фильтр «проекции» включает кадры контроля; тип кадра → фильтр', () => {
    const fr = advanced();
    const data = F.select(fr, 'data');
    assert.ok(data.every(i => fr[i].mode === 'data' || fr[i].mode === 'data_check'));
    assert.equal(F.select(fr, 'all').length, fr.length);
    assert.equal(F.filterOfMode('data_check'), 'data');
    assert.equal(F.filterOfMode('empty'), 'empty');
    assert.equal(F.filterOfMode('dark'), 'dark');
});

test('та же позиция в соседней серии пустого пучка', () => {
    const fr = advanced({s: 3});
    const firstSeries = fr.filter(f => f.mode === 'empty' && f.series === 0);
    const j = F.seriesJump(fr, firstSeries[1].index, 1);
    assert.equal(fr[j].series, 1);
    assert.equal(fr[j].inSeries, 1);
    assert.equal(F.seriesJump(fr, firstSeries[1].index, -1), null);
});

test('отклонения: ток, экспозиция, пауза внутри серии; смена режима — не пауза', () => {
    const fr = advanced({s: 3, total: 20, period: 5});
    const iData = fr.findIndex(f => f.mode === 'data' && f.angle === 3);
    fr[iData].current = 38.6;                              // на 3,5 % ниже медианы 40
    const iExp = fr.findIndex(f => f.mode === 'data' && f.angle === 4);
    fr[iExp].exposure = 10.2;                              // на 2 % выше
    const iPause = fr.findIndex(f => f.mode === 'data' && f.angle === 6);
    for (let k = iPause; k < fr.length; k++) fr[k].t += 95;   // пауза 95 с перед кадром
    F.annotate(fr);
    const d = F.deviations(fr);
    const keys = d.list.map(x => fr[x.idx].num + ':' + x.key);
    assert.deepEqual(keys.sort(), [fr[iData].num + ':current', fr[iExp].num + ':exposure', fr[iPause].num + ':interval'].sort());
    assert.equal(d.byIndex[iData].current.median, 40);
});

test('живое обновление: текущий кадр сохраняется, считаются добавленные', () => {
    const old = advanced({total: 4});
    const fresh = advanced({total: 6});
    const r = F.remap(old, fresh, 5);
    assert.equal(fresh[r.idx].id, old[5].id);
    assert.equal(r.added, fresh.length - old.length);
    // кадр исчез — ближайший по номеру
    const r2 = F.remap([{id: 'x', num: 7}], fresh, 0);
    assert.equal(fresh[r2.idx].num, 7);
});

test('подпись позиции', () => {
    const fr = advanced();
    const list = F.select(fr, 'empty');
    const e = fr.find(f => f.mode === 'empty' && f.series === 2 && f.inSeries === 1);
    assert.equal(F.positionText(fr, list, e.index, 'empty'),
        'пустой пучок: 6 из 6 · вставка 2 из 2 · кадр 2 из 2 в серии');
    const c = fr.find(f => f.mode === 'data_check');
    assert.match(F.positionText(fr, F.select(fr, 'data'), c.index, 'data'), /после вставки 1$/);
});

test('форматирование: запятая, минус, интервалы', () => {
    assert.equal(F.fmt(38.6, 1), '38,6');
    assert.equal(F.fmt(-0.5, 1), '−0,5');
    assert.equal(F.fmt(null, 1), '—');
    assert.equal(F.fmtInterval(12), '12 с');
    assert.equal(F.fmtInterval(2.5), '2,5 с');
    assert.equal(F.fmtInterval(125), '2 мин 5 с');
});
