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
 * Decode base64 string to Uint16Array.
 * @param {string} b64
 * @returns {Uint16Array}
 */
function base64ToUint16Array(b64) {
    var binaryStr = atob(b64);
    var bytes = new Uint8Array(binaryStr.length);
    for (var i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    return new Uint16Array(bytes.buffer);
}

/**
 * Draw a grayscale colorbar on a canvas element.
 * Shows real detector values (dataMin at bottom, dataMax at top).
 *
 * @param {HTMLCanvasElement} colorbarCanvas
 * @param {HTMLCanvasElement} imageCanvas    - image canvas to match height
 * @param {number}            dataMin
 * @param {number}            dataMax
 */
function drawColorbar(colorbarCanvas, imageCanvas, dataMin, dataMax) {
    // getBoundingClientRect gives CSS-rendered size (after flex/width:100% scaling)
    var rect = imageCanvas.getBoundingClientRect();
    var renderedH = rect.height || imageCanvas.height;
    var dpr = window.devicePixelRatio || 1;

    var barW = 18;
    var labelW = 52;
    var totalW = barW + labelW;

    colorbarCanvas.width  = totalW * dpr;
    colorbarCanvas.height = renderedH * dpr;
    colorbarCanvas.style.width  = totalW + 'px';
    colorbarCanvas.style.height = renderedH + 'px';

    var ctx = colorbarCanvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, totalW, renderedH);

    // Gradient: white at top (max), black at bottom (min)
    var grad = ctx.createLinearGradient(0, 0, 0, renderedH);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, barW, renderedH);

    // Border
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, barW, renderedH);

    // Numeric labels
    ctx.fillStyle = '#333';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';

    var numTicks = 5;
    for (var i = 0; i <= numTicks; i++) {
        var t = i / numTicks;
        var y = t * renderedH;
        var value = dataMax - t * (dataMax - dataMin);

        ctx.strokeStyle = '#888';
        ctx.beginPath();
        ctx.moveTo(barW, y);
        ctx.lineTo(barW + 4, y);
        ctx.stroke();

        var label = value.toFixed(0);
        var textY = Math.min(Math.max(y + 5, 13), renderedH - 2);
        ctx.fillText(label, barW + 6, textY);
    }
}

/**
 * Render raw uint16 pixel data onto a canvas using a gray colormap.
 * Normalises from [dataMin, dataMax] to [0, 255] in the browser.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Uint16Array}       pixels  - flat array of raw uint16 detector values
 * @param {number}            width
 * @param {number}            height
 * @param {number}            dataMin - raw minimum (for normalisation)
 * @param {number}            dataMax - raw maximum (for normalisation)
 */
function renderGrayscale(canvas, pixels, width, height, dataMin, dataMax) {
    canvas.width  = width;
    canvas.height = height;

    var ctx = canvas.getContext('2d');
    var imgData = ctx.createImageData(width, height);
    var data = imgData.data;

    var range = dataMax - dataMin || 1;

    for (var i = 0; i < pixels.length; i++) {
        var v = ((pixels[i] - dataMin) / range * 255 + 0.5) | 0;
        if (v < 0)   v = 0;
        if (v > 255) v = 255;
        var j = i * 4;
        data[j]     = v;
        data[j + 1] = v;
        data[j + 2] = v;
        data[j + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
}

/**
 * Fetch preview data from server and render on canvas + colorbar.
 * @param {string|number} exposureSec
 */
function loadPreview(exposureSec) {
    var container     = document.getElementById('preview-container');
    var loading       = document.getElementById('preview-loading');
    var placeholder   = document.getElementById('preview-placeholder');
    var errorDiv      = document.getElementById('preview-error');
    var infoDiv       = document.getElementById('preview-info');
    var canvas        = document.getElementById('preview-canvas');
    var colorbar      = document.getElementById('colorbar-canvas');
    var exposureLabel = document.getElementById('preview-exposure-label');

    // Show loading state
    if (container)   { container.style.display   = 'none'; }
    if (placeholder) { placeholder.style.display = 'none'; }
    if (errorDiv)    { errorDiv.style.display = 'none'; errorDiv.textContent = ''; }
    if (infoDiv)     { infoDiv.textContent = ''; }
    if (loading)     { loading.style.display = 'block'; }

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

        // Decode base64 → Uint16Array (raw detector values)
        var pixels;
        try {
            pixels = base64ToUint16Array(resp.pixels_b64);
        } catch (e) {
            showError('Ошибка декодирования данных изображения');
            return;
        }

        // Render with real min/max for correct colormap
        renderGrayscale(canvas, pixels, resp.width, resp.height, resp.data_min, resp.data_max);

        // Show container first so browser lays out canvas (needed for offsetHeight)
        if (container) { container.style.display = 'flex'; }

        // Colorbar with real detector values — must be after container is visible
        if (colorbar) {
            setTimeout(function() {
                drawColorbar(colorbar, canvas, resp.data_min, resp.data_max);
            }, 0);
        }

        if (exposureLabel) {
            exposureLabel.textContent = 'Экспозиция: ' + exposureSec + ' с';
        }
        if (infoDiv) {
            infoDiv.textContent = resp.width + '×' + resp.height + ' пикс  |  ' +
                'мин: ' + resp.data_min + '  макс: ' + resp.data_max;
        }
    };

    xhr.onerror = function() {
        if (loading) { loading.style.display = 'none'; }
        showError('Ошибка сети при запросе изображения');
    };

    xhr.send(JSON.stringify({
        exposure_sec: parseFloat(exposureSec) || 1.0,
        downsample: 6
    }));

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
