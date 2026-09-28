'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'steps.js', 'jobs.js', 'session.js');
const derive = S.steps.derive;

function base(over) {
    return Object.assign({
        overview: 'ready', roiEdited: false, load: 'none', roiDirty: false, axis: 'none', ringsChosen: false,
        runEdited: false, job: null, result: 'none'
    }, over);
}

function codes(st) {
    const d = derive(st);
    return [d.fov.code, d.axis.code, d.rings.code, d.run.code, d.result.code];
}

test('открытие страницы: обзор идёт, потом предложенная рамка — «авто»', () => {
    assert.deepEqual(codes(base({overview: 'loading', result: 'unknown'})), ['running', 'none', 'none', 'none', 'none']);
    assert.deepEqual(codes(base()), ['auto', 'none', 'none', 'none', 'none']);
    assert.equal(derive(base()).fov.text, 'авто');
    assert.equal(derive(base({overview: 'error'})).fov.code, 'error');
});

test('правка рамки до загрузки — «проверено», шаги 2–4 ещё «—»', () => {
    assert.deepEqual(codes(base({roiEdited: true})), ['checked', 'none', 'none', 'none', 'none']);
});

test('загрузка → ось → срез: статусы по шагам', () => {
    assert.deepEqual(codes(base({load: 'loading'})), ['running', 'none', 'none', 'none', 'none']);
    assert.deepEqual(codes(base({load: 'ready', axis: 'running'})), ['checked', 'running', 'auto', 'auto', 'none']);
    assert.deepEqual(codes(base({load: 'ready', axis: 'auto'})), ['checked', 'auto', 'auto', 'auto', 'none']);
    assert.deepEqual(codes(base({load: 'ready', axis: 'checked', ringsChosen: true, runEdited: true})),
        ['checked', 'checked', 'checked', 'checked', 'none']);
    assert.equal(derive(base({load: 'error'})).fov.code, 'error');
});

test('рамка изменена после загрузки или сессия потеряна — шаги 2–4 «устарело»', () => {
    const dirty = derive(base({load: 'ready', roiDirty: true, axis: 'auto'}));
    assert.deepEqual([dirty.axis.code, dirty.rings.code, dirty.run.code], ['stale', 'stale', 'stale']);
    assert.match(dirty.axis.hint, /рамка изменена/);
    assert.equal(dirty.axis.text, 'устарело');
    const lost = derive(base({load: 'lost', axis: 'auto'}));
    assert.deepEqual([lost.axis.code, lost.rings.code, lost.run.code], ['stale', 'stale', 'stale']);
    assert.match(lost.run.hint, /сессия закрыта/);
});

test('задача: активная — «идёт…» даже при устаревшей рамке; ошибка; результат', () => {
    assert.equal(derive(base({job: {status: 'running'}})).run.code, 'running');
    assert.equal(derive(base({load: 'lost', job: {status: 'queued'}})).run.code, 'running');
    assert.equal(derive(base({job: {status: 'error'}})).run.code, 'error');
    assert.equal(derive(base({job: {status: 'done'}})).run.code, 'none');
    assert.equal(derive(base({load: 'ready', job: {status: 'done'}})).run.code, 'auto');
    const r = derive(base({result: 'ready'})).result;
    assert.equal(r.code, 'checked');
    assert.equal(r.text, 'есть');
    assert.equal(derive(base({result: 'loading'})).result.code, 'running');
});

test('jobs: активность, интервал опроса, длительность, подписи', () => {
    const J = S.jobs;
    assert.ok(J.isActive('queued') && J.isActive('running') && J.isActive('publishing'));
    assert.ok(!J.isActive('done') && !J.isActive('error') && !J.isActive(undefined));
    assert.equal(J.pollDelay(false), 1500);
    assert.equal(J.pollDelay(true), 5000);
    assert.equal(J.elapsed({started: '2026-09-28T10:00:00+00:00', finished: '2026-09-28T10:02:30+00:00'}), 150);
    assert.equal(J.elapsed({created: '2026-09-28T10:00:00+00:00'}, Date.parse('2026-09-28T10:00:10Z')), 10);
    assert.equal(J.elapsed({}), null);
    assert.equal(J.statusText('publishing'), 'перенос в хранилище');
    assert.equal(J.stageText('wait_gpu').indexOf('ждёт GPU'), 0);
    assert.equal(J.stageText('unknown_stage'), 'unknown_stage');
});

test('session: ошибки, означающие потерю сессии', () => {
    const is = S.SessionCtl.isSessionError;
    assert.ok(is({status: 410, code: 'taken_over'}));
    assert.ok(is({status: 404, code: 'not_found'}));
    assert.ok(is({status: 403, code: 'forbidden'}));
    assert.ok(!is({status: 404, code: 'скан e1 не найден'}));
    assert.ok(!is({status: 409, code: 'not_ready'}));
    assert.ok(!is(null));
});
