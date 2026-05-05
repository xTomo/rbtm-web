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

/**
 * Update shutter buttons and status text colour based on current state.
 * @param {string} state - 'OPEN' | 'CLOSED' (or any other value = unknown)
 */
function updateShutterUI(state) {
    var span       = document.getElementById('current_shutter');
    var btnOpen    = document.getElementById('btn-shutter-open');
    var btnClose   = document.getElementById('btn-shutter-close');

    if (!span) return;

    if (state === 'OPEN') {
        // Label — green
        span.style.color = '#388e3c';
        span.textContent = 'открыта';

        // Закрыть — активная (красная), Открыть — неактивная
        if (btnOpen)  {
            btnOpen.classList.remove('shutter-btn-open-active');
            if (!btnOpen.dataset.disabledByServer) btnOpen.disabled = false;
        }
        if (btnClose) {
            btnClose.classList.add('shutter-btn-close-active');
            if (!btnClose.dataset.disabledByServer) btnClose.disabled = false;
        }

    } else if (state === 'CLOSE') {
        // Label — red
        span.style.color = '#c62828';
        span.textContent = 'закрыта';

        // Открыть — активная (зелёная), Закрыть — неактивная
        if (btnOpen)  {
            btnOpen.classList.add('shutter-btn-open-active');
            if (!btnOpen.dataset.disabledByServer) btnOpen.disabled = false;
        }
        if (btnClose) {
            btnClose.classList.remove('shutter-btn-close-active');
            if (!btnClose.dataset.disabledByServer) btnClose.disabled = false;
        }

    } else {
        // Unknown state — neutral
        span.style.color = '';
        span.textContent = state || 'неизвестно';

        if (btnOpen)  btnOpen.classList.remove('shutter-btn-open-active');
        if (btnClose) btnClose.classList.remove('shutter-btn-close-active');
    }
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
                updateShutterUI(dict.state);
                return;  // updateShutterUI sets span itself
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

// ─── Detector model (one-time fetch on page load) ────────────────────────────

function fetchDetectorModel() {
    var url = js_url_settings.get_detector_model_url;
    if (!url) return;
    var xhr = createCORSRequest('GET', url);
    if (!xhr) return;
    xhr.onload = function() {
        try {
            var resp = JSON.parse(this.response);
            var el = document.getElementById('detector-model-info');
            if (!el) return;
            el.textContent = resp.success
                ? 'Детектор: ' + resp.result
                : 'Детектор: недоступен';
        } catch (e) {}
    };
    xhr.onerror = function() {
        var el = document.getElementById('detector-model-info');
        if (el) el.textContent = 'Детектор: ошибка';
    };
    xhr.send();
}

fetchDetectorModel();

// ─── AJAX form submit helper ──────────────────────────────────────────────────

/**
 * Send a form via AJAX POST (application/x-www-form-urlencoded).
 * On response calls showToast with success/error message.
 *
 * @param {HTMLFormElement} formEl
 * @param {string}          submitName  - name of submit button to include
 * @param {string}          [extraBody] - optional extra encoded params
 */
function ajaxSubmitForm(formEl, submitName, extraBody) {
    var parts = [];

    // Collect all inputs/selects/textareas (not disabled, not submit)
    var elements = formEl.elements;
    for (var i = 0; i < elements.length; i++) {
        var el = elements[i];
        if (el.disabled) continue;
        if (el.type === 'submit' || el.type === 'button') continue;
        if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
        if (el.name) {
            parts.push(encodeURIComponent(el.name) + '=' + encodeURIComponent(el.value));
        }
    }

    // Include the clicked submit button by name
    if (submitName) {
        parts.push(encodeURIComponent(submitName) + '=1');
    }

    if (extraBody) {
        parts.push(extraBody);
    }

    var body = parts.join('&');

    var xhr = new XMLHttpRequest();
    xhr.open('POST', formEl.action || window.location.href, true);
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

    xhr.onload = function() {
        try {
            var resp = JSON.parse(xhr.responseText);
            if (resp.success) {
                showToast(resp.message || 'Готово', 'success');
            } else {
                showToast(resp.message || 'Ошибка выполнения команды', 'error');
            }
        } catch (e) {
            showToast('Не удалось разобрать ответ сервера', 'error');
        }
    };

    xhr.onerror = function() {
        showToast('Ошибка сети', 'error');
    };

    xhr.send(body);
}

/**
 * Send a shutter command via AJAX POST.
 * @param {string} gateState - 'open' | 'close'
 */
function ajaxShutterCommand(gateState) {
    var csrfInput = document.querySelector('[name=csrfmiddlewaretoken]');
    var csrfVal   = csrfInput ? csrfInput.value : (typeof csrf_token !== 'undefined' ? csrf_token : '');

    var body = 'text_gate=1'
        + '&gate_state=' + encodeURIComponent(gateState)
        + '&csrfmiddlewaretoken=' + encodeURIComponent(csrfVal);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', window.location.href, true);
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

    xhr.onload = function() {
        try {
            var resp = JSON.parse(xhr.responseText);
            if (resp.success) {
                showToast(resp.message || 'Готово', 'success');
                // Immediately update UI optimistically
                updateShutterUI(gateState === 'open' ? 'OPEN' : 'CLOSE');
            } else {
                showToast(resp.message || 'Ошибка выполнения команды', 'error');
            }
        } catch (e) {
            showToast('Не удалось разобрать ответ сервера', 'error');
        }
    };

    xhr.onerror = function() {
        showToast('Ошибка сети', 'error');
    };

    xhr.send(body);
}

// ─── Global state for preview ─────────────────────────────────────────────────

var gPixels     = null;   // Uint16Array — raw detector values
var gWidth      = 0;
var gHeight     = 0;
var gDataMin    = 0;      // absolute min from detector
var gDataMax    = 65535;  // absolute max from detector
var gDisplayMin = 0;      // current display window min
var gDisplayMax = 65535;  // current display window max

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
 */
function drawColorbar(colorbarCanvas, imageCanvas, dataMin, dataMax) {
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

    var grad = ctx.createLinearGradient(0, 0, 0, renderedH);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, barW, renderedH);

    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, barW, renderedH);

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
 * Draw histogram of pixel intensity values (log scale on Y).
 */
