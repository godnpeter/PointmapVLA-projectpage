/* Orbitable VQA scene viewer: point cloud in WebGL, answers (boxes / points / segments / paths) and labels on a 2D overlay.
   Raw WebGL, works from file://.  PMScene.mount(rootEl, { order: PMSCENES_ORDER, base: 'static/scenes/' })
   Scene payloads are written by build_scenes.py (window.PMSCENES[key]). */
(function () {
  var GREEN = '#12A54A', BLUE = 'rgb(50,118,203)', PURPLE = '#5B3CC4', MAG = '#c71f99';
  var VS = 'attribute vec3 p;attribute vec3 c;uniform mat4 mvp;uniform float ps;varying vec3 vc;void main(){gl_Position=mvp*vec4(p,1.0);float w=max(gl_Position.w,0.3);gl_PointSize=clamp(ps*1.4/w,1.2,ps*2.2);vc=c;}';
  var FS = 'precision mediump float;varying vec3 vc;void main(){gl_FragColor=vec4(vc,1.0);}';
  /* textured quads for the optional camera overlay (each camera's image on its frustum's far plane) */
  var VS2 = 'attribute vec3 p;attribute vec2 t;uniform mat4 mvp;varying vec2 vt;void main(){gl_Position=mvp*vec4(p,1.0);vt=t;}';
  var FS2 = 'precision mediump float;varying vec2 vt;uniform sampler2D tex;void main(){gl_FragColor=texture2D(tex,vt);}';
  var CAMC = ['#1c7ed6', '#0ca678', '#e8590c'], FR_D = 0.1;   /* short frustums: the image plane stays a small card near each camera */   /* camera colours (left, right, wrist) and the frustum depth in metres */
  function xf(T, p) { return [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2] * p[2] + T[0][3], T[1][0] * p[0] + T[1][1] * p[1] + T[1][2] * p[2] + T[1][3], T[2][0] * p[0] + T[2][1] * p[1] + T[2][2] * p[2] + T[2][3]]; }
  function frustum(c) { var K = c.K, H = c.hw[0], W = c.hw[1], d = FR_D; return [[0, 0], [W, 0], [W, H], [0, H]].map(function (uv) { return xf(c.T, [(uv[0] - K[2]) / K[0] * d, (uv[1] - K[3]) / K[1] * d, d]); }); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function prog(gl, vs, fs) { function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }
    var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; }
  function mul(a, b) { var o = new Float32Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(fov, asp, n, f) { var t = 1 / Math.tan(fov / 2); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]); }
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function eyeOf(c) { var az = c.az * Math.PI / 180, elv = c.el * Math.PI / 180; return [c.t[0] + c.d * Math.cos(elv) * Math.cos(az), c.t[1] + c.d * Math.cos(elv) * Math.sin(az), c.t[2] + c.d * Math.sin(elv)]; }
  function view(c) { var e = eyeOf(c), f = norm(sub(c.t, e)), r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
    return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, e), -dot(u, e), dot(f, e), 1]); }
  function camFrom(eye, target) { var d = sub(eye, target); return { t: target.slice(), d: Math.hypot(d[0], d[1], d[2]), az: Math.atan2(d[1], d[0]) * 180 / Math.PI, el: Math.asin(d[2] / (Math.hypot(d[0], d[1], d[2]) || 1)) * 180 / Math.PI }; }
  function b64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  /* binary assets (open-source build): <name>.bin.gz = gzip of the raw point buffers; fetched and inflated in the browser
     (needs http(s), not file://, and DecompressionStream). The base64 .js form is still accepted. */
  function loadBin(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url);
    if (!/\.gz$/.test(url)) return r.arrayBuffer(); if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate ' + url);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }, function (e) { throw new Error((location.protocol === 'file:' ? 'serve the page over http (e.g. python -m http.server): ' : '') + e.message); }); }
  function loadScript(src) { return new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); }
  var BOX_E = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];

  function mount(root, opt) {
    var order = opt.order || [], base = opt.base || 'static/scenes/';
    root.classList.add('pms');
    var tabs = el('div', 'tabs pms-tabs'), head = el('div', 'pms-head'), body = el('div', 'pms-body'), stage = el('div', 'pms-stage'), side = el('div', 'pms-side'), qas = el('div', 'pms-qas'), foot = el('div', 'pms-foot');
    var canvas = document.createElement('canvas'), ov = document.createElement('canvas'); ov.className = 'ov'; var msg = el('div', 'msg'), bar = el('div', 'pms-bar');
    stage.appendChild(canvas); stage.appendChild(ov); stage.appendChild(msg); stage.appendChild(bar); body.appendChild(stage); body.appendChild(side);
    var qbar = el('p', 'rr-prompt ep-instr pms-q'); qbar.hidden = true;
    root.appendChild(tabs); root.appendChild(head); root.appendChild(qbar); root.appendChild(body); root.appendChild(qas); root.appendChild(foot);
    var gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: false }); if (!gl) { stage.textContent = 'WebGL unavailable'; return; }
    var P = prog(gl, VS, FS), lp = gl.getAttribLocation(P, 'p'), lc = gl.getAttribLocation(P, 'c'), lmvp = gl.getUniformLocation(P, 'mvp'), lps = gl.getUniformLocation(P, 'ps');
    var vbo = gl.createBuffer(), cbo = gl.createBuffer(); gl.enable(gl.DEPTH_TEST); gl.clearColor(1, 1, 1, 1);
    var Q = prog(gl, VS2, FS2), lq = { p: gl.getAttribLocation(Q, 'p'), t: gl.getAttribLocation(Q, 't'), mvp: gl.getUniformLocation(Q, 'mvp'), tex: gl.getUniformLocation(Q, 'tex') }, qbo = gl.createBuffer(), texs = {};
    function texOf(key, v, uri) { var k = key + '/' + v; if (texs[k]) return texs[k].ok ? texs[k].t : null; var t = gl.createTexture(), im = new Image(); texs[k] = { t: t, ok: false };
      im.onload = function () { gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); texs[k].ok = true; kick(); };
      im.src = uri; return null; }
    var st = { key: null, scene: null, n: 0, qa: null, cam: null, cam0: null, dirty: true, orbit: false, req: 0, ps: 2.4, axes: !opt.camsDefault, cams: !!opt.camsDefault };   /* camsDefault (occlusion viewer): cameras on, axes off */

    var resetB = el('button', null, 'Reset view'), orbitB = el('button', null, 'Auto-orbit'), hint = el('span', 'n', 'drag to orbit · wheel to zoom · right-drag to pan');
    resetB.type = 'button'; orbitB.type = 'button'; resetB.onclick = function () { st.cam = JSON.parse(JSON.stringify(st.cam0)); st.dirty = true; };
    orbitB.onclick = function () { st.orbit = !st.orbit; orbitB.classList.toggle('on', st.orbit); if (st.orbit) tick(); };
    var originB = el('button', null, 'View from origin'), axesB = el('button', opt.camsDefault ? null : 'on', 'Axes'); originB.type = 'button'; axesB.type = 'button';
    originB.onclick = function () { var d = st.scene.general ? 2.5 : 0.8; st.cam = { t: [d, 0, 0], d: d, az: 180, el: 0 }; st.orbit = false; orbitB.classList.remove('on'); kick(); };
    axesB.onclick = function () { st.axes = !st.axes; axesB.classList.toggle('on', st.axes); kick(); };
    var camsB = el('button', opt.camsDefault ? 'on' : null, 'Cameras'); camsB.type = 'button'; camsB.hidden = true; camsB.title = 'Show each camera at its pose, with its image';   /* off by default (user) */
    function frameCams() { if (!st.scene || !st.scene.cams) return; var pts = st.scene.cams.map(function (c) { return xf(c.T, [0, 0, 0]); }).concat([st.cam0.t]), ctr = [0, 0, 0];   /* pull back so every camera is in frame */
      pts.forEach(function (q) { for (var k = 0; k < 3; k++) ctr[k] += q[k] / pts.length; }); var r = Math.max.apply(null, pts.map(function (q) { return Math.hypot(q[0] - ctr[0], q[1] - ctr[1], q[2] - ctr[2]); }));
      st.cam = { t: ctr, d: Math.max(st.cam0.d, r * 2.6), az: st.cam0.az, el: Math.max(st.cam0.el, 28) }; }
    camsB.onclick = function () { st.cams = !st.cams; camsB.classList.toggle('on', st.cams); st.orbit = false; orbitB.classList.remove('on');
      if (st.cams) frameCams(); else st.cam = JSON.parse(JSON.stringify(st.cam0)); kick(); };
    bar.appendChild(resetB); bar.appendChild(originB); bar.appendChild(orbitB); bar.appendChild(axesB); bar.appendChild(camsB); bar.appendChild(hint);

    function fit() { var dpr = Math.min(devicePixelRatio || 1, 2), w = Math.floor(stage.clientWidth * dpr), h = Math.floor(stage.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; ov.width = w; ov.height = h; } return dpr; }
    function mvpNow() { var W = canvas.width, H = canvas.height; return mul(persp(40 * Math.PI / 180, W / H, 0.02, 100), view(st.cam)); }
    function proj(m, p) { var x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (w <= 0.001) return null; return [(x / w * 0.5 + 0.5) * canvas.width, (0.5 - y / w * 0.5) * canvas.height, w]; }
    function draw() { if (!st.scene) return; var dpr = fit(); var W = canvas.width, H = canvas.height; if (!W || !H) return; gl.viewport(0, 0, W, H); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      var m = mvpNow(); gl.useProgram(P); gl.uniformMatrix4fv(lmvp, false, m); gl.uniform1f(lps, st.ps * dpr);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, cbo); gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, st.n); gl.disableVertexAttribArray(lp); gl.disableVertexAttribArray(lc);
      if (st.cams && st.scene.cams) { gl.useProgram(Q); gl.uniformMatrix4fv(lq.mvp, false, m); gl.uniform1i(lq.tex, 0); gl.activeTexture(gl.TEXTURE0);
        st.scene.cams.forEach(function (c, v) { var t = texOf(st.key, v, st.scene.images[v].uri); if (!t) return; var q = frustum(c), a = [];
          [[0, 0, 0], [1, 1, 0], [2, 1, 1], [0, 0, 0], [2, 1, 1], [3, 0, 1]].forEach(function (x) { a.push(q[x[0]][0], q[x[0]][1], q[x[0]][2], x[1], x[2]); });
          gl.bindTexture(gl.TEXTURE_2D, t); gl.bindBuffer(gl.ARRAY_BUFFER, qbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(a), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(lq.p); gl.vertexAttribPointer(lq.p, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(lq.t); gl.vertexAttribPointer(lq.t, 2, gl.FLOAT, false, 20, 12);
          gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(lq.p); gl.disableVertexAttribArray(lq.t); }); }
      overlay(m, dpr); }
    function overlay(m, dpr) { var x = ov.getContext('2d'); x.clearRect(0, 0, ov.width, ov.height); var q = st.qa || { draw: [] }; x.lineJoin = 'round'; x.lineCap = 'round'; var labels = [];
      function P2(p) { return proj(m, p); }
      function line(a, b, col, w, dash) { var A = P2(a), B = P2(b); if (!A || !B) return; x.strokeStyle = col; x.lineWidth = w * dpr; x.setLineDash(dash ? [6 * dpr, 5 * dpr] : []); x.beginPath(); x.moveTo(A[0], A[1]); x.lineTo(B[0], B[1]); x.stroke(); x.setLineDash([]); }
      function disc(p, col, r) { var A = P2(p); if (!A) return; x.fillStyle = col; x.beginPath(); x.arc(A[0], A[1], r * dpr, 0, Math.PI * 2); x.fill(); x.lineWidth = 2 * dpr; x.strokeStyle = '#fff'; x.stroke(); }
      if (st.axes && st.scene) { var L = st.scene.general ? 0.5 : 0.25, O = [0, 0, 0];
        [[[L, 0, 0], '#d62828', 'x'], [[0, L, 0], '#2a9d2a', 'y'], [[0, 0, L], '#2456c9', 'z']].forEach(function (ax) { line(O, ax[0], ax[1], 3); labels.push({ p: ax[0], t: ax[2], bg: ax[1] }); });
        disc(O, '#1b2024', 5); labels.push({ p: O, t: st.scene.general ? 'origin = camera' : 'origin = robot base', bg: '#1b2024' }); }
      if (st.cams && st.scene && st.scene.cams) st.scene.cams.forEach(function (c, v) { var o = xf(c.T, [0, 0, 0]), q = frustum(c), col = CAMC[v % 3];   /* frustum edges + apex at the true camera pose */
        q.forEach(function (p, k) { line(o, p, col, 1.6); line(p, q[(k + 1) % 4], col, 1.6); }); disc(o, col, 4); labels.push({ p: o, t: c.label, bg: col }); });
      q.draw.forEach(function (d, i) {
        if (d.t === 'box') { var bc = d.col || GREEN; BOX_E.forEach(function (e) { line(d.c[e[0]], d.c[e[1]], bc, 2.6); }); var top = d.c.reduce(function (acc, c) { return c[2] > acc[2] ? c : acc; }, d.c[0]); var cen = [0, 0, 0]; d.c.forEach(function (c) { cen[0] += c[0] / 8; cen[1] += c[1] / 8; cen[2] += c[2] / 8; }); labels.push({ p: [cen[0], cen[1], top[2]], t: d.label, bg: bc }); }
        else if (d.t === 'seg') { line(d.a, d.b, BLUE, 3); disc(d.b, BLUE, 5); if (d.label) labels.push({ p: [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2, (d.a[2] + d.b[2]) / 2], t: d.label, bg: BLUE }); }
        else if (d.t === 'ray') { line(d.a, d.b, BLUE, 3); var A = P2(d.a), B = P2(d.b); if (A && B) { var ang = Math.atan2(B[1] - A[1], B[0] - A[0]), L = 12 * dpr; x.fillStyle = BLUE; x.beginPath(); x.moveTo(B[0], B[1]); x.lineTo(B[0] - L * Math.cos(ang - 0.45), B[1] - L * Math.sin(ang - 0.45)); x.lineTo(B[0] - L * Math.cos(ang + 0.45), B[1] - L * Math.sin(ang + 0.45)); x.closePath(); x.fill(); } labels.push({ p: d.b, t: d.label, bg: BLUE }); }
        else if (d.t === 'path') { for (var k = 0; k + 1 < d.p.length; k++) line(d.p[k], d.p[k + 1], PURPLE, 3); d.p.forEach(function (p, k) { disc(p, k === 0 ? MAG : PURPLE, k === 0 ? 6 : 3.5); }); labels.push({ p: d.p[0], t: 'start', bg: MAG }); labels.push({ p: d.p[d.p.length - 1], t: 'end', bg: PURPLE }); }
        else if (d.t === 'pt') { var col = d.rgb ? 'rgb(' + d.rgb.join(',') + ')' : BLUE; disc(d.p, col, 6); if (d.label) labels.push({ p: d.p, t: d.label, bg: d.rgb ? '#333' : BLUE }); }
      });
      x.font = '700 ' + 13 * dpr + 'px "Open Sans", sans-serif'; x.textBaseline = 'middle';
      var placed = [];
      labels.forEach(function (l) { if (!l.t) return; var A = P2(l.p); if (!A) return; var tw = x.measureText(l.t).width + 14 * dpr, h = 22 * dpr, px = A[0] + 10 * dpr, py = A[1] - 16 * dpr;
        for (var tries = 0; tries < 8; tries++) { var hit = placed.some(function (r) { return px < r[0] + r[2] && px + tw > r[0] && py - h / 2 < r[1] + r[3] && py + h / 2 > r[1]; }); if (!hit) break; py += h + 3 * dpr; }
        placed.push([px, py - h / 2, tw, h]);
        x.fillStyle = l.bg; x.beginPath(); x.roundRect ? x.roundRect(px, py - h / 2, tw, h, 6 * dpr) : x.rect(px, py - h / 2, tw, h); x.fill(); x.fillStyle = '#fff'; x.fillText(l.t, px + 7 * dpr, py + 1); }); }

    var raf = 0, last = 0;
    function tick(now) { raf = 0; if (st.orbit) { var t = now || performance.now(); if (last) st.cam.az += (t - last) * 0.012; last = t; st.dirty = true; } else last = 0;
      if (st.dirty) { st.dirty = false; draw(); } if (st.orbit || st.dirty) raf = requestAnimationFrame(tick); }
    function kick() { st.dirty = true; if (!raf) raf = requestAnimationFrame(tick); }

    /* controls */
    var drag = null; stage.oncontextmenu = function (e) { e.preventDefault(); };
    stage.addEventListener('pointerdown', function (e) { if (e.target.tagName === 'BUTTON') return; drag = { x: e.clientX, y: e.clientY, b: e.button, sh: e.shiftKey }; stage.setPointerCapture(e.pointerId); st.orbit = false; orbitB.classList.remove('on'); });
    stage.addEventListener('pointermove', function (e) { if (!drag || !st.cam) return; var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.b === 2 || drag.sh) { var ey = eyeOf(st.cam), f = norm(sub(st.cam.t, ey)), r = norm(cross(f, [0, 0, 1])), u = cross(r, f), s = st.cam.d * 0.0016; st.cam.t = [st.cam.t[0] - (r[0] * dx - u[0] * dy) * s, st.cam.t[1] - (r[1] * dx - u[1] * dy) * s, st.cam.t[2] - (r[2] * dx - u[2] * dy) * s]; }
      else { st.cam.az -= dx * 0.4; st.cam.el = Math.max(-85, Math.min(85, st.cam.el + dy * 0.3)); } kick(); });
    stage.addEventListener('pointerup', function () { drag = null; }); stage.addEventListener('pointercancel', function () { drag = null; });
    stage.addEventListener('wheel', function (e) { if (!st.cam) return; e.preventDefault(); st.cam.d *= Math.exp(e.deltaY * 0.0012); st.cam.d = Math.max(0.15, Math.min(40, st.cam.d)); kick(); }, { passive: false });
    var pinch = null; stage.addEventListener('touchstart', function (e) { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
    stage.addEventListener('touchmove', function (e) { if (e.touches.length === 2 && pinch) { var d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); st.cam.d *= pinch / d; pinch = d; kick(); e.preventDefault(); } }, { passive: false });
    window.addEventListener('resize', kick);
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) kick(); else if (st.orbit) { st.orbit = false; orbitB.classList.remove('on'); } }); }); io.observe(stage);

    function upload(s) { var u = s.ptsU8 || b64(s.pts), n = s.n, i16 = new Int16Array(u.buffer, 0, n * 3), pos = new Float32Array(n * 3); for (var i = 0; i < n * 3; i++) pos[i] = i16[i] / 1000;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW); gl.bindBuffer(gl.ARRAY_BUFFER, cbo); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(u.buffer, n * 6, n * 3), gl.STATIC_DRAW); st.n = n; }

    function selectQA(q) { st.qa = q; qbar.hidden = !q; if (q) qbar.innerHTML = '<span>Question</span>' + q.q; Array.prototype.forEach.call(qas.children, function (c) { c.classList.toggle('on', c._qa === q); }); foot.textContent = q ? (q.draw.length ? 'Drawn in 3D: ' + q.draw.map(function (d) { return d.t === 'box' ? 'box ' + d.label : d.t === 'path' ? d.label : d.t === 'seg' ? 'distance' : d.t === 'ray' ? 'direction' : d.label || 'point'; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' · ') + (q.note ? '. ' + q.note : '') : (q.note || '')) : ''; kick(); }
    function render(key, s) { st.scene = s; st.key = key; upload(s); camsB.hidden = !s.cams; st.cam0 = camFrom(s.cam.eye, s.cam.target); st.cam = JSON.parse(JSON.stringify(st.cam0)); if (st.cams) frameCams(); msg.textContent = '';
      head.innerHTML = '<b>' + s.title + '</b> <span class="tag">' + s.tag + '</span> <span class="fr">' + s.frame + '</span>';   /* the selected question leads (qbar), not the episode instruction */
      side.innerHTML = ''; side.classList.toggle('pairs', !!s.pmimgs);
      if (s.pmimgs) s.images.forEach(function (im, v) { var row = el('div', 'pair'); [[im.uri, im.label], [s.pmimgs[v], 'pointmap']].forEach(function (x) { var f = el('figure'), i = document.createElement('img'); i.src = x[0]; i.alt = x[1]; f.appendChild(i); f.appendChild(el('figcaption', null, x[1])); row.appendChild(f); }); side.appendChild(row); });
      else s.images.forEach(function (im) { var f = el('figure'); var i = document.createElement('img'); i.src = im.uri; i.alt = im.label; f.appendChild(i); f.appendChild(el('figcaption', null, im.label)); side.appendChild(f); });
      if (!s.pmimgs) { var pf = el('figure'); var pi = document.createElement('img'); pi.src = s.pmimg; pi.alt = 'pointmap'; pf.appendChild(pi); pf.appendChild(el('figcaption', null, 'pointmap (one view)')); side.appendChild(pf); }
      s.qas.forEach(function (q) { q.draw = q.draw.filter(function (d) { return !d.extra; }); });   /* answers the paper figure does not draw (extra:true) stay hidden */
      qas.style.display = s.qas.length && !opt.hideQA ? '' : 'none'; foot.style.display = s.qas.length && !opt.hideQA ? '' : 'none'; if (s.source) head.innerHTML += ' <span class="fr">· ' + s.source + '</span>';
      qas.innerHTML = ''; s.qas.forEach(function (q) { var c = el('button', 'qa' + (q.draw.length ? '' : ' text')); c.type = 'button'; c._qa = q;
        c.innerHTML = '<span class="hd"><i>' + q.n + '</i><em>' + q.task + '</em>' + (q.draw.length ? '' : '<small>text only</small>') + '</span><span class="q"><b>Q</b>' + q.q + '</span><span class="a"><b>A</b>' + q.a + '</span>';
        c.onclick = function () { selectQA(q); }; qas.appendChild(c); });
      var first = s.qas.filter(function (q) { return q.draw.length; })[0] || s.qas[0]; selectQA(first); }
    function show(key) { var req = ++st.req; Array.prototype.forEach.call(tabs.children, function (b) { if (b.dataset.key) b.classList.toggle('on', b.dataset.key === key); });
      function ready(s) { if (s.ptsbin && !s.ptsU8) return loadBin(base + s.ptsbin).then(function (buf) { s.ptsU8 = new Uint8Array(buf); });   /* points shipped as <key>.bin.gz */
        return Promise.resolve(); }
      msg.textContent = 'loading 3D scene…';
      (window.PMSCENES && window.PMSCENES[key] ? Promise.resolve() : loadScript(base + key + '.js')).then(function () { return ready(window.PMSCENES[key]); })
        .then(function () { if (req === st.req) render(key, window.PMSCENES[key]); }, function (err) { msg.textContent = 'failed to load ' + key + ': ' + (err && err.message || err); }); }
    if (opt.groups) {   /* robot data: dataset tabs + numbered scene chips */
      var chips = el('div', 'pms-chips'); root.insertBefore(chips, head); var gtabs = [];
      function group(gi) { gtabs.forEach(function (b, j) { b.classList.toggle('on', j === gi); }); chips.innerHTML = '';
        opt.groups[gi][1].forEach(function (o, k) { var c = el('button', null, opt.namedChips ? o[1] : String(k + 1)); c.type = 'button'; c.dataset.key = o[0]; c.title = o[2] || o[1]; c.onclick = function () { mark(o[0]); show(o[0]); }; chips.appendChild(c); });
        mark(opt.groups[gi][1][0][0]); show(opt.groups[gi][1][0][0]); }
      function mark(key) { Array.prototype.forEach.call(chips.children, function (c) { c.classList.toggle('on', c.dataset.key === key); }); }
      opt.groups.forEach(function (g, gi) { var b = el('button', null, g[0]); b.type = 'button'; b.onclick = function () { group(gi); }; tabs.appendChild(b); gtabs.push(b); });
      group(0); return; }
    order.forEach(function (o) { var b = el('button', null, o[1]); b.type = 'button'; b.dataset.key = o[0]; b.onclick = function () { show(o[0]); }; tabs.appendChild(b); });
    show(order[0][0]);
  }
  window.PMScene = { mount: mount };
})();
