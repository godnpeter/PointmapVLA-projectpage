/* pm-robot-ep.js — corpus viewer, "Robot data" pane: DROID / InternData-M1 episodes played back in the robot-base frame, in the look
   of figure 2a's 3D view: fused point cloud per keyframe, each camera's frustum at its (solved) pose carrying its live RGB image with
   the pointmap image stacked on it, the gripper path, floor grid + base axes. Autoplays; drag to orbit, wheel to zoom, Pause, scrub.
   Below: each camera's live RGB | pointmap. Data from build/export_robot_episodes.py (window.PMROBOT_EPS, lazily loaded per episode).
   PMRobotEp.mount(root, PMROBOT_EPS) */
(function () {
  'use strict';
  var VS = 'attribute vec3 p;attribute vec3 c;uniform mat4 mvp;uniform float ps;varying vec3 vc;void main(){gl_Position=mvp*vec4(p*0.001,1.0);gl_PointSize=clamp(ps/gl_Position.w,1.5,7.0);vc=c;}';   /* positions are int16 mm */
  var FS = 'precision mediump float;varying vec3 vc;void main(){vec2 d=gl_PointCoord-0.5;if(dot(d,d)>0.25)discard;gl_FragColor=vec4(vc,1.0);}';
  var VSL = 'attribute vec3 p;attribute vec3 c;uniform mat4 mvp;varying vec3 vc;void main(){gl_Position=mvp*vec4(p,1.0);vc=c;}';
  var FSL = 'precision mediump float;varying vec3 vc;uniform float a;void main(){gl_FragColor=vec4(vc,a);}';
  var VST = 'attribute vec3 p;attribute vec2 uv;uniform mat4 mvp;varying vec2 v;void main(){gl_Position=mvp*vec4(p,1.0);v=uv;}';
  var FST = 'precision mediump float;varying vec2 v;uniform sampler2D t;void main(){gl_FragColor=vec4(texture2D(t,v).rgb,1.0);}';
  var CAMC = [[0.18, 0.49, 0.88], [0.07, 0.65, 0.58], [0.84, 0.45, 0.10]], PATHC = [0.78, 0.12, 0.6], FD = 0.12, FPS = 4;
  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }
  function prog(gl, vs, fs) { function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; } var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; }
  function mul(a, b) { var o = new Float32Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(f, a, n, fa) { var t = 1 / Math.tan(f / 2); return new Float32Array([t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]); }
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function xf(T, p) { return [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2] * p[2] + T[0][3], T[1][0] * p[0] + T[1][1] * p[1] + T[1][2] * p[2] + T[1][3], T[2][0] * p[0] + T[2][1] * p[1] + T[2][2] * p[2] + T[2][3]]; }
  /* binary assets (open-source build): <name>.bin.gz = gzip of the raw point buffers; fetched and inflated in the browser
     (needs http(s), not file://, and DecompressionStream). The base64 .js form is still accepted. */
  function loadBin(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url);
    if (!/\.gz$/.test(url)) return r.arrayBuffer(); if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate ' + url);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }, function (e) { throw new Error((location.protocol === 'file:' ? 'serve the page over http (e.g. python -m http.server): ' : '') + e.message); }); }
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

  function mount(root, EPS) {
    root.classList.add('pms', 'pre');
    var groups = []; EPS.forEach(function (e) { var g = groups.filter(function (x) { return x[0] === e.group; })[0]; if (!g) { g = [e.group, []]; groups.push(g); } g[1].push(e); });
    var tabs = el('div', 'tabs pms-tabs'), chips = el('div', 'pms-chips'), head = el('div', 'pms-head'), stage = el('div', 'pms-stage pre-stage'), canvas = el('canvas'), msg = el('div', 'msg');
    var bar = el('div', 'pms-bar'), play = el('button', null, 'Pause'), scrub = el('input'), reset = el('button', null, 'Reset view'), hint = el('span', 'n', 'left-drag rotate · right-drag pan · wheel zoom'), side = el('div', 'pms-side pairs');
    scrub.type = 'range'; scrub.min = 0; scrub.step = 1; play.type = reset.type = 'button'; [play, scrub, reset, hint].forEach(function (x) { bar.appendChild(x); });
    stage.appendChild(canvas); stage.appendChild(msg); [tabs, chips, head, stage, bar, side].forEach(function (x) { root.appendChild(x); });
    var gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false }); if (!gl) { msg.textContent = 'WebGL unavailable'; return; }
    var P = prog(gl, VS, FS), L = prog(gl, VSL, FSL), TX = prog(gl, VST, FST), vbo = gl.createBuffer(), cbo = gl.createBuffer(), lbo = gl.createBuffer(), tbo = gl.createBuffer();
    var st = { ep: null, frames: null, k: 0, playing: true, cam: null, cam0: null, last: 0, acc: 0, texs: {}, visible: true, req: 0 };

    function upload(im) { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im);
      [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(function (q) { gl.texParameteri(gl.TEXTURE_2D, q[0], q[1]); }); return t; }
    function preload(urls) { return Promise.all(urls.map(function (u) { return new Promise(function (res) { var im = new Image(); im.onload = function () { (im.decode ? im.decode() : Promise.resolve()).then(function () { res(im); }, function () { res(im); }); }; im.onerror = function () { res(null); }; im.src = u; }); })); }
    function texFrom(url) { var t = st.texs[url]; return t ? t : null; }
    function camFrom(e) { return { t: e.centre.slice(), d: e.dist, az: 200, el: 26 }; }
    function eye(c) { var a = c.az * Math.PI / 180, b = c.el * Math.PI / 180; return [c.t[0] + c.d * Math.cos(b) * Math.cos(a), c.t[1] + c.d * Math.cos(b) * Math.sin(a), c.t[2] + c.d * Math.sin(b)]; }
    function viewM(c) { var e = eye(c), f = norm([c.t[0] - e[0], c.t[1] - e[1], c.t[2] - e[2]]), r = norm(cross(f, [0, 0, 1])), u = cross(r, f);
      return { m: new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, e), -dot(u, e), dot(f, e), 1]), e: e }; }
    function lines(arr, mvp, a, tri) { gl.useProgram(L); gl.uniformMatrix4fv(gl.getUniformLocation(L, 'mvp'), false, mvp); gl.uniform1f(gl.getUniformLocation(L, 'a'), a); gl.bindBuffer(gl.ARRAY_BUFFER, lbo); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      var lp = gl.getAttribLocation(L, 'p'), lc = gl.getAttribLocation(L, 'c'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 3, gl.FLOAT, false, 24, 12); gl.drawArrays(tri ? gl.TRIANGLES : gl.LINES, 0, arr.length / 6); gl.disableVertexAttribArray(lp); gl.disableVertexAttribArray(lc); }
    /* camera-facing ribbon of constant pixel width along a 3D path (same as pm-stage.js, figure 2a) */
    function ribbon(path, to, wpx, c, eye, f, H) { var tri = [], fl = (H / 2) / Math.tan(22.5 * Math.PI / 180), dpr = Math.min(devicePixelRatio || 1, 2);
      for (var i = 1; i <= to; i++) { var p0 = path[i - 1], p1 = path[i], d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], nn = cross(d, f), l = Math.hypot(nn[0], nn[1], nn[2]) || 1e-6;
        var zc = dot([p0[0] - eye[0], p0[1] - eye[1], p0[2] - eye[2]], f), hw = wpx * zc / fl / 2 * dpr; nn = [nn[0] * hw / l, nn[1] * hw / l, nn[2] * hw / l];
        [[p0, -1], [p0, 1], [p1, 1], [p0, -1], [p1, 1], [p1, -1]].forEach(function (q) { tri.push(q[0][0] + q[1] * nn[0], q[0][1] + q[1] * nn[1], q[0][2] + q[1] * nn[2], c[0], c[1], c[2]); }); }
      return new Float32Array(tri); }
    function ring(c, eye, f, H, rpx, wpx, col) { var fl = (H / 2) / Math.tan(22.5 * Math.PI / 180), dpr = Math.min(devicePixelRatio || 1, 2), zc = dot([c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]], f), r = rpx * zc / fl * dpr;
      var rr = norm(cross(f, [0, 0, 1])), uu = cross(rr, f), pts = []; for (var i = 0; i <= 32; i++) { var t = i / 32 * 2 * Math.PI; pts.push([c[0] + r * (Math.cos(t) * rr[0] + Math.sin(t) * uu[0]), c[1] + r * (Math.cos(t) * rr[1] + Math.sin(t) * uu[1]), c[2] + r * (Math.cos(t) * rr[2] + Math.sin(t) * uu[2])]); }
      return ribbon(pts, 32, wpx, col, eye, f, H); }
    function quad(q, tex, mvp) { var uv = [[0, 0], [1, 0], [1, 1], [0, 1]], vb = []; [0, 1, 2, 0, 2, 3].forEach(function (i) { vb.push(q[i][0], q[i][1], q[i][2], uv[i][0], uv[i][1]); });
      gl.useProgram(TX); gl.uniformMatrix4fv(gl.getUniformLocation(TX, 'mvp'), false, mvp); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(gl.getUniformLocation(TX, 't'), 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, tbo); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vb), gl.DYNAMIC_DRAW); var lp = gl.getAttribLocation(TX, 'p'), lu = gl.getAttribLocation(TX, 'uv');
      gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(lu); gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 20, 12); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(lp); gl.disableVertexAttribArray(lu); }
    function corners(T, K, hw, d, du, dv) { var h = hw[0], w = hw[1], ou = (du || 0) * w, ov = (dv || 0) * h;
      return [[0, 0], [w, 0], [w, h], [0, h]].map(function (q) { return xf(T, [(q[0] + ou - K[0][2]) / K[0][0] * d, (q[1] + ov - K[1][2]) / K[1][1] * d, d]); }); }

    function render() { var e = st.ep, fr = st.frames; var dpr = Math.min(devicePixelRatio || 1, 2), W = Math.floor(canvas.clientWidth * dpr), H = Math.floor(canvas.clientHeight * dpr); if (!W || !H) return;
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (!e || !st.cam) return; var V = viewM(st.cam), mvp = mul(persp(45 * Math.PI / 180, W / H, 0.03, 60), V.m), fl = (H / 2) / Math.tan(22.5 * Math.PI / 180), k = st.k;
      var zf = e.zfloor; if (!st.grid) { var g = []; for (var i = -10; i <= 10; i++) { var s = i / 10 * 1.2, c = 0.86; g.push(-1, s, zf, c, c, c, 1.6, s, zf, c, c, c, s + 0.3, -1.2, zf, c, c, c, s + 0.3, 1.2, zf, c, c, c); } st.grid = new Float32Array(g); }
      lines(st.grid, mvp, 0.8); gl.disable(gl.DEPTH_TEST); lines(new Float32Array([0, 0, zf, .88, .19, .19, .25, 0, zf, .88, .19, .19, 0, 0, zf, .18, .62, .27, 0, .25, zf, .18, .62, .27, 0, 0, zf, .11, .49, .84, 0, 0, zf + .25, .11, .49, .84]), mvp, 1); gl.enable(gl.DEPTH_TEST);
      if (fr && fr[k]) { gl.useProgram(P); gl.uniformMatrix4fv(gl.getUniformLocation(P, 'mvp'), false, mvp); gl.uniform1f(gl.getUniformLocation(P, 'ps'), 2.6 * fl * 0.0042 * dpr);
        var lp = gl.getAttribLocation(P, 'p'), lc = gl.getAttribLocation(P, 'c'); gl.bindBuffer(gl.ARRAY_BUFFER, fr[k].p); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.SHORT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, fr[k].c); gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 3, gl.UNSIGNED_BYTE, true, 0, 0); gl.drawArrays(gl.POINTS, 0, fr[k].n); gl.disableVertexAttribArray(lp); gl.disableVertexAttribArray(lc); }
      /* cameras: frustum + RGB card with the pointmap card stacked on it (up-left), like figure 2a */
      var I = window.PMROBOT_IMG && window.PMROBOT_IMG[e.key], fl3 = []; gl.disable(gl.DEPTH_TEST);
      (e.poses[k] || []).forEach(function (T, v) { if (!T) return; var K = e.K[k][v], col = CAMC[v], o = xf(T, [0, 0, 0]), q = corners(T, K, e.hw, FD);
        if (I) { var t1 = texFrom(I.rgb[k][v]), t2 = texFrom(I.pm[k][v]); if (t1) quad(q, t1, mvp); if (t2) quad(corners(T, K, e.hw, FD * 0.94, -0.3, -0.5), t2, mvp); }
        for (var i2 = 0; i2 < 4; i2++) { var a2 = q[i2], b2 = q[(i2 + 1) % 4]; fl3.push(o[0], o[1], o[2], col[0], col[1], col[2], a2[0], a2[1], a2[2], col[0], col[1], col[2], a2[0], a2[1], a2[2], col[0], col[1], col[2], b2[0], b2[1], b2[2], col[0], col[1], col[2]); } });
      if (fl3.length) lines(new Float32Array(fl3), mvp, 1); gl.enable(gl.DEPTH_TEST);
      /* gripper path: whole path faint, travelled part bold */
      if (e.path) { var n = e.path.length, upto = Math.round(e.frames[k] / Math.max(1, e.length - 1) * (n - 1)), ey = V.e, fw = norm([st.cam.t[0] - ey[0], st.cam.t[1] - ey[1], st.cam.t[2] - ey[2]]);
        gl.disable(gl.DEPTH_TEST);   /* drawn over the cloud, as in figure 2a: faint whole path, bold travelled part with a white outline, ring on the gripper */
        lines(ribbon(e.path, n - 1, 4, [1, 1, 1], ey, fw, H), mvp, 0.9, true); lines(ribbon(e.path, n - 1, 1.5, [0.93, 0.78, 0.93], ey, fw, H), mvp, 1, true);
        if (upto > 0) { lines(ribbon(e.path, upto, 6.5, [1, 1, 1], ey, fw, H), mvp, 1, true); lines(ribbon(e.path, upto, 3.2, PATHC, ey, fw, H), mvp, 1, true); }
        var gp = e.path[upto]; lines(ring(gp, ey, fw, H, 7, 4.5, [1, 1, 1]), mvp, 1, true); lines(ring(gp, ey, fw, H, 7, 2.5, PATHC), mvp, 1, true);
        gl.enable(gl.DEPTH_TEST); }
      }

    var pairImgs = [];
    function sidePairs() { var e = st.ep, I = window.PMROBOT_IMG && window.PMROBOT_IMG[e.key]; if (!I) return;
      if (!pairImgs.length || pairImgs.key !== e.key) { side.innerHTML = ''; pairImgs = []; pairImgs.key = e.key;
        e.labels.forEach(function (lab, v) { var row = el('div', 'pair'); [lab, 'pointmap'].forEach(function (c, j) { var f = el('figure'), im = document.createElement('img'); f.appendChild(im); f.appendChild(el('figcaption', null, c)); row.appendChild(f); pairImgs.push([im, j, v]); }); side.appendChild(row); }); }
      pairImgs.forEach(function (x) { var src = (x[1] ? I.pm : I.rgb)[st.k][x[2]]; if (x[0].getAttribute('src') !== src) x[0].setAttribute('src', src); }); }

    function open(e) { var req = ++st.req; st.ep = e; st.frames = null; st.k = 0; st.cam0 = camFrom(e); st.cam = JSON.parse(JSON.stringify(st.cam0)); st.dirty = true; scrub.max = e.frames.length - 1;
      head.innerHTML = '<p class="rr-prompt ep-instr"><span>Instruction</span>“' + e.instruction + '”</p><span class="fr">' + e.source + ' · robot-base frame (x forward, y left, z up)</span>';   /* the task instruction leads */
      [].forEach.call(chips.children, function (c) { c.classList.toggle('on', c._ep === e); }); msg.textContent = 'loading episode…';
      window.PMROBOT_IMG = window.PMROBOT_IMG || {};
      var load = e.bin   /* binary episode: data.bin.gz + rgb_<k>_<v>.jpg / pm_<k>_<v>.jpg files (make_opensource.py) */
        ? loadBin(e.dir + '/data.bin.gz').then(function (buf) { window.PMROBOT_IMG[e.key] = window.PMROBOT_IMG[e.key] || { rgb: e.frames.map(function (_, k) { return e.labels.map(function (_, v) { return e.dir + '/rgb_' + k + '_' + v + '.jpg'; }); }),
            pm: e.frames.map(function (_, k) { return e.labels.map(function (_, v) { return e.dir + '/pm_' + k + '_' + v + '.jpg'; }); }) }; return { n: e.n, bb: new Uint8Array(buf) }; })
        : Promise.all([loadScript(e.dir + '/data.js'), loadScript(e.dir + '/imgs.js')]).then(function () { var d0 = window.PMROBOT_EP[e.key], bin = atob(d0.b64), bb0 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bb0[i] = bin.charCodeAt(i); return { n: d0.n, bb: bb0 }; });
      load.then(function (d) { if (req !== st.req) return; var bb = d.bb;
        var off = 0, fr = [], zs = []; d.n.forEach(function (m) { var pos = new Int16Array(bb.buffer.slice(off, off + m * 6)), col = new Uint8Array(bb.buffer.slice(off + m * 6, off + m * 9)); off += m * 9;
          var pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW); var cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
          for (var j = 2; j < pos.length; j += 90) zs.push(pos[j] / 1000); fr.push({ n: m, p: pb, c: cb }); });
        zs.sort(function (a, b) { return a - b; }); e.zfloor = zs[Math.floor(zs.length * 0.02)] || 0;
        var I = window.PMROBOT_IMG[e.key], urls = [].concat.apply([], I.rgb.concat(I.pm));
        return preload(urls).then(function (ims) { if (req !== st.req) return; Object.keys(st.texs).forEach(function (k) { gl.deleteTexture(st.texs[k]); }); st.texs = {};
          urls.forEach(function (u, i) { if (ims[i]) st.texs[u] = upload(ims[i]); }); st.grid = null; st.frames = fr; msg.textContent = ''; sidePairs(); st.dirty = true; }); }, function (err) { msg.textContent = 'failed to load: ' + (err && err.message || err); }); }
    function group(gi) { [].forEach.call(tabs.children, function (b, j) { b.classList.toggle('on', j === gi); }); chips.innerHTML = '';
      groups[gi][1].forEach(function (e, i) { var c = el('button', null, String(i + 1)); c.type = 'button'; c._ep = e; c.title = e.instruction; c.onclick = function () { open(e); }; chips.appendChild(c); }); open(groups[gi][1][0]); }
    groups.forEach(function (g, gi) { var b = el('button', null, g[0]); b.type = 'button'; b.onclick = function () { group(gi); }; tabs.appendChild(b); });

    play.onclick = function () { st.playing = !st.playing; play.textContent = st.playing ? 'Pause' : 'Play'; };
    scrub.oninput = function () { st.dirty = true; st.k = +scrub.value; st.playing = false; play.textContent = 'Play'; if (st.frames) sidePairs(); };
    reset.onclick = function () { st.cam = JSON.parse(JSON.stringify(st.cam0)); st.dirty = true; };
    /* left-drag = orbit, right-drag (or shift+drag) = pan, wheel = zoom; the context menu is suppressed on the canvas */
    var drag = null; canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    canvas.addEventListener('pointerdown', function (ev) { drag = { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.shiftKey }; canvas.setPointerCapture(ev.pointerId); canvas.style.cursor = drag.pan ? 'move' : 'grabbing'; });
    canvas.addEventListener('pointermove', function (ev) { if (!drag || !st.cam) return; var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY;
      if (drag.pan) { var e0 = eye(st.cam), f = norm([st.cam.t[0] - e0[0], st.cam.t[1] - e0[1], st.cam.t[2] - e0[2]]), r = norm(cross(f, [0, 0, 1])), u = cross(r, f), k = st.cam.d * 0.0012;
        for (var a = 0; a < 3; a++) st.cam.t[a] += (-dx * r[a] + dy * u[a]) * k; }
      else { st.cam.az -= dx * 0.35; st.cam.el = Math.max(-10, Math.min(85, st.cam.el + dy * 0.3)); } st.dirty = true; });
    canvas.addEventListener('pointerup', function () { drag = null; canvas.style.cursor = 'grab'; }); canvas.addEventListener('wheel', function (ev) { if (!st.cam) return; ev.preventDefault(); st.cam.d = Math.max(0.3, Math.min(8, st.cam.d * Math.exp(ev.deltaY * 0.001))); st.dirty = true; }, { passive: false });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { es.forEach(function (x) { st.visible = x.isIntersecting; }); }).observe(root);
    (function tick(now) { requestAnimationFrame(tick); var dt = st.last ? Math.min(now - st.last, 200) : 0; st.last = now; if (!st.visible) return;
      if (st.playing && st.frames) { st.acc += dt; if (st.acc > 1000 / FPS) { st.acc = 0; st.k = (st.k + 1) % st.frames.length; scrub.value = st.k; sidePairs(); st.dirty = true; } }
      if (st.dirty) { st.dirty = false; render(); } })(performance.now());
    addEventListener('resize', function () { st.dirty = true; });
    group(0); root.__pre = st;
  }
  window.PMRobotEp = { mount: mount };
})();