function drawHistogram(histCanvas, pixels, dataMin, dataMax, dispMin, dispMax) {
    var NUM_BINS = 256;
    var dpr  = window.devicePixelRatio || 1;
    var cssW = histCanvas.clientWidth  || 300;
    var cssH = histCanvas.clientHeight || 80;

    histCanvas.width  = cssW * dpr;
    histCanvas.height = cssH * dpr;

    var ctx = histCanvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    var range = dataMax - dataMin || 1;
    var counts = new Float32Array(NUM_BINS);

    for (var i = 0; i < pixels.length; i++) {
        var bin = ((pixels[i] - dataMin) / range * NUM_BINS) | 0;
        if (bin < 0) bin = 0;
        if (bin >= NUM_BINS) bin = NUM_BINS - 1;
        counts[bin]++;
    }

    var maxCount = 1;
    for (var b = 0; b < NUM_BINS; b++) {
        if (counts[b] > maxCount) maxCount = counts[b];
    }
    var logMax = Math.log(maxCount + 1);

    var padT = 4, padB = 4, padL = 2, padR = 2;
    var drawW = cssW - padL - padR;
    var drawH = cssH - padT - padB;
    var barW  = drawW / NUM_BINS;

    ctx.fillStyle = '#f8f8f8';
    ctx.fillRect(0, 0, cssW, cssH);

    var dispMinBin = Math.floor((dispMin - dataMin) / range * NUM_BINS);
    var dispMaxBin = Math.floor((dispMax - dataMin) / range * NUM_BINS);
    if (dispMinBin < 0) dispMinBin = 0;
    if (dispMaxBin >= NUM_BINS) dispMaxBin = NUM_BINS - 1;

    for (var b = 0; b < NUM_BINS; b++) {
        var normH = Math.log(counts[b] + 1) / logMax * drawH;
        var x = padL + b * barW;
        var y = padT + drawH - normH;

        ctx.fillStyle = (b >= dispMinBin && b <= dispMaxBin)
            ? 'rgba(70, 130, 200, 0.85)'
            : 'rgba(180, 180, 180, 0.6)';
        ctx.fillRect(x, y, Math.max(barW - 0.5, 0.5), normH);
    }

    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.strokeRect(padL, padT, drawW, drawH);

    ctx.strokeStyle = 'rgba(220, 50, 50, 0.9)';
    ctx.lineWidth = 1.5;

    var xMin = padL + dispMinBin * barW;
    ctx.beginPath(); ctx.moveTo(xMin, padT); ctx.lineTo(xMin, padT + drawH); ctx.stroke();

    var xMax = padL + dispMaxBin * barW;
    ctx.beginPath(); ctx.moveTo(xMax, padT); ctx.lineTo(xMax, padT + drawH); ctx.stroke();
}

/**
 * Re-render the image, colorbar and histogram using the current global
 * display window [gDisplayMin, gDisplayMax].
 */
