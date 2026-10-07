/* Студия реконструкции — значки «?» (span.st-help с текстом в data-help, перевод строки — &#10;).
 *
 * Подсказка — одна общая карточка в <body> с position: fixed: колонка шагов прокручивается (overflow-y: auto) и
 * обрезала бы всё, что из неё выходит. Показ — при наведении и фокусе с клавиатуры (Tab), щелчок или Enter
 * закрепляет (длинный текст можно дочитать), повторный щелчок, щелчок мимо или Esc — закрывают. Карточка ставится
 * справа-снизу от значка, у правого края окна — левее, у нижнего — над значком. Текст вставляется как текст (без
 * HTML). Обработчики делегированы на document: значки, добавленные позже, работают без инициализации. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    if (!root.document) return;
    var doc = root.document, pop = null, cur = null, pinned = false;

    function box() {
        if (!pop) {
            pop = doc.createElement('div');
            pop.className = 'st-help-pop';
            pop.id = 'st-help-pop';
            pop.setAttribute('role', 'tooltip');
            pop.hidden = true;
            doc.body.appendChild(pop);
        }
        return pop;
    }

    function place(icon) {
        var p = box(), r = icon.getBoundingClientRect(), m = 8;
        var vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
        p.style.left = '0px';
        p.style.top = '0px';
        var w = p.offsetWidth, h = p.offsetHeight;
        var x = Math.min(Math.max(m, r.left - 12), vw - w - m);
        var y = r.bottom + 6;
        if (y + h > vh - m) y = Math.max(m, r.top - h - 6);
        p.style.left = x + 'px';
        p.style.top = y + 'px';
    }

    function show(icon, pin) {
        var p = box();
        if (cur && cur !== icon) cur.classList.remove('st-help-on');
        cur = icon;
        pinned = !!pin;
        p.textContent = icon.getAttribute('data-help') || '';
        p.classList.toggle('st-pinned', pinned);
        p.hidden = false;
        icon.classList.add('st-help-on');
        icon.setAttribute('aria-describedby', p.id);
        place(icon);
    }

    function hide() {
        if (pop) pop.hidden = true;
        if (cur) {
            cur.classList.remove('st-help-on');
            cur.removeAttribute('aria-describedby');
        }
        cur = null;
        pinned = false;
    }

    function iconOf(e) {
        return e.target && e.target.closest ? e.target.closest('.st-help') : null;
    }

    doc.addEventListener('mouseover', function (e) {
        var t = iconOf(e);
        if (t && !pinned) show(t);
    });
    doc.addEventListener('mouseout', function (e) {
        var t = iconOf(e);
        if (t && !pinned && !t.contains(e.relatedTarget)) hide();
    });
    doc.addEventListener('focusin', function (e) {
        var t = iconOf(e);
        if (t && !pinned) show(t);
    });
    doc.addEventListener('focusout', function (e) {
        if (iconOf(e) && !pinned) hide();
    });
    doc.addEventListener('click', function (e) {
        var t = iconOf(e);
        if (t) {
            e.preventDefault();             // значок внутри <label> не должен переводить фокус в поле
            e.stopPropagation();            // и внутри заголовка шага — сворачивать шаг
            if (pinned && cur === t) hide();
            else show(t, true);
        } else if (pinned && !(pop && pop.contains(e.target))) {
            hide();
        }
    }, true);
    doc.addEventListener('keydown', function (e) {
        var t = iconOf(e);
        if (e.key === 'Escape' && cur) {
            hide();
        } else if (t && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            show(t, !(pinned && cur === t));
        }
    });
    root.addEventListener('resize', hide);
    doc.addEventListener('scroll', function () {
        if (cur) place(cur);
    }, true);

    S.help = {hide: hide};
})(typeof window !== 'undefined' ? window : globalThis);
