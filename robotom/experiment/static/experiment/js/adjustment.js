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


var createCORSRequest = function(method, url) {

    var xhr = new XMLHttpRequest();
    if ("withCredentials" in xhr) {
        // Most browsers.
        xhr.open(method, url, true);
    } else if (typeof XDomainRequest != "undefined") {
        // IE8 & IE9
        xhr = new XDomainRequest();
        xhr.open(method, url);
    } else {
        // CORS not supported.
        xhr = null;
    }
      return xhr;

};


function setSpanValue(spanId, text) {

    var span = document.getElementById(spanId);
    span.innerHTML = text;

}

function setValueOnload(spanId, respJSON, measure) {

    try {

        response = jQuery.parseJSON(respJSON);

        if (response.success) {

            var value_to_set = response.result;

            // format the angle float value
            if (spanId === "current_angle") {

                // FORMAT ANGLE HERE!!!1!
                value_to_set = parseFloat(value_to_set).toFixed(4);

            }

            // set the shutter state depending on
            if (spanId === "current_shutter") {

                var dict = JSON.parse(value_to_set);
                value_to_set = dict.state === "OPEN" ? "открыта" : "закрыта";

            }

            setSpanValue(spanId, value_to_set + measure);

        } else {
            setSpanValue(spanId, response.exception_message);
        }

    } catch (e) {

        setValueOnerror(spanId);
        return;

    }

}

function setValueOnerror(spanId) {
    setSpanValue(spanId, "ошибка загрузки");
}

function reloadValue(url, spanId, measure) {

    var xhr = createCORSRequest('GET', url);

    xhr.onload = function() {
        setValueOnload(spanId, this.response, measure);
    };

    xhr.onerror = function() {
        setValueOnerror(spanId);
    };

    xhr.send();

}

function display() {

    reloadValue(js_url_settings.get_voltage_url, "current_voltage", " кВ");
    reloadValue(js_url_settings.get_current_url, "current_current", " мА");
    reloadValue(js_url_settings.get_angle_url, "current_angle", "&deg;");
    reloadValue(js_url_settings.get_vert_url, "current_vert", "");
    reloadValue(js_url_settings.get_horiz_url, "current_horiz", "");
    reloadValue(js_url_settings.get_shutter_url, "current_shutter", "");
    setTimeout("display()", 3000)

}

display()