function rerenderImage() {
    if (!gPixels) return;

    var canvas     = document.getElementById('preview-canvas');
    var colorbar   = document.getElementById('colorbar-canvas');
    var histCanvas = document.getElementById('histogram-canvas');
    var minLabel   = document.getElementById('range-min-label');
    var maxLabel   = document.getElementById('range-max-label');

    renderGrayscale(canvas, gPixels, gWidth, gHeight, gDisplayMin, gDisplayMax);

    if (colorbar) {
        drawColorbar(colorbar, canvas, gDisplayMin, gDisplayMax);
    }

    if (histCanvas) {
        drawHistogram(histCanvas, gPixels, gDataMin, gDataMax, gDisplayMin, gDisplayMax);
    }

    if (minLabel) minLabel.textContent = gDisplayMin;
    if (maxLabel) maxLabel.textContent = gDisplayMax;
}

/**
 * Initialise the controls panel (histogram + dual slider) after image load.
 */
function initControls(dataMin, dataMax) {
    var controls   = document.getElementById('preview-controls');
    var sliderMin  = document.getElementById('range-min');
    var sliderMax  = document.getElementById('range-max');
    var minLabel   = document.getElementById('range-min-label');
    var maxLabel   = document.getElementById('range-max-label');
    var histCanvas = document.getElementById('histogram-canvas');

    if (!controls || !sliderMin || !sliderMax) return;

    sliderMin.min   = dataMin;
    sliderMin.max   = dataMax;
    sliderMin.value = dataMin;

    sliderMax.min   = dataMin;
    sliderMax.max   = dataMax;
    sliderMax.value = dataMax;

    if (minLabel) minLabel.textContent = dataMin;
    if (maxLabel) maxLabel.textContent = dataMax;

    controls.style.display = 'block';

    if (histCanvas) {
        setTimeout(function() {
            drawHistogram(histCanvas, gPixels, gDataMin, gDataMax, gDisplayMin, gDisplayMax);
        }, 0);
    }
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
    var controls      = document.getElementById('preview-controls');
    var intensityDiv  = document.getElementById('preview-intensity');

    if (container)    { container.style.display   = 'none'; }
    if (placeholder)  { placeholder.style.display = 'none'; }
    if (errorDiv)     { errorDiv.style.display = 'none'; errorDiv.textContent = ''; }
    if (infoDiv)      { infoDiv.textContent = ''; }
    if (loading)      { loading.style.display = 'block'; }
    if (controls)     { controls.style.display = 'none'; }
    if (intensityDiv) { intensityDiv.textContent = ''; }

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

        var pixels;
        try {
            pixels = base64ToUint16Array(resp.pixels_b64);
        } catch (e) {
            showError('Ошибка декодирования данных изображения');
            return;
        }

        gPixels     = pixels;
        gWidth      = resp.width;
        gHeight     = resp.height;
        gDataMin    = resp.data_min;
        gDataMax    = resp.data_max;
        gDisplayMin = resp.data_min;
        gDisplayMax = resp.data_max;

        renderGrayscale(canvas, pixels, resp.width, resp.height, resp.data_min, resp.data_max);

        if (container) { container.style.display = 'flex'; }

        if (colorbar) {
            // Два requestAnimationFrame гарантируют, что браузер завершил
            // layout flex-контейнера перед тем, как мы читаем getBoundingClientRect().
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    drawColorbar(colorbar, canvas, resp.data_min, resp.data_max);

                    // ResizeObserver: перерисовываем колорбар при каждом
                    // изменении размеров canvas (ресайз окна и т.п.).
                    if (window.ResizeObserver) {
                        if (window._previewResizeObserver) {
                            window._previewResizeObserver.disconnect();
                        }
                        window._previewResizeObserver = new ResizeObserver(function() {
                            if (gPixels) {
                                drawColorbar(colorbar, canvas, gDisplayMin, gDisplayMax);
                            }
                        });
                        window._previewResizeObserver.observe(canvas);
                    }
                });
            });
        }

        if (exposureLabel) {
            exposureLabel.textContent = 'Экспозиция: ' + exposureSec + ' с';
        }
        if (infoDiv) {
            infoDiv.textContent = resp.width + '×' + resp.height + ' пикс  |  ' +
                'мин: ' + resp.data_min + '  макс: ' + resp.data_max;
        }

        initControls(resp.data_min, resp.data_max);
    };

    xhr.onerror = function() {
        if (loading) { loading.style.display = 'none'; }
        showError('Ошибка сети при запросе изображения');
    };

    xhr.send(JSON.stringify({
        exposure_sec: parseFloat(exposureSec) || 1.0,
        downsample: 4
    }));

    function showError(msg) {
        if (placeholder) { placeholder.style.display = 'block'; }
        if (errorDiv)    { errorDiv.style.display = 'block'; errorDiv.textContent = msg; }
    }
}

