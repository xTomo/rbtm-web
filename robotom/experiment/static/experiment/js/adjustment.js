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
 * The bar goes from black (bottom) to white (top), with numeric labels.
 * @param {HTMLCanvasElement} canvas
 * @param {number} dataMin - original data minimum value
 * @param {number} dataMax - original data maximum value
 * @param {number} height  - desired height in px (matches image canvas)
 */
function drawColorbar(canvas, dataMin, dataMax, height) {
    var W = 32;       // total width: 16px gradient + 16px labels area
    var barW = 14;    // gradient strip width
    var labelX = barW + 3;
    canvas.width = W + 40;  // extra for labels
    canvas.height = height;

    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Gradient bar: white at top, black at bottom
    var grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, barW, height);

    // Border around the bar
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, barW, height);

    // Labels
    ctx.fillStyle = '#333';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';

    var numTicks = 5;
    for (var i = 0; i <= numTicks; i++) {
        var t = i / numTicks;          // 0 at top (white) → 1 at bottom (black)
        var y = t * height;
        var value = dataMax - t * (dataMax - dataMin);  // high value at top

        // tick line
        ctx.strokeStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(barW, y);
        ctx.lineTo(barW + 3, y);
        ctx.stroke();

        // label
        var label = value.toFixed(0);
        var textY = Math.min(Math.max(y + 3, 10), height);
        ctx.fillText(label, labelX + 3, textY);
    }
}

/**
 * Render uint16 grayscale pixels (0–65535) onto a canvas using a gray colormap.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<number>} pixels - flat array of uint16 values
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
        var v = Math.round(pixels[i] / 257);  // 0–65535 → 0–255
        var j = i * 4;
        data[j]     = v;
        data[j + 1] = v;
        data[j + 2] = v;
        data[j + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
}

/**
 * Request preview data from the server, render on canvas and draw colorbar.
 * Called when the exposure form is submitted (intercepts default POST).
 * @param {number|string} exposureSec
 */
function loadPreview(exposureSec) {
    var container    = document.getElementById('preview-container');
    var loading      = document.getElementById('preview-loading');
    var placeholder  = document.getElementById('preview-placeholder');
    var infoDiv      = document.getElementById('preview-info');
    var canvas       = document.getElementById('preview-canvas');
    var colorbar     = document.getElementById('colorbar-canvas');
    var exposureLabel = document.getElementById('preview-exposure-label');

    // Show loading state
    if (container)   container.style.display   = 'none';
    if (placeholder) placeholder.style.display = 'none';
    if (loading)     loading.style.display     = 'block';
    if (infoDiv)     infoDiv.textContent        = '';

    var xhr = new XMLHttpRequest();
    xhr.open('POST', preview_data_url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-CSRFToken', csrf_token);

    xhr.onload = function() {
        if (loading) loading.style.display = 'none';

        if (xhr.status !== 200) {
            if (placeholder) placeholder.style.display = 'block';
            if (infoDiv) infoDiv.textContent = 'Ошибка получения изображения (код ' + xhr.status + ')';
            return;
        }

        var resp;
        try {
            resp = JSON.parse(xhr.responseText);
        } catch (e) {
            if (placeholder) placeholder.style.display = 'block';
            if (infoDiv) infoDiv.textContent = 'Ошибка разбора ответа сервера';
            return;
        }

        if (resp.error) {
            if (placeholder) placeholder.style.display = 'block';
            if (infoDiv) infoDiv.textContent = 'Ошибка: ' + resp.error;
            return;
        }

        // Render image
        renderGrayscale(canvas, resp.pixels, resp.width, resp.height);
        drawColorbar(colorbar, resp.data_min, resp.data_max, resp.height);

        // Show container
        if (container) container.style.display = 'flex';

        // Update labels
        if (exposureLabel) {
            exposureLabel.textContent = 'Экспозиция: ' + exposureSec + ' с';
        }
        if (infoDiv) {
            infoDiv.textContent = 'Размер: ' + resp.width + '×' + resp.height +
                '  |  Диапазон: ' + resp.data_min.toFixed(1) + ' – ' + resp.data_max.toFixed(1);
        }
    };

    xhr.onerror = function() {
        if (loading)     loading.style.display     = 'none';
        if (placeholder) placeholder.style.display = 'block';
        if (infoDiv)     infoDiv.textContent        = 'Ошибка сети при запросе изображения';
    };

    xhr.send(JSON.stringify({ exposure_sec: parseFloat(exposureSec) || 1.0 }));
}

// ─── Hook into the exposure form ─────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {

    // If page loaded with preview=True (server-side redirect after POST),
    // automatically fetch the image using the stored exposure value.
    if (typeof initial_preview !== 'undefined' && initial_preview && initial_exposure_sec) {
        loadPreview(initial_exposure_sec);
    }

    var form = document.querySelector('form[name="picture_exposure_form"]');
    if (!form) return;

    form.addEventListener('submit', function(e) {
        var submitBtn = document.getElementById('picture_exposure_submit');
        if (!submitBtn || submitBtn.disabled) return;

        // Don't let Django handle the POST for preview — we do it via AJAX instead.
        // The form still submits to Django (so the page reloads with preview=True context),
        // but we intercept it here for the canvas rendering path.
        //
        // Strategy: intercept, fire AJAX, but also allow normal submit so that
        // exposure_sec is preserved across other form actions.
        var exposureSec = document.getElementById('picture_exposure').value;
        if (!exposureSec) return;  // let normal validation handle it

        e.preventDefault();  // stop normal form submit

        loadPreview(exposureSec);
    });
});
