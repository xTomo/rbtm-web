'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load} = require('./load');

const S = load('core.js', 'api.js');

const toasts = [];
globalThis.showToast = (msg, type) => toasts.push({msg, type});

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

/** fetch-заглушка: handler(url, init) → Response | Promise; запросы копятся в calls. */
function mockFetch(handler) {
    const calls = [];
    globalThis.fetch = (url, init) => {
        calls.push({url, init});
        return Promise.resolve().then(() => handler(url, init));
    };
    return calls;
}

/** Ответ, который ждёт отмены (AbortController) или ручного resolve. */
function pendingResponse(init) {
    let resolve;
    const p = new Promise((res, rej) => {
        resolve = res;
        if (init && init.signal) {
            init.signal.addEventListener('abort', () => {
                const e = new Error('aborted');
                e.name = 'AbortError';
                rej(e);
            });
        }
    });
    p.resolve = resolve;
    return p;
}

const api = S.api.create({api_base: '/studio/api/', csrf_token: 'tok'});

test('url: префикс, параметры без пустых значений, 0 сохраняется', () => {
    assert.equal(api.url('scans/e1/outside', {x0: 0, x1: 10, y0: null, y1: undefined, z: ''}),
        '/studio/api/scans/e1/outside?x0=0&x1=10');
    assert.equal(api.url('/jobs', {exp_id: 'a b'}), '/studio/api/jobs?exp_id=a%20b');
    assert.equal(S.api.create({api_base: '/x'}).url('y'), '/x/y');
});

test('getJSON и postJSON: заголовки, CSRF, тело JSON', async () => {
    const calls = mockFetch(() => jsonResponse(200, {ok: true}));
    assert.deepEqual(await api.getJSON('scans/e1/info'), {ok: true});
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);
    assert.equal(calls[0].init.headers['X-CSRFToken'], undefined);
    await api.postJSON('sessions', {exp_id: 'e1'});
    const c = calls[1];
    assert.equal(c.url, '/studio/api/sessions');
    assert.equal(c.init.method, 'POST');
    assert.equal(c.init.headers['X-CSRFToken'], 'tok');
    assert.equal(c.init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(c.init.body), {exp_id: 'e1'});
});

test('getBinary: декодирование заголовков ответа', async () => {
    mockFetch(() => new Response(new Uint16Array([1, 2, 3, 4, 5, 6]).buffer, {
        status: 200,
        headers: {'X-Shape': '2,3', 'X-Dtype': 'uint16', 'X-Scale': '0.5', 'X-Offset': '1', 'X-Meta': '{"bin":4}'}
    }));
    const img = await api.getBinary('scans/e1/envelope');
    assert.equal(img.w, 3);
    assert.equal(img.h, 2);
    assert.equal(img.meta.bin, 4);
    assert.equal(S.core.valueAt(img, 2, 1), 6 * 0.5 + 1);
});

test('postBinary: POST с телом JSON и CSRF, ответ — стопка (k, h, w)', async () => {
    const calls = mockFetch(() => new Response(new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, {
        status: 200,
        headers: {'X-Shape': '2,2,2', 'X-Dtype': 'uint16', 'X-Scale': '0.25', 'X-Offset': '0',
            'X-Meta': '{"region":[0,0,2,2],"metrics":[{"noise":0.1},{"noise":0.2}]}'}
    }));
    const body = {row: 5, region: null, variants: [{rings: 'off', smoothing: null}, {rings: 'weak', smoothing: null}]};
    const img = await api.postBinary('sessions/abc/compare', body);
    assert.equal(calls[0].url, '/studio/api/sessions/abc/compare');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-CSRFToken'], 'tok');
    assert.equal(calls[0].init.headers['Accept'], 'application/octet-stream');
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
    assert.equal(img.k, 2);
    assert.equal(img.w, 2);
    assert.equal(img.meta.metrics[1].noise, 0.2);
    assert.equal(S.core.valueAt(S.core.frameOf(img, 1), 1, 1), 8 * 0.25);
});

test('ошибка JSON {error}: ApiError с кодом, уведомление; expect — без уведомления', async () => {
    toasts.length = 0;
    mockFetch(() => jsonResponse(409, {error: 'busy', owner: 'ivan', exp_id: 'e2', idle_s: 12}));
    await assert.rejects(api.postJSON('sessions', {}), (err) => {
        assert.equal(err.name, 'ApiError');
        assert.equal(err.status, 409);
        assert.equal(err.code, 'busy');
        assert.equal(err.body.owner, 'ivan');
        return true;
    });
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].msg, /занята пользователем ivan/);
    assert.equal(toasts[0].type, 'error');
    await assert.rejects(api.postJSON('sessions', {}, {expect: ['busy']}));
    await assert.rejects(api.postJSON('sessions', {}, {expect: [409]}));
    assert.equal(toasts.length, 1);
});