// ─── DOM ready ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {

    // ── Voltage form ──────────────────────────────────────────────────────────
    (function() {
        var btn = document.querySelector('[name="experiment_on_voltage"]');
        if (!btn || btn.disabled) return;
        var form = btn.closest('form') || btn.form;
        if (!form) return;
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            ajaxSubmitForm(form, 'experiment_on_voltage');
        });
    })();

    // ── Current form ──────────────────────────────────────────────────────────
    (function() {
        var btn = document.querySelector('[name="experiment_on_current"]');
        if (!btn || btn.disabled) return;
        var form = btn.closest('form') || btn.form;
        if (!form) return;
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            ajaxSubmitForm(form, 'experiment_on_current');
        });
    })();

    // ── Horizontal move form ──────────────────────────────────────────────────
    (function() {
        var btn = document.querySelector('[name="move_hor_submit"]');
        if (!btn || btn.disabled) return;
        var form = btn.closest('form') || btn.form;
        if (!form) return;
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            ajaxSubmitForm(form, 'move_hor_submit');
        });
    })();

    // ── Rotate form ───────────────────────────────────────────────────────────
    (function() {
        var btn = document.querySelector('[name="rotate_submit"]');
        if (!btn || btn.disabled) return;
        var form = btn.closest('form') || btn.form;
        if (!form) return;
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            ajaxSubmitForm(form, 'rotate_submit');
        });
    })();

    // ── Reset angle form ──────────────────────────────────────────────────────
    (function() {
        var btn = document.querySelector('[name="reset_submit"]');
        if (!btn || btn.disabled) return;
        var form = btn.closest('form') || btn.form;
        if (!form) return;
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            ajaxSubmitForm(form, 'reset_submit');
        });
    })();

    // ── Shutter buttons ───────────────────────────────────────────────────────
    var btnOpen  = document.getElementById('btn-shutter-open');
    var btnClose = document.getElementById('btn-shutter-close');

    if (btnOpen && !btnOpen.disabled) {
        btnOpen.addEventListener('click', function() {
            ajaxShutterCommand('open');
        });
    }

    if (btnClose && !btnClose.disabled) {
        btnClose.addEventListener('click', function() {
            ajaxShutterCommand('close');
        });
    }

    // ── Exposure form submit (preview) ────────────────────────────────────────
    var form = document.querySelector('form[name="picture_exposure_form"]');
    if (form) {
        form.addEventListener('submit', function(e) {
            var submitBtn = document.getElementById('picture_exposure_submit');
            if (!submitBtn || submitBtn.disabled) return;

            var exposureInput = document.getElementById('picture_exposure');
            var exposureSec = exposureInput ? exposureInput.value : '';
            if (!exposureSec) return;

            e.preventDefault();
            loadPreview(exposureSec);
        });
    }

    // ── Mousemove on preview canvas → intensity readout ───────────────────────
    var canvas       = document.getElementById('preview-canvas');
    var intensityDiv = document.getElementById('preview-intensity');

    if (canvas && intensityDiv) {
        canvas.addEventListener('mousemove', function(e) {
            if (!gPixels) return;

            var rect   = canvas.getBoundingClientRect();
            var scaleX = gWidth  / rect.width;
            var scaleY = gHeight / rect.height;
            var px = Math.floor((e.clientX - rect.left) * scaleX);
            var py = Math.floor((e.clientY - rect.top)  * scaleY);

            if (px < 0 || px >= gWidth || py < 0 || py >= gHeight) {
                intensityDiv.textContent = '';
                return;
            }

            var val = gPixels[py * gWidth + px];
            intensityDiv.textContent = 'x=' + px + ', y=' + py + '  |  значение: ' + val;
        });

        canvas.addEventListener('mouseleave', function() {
            intensityDiv.textContent = '';
        });
    }

    // ── Dual range slider events ──────────────────────────────────────────────
    var sliderMin = document.getElementById('range-min');
    var sliderMax = document.getElementById('range-max');

    if (sliderMin && sliderMax) {

        sliderMin.addEventListener('input', function() {
            var vMin = parseInt(sliderMin.value, 10);
            var vMax = parseInt(sliderMax.value, 10);
            if (vMin >= vMax) {
                vMin = vMax - 1;
                sliderMin.value = vMin;
            }
            gDisplayMin = vMin;
            rerenderImage();
        });

        sliderMax.addEventListener('input', function() {
            var vMin = parseInt(sliderMin.value, 10);
            var vMax = parseInt(sliderMax.value, 10);
            if (vMax <= vMin) {
                vMax = vMin + 1;
                sliderMax.value = vMax;
            }
            gDisplayMax = vMax;
            rerenderImage();
        });
    }
});
