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
 * Палитра («Мягкий» и «Максимум»): серая или цветная из текстуры 256×1 (PALETTES). В «Мягком» с цветной палитрой цвет
 * берётся по значению в точке максимума, а затухание действует только на яркость. Шкала справа сверху: низ, середина
 * (с учётом гаммы) и верх окна в 1/мм; в «Поверхности» её нет.
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
    // Палитры: серая; перцептивно равномерные из matplotlib (палитры BIDS, CC0) — яркость растёт монотонно, ложных
    // границ нет, cividis различима и при дальтонизме; jet — привычная, но с ложными границами на голубом и жёлтом
    // (Borland, Taylor, IEEE CG&A 2007). Таблицы — 256 цветов RGB8 из matplotlib 3.10 (scratchpad make_palettes.py).
    var PALETTES = [['gray', 'серая'], ['inferno', 'inferno'], ['viridis', 'viridis'], ['magma', 'magma'],
        ['plasma', 'plasma'], ['cividis', 'cividis'], ['jet', 'jet']];
    var PALETTE_HEX = {
        inferno: '00000401000501010601010802010a02020c02020e03021004031204031405041706041907051b08051d09061f0a07220b07240c08260d08290e092b10092d110a30120a32140b34150b37160b39180c3c190c3e1b0c411c0c431e0c451f0c48210c4a230c4c240c4f260c51280b53290b552b0b572d0b592f0a5b310a5c320a5e340a5f3609613809623909633b09643d09653e0966400a67420a68440a68450a69470b6a490b6a4a0c6b4c0c6b4d0d6c4f0d6c510e6c520e6d540f6d550f6d57106e59106e5a116e5c126e5d126e5f136e61136e62146e64156e65156e67166e69166e6a176e6c186e6d186e6f196e71196e721a6e741a6e751b6e771c6d781c6d7a1d6d7c1d6d7d1e6d7f1e6c801f6c82206c84206b85216b87216b88226a8a226a8c23698d23698f24699025689225689326679526679727669827669a28659b29649d29649f2a63a02a63a22b62a32c61a52c60a62d60a82e5fa92e5eab2f5ead305dae305cb0315bb1325ab3325ab43359b63458b73557b93556ba3655bc3754bd3853bf3952c03a51c13a50c33b4fc43c4ec63d4dc73e4cc83f4bca404acb4149cc4248ce4347cf4446d04545d24644d34743d44842d54a41d74b3fd84c3ed94d3dda4e3cdb503bdd513ade5238df5337e05536e15635e25734e35933e45a31e55c30e65d2fe75e2ee8602de9612bea632aeb6429eb6628ec6726ed6925ee6a24ef6c23ef6e21f06f20f1711ff1731df2741cf3761bf37819f47918f57b17f57d15f67e14f68013f78212f78410f8850ff8870ef8890cf98b0bf98c0af98e09fa9008fa9207fa9407fb9606fb9706fb9906fb9b06fb9d07fc9f07fca108fca309fca50afca60cfca80dfcaa0ffcac11fcae12fcb014fcb216fcb418fbb61afbb81dfbba1ffbbc21fbbe23fac026fac228fac42afac62df9c72ff9c932f9cb35f8cd37f8cf3af7d13df7d340f6d543f6d746f5d949f5db4cf4dd4ff4df53f4e156f3e35af3e55df2e661f2e865f2ea69f1ec6df1ed71f1ef75f1f179f2f27df2f482f3f586f3f68af4f88ef5f992f6fa96f8fb9af9fc9dfafda1fcffa4',
        viridis: '44015444025645045745055946075a46085c460a5d460b5e470d60470e6147106347116447136548146748166848176948186a481a6c481b6d481c6e481d6f481f70482071482173482374482475482576482677482878482979472a7a472c7a472d7b472e7c472f7d46307e46327e46337f463480453581453781453882443983443a83443b84433d84433e85423f854240864241864142874144874045884046883f47883f48893e49893e4a893e4c8a3d4d8a3d4e8a3c4f8a3c508b3b518b3b528b3a538b3a548c39558c39568c38588c38598c375a8c375b8d365c8d365d8d355e8d355f8d34608d34618d33628d33638d32648e32658e31668e31678e31688e30698e306a8e2f6b8e2f6c8e2e6d8e2e6e8e2e6f8e2d708e2d718e2c718e2c728e2c738e2b748e2b758e2a768e2a778e2a788e29798e297a8e297b8e287c8e287d8e277e8e277f8e27808e26818e26828e26828e25838e25848e25858e24868e24878e23888e23898e238a8d228b8d228c8d228d8d218e8d218f8d21908d21918c20928c20928c20938c1f948c1f958b1f968b1f978b1f988b1f998a1f9a8a1e9b8a1e9c891e9d891f9e891f9f881fa0881fa1881fa1871fa28720a38620a48621a58521a68522a78522a88423a98324aa8325ab8225ac8226ad8127ad8128ae8029af7f2ab07f2cb17e2db27d2eb37c2fb47c31b57b32b67a34b67935b77937b87838b9773aba763bbb753dbc743fbc7340bd7242be7144bf7046c06f48c16e4ac16d4cc26c4ec36b50c46a52c56954c56856c66758c7655ac8645cc8635ec96260ca6063cb5f65cb5e67cc5c69cd5b6ccd5a6ece5870cf5773d05675d05477d1537ad1517cd2507fd34e81d34d84d44b86d54989d5488bd6468ed64590d74393d74195d84098d83e9bd93c9dd93ba0da39a2da37a5db36a8db34aadc32addc30b0dd2fb2dd2db5de2bb8de29bade28bddf26c0df25c2df23c5e021c8e020cae11fcde11dd0e11cd2e21bd5e21ad8e219dae319dde318dfe318e2e418e5e419e7e419eae51aece51befe51cf1e51df4e61ef6e620f8e621fbe723fde725',
        magma: '00000401000501010601010802010902020b02020d03030f03031204041405041606051806051a07061c08071e0907200a08220b09240c09260d0a290e0b2b100b2d110c2f120d31130d34140e36150e38160f3b180f3d19103f1a10421c10441d11471e114920114b21114e22115024125325125527125829115a2a115c2c115f2d11612f116331116533106734106936106b38106c390f6e3b0f703d0f713f0f72400f74420f75440f764510774710784910784a10794c117a4e117b4f127b51127c52137c54137d56147d57157e59157e5a167e5c167f5d177f5f187f601880621980641a80651a80671b80681c816a1c816b1d816d1d816e1e81701f81721f817320817521817621817822817922827b23827c23827e24828025828125818326818426818627818827818928818b29818c29818e2a81902a81912b81932b80942c80962c80982d80992d809b2e7f9c2e7f9e2f7fa02f7fa1307ea3307ea5317ea6317da8327daa337dab337cad347cae347bb0357bb2357bb3367ab5367ab73779b83779ba3878bc3978bd3977bf3a77c03a76c23b75c43c75c53c74c73d73c83e73ca3e72cc3f71cd4071cf4070d0416fd2426fd3436ed5446dd6456cd8456cd9466bdb476adc4869de4968df4a68e04c67e24d66e34e65e44f64e55064e75263e85362e95462ea5661eb5760ec5860ed5a5fee5b5eef5d5ef05f5ef1605df2625df2645cf3655cf4675cf4695cf56b5cf66c5cf66e5cf7705cf7725cf8745cf8765cf9785df9795df97b5dfa7d5efa7f5efa815ffb835ffb8560fb8761fc8961fc8a62fc8c63fc8e64fc9065fd9266fd9467fd9668fd9869fd9a6afd9b6bfe9d6cfe9f6dfea16efea36ffea571fea772fea973feaa74feac76feae77feb078feb27afeb47bfeb67cfeb77efeb97ffebb81febd82febf84fec185fec287fec488fec68afec88cfeca8dfecc8ffecd90fecf92fed194fed395fed597fed799fed89afdda9cfddc9efddea0fde0a1fde2a3fde3a5fde5a7fde7a9fde9aafdebacfcecaefceeb0fcf0b2fcf2b4fcf4b6fcf6b8fcf7b9fcf9bbfcfbbdfcfdbf',
        plasma: '0d088710078813078916078a19068c1b068d1d068e20068f2206902406912605912805922a05932c05942e05952f059631059733059735049837049938049a3a049a3c049b3e049c3f049c41049d43039e44039e46039f48039f4903a04b03a14c02a14e02a25002a25102a35302a35502a45601a45801a45901a55b01a55c01a65e01a66001a66100a76300a76400a76600a76700a86900a86a00a86c00a86e00a86f00a87100a87201a87401a87501a87701a87801a87a02a87b02a87d03a87e03a88004a88104a78305a78405a78606a68707a68808a68a09a58b0aa58d0ba58e0ca48f0da4910ea3920fa39410a29511a19613a19814a099159f9a169f9c179e9d189d9e199da01a9ca11b9ba21d9aa31e9aa51f99a62098a72197a82296aa2395ab2494ac2694ad2793ae2892b02991b12a90b22b8fb32c8eb42e8db52f8cb6308bb7318ab83289ba3388bb3488bc3587bd3786be3885bf3984c03a83c13b82c23c81c33d80c43e7fc5407ec6417dc7427cc8437bc9447aca457acb4679cc4778cc4977cd4a76ce4b75cf4c74d04d73d14e72d24f71d35171d45270d5536fd5546ed6556dd7566cd8576bd9586ada5a6ada5b69db5c68dc5d67dd5e66de5f65de6164df6263e06363e16462e26561e26660e3685fe4695ee56a5de56b5de66c5ce76e5be76f5ae87059e97158e97257ea7457eb7556eb7655ec7754ed7953ed7a52ee7b51ef7c51ef7e50f07f4ff0804ef1814df1834cf2844bf3854bf3874af48849f48948f58b47f58c46f68d45f68f44f79044f79143f79342f89441f89540f9973ff9983ef99a3efa9b3dfa9c3cfa9e3bfb9f3afba139fba238fca338fca537fca636fca835fca934fdab33fdac33fdae32fdaf31fdb130fdb22ffdb42ffdb52efeb72dfeb82cfeba2cfebb2bfebd2afebe2afec029fdc229fdc328fdc527fdc627fdc827fdca26fdcb26fccd25fcce25fcd025fcd225fbd324fbd524fbd724fad824fada24f9dc24f9dd25f8df25f8e125f7e225f7e425f6e626f6e826f5e926f5eb27f4ed27f3ee27f3f027f2f227f1f426f1f525f0f724f0f921',
        cividis: '00224e00234f00245100255300255400265600275800285900285b00295d002a5f002a61002b62002c64002c66002d68002e6a002e6c002f6d00306f0030700031700031710132710533710833700c34700f357012357014367016377018376f1a386f1c396f1e3a6f203a6f213b6e233c6e243c6e263d6e273e6e293f6e2a3f6d2b406d2d416d2e416d2f426d31436d32436d33446d34456c35456c36466c38476c39486c3a486c3b496c3c4a6c3d4a6c3e4b6c3f4c6c404c6c414d6c424e6c434e6c444f6c45506c46516c47516c48526c49536c4a536c4b546c4c556c4d556c4e566c4f576c50576c51586d52596d535a6d545a6d555b6d555c6d565c6d575d6d585e6d595e6e5a5f6e5b606e5c616e5d616e5e626e5e636f5f636f60646f61656f62656f636670646770656870656870666970676a71686a71696b716a6c716b6d726c6d726c6e726d6f726e6f736f70737071737172747272747273747374757474757575757676767777767777777878777979777a7a787b7a787c7b787d7c787e7c787e7d787f7e78807f78817f788280798381798482798582798683798784788885788985788a86788b87788c88788d88788e89788f8a78908b78918b78928c78928d78938e78948e77958f779690779791779892779992779a93769b94769c95769d95769e96769f9775a09875a19975a29975a39a74a49b74a59c74a69c74a79d73a89e73a99f73aaa073aba072aca172ada272aea371afa471b0a571b1a570b3a670b4a76fb5a86fb6a96fb7a96eb8aa6eb9ab6dbaac6dbbad6dbcae6cbdae6cbeaf6bbfb06bc0b16ac1b26ac2b369c3b369c4b468c5b568c6b667c7b767c8b866c9b965cbb965ccba64cdbb63cebc63cfbd62d0be62d1bf61d2c060d3c05fd4c15fd5c25ed6c35dd7c45cd9c55cdac65bdbc75adcc859ddc858dec958dfca57e0cb56e1cc55e2cd54e4ce53e5cf52e6d051e7d150e8d24fe9d34eead34cebd44bedd54aeed649efd748f0d846f1d945f2da44f3db42f5dc41f6dd3ff7de3ef8df3cf9e03afbe138fce236fde334fee434fee535fee636fee838'
    };

    /** jet как в MATLAB: x ∈ [0, 1] → [r, g, b] ∈ [0, 1]. */
    function jet(x) {
        var c = function (k) {
            return core.clamp(1.5 - Math.abs(4 * x - k), 0, 1);
        };
        return [c(3), c(2), c(1)];
    }

    /** Таблица палитры: Uint8Array(256 · 3), RGB от низа окна к верху; неизвестное имя — серая. */
    function paletteTable(name) {
        var out = new Uint8Array(768), i;
        var hex = PALETTE_HEX[name];
        if (hex) {
            for (i = 0; i < 768; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        } else {
            for (i = 0; i < 256; i++) {
                var c = name === 'jet' ? jet(i / 255) : [i / 255, i / 255, i / 255];
                out[i * 3] = Math.round(c[0] * 255);
                out[i * 3 + 1] = Math.round(c[1] * 255);
                out[i * 3 + 2] = Math.round(c[2] * 255);
            }
        }
        return out;
    }

    /** Подписи шкалы: доля высоты снизу (0 — низ окна, 1 — верх) и физическое значение с учётом гаммы
     *  (яркость/цвет = ((v − lo) / (hi − lo))^γ, поэтому середина шкалы — lo + (hi − lo)·0,5^(1/γ)). */
    function colorbarTicks(lo, hi, gamma) {
        var g = gamma > 0 ? gamma : 1;
        return [1, 0.5, 0].map(function (f) {
            return {frac: f, value: lo + (hi - lo) * Math.pow(f, 1 / g)};
        });
    }

    S.vol3d = {
        jet: jet, paletteTable: paletteTable, PALETTES: PALETTES, colorbarTicks: colorbarTicks,
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
        'uniform int u_cmap;',        // 0 серая, 1 — палитра из u_lut (кроме «Поверхности»)
        'uniform sampler2D u_lut;',
        'uniform float u_atten;',     // затухание на воксель вещества с яркостью верха окна
        'uniform float u_iso;',       // порог, единицы текстуры
        'uniform float u_step;',      // шаг, воксели
        'uniform int u_clip_axis;',   // −1 — без разреза
        'uniform float u_clip_pos;',
        'uniform float u_clip_side;',
        '',
        'float tex(vec3 p) { return texture(u_vol, p / u_dims).r; }',
        'float win(float t) { return clamp((t - u_win.x) / (u_win.y - u_win.x), 0.0, 1.0); }',
        // палитра — текстура 256×1 (S.vol3d.paletteTable): x ∈ [0, 1] → центр соответствующего текселя
        'vec3 cmap(float x) { return texture(u_lut, vec2((x * 255.0 + 0.5) / 256.0, 0.5)).rgb; }',
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
        '    float best = 0.0, bestW = 0.0, sum = 0.0;',
        '    for (int i = 0; i < 16384; i++) {',
        '        if (t > tf) break;',
        '        vec3 p = u_eye + dir * t;',
        '        float v = tex(p);',
        '        if (u_mode == 1) {',
        '            best = max(best, v);',
        '        } else if (u_mode == 0) {',
        '            float w = win(v);',
        '            float s = w * exp(-u_atten * sum);',
        '            if (s > best) { best = s; bestW = w; }',
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
        '    if (u_cmap == 0) {',
        '        float g = u_mode == 1 ? win(best) : best;',
        '        o_color = vec4(vec3(pow(g, u_gamma)), 1.0);',
        '    } else if (u_mode == 1) {',
        '        o_color = vec4(cmap(pow(win(best), u_gamma)), 1.0);',
        '    } else {',
        // «Мягкий» в цвете: цвет — по значению в точке максимума, затухание — только яркостью
        '        float shade = bestW > 0.0 ? best / bestW : 1.0;',
        '        o_color = vec4(cmap(pow(bestW, u_gamma)) * shade, 1.0);',
        '    }',
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
        return {mode: 'soft', cmap: 'gray', gamma: 1, atten: 0.05, iso: 0.5, box: true, axes: true,
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
        this._buildColorbar(opts.before || null);
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

    /** Шкала цвета справа сверху: градиент палитры и три подписи (верх окна, середина с учётом гаммы, низ). */
    View3D.prototype._buildColorbar = function (before) {
        var doc = root.document;
        var bar = this.cbar = doc.createElement('div');
        bar.className = 'sv-cbar hidden';
        this.cbarGrad = doc.createElement('canvas');
        this.cbarGrad.className = 'sv-cbar-grad';
        this.cbarGrad.width = 1;
        this.cbarGrad.height = 256;
        this.cbarLabels = doc.createElement('div');
        this.cbarLabels.className = 'sv-cbar-labels';
        bar.appendChild(this.cbarGrad);
        bar.appendChild(this.cbarLabels);
        this.stage.insertBefore(bar, before);
        this._cbarMap = null;
    };

    View3D.prototype._colorbar = function () {
        var o = this.opts;
        var on = this.active && !!this.win && o.mode !== 'iso';
        this.cbar.classList.toggle('hidden', !on);
        if (!on) return;
        if (this._cbarMap !== o.cmap) {
            var ctx = this.cbarGrad.getContext('2d');
            if (ctx) {
                var img = ctx.createImageData(1, 256), lut = paletteTable(o.cmap);
                for (var i = 0; i < 256; i++) {          // строка 0 холста — верх шкалы
                    var j = (255 - i) * 3;
                    img.data[i * 4] = lut[j];
                    img.data[i * 4 + 1] = lut[j + 1];
                    img.data[i * 4 + 2] = lut[j + 2];
                    img.data[i * 4 + 3] = 255;
                }
                ctx.putImageData(img, 0, 0);
            }
            this._cbarMap = o.cmap;
        }
        var labels = this.cbarLabels;
        while (labels.firstChild) labels.removeChild(labels.firstChild);
        colorbarTicks(this.win[0], this.win[1], o.gamma).forEach(function (t, k) {
            var s = root.document.createElement('span');
            s.textContent = core.fmtValue(t.value) + (k === 0 ? ' 1/мм' : '');
            labels.appendChild(s);
        });
        this.cbar.title = o.mode === 'soft' ? 'Цвет — значение в точке максимума; глубже лежащее вещество ' +
            'темнее (затухание), поэтому яркость шкале не соответствует' : 'Значение вдоль луча (максимум)';
    };

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
        this.lut = gl.createTexture();
        this._lutName = null;
        this._lineCount = 0;
    };

    /** Палитра this.opts.cmap → текстура 256×1 RGB8 с линейной интерполяцией. */
    View3D.prototype._uploadLut = function () {
        var gl = this.gl;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lut);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, paletteTable(this.opts.cmap));
        gl.activeTexture(gl.TEXTURE0);
        this._lutName = this.opts.cmap;
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

    /** Изменить настройки: {mode, cmap, gamma, atten, iso, box, axes, clip: {...}, slice: {axis, pos} | null}. */
    View3D.prototype.set = function (patch) {
        var o = this.opts;
        Object.keys(patch || {}).forEach(function (k) {
            if (k === 'clip') o.clip = Object.assign({}, o.clip, patch.clip);
            else o[k] = patch[k];
        });
        if ('box' in patch || 'slice' in patch || 'axes' in patch) this._lines();
        this._colorbar();
        this.render();
    };

    /** Окно контраста (физические единицы) — из гистограммы просмотрщика. */
    View3D.prototype.setWindow = function (lo, hi) {
        this.win = [lo, hi];
        this._colorbar();
        this.render();
    };

    View3D.prototype.activate = function (on) {
        this.active = !!on;
        this.canvas.classList.toggle('hidden', !on);
        this._colorbar();
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
        gl.uniform1i(u.u_cmap, o.cmap && o.cmap !== 'gray' ? 1 : 0);
        if (this._lutName !== o.cmap) this._uploadLut();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lut);
        gl.uniform1i(u.u_lut, 1);
        gl.activeTexture(gl.TEXTURE0);
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
