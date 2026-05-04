// ─── CORS helper ────────────────────────────────────────────────────────────

var createCORSRequest = function(method, url) {
    var xhr = new XMLHttpRequest();
    if ("withCredentials" in xhr) {
        xhr.open(method, url, true);
    } else if (typeof XDomainRequest != "undefined") {
        xhr = new XDomainRequest();
        xhr.open(method, url);
    } else {
        xhr = null;
    }
    return xhr;
};

// ─── Status span helpers ─────────────────────────────────────────────────────

function setSpanValue(spanId, text) {
    var span = document.getElementById(spanId);
    if (span) span.innerHTML = text;
}

function setValueOnload(spanId, respJSON, measure) {
    try {
        var response = jQuery.parseJSON(respJSON);
        if (response.success) {
            var value_to_set = response.result;

            if (spanId === "current_angle") {
                value_to_set = parseFloat(value_to_set).toFixed(4);
            }

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
    }
}

function setValueOnerror(spanId) {
    setSpanValue(spanId, "ошибка загрузки");
}

function reloadValue(url, spanId, measure) {
    var xhr = createCORSRequest('GET', url);
    if (!xhr) return;
    xhr.onload = function() { setValueOnload(spanId, this.response, measure); };
    xhr.onerror = function() { setValueOnerror(spanId); };
    xhr.send();
}

function display() {
    reloadValue(js_url_settings.get_voltage_url, "current_voltage", " кВ");
    reloadValue(js_url_settings.get_current_url, "current_current", " мА");
    reloadValue(js_url_settings.get_angle_url, "current_angle", "°");
    reloadValue(js_url_settings.get_vert_url, "current_vert", "");
    reloadValue(js_url_settings.get_horiz_url, "current_horiz", "");
    reloadValue(js_url_settings.get_shutter_url, "current_shutter", "");
    setTimeout(display, 3000);
}

display();

// ─── Canvas preview with grayscale colormap ──────────────────────────────────

/**
 * Draw a grayscale colorbar on a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {number} dataMin
 * @param {number} dataMax
 * @param {number} height
 */
function drawColorbar(canvas, dataMin, dataMax, height) {
    var barW = 14;
    canvas.width = 58;   // 14px bar + 44px label area
    canvas.height = height;

    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Gradient: white at top, black at bottom
    var grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, barW, height);

    // Border
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, barW, height);

    // Labels
    ctx.fillStyle = '#333';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';

    var numTicks = 5;
    for (var i = 0; i <= numTicks; i++) {
        var t = i / numTicks;
        var y = t * height;
        var value = dataMax - t * (dataMax - dataMin);

        ctx.strokeStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(barW, y);
        ctx.lineTo(barW + 3, y);
        ctx.stroke();

        var label = value.toFixed(0);
        var textY = Math.min(Math.max(y + 3, 10), height - 1);
        ctx.fillText(label, barW + 5, textY);
    }
}

/**
 * Render uint16 grayscale pixels onto a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<number>} pixels - flat uint16 array (0–65535)
 * @param {number} width
 * @param {number} height
 */
function renderGrayscale(canvas, pixels, width, height) {
    canvas.width = width;
    canvas.height = height;

    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(width, height);
    var data = imgData.data;

    for (var i = 0; i < pixels.length; i++) {
        var v = (pixels[i] / 65535 * 255 + 0.5) | 0;  // fast floor
        var j = i * 4;
        data[j]     = v;
        data[j + 1] = v;
        data[j + 2] = v;
        data[j + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
}

/**
 * Fetch preview data from server and render on canvas.
 * @param {string|number} exposureSec
 */
function loadPreview(exposureSec) {
    var container    = document.getElementById('preview-container');
    var loading      = document.getElementById('preview-loading');
    var placeholder  = document.getElementById('preview-placeholder');
    var errorDiv     = document.getElementById('preview-error');
    var infoDiv      = document.getElementById('preview-info');
    var canvas       = document.getElementById('preview-canvas');
    var exposureLabel = document.getElementById('preview-exposure-label');

    // Show loading, hide everything else
    if (container)   { container.style.display   = 'none'; }
    if (placeholder) { placeholder.style.display = 'none'; }
    if (errorDiv)    { errorDiv.style.display     = 'none'; errorDiv.textContent = ''; }
    if (infoDiv)     { infoDiv.textContent         = ''; }
    if (loading)     { loading.style.display       = 'block'; }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', preview_data_url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-CSRFToken', csrf_token);

    xhr.onload = function() {
        if (loading) { loading.style.display = 'none'; }

        if (xhr.status !== 200) {
            showError('Ошибка получения изображения (HTTP ' + xhr.status + ')');
            return;
        }

        var resp;
        try {
            resp = JSON.parse(xhr.responseText);
        } catch (e) {
            showError('Не удалось разобрать ответ сервера');
            return;
        }

        if (resp.error) {
            showError('Ошибка: ' + resp.error);
            return;
        }

        // Render
        renderGrayscale(canvas, resp.pixels, resp.width, resp.height);

        if (container) { container.style.display = 'block'; }

        if (exposureLabel) {
            exposureLabel.textContent = 'Экспозиция: ' + exposureSec + ' с';
        }
        if (infoDiv) {
            infoDiv.textContent = resp.width + '×' + resp.height + ' пикс  |  ' +
                'мин: ' + resp.data_min.toFixed(1) + '  макс: ' + resp.data_max.toFixed(1);
        }
    };

    xhr.onerror = function() {
        if (loading) { loading.style.display = 'none'; }
        showError('Ошибка сети при запросе изображения');
    };

    xhr.send(JSON.stringify({ exposure_sec: parseFloat(exposureSec) || 1.0 }));

    function showError(msg) {
        if (placeholder) { placeholder.style.display = 'block'; }
        if (errorDiv)    { errorDiv.style.display = 'block'; errorDiv.textContent = msg; }
    }
}

// ─── Hook into the exposure form ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    var form = document.querySelector('form[name="picture_exposure_form"]');
    if (!form) return;

    form.addEventListener('submit', function(e) {
        var submitBtn = document.getElementById('picture_exposure_submit');
        if (!submitBtn || submitBtn.disabled) return;

        var exposureInput = document.getElementById('picture_exposure');
        var exposureSec = exposureInput ? exposureInput.value : '';
        if (!exposureSec) return;  // let native validation handle it

        e.preventDefault();
        loadPreview(exposureSec);
    });
});
