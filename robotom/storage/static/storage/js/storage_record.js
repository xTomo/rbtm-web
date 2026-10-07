/* Шапка страницы записи: копирование id и удаление эксперимента.
 * Удаление: хранилище стирает папку эксперимента вместе с HDF5, восстановить нельзя. Подтверждение — вводом названия
 * образца (у эксперимента без названия — его id); сервер сверяет его с хранилищем сам. Запрос — POST с CSRF; кнопка есть
 * только у экспериментатора и администратора (роль сервер тоже проверяет сам). */
(function () {
    'use strict';
    var $ = function (id) { return document.getElementById(id); };

    var copy = $('copy-id');
    if (copy) {
        copy.addEventListener('click', function (e) {
            e.preventDefault();
            var id = copy.getAttribute('data-id');
            var ok = function () { window.showToast && window.showToast('id скопирован: ' + id, 'success'); };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(id).then(ok, function () { window.prompt('id эксперимента:', id); });
            } else {
                window.prompt('id эксперимента:', id);
            }
        });
    }

    var box = $('del-box');
    if (!box) return;
    var input = $('del-name'), go = $('del-go');
    var expected = (input.getAttribute('data-expected') || '').trim();

    $('del-open').addEventListener('click', function () {
        box.classList.toggle('open');
        if (box.classList.contains('open')) input.focus();
    });
    $('del-cancel').addEventListener('click', function () {
        box.classList.remove('open');
        input.value = '';
        go.disabled = true;
    });
    input.addEventListener('input', function () { go.disabled = input.value.trim() !== expected; });

    box.addEventListener('submit', function (e) {
        e.preventDefault();
        if (input.value.trim() !== expected) return;
        go.disabled = true;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', box.action);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
        xhr.onload = function () {
            if (xhr.status === 200) {
                window.showToast && window.showToast('Эксперимент удалён', 'success');
                window.location.href = box.getAttribute('data-index-url');
            } else {
                go.disabled = false;
                window.showToast && window.showToast('Не удалось удалить эксперимент: ' +
                    (xhr.responseText || xhr.status), 'error');
            }
        };
        xhr.onerror = function () {
            go.disabled = false;
            window.showToast && window.showToast('Не удалось удалить эксперимент: нет ответа сервера', 'error');
        };
        var csrf = box.querySelector('[name=csrfmiddlewaretoken]');
        xhr.send('confirm=' + encodeURIComponent(input.value.trim()) +
            '&csrfmiddlewaretoken=' + encodeURIComponent(csrf ? csrf.value : ''));
    });
})();
