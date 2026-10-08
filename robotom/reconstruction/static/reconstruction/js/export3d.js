/* Студия реконструкции — сохранение 3D-вида в отдельный HTML-файл (кнопка в шаге «Результат»).
 *
 * Браузер собирает «оболочку»: стили view3d_page.css, код core.js, volume3d.js и view3d_page.js (берутся с сайта тем
 * же адресом, что у студии), настройки вида (RBTM_STATE) и метку __RBTM_VOLUME__ на месте объёма. Оболочка — около
 * 150 КБ; объём (мегабайты) в неё вставляет сервис реконструкции (POST results/<id>/view3d-html с теми же пределами,
 * что у GET volume3d, — объём тот же, что на экране) и кладёт файл view3d-<run_id>.html в каталог результата.
 * После сохранения файл скачивается (GET results/<id>/file/<имя>).
 * S.export3d.buildShell — чистая функция (node-тесты). */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};

    var MARK = '__RBTM_VOLUME__';
    var PARTS = {css: 'css/view3d_page.css', js: ['js/core.js', 'js/volume3d.js', 'js/view3d_page.js']};

    function escapeHtml(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c];
        });
    }

    /** Код внутри <script> / <style>: «</script» и «</style» не должны закрыть тег. */
    function inlineCode(code) {
        return String(code).replace(/<\/(script|style)/gi, '<\\/$1');
    }

    /**
     * Оболочка 3D-вида: {title, css, scripts: [текст], state} → HTML с одной меткой MARK.
     * Метки не должно быть ни в коде, ни в настройках (иначе сервис не поймёт, куда вставлять объём).
     */
    function buildShell(o) {
        var stateJson = JSON.stringify(o.state || {}).replace(/</g, '\\u003c');
        var all = [o.css || '', stateJson].concat(o.scripts || []);
        all.forEach(function (t) {
            if (String(t).indexOf(MARK) >= 0) throw new Error('метка ' + MARK + ' встретилась в коде или настройках');
        });
        var out = ['<!doctype html>', '<html lang="ru">', '<head>', '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            '<title>' + escapeHtml(o.title || '3D-вид') + '</title>',
            '<style>' + inlineCode(o.css || '') + '</style>', '</head>', '<body>', '<div id="v3-app"></div>',
            '<script>var RBTM_STATE = ' + stateJson + ';</script>',
            '<script>var RBTM_VOLUME = ' + MARK + ';</script>'];
        (o.scripts || []).forEach(function (code) {
            out.push('<script>' + inlineCode(code) + '</script>');
        });
        out.push('</body>', '</html>', '');
        return out.join('\n');
    }

    /** Адреса частей оболочки по адресу core.js студии (тот же каталог static и та же версия ?v=). */
    function partUrls(coreSrc) {
        var m = /^(.*\/)js\/core\.js(\?.*)?$/.exec(coreSrc || '');
        if (!m) return null;
        var base = m[1], q = m[2] || '';
        return {css: base + PARTS.css + q, js: PARTS.js.map(function (p) {
            return base + p + q;
        })};
    }

    function fetchText(url) {
        return root.fetch(url, {credentials: 'same-origin'}).then(function (r) {
            if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
            return r.text();
        });
    }

    /** Собрать оболочку на странице студии: Promise<строка>. info — {title, lines, state}. */
    function collect(info) {
        var tag = root.document.querySelector('script[src*="reconstruction/js/core.js"]');
        var urls = partUrls(tag && tag.getAttribute('src'));
        if (!urls) return Promise.reject(new Error('не найден адрес core.js студии'));
        return Promise.all([fetchText(urls.css)].concat(urls.js.map(fetchText))).then(function (texts) {
            return buildShell({title: info.title, css: texts[0], scripts: texts.slice(1), state: info.state});
        });
    }

    S.export3d = {MARK: MARK, buildShell: buildShell, partUrls: partUrls, collect: collect, inlineCode: inlineCode};
})(typeof window !== 'undefined' ? window : globalThis);