test('409 superseded — молча (silent), не показывается', async () => {
    toasts.length = 0;
    mockFetch(() => jsonResponse(409, {error: 'superseded', detail: 'старее'}));
    await assert.rejects(api.getBinary('sessions/x/slice'), (err) => err.silent === true);
    assert.equal(toasts.length, 0);
});

test('не JSON вместо JSON (страница входа) — понятная ошибка; тело не JSON при ошибке', async () => {
    toasts.length = 0;
    mockFetch(() => new Response('<html>login</html>', {status: 200, headers: {'Content-Type': 'text/html'}}));
    await assert.rejects(api.getJSON('jobs', null, {quiet: true}), /не JSON/);
    mockFetch(() => new Response('Bad gateway', {status: 502, statusText: 'Bad Gateway'}));
    await assert.rejects(api.getJSON('jobs'), (err) => err.status === 502 && err.code === null);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].msg, /502/);
});

test('getText: лог задачи как текст', async () => {
    mockFetch(() => new Response('строка 1\nстрока 2\n', {status: 200, headers: {'Content-Type': 'text/plain'}}));
    assert.equal(await api.getText('jobs/abc/log', {lines: 10}), 'строка 1\nстрока 2\n');
});

test('report: один раз на ошибку', () => {
    toasts.length = 0;
    const err = new S.api.ApiError(500, {error: 'сбой'}, 'сбой');
    api.report(err, 'Срез');
    api.report(err, 'Срез');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].msg, 'Срез: сбой');
});

// --- канал ----------------------------------------------------------------------------------------------------

test('канал: новый запрос отменяет прежний (STALE), seq растёт, busy', async () => {
    const pend = [];
    mockFetch((url, init) => {
        const p = pendingResponse(init);
        pend.push(p);
        return p;
    });
    const busy = [];
    const ch = api.channel({onBusy: (b) => busy.push(b)});
    const seqs = [];
    const r1 = ch.run((signal, seq) => {
        seqs.push(seq);
        return api.getJSON('a', {seq}, {signal});
    });
    await new Promise((r) => setImmediate(r));
    const r2 = ch.run((signal, seq) => {
        seqs.push(seq);
        return api.getJSON('b', {seq}, {signal});
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(pend.length, 2);
    pend[1].resolve(jsonResponse(200, {v: 2}));
    assert.equal(await r1, S.api.STALE);
    assert.deepEqual(await r2, {v: 2});
    assert.ok(seqs[1] > seqs[0]);
    assert.ok(seqs[0] >= Date.now() - 10000);
    assert.deepEqual(busy, [true, false]);
});

test('канал с задержкой: из серии правок выполняется только последняя', async (t) => {
    const calls = mockFetch(() => jsonResponse(200, {ok: 1}));
    t.mock.timers.enable({apis: ['setTimeout']});
    const ch = api.channel({delay: 250});
    const res = [];
    for (let i = 0; i < 5; i++) {
        ch.run((signal, seq) => api.getJSON('outside', {i}, {signal})).then((v) => res.push(v));
        t.mock.timers.tick(100);
    }
    t.mock.timers.tick(250);
    t.mock.timers.reset();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /i=4/);
    assert.equal(res.filter((v) => v === S.api.STALE).length, 4);
    assert.deepEqual(res[res.length - 1], {ok: 1});
});

test('канал: ответ superseded и отмена — STALE; прочая ошибка — отклонение', async () => {
    toasts.length = 0;
    mockFetch(() => jsonResponse(409, {error: 'superseded'}));
    const ch = api.channel();
    assert.equal(await ch.run((signal) => api.getJSON('s', null, {signal})), S.api.STALE);
    mockFetch(() => jsonResponse(500, {error: 'сбой'}));
    await assert.rejects(ch.run((signal) => api.getJSON('s', null, {signal, quiet: true})), (e) => e.status === 500);
    mockFetch((url, init) => pendingResponse(init));
    const p = ch.run((signal) => api.getJSON('s', null, {signal}));
    await new Promise((r) => setImmediate(r));
    ch.cancel();
    assert.equal(await p, S.api.STALE);
    assert.equal(toasts.length, 0);
});

test('describe: понятные тексты кодов сессии', () => {
    const E = S.api.ApiError;
    assert.match(S.api.describe(new E(410, {error: 'taken_over', by: 'petr'})), /перехватил пользователь petr/);
    assert.match(S.api.describe(new E(404, {error: 'not_found'})), /сессия закрыта/);
    assert.match(S.api.describe(new E(409, {error: 'not_ready', state: 'loading'})), /loading/);
    assert.equal(S.api.describe(new E(400, {error: 'ROI x [0, 0) вне кадра'})), 'ROI x [0, 0) вне кадра');
    const te = new TypeError('Failed to fetch');
    assert.match(S.api.describe(te), /нет связи/);
});
