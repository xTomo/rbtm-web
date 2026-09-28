/* Студия реконструкции — наложение (SVG поверх canvas просмотрщика).
 *
 * Фигуры задаются в координатах изображения текущего вида; группа фигур получает то же преобразование, что и
 * canvas (matrix(sx 0 0 sy tx ty)), линии — с vector-effect: non-scaling-stroke. Ручки рисуются в отдельной
 * группе в экранных координатах — их размер на экране постоянный.
 *
 * Фигуры:
 *  {id, type: 'rect', x0, x1, y0, y1, bounds: {x0, y0, x1, y1}, minW, minH, axes: 'xy' | 'x', editable, warn,
 *   label}                  — рамка: 8 ручек (углы и середины сторон), края и перенос (ручка в центре);
 *  {id, type: 'hline', y, x0, x1, ymin, ymax, editable, label} — горизонтальная линия с ручкой справа.
 *
 * События: 'drag' (id, геометрия) — во время перетаскивания; 'commit' (id, геометрия) — по отпусканию. */
(function (root) {
    'use strict';
    var S = root.Studio = root.Studio || {};
    var core = S.core;
    var SVGNS = 'http://www.w3.org/2000/svg';
    var HANDLE = 9;          // сторона ручки, px экрана
    var MOVE = 14;           // ручка переноса

    var CURSORS = {
        nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
        n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move', line: 'ns-resize'
    };

    function svgEl(tag, attrs, parent) {
        var e = root.document.createElementNS(SVGNS, tag);
        if (attrs) {
            Object.keys(attrs).forEach(function (k) {
                e.setAttribute(k, attrs[k]);
            });
        }
        if (parent) parent.appendChild(e);
        return e;
    }

    function setAttrs(e, attrs) {
        Object.keys(attrs).forEach(function (k) {
            e.setAttribute(k, attrs[k]);
        });
    }

    function Overlay(viewer) {
        core.Emitter.call(this);
        var self = this;
        this.viewer = viewer;
        this.svg = viewer.svg;
        this.gImg = svgEl('g', {'class': 'ov-img'}, this.svg);
        this.gScr = svgEl('g', {'class': 'ov-scr'}, this.svg);
        this.shapes = [];
        this.drag = null;
        viewer.on('transform', function () {
            self.layout();
        });
    }
    core.Emitter.mixin(Overlay.prototype);

    /** Заменить все фигуры. */
    Overlay.prototype.set = function (specs) {
        this.clear();
        var self = this;
        (specs || []).forEach(function (spec) {
            self._build(Object.assign({}, spec));
        });
        this.layout();
    };

    Overlay.prototype.clear = function () {
        this.drag = null;
        this.shapes = [];
        while (this.gImg.firstChild) this.gImg.removeChild(this.gImg.firstChild);
        while (this.gScr.firstChild) this.gScr.removeChild(this.gScr.firstChild);
        this.svg.classList.remove('ov-dragging');
    };

    Overlay.prototype.get = function (id) {
        for (var i = 0; i < this.shapes.length; i++) {
            if (this.shapes[i].spec.id === id) return this.shapes[i];
        }
        return null;
    };

    /** Изменить свойства фигуры (геометрию, подпись, warn); во время перетаскивания допустимо. */
    Overlay.prototype.update = function (id, props) {
        var sh = this.get(id);
        if (!sh) return;
        Object.assign(sh.spec, props);
        this._layoutShape(sh, this.viewer.xf());
    };

    Overlay.prototype.dragging = function () {
        return !!this.drag;
    };

    Overlay.prototype._build = function (spec) {
        var sh = {spec: spec, img: [], scr: [], handles: {}};
        var gi = svgEl('g', {'class': 'ov-shape ov-' + spec.type}, this.gImg);
        var gs = svgEl('g', {'class': 'ov-shape ov-' + spec.type}, this.gScr);
        sh.gi = gi;
        sh.gs = gs;
        var editable = spec.editable !== false;
        if (spec.type === 'rect') {
            sh.frame = svgEl('rect', {'class': 'ov-frame'}, gi);
            if (editable) {
                var edges = spec.axes === 'x' ? ['w', 'e'] : ['n', 's', 'w', 'e'];
                sh.hits = {};
                edges.forEach(function (h) {
                    sh.hits[h] = svgEl('line', {'class': 'ov-hit', 'data-handle': h}, gi);
                });
                var hs = spec.axes === 'x' ? ['w', 'e'] : core.RECT_HANDLES;
                hs.forEach(function (h) {
                    sh.handles[h] = svgEl('rect', {'class': 'ov-handle', 'data-handle': h,
                        width: HANDLE, height: HANDLE}, gs);
                });
                var mv = svgEl('g', {'class': 'ov-move', 'data-handle': 'move'}, gs);
                svgEl('rect', {'class': 'ov-move-bg', x: -MOVE / 2, y: -MOVE / 2, width: MOVE, height: MOVE,
                    'data-handle': 'move'}, mv);
                svgEl('path', {'class': 'ov-move-cross', 'data-handle': 'move',
                    d: spec.axes === 'x' ? 'M -5 0 H 5' : 'M -5 0 H 5 M 0 -5 V 5'}, mv);
                sh.handles.move = mv;
            }
            sh.label = svgEl('text', {'class': 'ov-label'}, gs);
        } else if (spec.type === 'hline') {
            sh.line = svgEl('line', {'class': 'ov-line'}, gi);
            if (editable) {
                sh.hits = {line: svgEl('line', {'class': 'ov-hit', 'data-handle': 'line'}, gi)};
                sh.handles.line = svgEl('rect', {'class': 'ov-handle ov-handle-line', 'data-handle': 'line',
                    width: HANDLE + 2, height: HANDLE + 2}, gs);
            }
            sh.label = svgEl('text', {'class': 'ov-label ov-label-line'}, gs);
        }
        var self = this;
        if (editable) {
            [gi, gs].forEach(function (g) {
                g.addEventListener('pointerdown', function (e) {
                    self._down(sh, e);
                });
            });
        }
        Object.keys(sh.handles).forEach(function (h) {
            sh.handles[h].style.cursor = CURSORS[h];
        });
        if (sh.hits) {
            Object.keys(sh.hits).forEach(function (h) {
                sh.hits[h].style.cursor = CURSORS[h];
            });
        }
        this.shapes.push(sh);
        return sh;
    };

    // --- перетаскивание ---------------------------------------------------------------------------------------

    function geometry(spec) {
        return spec.type === 'rect' ? {x0: spec.x0, x1: spec.x1, y0: spec.y0, y1: spec.y1} : {y: spec.y};
    }

    Overlay.prototype._down = function (sh, e) {
        var t = e.target && e.target.closest ? e.target.closest('[data-handle]') : null;
        if (!t || (e.button !== 0 && e.pointerType === 'mouse')) return;
        var p = this.viewer.clientToImage(e.clientX, e.clientY);
        if (!p) return;
        e.stopPropagation();
        var self = this, target = e.currentTarget;
        var handle = t.getAttribute('data-handle');
        this.drag = {id: e.pointerId, sh: sh, handle: handle, p0: p, start: geometry(sh.spec)};
        this.svg.classList.add('ov-dragging');
        this.svg.style.cursor = CURSORS[handle] || '';
        try {
            target.setPointerCapture(e.pointerId);
        } catch (err) { /* уже отпущен */ }

        function move(ev) {
            if (!self.drag || ev.pointerId !== self.drag.id) return;
            self._move(ev);
        }
        function up(ev) {
            if (!self.drag || ev.pointerId !== self.drag.id) return;
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            target.removeEventListener('pointercancel', up);
            try {
                target.releasePointerCapture(ev.pointerId);
            } catch (err) { /* уже отпущен */ }
            var d = self.drag;
            self.drag = null;
            self.svg.classList.remove('ov-dragging');
            self.svg.style.cursor = '';
            self.emit('commit', d.sh.spec.id, geometry(d.sh.spec));
        }
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
        target.addEventListener('pointercancel', up);
    };

    Overlay.prototype._move = function (ev) {
        var d = this.drag, spec = d.sh.spec;
        var p = this.viewer.clientToImage(ev.clientX, ev.clientY);
        if (!p) return;
        var dx = p.x - d.p0.x, dy = p.y - d.p0.y;
        if (spec.type === 'rect') {
            var b = spec.bounds || {x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity};
            var g = core.dragRect(d.start, d.handle, dx, dy, b, spec.minW || 0, spec.minH || 0, spec.axes);
            Object.assign(spec, g);
        } else if (spec.type === 'hline') {
            var lo = spec.ymin === undefined ? -Infinity : spec.ymin;
            var hi = spec.ymax === undefined ? Infinity : spec.ymax;
            spec.y = core.clamp(d.start.y + dy, lo, hi);
        }
        this._layoutShape(d.sh, this.viewer.xf());
        this.emit('drag', spec.id, geometry(spec));
    };

    // --- размещение ---------------------------------------------------------------------------------------------

    Overlay.prototype.layout = function () {
        var xf = this.viewer.xf();
        var visible = !!xf && this.shapes.length > 0;
        this.gImg.style.display = visible ? '' : 'none';
        this.gScr.style.display = visible ? '' : 'none';
        if (!visible) return;
        this.gImg.setAttribute('transform', 'matrix(' + [xf.sx, 0, 0, xf.sy, xf.tx, xf.ty].join(' ') + ')');
        for (var i = 0; i < this.shapes.length; i++) this._layoutShape(this.shapes[i], xf);
    };

    Overlay.prototype._layoutShape = function (sh, xf) {
        if (!xf) return;
        var s = sh.spec, h2 = HANDLE / 2;
        if (s.type === 'rect') {
            setAttrs(sh.frame, {x: s.x0, y: s.y0, width: Math.max(0, s.x1 - s.x0), height: Math.max(0, s.y1 - s.y0)});
            sh.frame.classList.toggle('ov-warn', !!s.warn);
            if (sh.hits) {
                var L = {
                    n: [s.x0, s.y0, s.x1, s.y0], s: [s.x0, s.y1, s.x1, s.y1],
                    w: [s.x0, s.y0, s.x0, s.y1], e: [s.x1, s.y0, s.x1, s.y1]
                };
                Object.keys(sh.hits).forEach(function (k) {
                    var l = L[k];
                    setAttrs(sh.hits[k], {x1: l[0], y1: l[1], x2: l[2], y2: l[3]});
                });
            }
            var a = core.toScreen(xf, s.x0, s.y0), b = core.toScreen(xf, s.x1, s.y1);
            var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            var P = {nw: [a.x, a.y], n: [mx, a.y], ne: [b.x, a.y], e: [b.x, my], se: [b.x, b.y], s: [mx, b.y],
                sw: [a.x, b.y], w: [a.x, my]};
            // на маленькой рамке ручки середин сторон мешают — прячем
            var small = Math.abs(b.x - a.x) < 5 * HANDLE || Math.abs(b.y - a.y) < 5 * HANDLE;
            Object.keys(sh.handles).forEach(function (k) {
                var el = sh.handles[k];
                if (k === 'move') {
                    el.setAttribute('transform', 'translate(' + mx + ' ' + my + ')');
                    return;
                }
                var p = P[k];
                setAttrs(el, {x: p[0] - h2, y: p[1] - h2});
                var mid = k.length === 1;
                el.style.display = small && mid && s.axes !== 'x' ? 'none' : '';
            });
            if (sh.label) {
                sh.label.textContent = s.label || '';
                // над рамкой, а если она у верхнего края вида — внутри
                setAttrs(sh.label, {x: a.x + 4, y: a.y < 18 ? a.y + 16 : a.y - 6});
            }
        } else if (s.type === 'hline') {
            setAttrs(sh.line, {x1: s.x0, y1: s.y, x2: s.x1, y2: s.y});
            if (sh.hits) setAttrs(sh.hits.line, {x1: s.x0, y1: s.y, x2: s.x1, y2: s.y});
            var r = core.toScreen(xf, s.x1, s.y);
            if (sh.handles.line) setAttrs(sh.handles.line, {x: r.x - h2 - 1, y: r.y - h2 - 1});
            if (sh.label) {
                sh.label.textContent = s.label || '';
                var l0 = core.toScreen(xf, s.x0, s.y);
                setAttrs(sh.label, {x: l0.x + 4, y: r.y - 5});
            }
        }
    };

    S.Overlay = Overlay;
})(typeof window !== 'undefined' ? window : globalThis);
