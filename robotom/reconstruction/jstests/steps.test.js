'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'steps.js', 'jobs.js', 'session.js');
const derive = S.steps.derive;

function base(over) {
    return Object.assign({
        overview: 'ready', roiEdited: false, load: 'none', roiDirty: false, axis: 'none', ringsChosen: false,
        smoothingChosen: false, runEdited: false, job: null, result: 'none'
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

test('шаг 3: «проверено» — выбран пресет колец или тронуто сглаживание; иначе «авто»', () => {
    assert.equal(derive(base({load: 'ready', axis: 'auto'})).rings.code, 'auto');
    assert.equal(derive(base({load: 'ready', axis: 'auto', smoothingChosen: true})).rings.code, 'checked');
    assert.equal(derive(base({load: 'ready', axis: 'auto', ringsChosen: true})).rings.code, 'checked');
    assert.equal(derive(base({smoothingChosen: true})).rings.code, 'none');          // область не загружена
    assert.equal(derive(base({load: 'lost', smoothingChosen: true})).rings.code, 'stale');
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

test('jobs: строка статуса в шапке — состояния, остаток по оценке при запуске, сутки после конца', () => {
    const J = S.jobs;
    const t0 = Date.parse('2026-10-07T12:00:00Z');
    const run = {status: 'running', stage: 'recon', progress: 0.42, started: '2026-10-07T12:00:00Z',
        created: '2026-10-07T11:59:00Z'};
    // остаток — оценка минус прошло со старта (очередь не считается)
    assert.equal(J.remaining(run, 600, t0 + 190e3), 410);
    assert.equal(J.remaining(run, null, t0 + 190e3), null);
    assert.equal(J.remaining({status: 'queued'}, 600, t0), null);
    let h = J.headState(run, 600, t0 + 190e3);
    assert.equal(h.state, 'running');
    assert.equal(h.action, 'step');
    assert.equal(h.frac, 0.42);
    assert.match(h.text, /^реконструкция срезов · 42 % · прошло 3 мин 10 с · ≈ 6 мин 50 с осталось$/);
    assert.match(J.headState(run, 100, t0 + 190e3).text, /дольше оценки на 1 мин 30 с$/);
    assert.match(J.headState(run, null, t0 + 190e3).text, /прошло 3 мин 10 с$/);
    assert.equal(J.headState({status: 'queued'}, null, t0).state, 'queued');
    const done = {status: 'done', started: '2026-10-07T12:00:00Z', finished: '2026-10-07T12:07:40Z'};
    h = J.headState(done, 600, t0 + 3600e3);
    assert.equal(h.state, 'done');
    assert.equal(h.action, 'result');
    assert.match(h.text, /^✓ Готово .+ \(7 мин 40 с\)$/);
    assert.equal(J.headState(done, 600, t0 + 25 * 3600e3), null);   // больше суток — не показывать
    assert.equal(J.headState({status: 'error', finished: '2026-10-07T12:01:00Z'}, null, t0 + 60e3).state, 'error');
    assert.equal(J.headState({status: 'interrupted', finished: '2026-10-07T12:01:00Z'}, null, t0).state, 'error');
    assert.equal(J.headState({status: 'canceled', finished: '2026-10-07T12:01:00Z'}, null, t0).state, 'canceled');
    assert.equal(J.headState(null), null);
});

test('steps: процент идущей задачи в статусе шага 4', () => {
    const d = S.steps.derive;
    const s = {overview: 'ready', roiEdited: false, load: 'ready', roiDirty: false, axis: 'checked', ringsChosen: true,
        smoothingChosen: false, denoiseChosen: false, runEdited: true, result: 'none'};
    assert.equal(d(Object.assign({}, s, {job: {status: 'running', progress: 0.416}})).run.text, 'идёт 42 %');
    assert.equal(d(Object.assign({}, s, {job: {status: 'queued'}})).run.text, 'в очереди');
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
