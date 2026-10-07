/* Студия реконструкции — помощники DOM: поиск элементов, показ/скрытие, модальные окна (разметка Bootstrap 3,
 * без jQuery), подтверждение, окно с текстом. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var ui = S.ui = {};

    ui.$ = function (id) {
        return root.document.getElementById(id);
    };

    ui.qs = function (sel, ctx) {
        return (ctx || root.document).querySelector(sel);
    };

    ui.qsa = function (sel, ctx) {
        return Array.prototype.slice.call((ctx || root.document).querySelectorAll(sel));
    };

    ui.text = function (el, text) {
        if (el) el.textContent = text === null || text === undefined ? '' : String(text);
    };

    ui.show = function (el, on) {
        if (!el) return;
        if (on === undefined || on) el.classList.remove('hidden');
        else el.classList.add('hidden');
    };

    ui.hide = function (el) {
        ui.show(el, false);
    };

    /** Кнопка/поле: доступность с подсказкой, почему недоступно. */
    ui.enable = function (el, on, why) {
        if (!el) return;
        el.disabled = !on;
        if (on) {
            if (el.dataset.titleOn !== undefined) el.title = el.dataset.titleOn;
        } else {
            if (el.dataset.titleOn === undefined) el.dataset.titleOn = el.title || '';
            if (why) el.title = why;
        }
    };

    /** Элемент: el('div', {class: 'x', text: '…'}, [дети]). */
    ui.el = function (tag, attrs, children) {
        var e = root.document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                var v = attrs[k];
                if (v === null || v === undefined || v === false) return;
                if (k === 'text') e.textContent = String(v);
                else if (k === 'class') e.className = v;
                else if (k === 'html') e.innerHTML = v;
                else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
                else e.setAttribute(k, v === true ? '' : String(v));
            });
        }
        (children || []).forEach(function (c) {
            if (c === null || c === undefined || c === false) return;
            e.appendChild(typeof c === 'string' ? root.document.createTextNode(c) : c);
        });
        return e;
    };

    ui.clear = function (el) {
        while (el && el.firstChild) el.removeChild(el.firstChild);
    };

    /** Индикатор выполнения Bootstrap: frac 0..1 или null (неопределённый). */
    ui.progress = function (el, frac, label) {
        if (!el) return;
        var bar = el.querySelector('.progress-bar');
        var text = el.querySelector('.st-progress-label');
        if (!bar) {
            bar = ui.el('div', {class: 'progress-bar', role: 'progressbar'});
            el.appendChild(bar);
        }
        if (!text) {
            // подпись поверх всей полосы: на узкой заполненной части она бы обрезалась
            text = ui.el('span', {class: 'st-progress-label'});
            el.appendChild(text);
        }
        var indeterminate = frac === null || frac === undefined || !isFinite(frac);
        var pct = indeterminate ? 100 : Math.round(Math.max(0, Math.min(1, frac)) * 100);
        bar.style.width = pct + '%';
        bar.setAttribute('aria-valuenow', indeterminate ? '' : String(pct));
        bar.classList.toggle('progress-bar-striped', indeterminate || pct < 100);
        bar.classList.toggle('active', indeterminate || pct < 100);
        text.textContent = label !== undefined ? label : (indeterminate ? '' : pct + ' %');
    };

    // --- модальные окна -------------------------------------------------------------------------------------

    var openCount = 0;

    /**
     * Модальное окно. opts: title, body (строка или узел), pre (текст моноширинным), buttons: [{text, cls,
     * value}], large, handle (объект: в него кладётся close(value) — закрыть окно из кода). Возвращает Promise
     * значения нажатой кнопки (Esc, крестик, фон — null).
     */
    ui.modal = function (opts) {
        return new Promise(function (resolve) {
            var doc = root.document;
            var backdrop = ui.el('div', {class: 'modal-backdrop fade in'});
            var body = ui.el('div', {class: 'modal-body'});
            if (opts.pre !== undefined) {
                body.appendChild(ui.el('pre', {class: 'st-log', text: opts.pre}));
            } else if (typeof opts.body === 'string') {
                body.appendChild(ui.el('p', {text: opts.body}));
            } else if (opts.body) {
                body.appendChild(opts.body);
            }
            var footer = ui.el('div', {class: 'modal-footer'});
            var closeX = ui.el('button', {type: 'button', class: 'close', 'aria-label': 'Закрыть', html: '&times;'});
            var dialog = ui.el('div', {class: 'modal-dialog' + (opts.large ? ' modal-lg' : '')}, [
                ui.el('div', {class: 'modal-content'}, [
                    ui.el('div', {class: 'modal-header'}, [closeX, ui.el('h4', {class: 'modal-title', text: opts.title || ''})]),
                    body, footer
                ])
            ]);
            var modal = ui.el('div', {class: 'modal fade in st-modal', tabindex: '-1', role: 'dialog'}, [dialog]);
            modal.style.display = 'block';
            var done = false;

            function close(value) {
                if (done) return;
                done = true;
                doc.removeEventListener('keydown', onKey, true);
                if (modal.parentNode) modal.parentNode.removeChild(modal);
                if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
                openCount = Math.max(0, openCount - 1);
                if (!openCount) doc.body.classList.remove('modal-open');
                resolve(value === undefined ? null : value);
            }
            function onKey(e) {
                if (e.key === 'Escape') {
                    e.stopPropagation();
                    close(null);
                }
            }
            if (opts.handle) opts.handle.close = close;
            var buttons = opts.buttons || [{text: 'Закрыть', cls: 'btn-default', value: null}];
            var first = null;
            buttons.forEach(function (b) {
                var btn = ui.el('button', {type: 'button', class: 'btn ' + (b.cls || 'btn-default'), text: b.text});
                btn.addEventListener('click', function () {
                    close(b.value);
                });
                footer.appendChild(btn);
                if (b.focus || !first) first = btn;
            });
            closeX.addEventListener('click', function () {
                close(null);
            });
            modal.addEventListener('mousedown', function (e) {
                if (e.target === modal) close(null);
            });
            doc.addEventListener('keydown', onKey, true);
            doc.body.appendChild(backdrop);
            doc.body.appendChild(modal);
            doc.body.classList.add('modal-open');
            openCount++;
            if (first) first.focus();
        });
    };

    /** Подтверждение: Promise<boolean>. */
    ui.confirm = function (title, text, okText, okCls) {
        return ui.modal({
            title: title, body: text,
            buttons: [
                {text: 'Отмена', cls: 'btn-default', value: false},
                {text: okText || 'OK', cls: okCls || 'btn-primary', value: true, focus: true}
            ]
        }).then(function (v) {
            return v === true;
        });
    };

    /** Окно с моноширинным текстом (лог). */
    ui.textWindow = function (title, text) {
        return ui.modal({title: title, pre: text, large: true});
    };

    ui.toast = function (msg, type, delay) {
        S.api.toast(msg, type, delay);
    };
})(typeof window !== 'undefined' ? window : globalThis);
