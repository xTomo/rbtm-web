// node --test robotom/reconstruction/jstests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {load, STATIC_JS} = require('./load');

const S = load('core.js', 'volume3d.js', 'export3d.js', 'view3d_page.js');
const E = S.export3d, P = S.page3d;

test('buildShell: одна метка объёма, код и настройки не закрывают <script>', () => {
    const html = E.buildShell({
        title: 'Образец <a&b>', css: 'body{}', scripts: ['var s = "</script>";', 'var t = 1;'],
        state: {title: 'x</script><b>', opts: {mode: 'soft'}},
    });
    assert.equal(html.split(E.MARK).length, 2);
    assert.match(html, /<title>Образец &lt;a&amp;b&gt;<\/title>/);
    // в теле страницы «</script>» встречается только как закрытие наших тегов: 2 + число скриптов
    assert.equal((html.match(/<\/script>/g) || []).length, 4);
    assert.ok(html.includes('var s = "<\\/script>";'));
    assert.ok(html.includes('"x\\u003c/script>\\u003cb>"'));
    assert.throws(() => E.buildShell({scripts: ['x = "' + E.MARK + '"']}), /метка/);
});

test('partUrls: части оболочки — рядом с core.js студии, с той же версией', () => {
    const u = E.partUrls('/static/reconstruction/js/core.js?v=abc');
    assert.equal(u.css, '/static/reconstruction/css/view3d_page.css?v=abc');
    assert.deepEqual(u.js, ['/static/reconstruction/js/core.js?v=abc', '/static/reconstruction/js/volume3d.js?v=abc',
        '/static/reconstruction/js/view3d_page.js?v=abc']);
    assert.equal(E.partUrls('/static/other.js'), null);
});

test('в частях оболочки нет метки объёма (иначе сервис откажет)', () => {
    for (const name of ['core.js', 'volume3d.js', 'view3d_page.js']) {
        assert.ok(!fs.readFileSync(path.join(STATIC_JS, name), 'utf8').includes(E.MARK), name);
    }
    const css = path.join(STATIC_JS, '..', 'css', 'view3d_page.css');
    assert.ok(!fs.readFileSync(css, 'utf8').includes(E.MARK));
});

test('page3d: объём из base64 и авто-окно по гистограмме кодов', () => {
    const data = new Uint8Array(2 * 3 * 4);
    for (let i = 0; i < data.length; i++) data[i] = i * 10;
    const v = {w: 4, h: 3, k: 2, scale: 0.01, offset: -0.1, meta: {binning: 4},
        b64: Buffer.from(data).toString('base64')};
    const img = P.decodeVolume(v);
    assert.deepEqual(Array.from(img.data), Array.from(data));
    assert.equal(img.w, 4);
    assert.throws(() => P.decodeVolume(Object.assign({}, v, {w: 5})), /повреждён/);
    const hist = P.codeHistogram(img.data);
    assert.equal(hist[230], 1);
    const [lo, hi] = P.autoWindow(hist, 0.01, -0.1, 0, 100);
    assert.ok(Math.abs(lo - (0 * 0.01 - 0.1)) < 1e-12);
    assert.ok(Math.abs(hi - (230 * 0.01 - 0.1)) < 1e-12);
});

test('собранный файл исполняется: страница находит объём и строит вид (без WebGL — сообщение)', () => {
    const read = (n) => fs.readFileSync(path.join(STATIC_JS, n), 'utf8');
    const html = E.buildShell({title: 't', css: '', scripts: [read('core.js'), read('volume3d.js'), read('view3d_page.js')],
        state: {title: 'Образец', lines: ['строка'], opts: {mode: 'mip'}, win: [0, 1]}});
    const vol = {w: 2, h: 2, k: 2, scale: 1, offset: 0, meta: {}, b64: Buffer.from(new Uint8Array(8)).toString('base64')};
    const full = html.replace(E.MARK, JSON.stringify(vol));
    // минимальный DOM: только то, что трогают view3d_page.js и View3D без WebGL
    const nodes = [];
    function node(tag) {
        const n = {tagName: tag, children: [], style: {}, attrs: {}, classList: {add() {}, remove() {}, toggle() {}},
            appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; },
            setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {}, getContext() { return null; },
            set textContent(t) { this._t = t; }, get textContent() { return this._t || ''; }, clientWidth: 400,
            clientHeight: 300};
        nodes.push(n);
        return n;
    }
    const app = node('div');
    const document = {createElement: node, createTextNode: (t) => ({t}), getElementById: () => app};
    const ctx = {document, console, Buffer, Math, JSON, Uint8Array, Float32Array, Float64Array, Object, Array, String,
        Number, isFinite, parseFloat, Error, setTimeout, clearTimeout};
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const m of full.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], ctx);
    assert.ok(ctx.Studio.page3d && ctx.Studio.View3D);
    const texts = nodes.map((n) => n._t || '').join('\n');
    assert.match(texts, /Образец/);
    assert.match(texts, /3D-вид недоступен/);           // в node нет WebGL2 — понятное сообщение, без исключения
});
