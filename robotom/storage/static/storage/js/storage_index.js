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
