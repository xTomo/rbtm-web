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

function deleteExperiment(experiment_id) {
    if (confirm("Вы действительно хотите удалить эксперимент? Его невозможно будет восстановить.")) {
        $.ajax({
            url: storage_url + 'delete_experiment_' + experiment_id + '/',
            method: 'GET',
            dataType: 'text',
            success: function () {
                window.showToast('Эксперимент успешно удалён', 'success');
                var row = document.getElementById('id' + experiment_id);
                if (row) { row.parentNode.removeChild(row); }
            },
            error: function () {
                window.showToast('Не удалось удалить эксперимент', 'error');
            }
        });
    }
}

function redirectToHdf5Load(host) {

    // TODO: this function seems unused
    console.log('redirectToHdf5Load() function executed. Please remove todo in storage/static/storage/js/storage_index.js')
    location.href = host;

}