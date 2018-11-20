console.log(`storage_url: ${ storage_url }`)
console.log(`page_size: ${ page_size }`)
console.log(`request_is_secure: ${ request_is_secure }`)

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
            url: storage_url + 'delete_experiment_' + experiment_id,
            method: 'GET',
            dataType: 'text',
            success: function () {
                var errorMessage = document.createElement('div');
                errorMessage.className = 'row';
                errorMessage.innerHTML = '<div class="col-sm-6 col-sm-offset-3 col-lg-4 col-lg-offset-3">' +
                        '<div class="alert alert-success">' + '<a class="close" data-dismiss="alert"">&times;</a>' +
                        'Эксперимент успешно удален</div></div>';

                var searchResult = document.getElementsByClassName('container-fluid')[2];
                searchResult.parentNode.insertBefore(errorMessage, searchResult);

                var td = document.getElementById('id' + experiment_id);
                td.parentNode.removeChild(td);
            },
            error: function () {
                var errorMessage = document.createElement('div');
                errorMessage.className = 'row';
                errorMessage.innerHTML = '<div class="col-sm-6 col-sm-offset-3 col-lg-4 col-lg-offset-3">' +
                        '<div class="alert alert-danger">' + '<a class="close" data-dismiss="alert"">&times;</a>' +
                        'Не удалось удалить эксперимент</div></div>';

                var searchResult = document.getElementsByClassName('container-fluid')[2];
                searchResult.parentNode.insertBefore(errorMessage, searchResult);
            }
        });
    }
}

function redirectToHdf5Load(host) {

    // TODO: this function seems unused
    console.log('redirectToHdf5Load() function executed. Please remove todo in storage/static/storage/js/storage_index.js')
    location.href = host;

}