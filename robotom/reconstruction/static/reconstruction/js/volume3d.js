/* Студия реконструкции — 3D-вид готового объёма (WebGL2, проход лучей по 3D-текстуре).
 *
 * Объём приходит из GET results/<id>/volume3d: uint8 (nz, ny, nx), значение = код · scale + offset, воксель
 * кубический. Текстура R8 с линейной интерполяцией загружается в видеопамять целиком; на каждый пиксель экрана луч
 * идёт от глаза через коробку объёма с шагом в полвокселя (во время поворота — в воксель).
 *
 * Режимы — как в сегментаторе Tomat (napari/vispy):
 *  - «Мягкий» (attenuated MIP): вдоль луча берётся максимум значения в окне, ослабленного пройденным веществом:
 *    s = v · exp(−затухание · Σ v·шаг) — сумма по вокселям перед точкой, v ∈ [0, 1] по окну контраста. Затухание
 *    («Глубина») — на воксель вещества с яркостью верха окна: меньше — видно глубже;
 *  - «Максимум» (MIP): максимум вдоль луча — ярче всего, но глубина не читается;
 *  - «Поверхность»: первая точка луча, где значение ≥ порога (доля окна контраста, поэтому оболочка едет вместе с
 *    окном), уточнение делением отрезка, освещение по градиенту (свет от глаза); на срезанной грани разреза —
 *    по нормали плоскости.
 * Гамма применяется к итоговой яркости (меньше 1 — светлее полутона).
 * Разрез — плоскость, перпендикулярная оси x, y или z; остаётся половина со стороны side. Плоскость среза шага
 * «Результат» и габаритная рамка рисуются линиями поверх объёма, оси — цветными отрезками из угла (0, 0, 0):
 * x — красный, y — зелёный, z — синий.
 *
 * Координаты: воксельные (x, y, z) ∈ [0, nx] × [0, ny] × [0, nz] — воксель i занимает [i, i + 1); z — строка
 * детектора, растёт вниз. Мир — поворот на 180° вокруг x: (x, −y, −z), центр объёма в нуле, наибольшая сторона = 1,
 * вверх экрана — мировая z, то есть срез z = 0 (верхняя строка детектора) наверху, образец стоит как на кадре.
 * Поворот, а не отражение: образец не зеркалится; сверху (вдоль −z мира) срез виден как в 2D: x вправо, y вниз.
 * Матрицы — column-major Float32Array(16), как ждёт WebGL.
 *
 * S.vol3d — чистая логика (node-тесты), S.View3D — отрисовка. С просмотрщиком (viewer.js) вид связан через
 * desc.external: просмотрщик держит изображение для гистограммы и окна, а рисует и обрабатывает мышь этот модуль. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;

    var DEG = Math.PI / 180;
    var FOVY = 30 * DEG;

    // --- матрицы ----------------------------------------------------------------------------------------------

    var m4 = {
        identity: function () {
            var m = new Float32Array(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            return m;
        },
        /** a · b */
        multiply: function (a, b) {
            var o = new Float32Array(16);
            for (var c = 0; c < 4; c++) {
                for (var r = 0; r < 4; r++) {
                    var s = 0;
                    for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
                    o[c * 4 + r] = s;
                }
            }
            return o;
        },
        perspective: function (fovy, aspect, near, far) {
            var f = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
            o[0] = f / aspect;
            o[5] = f;
            o[10] = (far + near) / (near - far);
            o[11] = -1;
            o[14] = 2 * far * near / (near - far);
            return o;
        },
        lookAt: function (eye, target, up) {
            var z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
            var o = new Float32Array(16);
            o[0] = x[0]; o[4] = x[1]; o[8] = x[2];
            o[1] = y[0]; o[5] = y[1]; o[9] = y[2];
            o[2] = z[0]; o[6] = z[1]; o[10] = z[2];
            o[12] = -dot(x, eye);
            o[13] = -dot(y, eye);
            o[14] = -dot(z, eye);
            o[15] = 1;
            return o;
        },
        translation: function (t) {
            var o = m4.identity();
            o[12] = t[0]; o[13] = t[1]; o[14] = t[2];
            return o;
        },
        scaling: function (s) {
            var o = m4.identity();
            o[0] = s; o[5] = s; o[10] = s;
            return o;
        },
        /** Точка p (x, y, z) через m с делением на w. */
        apply: function (m, p) {
            var x = p[0], y = p[1], z = p[2];
            var w = m[3] * x + m[7] * y + m[11] * z + m[15];
            return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
                (m[2] * x + m[6] * y + m[10] * z + m[14]) / w];
        }
    };

    function sub(a, b) {
        return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    }
    function dot(a, b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
    function cross(a, b) {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }
    function norm(a) {
        var l = Math.sqrt(dot(a, a)) || 1;
        return [a[0] / l, a[1] / l, a[2] / l];
    }

    // --- камера и геометрия -------------------------------------------------------------------------------

    /** Размеры (nx, ny, nz) в мире: наибольшая сторона = 1. */
    function extents(dims) {
        var m = Math.max(dims[0], dims[1], dims[2]) || 1;
        return [dims[0] / m, dims[1] / m, dims[2] / m];
    }

    /** Расстояние, с которого описанная сфера коробки целиком видна при вертикальном угле fovy и отношении сторон. */
    function fitDistance(dims, fovy, aspect) {
        var e = extents(dims);
        var r = 0.5 * Math.sqrt(dot(e, e));
        var fovx = 2 * Math.atan(Math.tan(fovy / 2) * (aspect > 0 ? aspect : 1));
        return r / Math.sin(Math.min(fovy, fovx) / 2) * 1.05;
    }

    /** Камера по умолчанию: вид спереди-сбоку и чуть сверху, вписано. */
    function defaultCamera(dims, aspect) {
        return {az: -55 * DEG, el: 20 * DEG, dist: fitDistance(dims, FOVY, aspect), target: [0, 0, 0]};
    }

    /** Положение глаза в мире: орбита вокруг target, z вверх. */
    function eyePosition(cam) {
        var ce = Math.cos(cam.el);
        return [cam.target[0] + cam.dist * ce * Math.cos(cam.az), cam.target[1] + cam.dist * ce * Math.sin(cam.az),
            cam.target[2] + cam.dist * Math.sin(cam.el)];
    }

    /** Поворот на 180° вокруг x: (x, y, z) → (x, −y, −z) — строка детектора 0 (срез z = 0) наверху. */
    var FLIP = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);

    /** Матрицы кадра: {model (воксели → мир), view, proj, mvp (воксели → клип), eyeVox (глаз в вокселях)}. */
    function frameMatrices(dims, cam, aspect) {
        var m = Math.max(dims[0], dims[1], dims[2]) || 1;
        var model = m4.multiply(m4.scaling(1 / m),
            m4.multiply(FLIP, m4.translation([-dims[0] / 2, -dims[1] / 2, -dims[2] / 2])));
        var eye = eyePosition(cam);
        var view = m4.lookAt(eye, cam.target, [0, 0, 1]);
        var near = Math.max(cam.dist * 0.01, 1e-3), far = cam.dist + 4;
        var proj = m4.perspective(FOVY, aspect > 0 ? aspect : 1, near, far);
        var mvp = m4.multiply(proj, m4.multiply(view, model));
        var eyeVox = [eye[0] * m + dims[0] / 2, -eye[1] * m + dims[1] / 2, -eye[2] * m + dims[2] / 2];
        return {model: model, view: view, proj: proj, mvp: mvp, eyeVox: eyeVox};
    }

    /** Поворот орбиты на сдвиг мыши (dx, dy) пикселей: 0,4° на пиксель; высота ограничена ±89°. */
    function orbit(cam, dx, dy) {
        return Object.assign({}, cam, {az: cam.az - dx * 0.4 * DEG,
            el: core.clamp(cam.el + dy * 0.4 * DEG, -89 * DEG, 89 * DEG)});
    }

    /** Сдвиг цели в плоскости экрана: (dx, dy) пикселей при высоте вида H. */
    function pan(cam, dx, dy, H) {
        var eye = eyePosition(cam);
        var fwd = norm(sub(cam.target, eye));
        var right = norm(cross(fwd, [0, 0, 1]));
        var up = cross(right, fwd);
        var k = 2 * cam.dist * Math.tan(FOVY / 2) / Math.max(1, H);
        var t = cam.target;
        return Object.assign({}, cam, {target: [t[0] - (right[0] * dx - up[0] * dy) * k,
            t[1] - (right[1] * dx - up[1] * dy) * k, t[2] - (right[2] * dx - up[2] * dy) * k]});
    }

    /** Приближение: дистанция × factor, в пределах [0,05; 20]. */
    function zoom(cam, factor) {
        return Object.assign({}, cam, {dist: core.clamp(cam.dist * factor, 0.05, 20)});
    }

    /** Окно [lo, hi] в физических единицах → в единицах текстуры R8 (код / 255). */
    function texWindow(lo, hi, scale, offset) {
        var s = scale > 0 ? scale * 255 : 1;
        var a = (lo - offset) / s, b = (hi - offset) / s;
        if (!(b > a)) b = a + 1e-6;
        return [a, b];
    }

    /** Положение плоскости среза копии (номер i) в вокселях 3D-объёма, уменьшенного ещё в f раз: центр среза. */
    function slicePosition(i, f) {
        return (i + 0.5) / Math.max(1, f);
    }

    /** Рёбра коробки [0, nx] × [0, ny] × [0, nz]: 24 вершины (12 отрезков). */
    function boxEdges(dims) {
        var x = dims[0], y = dims[1], z = dims[2], out = [];
        var c = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
        [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
            .forEach(function (e) {
                out.push.apply(out, c[e[0]]);
                out.push.apply(out, c[e[1]]);
            });
        return new Float32Array(out);
    }

    /** Контур плоскости axis = pos (0 — x, 1 — y, 2 — z) внутри коробки: 8 вершин (4 отрезка). */
    function planeEdges(dims, axis, pos) {
        var a = (axis + 1) % 3, b = (axis + 2) % 3, pts = [];
        [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(function (q) {
            var p = [0, 0, 0];
            p[axis] = pos;
            p[a] = q[0] * dims[a];
            p[b] = q[1] * dims[b];
            pts.push(p);
        });
        var out = [];
        for (var i = 0; i < 4; i++) {
            out.push.apply(out, pts[i]);
            out.push.apply(out, pts[(i + 1) % 4]);
        }
        return new Float32Array(out);
    }

    /** Оси из угла (0, 0, 0): по отрезку длиной len вдоль x, y, z — 6 вершин. */
    function axesEdges(len) {
        return new Float32Array([0, 0, 0, len, 0, 0, 0, 0, 0, 0, len, 0, 0, 0, 0, 0, 0, len]);
    }

    var MODES = {soft: 0, mip: 1, iso: 2};

    S.vol3d = {
        m4: m4, extents: extents, fitDistance: fitDistance, defaultCamera: defaultCamera, eyePosition: eyePosition,
        frameMatrices: frameMatrices, orbit: orbit, pan: pan, zoom: zoom, texWindow: texWindow,
        slicePosition: slicePosition, boxEdges: boxEdges, planeEdges: planeEdges, axesEdges: axesEdges, MODES: MODES,
        FOVY: FOVY
    };

    // --- шейдеры ----------------------------------------------------------------------------------------------

    var VS_VOL = [
        '#version 300 es',
        'in vec3 a_pos;',
        'uniform mat4 u_mvp;',
        'out vec3 v_pos;',
        'void main() { v_pos = a_pos; gl_Position = u_mvp * vec4(a_pos, 1.0); }'
    ].join('\n');

    var FS_VOL = [
        '#version 300 es',
        'precision highp float;',
        'precision highp sampler3D;',
        'in vec3 v_pos;',
        'out vec4 o_color;',
        'uniform sampler3D u_vol;',
        'uniform vec3 u_dims;',       // nx, ny, nz
        'uniform vec3 u_eye;',        // глаз, воксели
        'uniform int u_mode;',        // 0 мягкий, 1 максимум, 2 поверхность
        'uniform vec2 u_win;',        // окно, единицы текстуры
        'uniform float u_gamma;',
        'uniform float u_atten;',     // затухание на воксель вещества с яркостью верха окна
        'uniform float u_iso;',       // порог, единицы текстуры
        'uniform float u_step;',      // шаг, воксели
        'uniform int u_clip_axis;',   // −1 — без разреза
        'uniform float u_clip_pos;',
        'uniform float u_clip_side;',
        '',
        'float tex(vec3 p) { return texture(u_vol, p / u_dims).r; }',
        'float win(float t) { return clamp((t - u_win.x) / (u_win.y - u_win.x), 0.0, 1.0); }',
        '',
        'void main() {',
        '    vec3 dir = normalize(v_pos - u_eye);',
        '    vec3 d = dir;',
        '    if (abs(d.x) < 1e-7) d.x = 1e-7;',
        '    if (abs(d.y) < 1e-7) d.y = 1e-7;',
        '    if (abs(d.z) < 1e-7) d.z = 1e-7;',
        '    vec3 t0 = -u_eye / d, t1 = (u_dims - u_eye) / d;',
        '    vec3 tmin = min(t0, t1), tmax = max(t0, t1);',
        '    float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));',
        '    float tf = min(min(tmax.x, tmax.y), tmax.z);',
        '    bool cut = false;',          // луч входит в объём через плоскость разреза
        '    if (u_clip_axis >= 0) {',
        '        float e = u_eye[u_clip_axis], dc = dir[u_clip_axis];',
        '        if (abs(dc) < 1e-7) {',
        '            if ((e - u_clip_pos) * u_clip_side < 0.0) discard;',
        '        } else {',
        '            float tp = (u_clip_pos - e) / dc;',
        '            if (u_clip_side * dc > 0.0) { cut = tp > tn; tn = max(tn, tp); } else tf = min(tf, tp);',
        '        }',
        '    }',
        '    if (tf <= tn) discard;',
        // сдвиг начала луча на долю шага по пикселю — без «древесных колец» от одинаковых шагов соседних лучей
        '    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);',
        '    float t = tn + jitter * u_step;',
        '    float best = 0.0, sum = 0.0, prev = -1.0;',
        '    for (int i = 0; i < 16384; i++) {',
        '        if (t > tf) break;',
        '        vec3 p = u_eye + dir * t;',
        '        float v = tex(p);',
        '        if (u_mode == 1) {',
        '            best = max(best, v);',
        '        } else if (u_mode == 0) {',
        '            float w = win(v);',
        '            best = max(best, w * exp(-u_atten * sum));',
        '            sum += w * u_step;',
        '        } else if (v >= u_iso) {',
        // поверхность: уточнить пересечение делением отрезка [t − шаг, t]
        '            float a = max(t - u_step, tn), b = t;',
        '            for (int k = 0; k < 5; k++) {',
        '                float m = 0.5 * (a + b);',
        '                if (tex(u_eye + dir * m) >= u_iso) b = m; else a = m;',
        '            }',
        '            vec3 q = u_eye + dir * b;',
        '            vec3 g = vec3(tex(q + vec3(1, 0, 0)) - tex(q - vec3(1, 0, 0)),',
        '                          tex(q + vec3(0, 1, 0)) - tex(q - vec3(0, 1, 0)),',
        '                          tex(q + vec3(0, 0, 1)) - tex(q - vec3(0, 0, 1)));',
        // на срезанной грани (вещество уже в первой точке за плоскостью) — нормаль плоскости, а не шумный градиент
        '            float diff = (cut && b <= tn + u_step) ? abs(dir[max(u_clip_axis, 0)]) :',
        '                (length(g) > 1e-6 ? abs(dot(normalize(g), dir)) : 1.0);',
        '            float spec = pow(diff, 24.0) * 0.25;',
        '            vec3 c = vec3(0.86, 0.82, 0.74) * (0.22 + 0.78 * diff) + spec;',
        '            o_color = vec4(pow(clamp(c, 0.0, 1.0), vec3(u_gamma)), 1.0);',
        '            return;',
        '        }',
        '        t += u_step;',
        '    }',
        '    if (u_mode == 2) discard;',
        '    float g = u_mode == 1 ? win(best) : best;',
        '    o_color = vec4(vec3(pow(g, u_gamma)), 1.0);',
        '}'
    ].join('\n');

    var VS_LINE = [
        '#version 300 es',
        'in vec3 a_pos;',
        'uniform mat4 u_mvp;',
        'void main() { gl_Position = u_mvp * vec4(a_pos, 1.0); }'
    ].join('\n');

    var FS_LINE = [
        '#version 300 es',
        'precision mediump float;',
        'uniform vec4 u_color;',
        'out vec4 o_color;',
        'void main() { o_color = u_color; }'
    ].join('\n');

    function compile(gl, type, src) {
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            var log = gl.getShaderInfoLog(sh);
            gl.deleteShader(sh);
            throw new Error('шейдер не собрался: ' + log);
        }
        return sh;
    }

    function program(gl, vs, fs) {
        var p = gl.createProgram();
        gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, 'a_pos');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('программа не собралась: ' + gl.getProgramInfoLog(p));
        var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < n; i++) {
            var name = gl.getActiveUniform(p, i).name;
            u[name] = gl.getUniformLocation(p, name);
        }
        return {p: p, u: u};
    }

    // --- вид ----------------------------------------------------------------------------------------------------

    var HINT = 'перетаскивание — поворот, Shift или правая кнопка — сдвиг, колесо — масштаб, двойной щелчок — ' +
        'исходный вид; оси: x — красная, y — зелёная, z — синяя';

    /** Настройки по умолчанию (как в сегментаторе: «Мягкий», затухание 0,05, порог — середина окна). */
    function defaults() {
        return {mode: 'soft', gamma: 1, atten: 0.05, iso: 0.5, box: true, axes: true,
            clip: {enabled: false, axis: 2, pos: 0.5, side: 1}, slice: null};
    }

    /**
     * stage — контейнер просмотрщика; canvas вставляется перед opts.before (наложение SVG просмотрщика).
     * Без WebGL2 — supported() === false, остальное ничего не делает.
     */
    function View3D(stage, opts) {
        opts = opts || {};
        this.stage = stage;
        this.hint = HINT;
        this.opts = defaults();
        this.vol = null;          // {dims, scale, offset}
        this.cam = null;
        this.win = null;
        this.active = false;
        this._raf = 0;
        this._settle = 0;
        this._drag = null;
        this.canvas = root.document.createElement('canvas');
        this.canvas.className = 'sv-canvas sv-gl hidden';
        stage.insertBefore(this.canvas, opts.before || null);
        var gl = null;
        try {
            gl = this.canvas.getContext('webgl2', {antialias: true, premultipliedAlpha: false,
                preserveDrawingBuffer: true});
        } catch (e) {
            gl = null;
        }
        this.gl = gl;
        this.error = null;
        if (gl) {
            try {
                this._initGL();
            } catch (e) {
                this.error = e.message;
                this.gl = null;
            }
        } else {
            this.error = 'браузер не поддерживает WebGL2';
        }
        this._bind();
    }

    View3D.prototype.supported = function () {
        return !!this.gl;
    };

    /** Наибольшая сторона 3D-текстуры, которую примет видеокарта (не больше 1024 — дальше сервис не просим). */
    View3D.prototype.maxSide = function () {
        if (!this.gl) return 0;
        return Math.min(1024, this.gl.getParameter(this.gl.MAX_3D_TEXTURE_SIZE) || 256);
    };

    View3D.prototype._initGL = function () {
        var gl = this.gl;
        this.progVol = program(gl, VS_VOL, FS_VOL);
        this.progLine = program(gl, VS_LINE, FS_LINE);
        this.vaoBox = gl.createVertexArray();
        this.bufBox = gl.createBuffer();
        this.vaoLine = gl.createVertexArray();
        this.bufLine = gl.createBuffer();
        this.tex = gl.createTexture();
        this._lineCount = 0;
    };

    /** Объём из ответа volume3d (core.decodeBinary: w = nx, h = ny, k = nz, uint8). */
    View3D.prototype.setVolume = function (img) {
        var dims = [img.w, img.h, img.k];
        var first = !this.vol || this.vol.dims.join() !== dims.join();
        this.vol = {dims: dims, scale: img.scale, offset: img.offset, data: img.data};
        if (!this.gl) return;
        this._upload();
        if (first || !this.cam) this.cam = defaultCamera(dims, this._aspect());
        this._geometry();
        this.render();
    };

    View3D.prototype._upload = function () {
        var gl = this.gl, v = this.vol, d = v.dims;
        gl.bindTexture(gl.TEXTURE_3D, this.tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, d[0], d[1], d[2], 0, gl.RED, gl.UNSIGNED_BYTE, v.data);
    };

    /** Буферы: коробка (треугольники — задние грани для лучей) и линии (рамка, плоскость среза, оси). */
    View3D.prototype._geometry = function () {
        var gl = this.gl, d = this.vol.dims;
        var x = d[0], y = d[1], z = d[2];
        var c = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
        var faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
        var tri = [];
        faces.forEach(function (f) {
            [f[0], f[1], f[2], f[0], f[2], f[3]].forEach(function (i) {
                tri.push(c[i][0], c[i][1], c[i][2]);
            });
        });
        gl.bindVertexArray(this.vaoBox);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufBox);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tri), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this._lines();
    };

    View3D.prototype._lines = function () {
        if (!this.gl || !this.vol) return;
        var gl = this.gl, d = this.vol.dims, o = this.opts, parts = [], segs = [];
        var push = function (arr, color) {
            segs.push({first: parts.length / 3, count: arr.length / 3, color: color});
            for (var i = 0; i < arr.length; i++) parts.push(arr[i]);
        };
        if (o.box) push(boxEdges(d), [0.65, 0.65, 0.65, 0.7]);
        if (o.slice && o.slice.pos >= 0 && o.slice.pos <= d[o.slice.axis]) {
            push(planeEdges(d, o.slice.axis, o.slice.pos), [1.0, 0.62, 0.1, 0.95]);
        }
        if (o.axes) {
            var a = axesEdges(Math.max(d[0], d[1], d[2]) * 0.18);
            push(a.subarray(0, 6), [0.95, 0.3, 0.3, 1]);
            push(a.subarray(6, 12), [0.35, 0.85, 0.35, 1]);
            push(a.subarray(12, 18), [0.35, 0.55, 1.0, 1]);
        }
        gl.bindVertexArray(this.vaoLine);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bufLine);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(parts.length ? parts : [0, 0, 0]), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        this._segs = segs;
    };

    /** Изменить настройки: {mode, gamma, atten, iso, box, axes, clip: {...}, slice: {axis, pos} | null}. */
    View3D.prototype.set = function (patch) {
        var o = this.opts;
        Object.keys(patch || {}).forEach(function (k) {
            if (k === 'clip') o.clip = Object.assign({}, o.clip, patch.clip);
            else o[k] = patch[k];
        });
        if ('box' in patch || 'slice' in patch || 'axes' in patch) this._lines();
        this.render();
    };

    /** Окно контраста (физические единицы) — из гистограммы просмотрщика. */
    View3D.prototype.setWindow = function (lo, hi) {
        this.win = [lo, hi];
        this.render();
    };

    View3D.prototype.activate = function (on) {
        this.active = !!on;
        this.canvas.classList.toggle('hidden', !on);
        if (on) {
            this._resize();
            this.render();
        }
    };

    /** Сторона разреза (side), при которой остаётся дальняя от глаза половина — срезанная грань смотрит на зрителя. */
    View3D.prototype.farSide = function (axis, pos) {
        if (!this.vol || !this.cam) return 1;
        var d = this.vol.dims;
        var eye = frameMatrices(d, this.cam, this._aspect()).eyeVox;
        return eye[axis] > pos * d[axis] ? -1 : 1;
    };

    /** Исходный вид (двойной щелчок, «Вписать»). */
    View3D.prototype.fit = function () {
        if (!this.vol) return;
        this.cam = defaultCamera(this.vol.dims, this._aspect());
        this.render();
    };

    View3D.prototype._aspect = function () {
        var W = this.stage.clientWidth, H = this.stage.clientHeight;
        return W > 0 && H > 0 ? W / H : 1;
    };

    View3D.prototype._resize = function () {
        var dpr = Math.min(root.devicePixelRatio || 1, 2);
        var W = Math.max(1, Math.round(this.stage.clientWidth * dpr)), H = Math.max(1, Math.round(this.stage.clientHeight * dpr));
        if (this.canvas.width !== W || this.canvas.height !== H) {
            this.canvas.width = W;
            this.canvas.height = H;
        }
    };

    /** Перерисовать в следующем кадре; fast — грубый шаг (во время поворота), потом — точный. */
    View3D.prototype.render = function (fast) {
        var self = this;
        if (!this.gl || !this.active) return;
        this._fast = !!fast;
        if (this._raf) return;
        var raf = root.requestAnimationFrame || function (f) {
            return setTimeout(f, 16);
        };
        this._raf = raf(function () {
            self._raf = 0;
            self._draw();
            clearTimeout(self._settle);
            if (self._fast) {
                self._settle = setTimeout(function () {
                    self.render(false);
                }, 150);
            }
        });
    };

    View3D.prototype._draw = function () {
        var gl = this.gl;
        if (!gl || !this.vol || gl.isContextLost()) return;
        this._resize();
        var W = this.canvas.width, H = this.canvas.height;
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        var v = this.vol, o = this.opts, d = v.dims;
        var fm = frameMatrices(d, this.cam, W / H);
        var tw = this.win ? texWindow(this.win[0], this.win[1], v.scale, v.offset) : [0, 1];

        // объём: задние грани коробки — луч от глаза (или от передней грани) до них
        var P = this.progVol, u = P.u;
        gl.useProgram(P.p);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, this.tex);
        gl.uniform1i(u.u_vol, 0);
        gl.uniformMatrix4fv(u.u_mvp, false, fm.mvp);
        gl.uniform3f(u.u_dims, d[0], d[1], d[2]);
        gl.uniform3f(u.u_eye, fm.eyeVox[0], fm.eyeVox[1], fm.eyeVox[2]);
        gl.uniform1i(u.u_mode, MODES[o.mode] !== undefined ? MODES[o.mode] : 0);
        gl.uniform2f(u.u_win, tw[0], tw[1]);
        gl.uniform1f(u.u_gamma, o.gamma);
        gl.uniform1f(u.u_atten, o.atten);
        gl.uniform1f(u.u_iso, tw[0] + o.iso * (tw[1] - tw[0]));
        gl.uniform1f(u.u_step, this._fast ? 1.0 : 0.5);
        var c = o.clip;
        gl.uniform1i(u.u_clip_axis, c.enabled ? c.axis : -1);
        gl.uniform1f(u.u_clip_pos, c.pos * d[c.axis]);
        gl.uniform1f(u.u_clip_side, c.side >= 0 ? 1 : -1);
        gl.bindVertexArray(this.vaoBox);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
        gl.disable(gl.CULL_FACE);

        // линии поверх
        if (this._segs && this._segs.length) {
            var L = this.progLine;
            gl.useProgram(L.p);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.uniformMatrix4fv(L.u.u_mvp, false, fm.mvp);
            gl.bindVertexArray(this.vaoLine);
            this._segs.forEach(function (s) {
                gl.uniform4fv(L.u.u_color, s.color);
                gl.drawArrays(gl.LINES, s.first, s.count);
            });
            gl.disable(gl.BLEND);
        }
        gl.bindVertexArray(null);
    };

    View3D.prototype._bind = function () {
        var self = this, cv = this.canvas;
        cv.addEventListener('contextmenu', function (e) {
            e.preventDefault();
        });
        cv.addEventListener('pointerdown', function (e) {
            if (!self.cam) return;
            var panMode = e.button === 2 || e.button === 1 || e.shiftKey;
            if (e.button !== 0 && !panMode) return;
            e.preventDefault();
            self._drag = {id: e.pointerId, x: e.clientX, y: e.clientY, pan: panMode};
            try {
                cv.setPointerCapture(e.pointerId);
            } catch (err) { /* указатель уже отпущен */ }
            self.stage.classList.add('sv-panning');
        });
        cv.addEventListener('pointermove', function (e) {
            var dr = self._drag;
            if (!dr || dr.id !== e.pointerId) return;
            var dx = e.clientX - dr.x, dy = e.clientY - dr.y;
            dr.x = e.clientX;
            dr.y = e.clientY;
            self.cam = dr.pan ? pan(self.cam, dx, dy, self.stage.clientHeight) : orbit(self.cam, dx, dy);
            self.render(true);
        });
        function end(e) {
            if (self._drag && self._drag.id === e.pointerId) {
                self._drag = null;
                self.stage.classList.remove('sv-panning');
                try {
                    cv.releasePointerCapture(e.pointerId);
                } catch (err) { /* уже отпущен */ }
                self.render(false);
            }
        }
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', end);
        cv.addEventListener('wheel', function (e) {
            if (!self.cam) return;
            e.preventDefault();
            var dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
            self.cam = zoom(self.cam, Math.exp(core.clamp(dy, -600, 600) * 0.0015));
            self.render(true);
        }, {passive: false});
        cv.addEventListener('dblclick', function () {
            self.fit();
        });
        cv.addEventListener('webglcontextlost', function (e) {
            e.preventDefault();
        });
        cv.addEventListener('webglcontextrestored', function () {
            try {
                self._initGL();
                if (self.vol) {
                    self._upload();
                    self._geometry();
                }
                self.render();
            } catch (err) {
                self.error = err.message;
            }
        });
        if (typeof root.ResizeObserver === 'function') {
            new root.ResizeObserver(function () {
                if (self.active) self.render();
            }).observe(this.stage);
        }
    };

    View3D.defaults = defaults;
    S.View3D = View3D;
})(typeof window !== 'undefined' ? window : globalThis);
