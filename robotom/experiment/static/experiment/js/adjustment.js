// TODO: check it
// this function seems to not be used
function Disable() {

    console.log('the "unused" function Disable() was still used, please remove corresponding TODO')

    document.getElementById('picture_exposure_submit').value="Получение...";
    document.getElementById('picture_exposure_submit').disabled = true;
    document.getElementById('picture_exposure_submit').readonly = true;
    document.forms['picture_exposure_form'].submit();

    return false;

}

// TODO: check it
// this function seems to not be used
function post(path, params) {

    console.log('the "unused" function post(path, params) was still used, please remove corresponding TODO')

    var form = document.createElement("form");
    form.setAttribute("method", "post");
    form.setAttribute("action", path);

    for (var key in params) {

        if (params.hasOwnProperty(key)) {

            var hiddenField = document.createElement("input");
            hiddenField.setAttribute("type", "hidden");
            hiddenField.setAttribute("name", key);
            hiddenField.setAttribute("value", params[key]);

            form.appendChild(hiddenField);

        }

    }

    var hiddenField = document.createElement("input");
    hiddenField.setAttribute("type", "hidden");
    hiddenField.setAttribute("name", "csrfmiddlewaretoken");
    hiddenField.setAttribute("value", csrf_token);
    form.appendChild(hiddenField);

    document.body.appendChild(form);
    form.submit();

}
