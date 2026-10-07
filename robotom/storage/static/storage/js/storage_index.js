//console.log(`storage_url: ${ storage_url }`)
//console.log(`page_size: ${ page_size }`)

function showPage(page) {
    var divs = $(".paginated-content");
    divs.hide();
    divs.each(function (n) {
        if (n >= page_size * (page - 1) && n < page_size * page)
            $(this).show();
    });
};

showPage(1);

$(".pagination").find("li").find("a").click(function () {
    $(".pagination").find("li").removeClass("active");
    $(this).parent().addClass("active");
    showPage(parseInt($(this).text()))
});

/* Удаление эксперимента: хранилище стирает его папку вместе с HDF5, восстановить нельзя. Подтверждение — вводом
 * названия образца (у эксперимента без названия — его id); сервер сверяет его с хранилищем. Запрос — POST с CSRF;
 * кнопка есть только у экспериментатора и администратора (сервер проверяет роль сам). */
function deleteExperiment(experiment_id) {
    var btn = document.getElementById(experiment_id);
    var specimen = (btn && btn.getAttribute('data-specimen')) || '';
    var expected = specimen || experiment_id;
    var typed = prompt('Удалить эксперимент «' + expected + '»?\n\nХранилище сотрёт его вместе с HDF5, ' +
        'восстановить будет нельзя.\nДля подтверждения введите ' + (specimen ? 'название образца' : 'id эксперимента') +
        ':\n' + expected);
    if (typed === null) return;
    if (typed.trim() !== expected.trim()) {
        window.showToast('Название введено неверно — эксперимент не удалён', 'error');
        return;
    }
    var csrf = document.querySelector('[name=csrfmiddlewaretoken]');
    $.ajax({
        url: storage_url + 'delete_experiment_' + experiment_id + '/',
        method: 'POST',
        data: {confirm: typed.trim(), csrfmiddlewaretoken: csrf ? csrf.value : ''},
        dataType: 'text',
        success: function () {
            window.showToast('Эксперимент удалён', 'success');
            var row = document.getElementById('id' + experiment_id);
            if (row) { row.parentNode.removeChild(row); }
        },
        error: function (xhr) {
            window.showToast('Не удалось удалить эксперимент: ' + (xhr.responseText || xhr.status), 'error');
        }
    });
}