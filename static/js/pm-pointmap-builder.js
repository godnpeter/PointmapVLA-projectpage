/* Adapted from presentation/pointmapvla_site_v3/static/js/pm-explain.js.
   Uses the current page's RoboCasa frame, separate camera/base XYZ textures, and per-view controls. */
/* pm-explain.js — "how a pointmap is made", staged entirely in one 3-D view, cards stacked per camera like section1.
   Act 1  RGB          an RGB card hangs at each camera
   Act 2  + depth      a depth image appears beside each RGB image
   Act 3  + extrinsics the lifted points swing into the robot-base frame; the three views merge into one scene; a pointmap card stacks in
   Act 4  pointmap     the cloud recolours to XYZ-as-colour = the pointmap values; the pointmap card is what the model gets
   Auto-plays and loops; scrub with the bar or click a step. Raw WebGL, works from file://. window.PMPointmapBuilder.mount(root, PMX) */
(function () {
  'use strict';
  var VS = 'attribute vec3 a_flat; attribute vec3 a_cam; attribute vec3 a_pos; attribute vec3 a_rgb; attribute vec3 a_pm; attribute float a_view;' +
    'uniform mat4 u_mvp; uniform float u_lift; uniform float u_rot; uniform float u_pmcol; uniform float u_psize; uniform float u_bycam; varying vec3 v_col;' +
    'void main(){ vec3 p = mix(mix(a_flat, a_cam, u_lift), a_pos, u_rot); gl_Position = u_mvp*vec4(p,1.0); gl_PointSize = clamp(u_psize/gl_Position.w, 1.5, 6.0); vec3 vc = a_view < 0.5 ? vec3(0.18,0.49,0.88) : (a_view < 1.5 ? vec3(0.07,0.65,0.58) : vec3(0.84,0.45,0.10)); v_col = mix(mix(a_pm, a_rgb, clamp(u_lift*1.6, 0.0, 1.0)), vc, u_bycam); }';
  var FS = 'precision mediump float; varying vec3 v_col; void main(){ vec2 c=gl_PointCoord-0.5; float d=dot(c,c); if(d>0.25) discard; gl_FragColor = vec4(v_col, smoothstep(0.25, 0.16, d)); }';
  var VSL = 'attribute vec3 a_pos; attribute vec3 a_col; uniform mat4 u_mvp; varying vec3 v_col; void main(){ gl_Position=u_mvp*vec4(a_pos,1.0); v_col=a_col; }';
  var FSL = 'precision mediump float; varying vec3 v_col; void main(){ gl_FragColor=vec4(v_col,1.0); }';
  var VST = 'attribute vec3 a_pos; attribute vec2 a_uv; uniform mat4 u_mvp; varying vec2 v_uv; void main(){ gl_Position=u_mvp*vec4(a_pos,1.0); v_uv=a_uv; }';
  var FST = 'precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha; uniform float u_cut; void main(){ if(v_uv.x>u_cut) discard; vec4 c=texture2D(u_tex,v_uv); if(c.a<0.05) discard; gl_FragColor=vec4(c.rgb, c.a*u_alpha); }';
  var VIEW_COL = [[0.18, 0.49, 0.88], [0.07, 0.65, 0.58], [0.84, 0.45, 0.10]];
  var CARD = 0.13, LANE_CARD = 0.42, OFF_X = 0.16, OFF_Z = 0.05, WR_X = -1.15, WR_Z = -0.08;   /* same card geometry as section1 */
  var ACTS = [
    { t: 0.00, title: 'RGB image', key: 'Start with RGB observations.', sub: 'Each camera supplies an image of the same scene.' },
    { t: 0.18, title: 'RGB + Depth', key: 'Add metric depth to each RGB view.', sub: 'RGB describes appearance; depth gives the camera-space Z coordinate in meters.' },
    { t: 0.34, title: 'RGB + camera-frame pointmap', key: 'Pixels become 3D points (X, Y, Z).', sub: 'Depth and the intrinsics K turn every pixel into a point: first written as an image (the pointmap), then lifted into space. Each camera still measures from its own origin.', eq: 'P(u, v) = D(u, v) \u00b7 K\u207b\u00b9 [u, v, 1]\u1d40' },
    { t: 0.66, title: 'RGB + robot-frame pointmap', key: 'Same points, one origin: the robot base.', sub: 'The extrinsics (R, t) move every point into the robot\u2019s frame. This is PointmapVLA\u2019s input.', eq: 'P\u1d3f(u, v) = R \u00b7 P(u, v) + t' }];
  var LOOP = 26000;

  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function prog(gl, vs, fs) { function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }
    var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; }
  function b64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function mul(a, b) { var o = new Float32Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(f, a, n, fa) { var t = 1 / Math.tan(f / 2); return new Float32Array([t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]); }
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function camAxes(c) { var az = c.az * Math.PI / 180, e = c.el * Math.PI / 180, eye = [c.t[0] + c.d * Math.cos(e) * Math.cos(az), c.t[1] + c.d * Math.cos(e) * Math.sin(az), c.t[2] + c.d * Math.sin(e)];
    var f = norm([c.t[0] - eye[0], c.t[1] - eye[1], c.t[2] - eye[2]]), r = norm(cross(f, [0, 0, 1])), u = cross(r, f); return { eye: eye, f: f, r: r, u: u }; }
  function view(c) { var a = camAxes(c), e = a.eye; return new Float32Array([a.r[0], a.u[0], -a.f[0], 0, a.r[1], a.u[1], -a.f[1], 0, a.r[2], a.u[2], -a.f[2], 0, -dot(a.r, e), -dot(a.u, e), dot(a.f, e), 1]); }
  function xf(T, p) { return [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2] * p[2] + T[0][3], T[1][0] * p[0] + T[1][1] * p[1] + T[1][2] * p[2] + T[1][3], T[2][0] * p[0] + T[2][1] * p[1] + T[2][2] * p[2] + T[2][3]]; }
  function ease(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
  function turbo(t) { var t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t, cl = function (v) { return Math.max(0, Math.min(255, 255 * v)); };
    return [cl(0.13572138 + 4.61539260 * t - 42.66032258 * t2 + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5), cl(0.09140261 + 2.19418839 * t + 4.84296658 * t2 - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5), cl(0.10667330 + 12.64194608 * t - 60.58204836 * t2 + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5)]; }
  function lerpPose(A, B, t) { if (t <= 0) return A; if (t >= 1) return B; var M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]];
    for (var i = 0; i < 3; i++) M[i][3] = A[i][3] + (B[i][3] - A[i][3]) * t;
    var z = norm([A[0][2] + (B[0][2] - A[0][2]) * t, A[1][2] + (B[1][2] - A[1][2]) * t, A[2][2] + (B[2][2] - A[2][2]) * t]);
    var x0 = [A[0][0] + (B[0][0] - A[0][0]) * t, A[1][0] + (B[1][0] - A[1][0]) * t, A[2][0] + (B[2][0] - A[2][0]) * t];
    var y = norm(cross(z, x0)), x = cross(y, z);
    for (var r = 0; r < 3; r++) { M[r][0] = x[r]; M[r][1] = y[r]; M[r][2] = z[r]; } return M; }
  function corners(K, hw, T, d, shiftU, shiftZ) { var h = hw[0], w = hw[1]; return [[0, 0], [w, 0], [w, h], [0, h]].map(function (uv) { return xf(T, [(uv[0] + (shiftU || 0) * w - K[0][2]) / K[0][0] * d, (uv[1] - K[1][2]) / K[1][1] * d, d + (shiftZ || 0)]); }); }

  function mount(root, PMX) {
    var visibleViews = PMX.cams.map(function () { return true; }), ranges = [], colorByCamera = false;
    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var cams = PMX.cams, nV = cams.length, Ds = cams.map(function (c) { return PMX.data[c]; }), w = Ds[0].w, h = Ds[0].h, N = w * h, hw = [h, w];
    var depth = Ds.map(function (D) { return new Uint16Array(b64(D.depth).buffer); }), xyz = Ds.map(function (D) { return new Int16Array(b64(D.xyz).buffer); }), rgb = Ds.map(function (D) { return b64(D.rgb_flat); });
    root.classList.add('pmx');
    var steps = el('div', 'pmx-steps'), flow = el('div', 'flow'), capt = el('div', 'capt'); steps.appendChild(flow); steps.appendChild(capt);
    var ARROWS = ['+ Depth', '+ Intrinsics K', '+ Extrinsics (R, t)'];
    var stepEls = ACTS.map(function (a, i) { var d = el('button', 'node'); d.innerHTML = '<i>' + (i + 1) + '</i><span>' + a.title + '</span>'; d.onclick = function () { st.userMoved = false; st.orbit = false; orbit.classList.remove('on'); st.u = reducedMotion ? [0.08, 0.29, 0.63, 0.99][i] : a.t + 0.001; st.stopAt = i < 3 ? ACTS[i+1].t - 0.015 : 0.995; st.playing = !reducedMotion; play.textContent = st.playing ? 'Pause' : 'Play'; draw(); }; flow.appendChild(d);
      if (i < 3) { var ar = el('div', 'arrow'); ar.innerHTML = '<em>' + ARROWS[i] + '</em><b></b>'; flow.appendChild(ar); } return d; });

    var stage = el('div', 'pmx-stage'), canvas = el('canvas'), bar = el('div', 'pmx-bar'), eq = el('div', 'pmx-eq'), legend = el('div', 'pmx-legend');
    var tags = [], ptTags = [];   /* no floating chips on the canvas: frames are the dot+axes, coordinates live in the caption */
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'pmx-axes');
    eq.innerHTML = '<span class="k">camera frame</span> P<sub>cam</sub> = D(u,v) · K<sup>−1</sup> [u, v, 1]<sup>T</sup> &nbsp;&nbsp;&nbsp; <span class="k">robot frame</span> P = R<sub>r←c</sub> P<sub>cam</sub> + t<sub>r←c</sub>';
    legend.innerHTML = PMX.labels.map(function (l, i) { return '<span><i style="background:rgb(' + VIEW_COL[i].map(function (x) { return Math.round(x * 255); }).join(',') + ')"></i>' + l + '</span>'; }).join('');
    var play = el('button', null, reducedMotion ? 'Play' : 'Pause'), prog_ = document.createElement('input'), orbit = el('button', null, 'Auto-orbit'), reset = el('button', null, 'Reset view');
    prog_.type = 'range'; prog_.min = 0; prog_.max = 1; prog_.step = 0.001; prog_.value = 0; prog_.setAttribute('aria-label', 'Pointmap construction progress');
    [play, prog_, el('span', 'sep'), orbit, reset].forEach(function (e) { bar.appendChild(e); });
    stage.appendChild(canvas); stage.appendChild(svg); tags.concat(ptTags).forEach(function (t) { t.style.display = 'none'; stage.appendChild(t); }); stage.appendChild(legend); stage.appendChild(bar);
    root.appendChild(steps); root.appendChild(stage);
    var finalPanel = el('div', 'builder-final-inputs'); finalPanel.hidden = true;
    finalPanel.appendChild(el('h4', null, 'Model inputs in the robot-base frame'));
    var finalGrid = el('div', 'builder-input-grid');
    finalPanel.appendChild(finalGrid); root.appendChild(finalPanel);
    var finalCards = [], baseURLs = [];
    var st = { u: 0, playing: !reducedMotion, orbit: false, dirty: false, last: 0, userMoved: false, visible: false, stopAt: null };
    var controls = el('div', 'visual-toolbar builder-controls');
    PMX.labels.forEach(function (label, v) {
      var lab = el('label'), check = el('input'); check.type = 'checkbox'; check.checked = true;
      check.setAttribute('aria-label', 'Show ' + label + ' pointmap');
      check.onchange = function () { visibleViews[v] = check.checked; draw(); };
      lab.appendChild(check); lab.appendChild(el('span', null, 'View '+(v+1)+' · '+label)); controls.appendChild(lab);
    });
    var colorLabel = el('label', null, '3D colors '), colors = el('select'); colors.setAttribute('aria-label', 'Point cloud colors');
    ['RGB colors', 'Color by camera'].forEach(function (label, i) { var o=el('option',null,label);o.value=i;colors.appendChild(o); });
    colors.onchange=function(){colorByCamera=colors.value==='1';draw();};colorLabel.appendChild(colors);controls.appendChild(colorLabel);root.appendChild(controls);
    var representation=el('p','builder-representation');root.appendChild(representation);


    /* ---- card textures: RGB / depth(grey) / pointmap(XYZ colour) per camera ---- */
    var gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false }); if (!gl) { stage.appendChild(el('p','visual-fallback','This interactive view requires WebGL.')); return; }
    gl.depthFunc(gl.LEQUAL);
    var P = prog(gl, VS, FS), L = prog(gl, VSL, FSL), Q = prog(gl, VST, FST);
    var lp = {}; ['a_flat', 'a_cam', 'a_pos', 'a_rgb', 'a_pm', 'a_view'].forEach(function (n) { lp[n] = gl.getAttribLocation(P, n); }); ['u_mvp', 'u_lift', 'u_rot', 'u_pmcol', 'u_psize', 'u_bycam'].forEach(function (n) { lp[n] = gl.getUniformLocation(P, n); });
    var ll = { pos: gl.getAttribLocation(L, 'a_pos'), col: gl.getAttribLocation(L, 'a_col'), mvp: gl.getUniformLocation(L, 'u_mvp') };
    var lq = { pos: gl.getAttribLocation(Q, 'a_pos'), uv: gl.getAttribLocation(Q, 'a_uv'), mvp: gl.getUniformLocation(Q, 'u_mvp'), tex: gl.getUniformLocation(Q, 'u_tex'), alpha: gl.getUniformLocation(Q, 'u_alpha'), cut: gl.getUniformLocation(Q, 'u_cut') };
    function tex(pix) { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, pix);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; }
    var pmPix = [], texRGB = [], texD = [], texPM = [], texBase = [];
    var BASE_LO = [-0.6,-0.9,-0.5], BASE_HI = [0.9,0.9,1.2];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    Ds.forEach(function (D, v) { var dp = new Uint8Array(N * 3), pp = new Uint8Array(N * 3), bp = new Uint8Array(N * 3), zs = [];
      for (var i = 0; i < N; i += 5) if (depth[v][i] > 0) zs.push(depth[v][i]); zs.sort(function (a, b) { return a - b; }); var zlo = zs[Math.floor(zs.length * 0.02)], zhi = zs[Math.floor(zs.length * 0.98)];   /* grey depth: near = bright, far = dark, per camera */
      for (var i = 0; i < N; i++) { var z = depth[v][i] / 1000; if (z <= 0) { dp[i * 3] = dp[i * 3 + 1] = dp[i * 3 + 2] = 0; pp[i * 3] = pp[i * 3 + 1] = pp[i * 3 + 2] = 0; continue; }
        var g = Math.round(40 + 215 * Math.max(0, Math.min(1, 1 - (depth[v][i] - zlo) / Math.max(1, zhi - zlo)))); dp[i * 3] = dp[i * 3 + 1] = dp[i * 3 + 2] = g;
        var u = i % w, r = Math.floor(i / w), K = D.K;
        var cp = [(u + 0.5-K[0][2])/K[0][0]*z, (r+0.5-K[1][2])/K[1][1]*z, z];
        var cameraLo = [-1.2,-1.0,0.3], cameraHi = [1.2,1.0,3.0];
        for (var axis=0;axis<3;axis++) {
          pp[i*3+axis]=Math.max(0,Math.min(255,(cp[axis]-cameraLo[axis])/(cameraHi[axis]-cameraLo[axis])*255));
          bp[i*3+axis]=Math.max(0,Math.min(255,(xyz[v][i*3+axis]/1000-BASE_LO[axis])/(BASE_HI[axis]-BASE_LO[axis])*255));
        }
      }
      D._grey = dp;
      var preview = document.createElement('canvas'); preview.width = w; preview.height = h;
      var previewContext = preview.getContext('2d'), pixels = previewContext.createImageData(w, h);
      for (var j=0;j<N;j++) { for(var a=0;a<3;a++) pixels.data[j*4+a]=bp[j*3+a];pixels.data[j*4+3]=255; }
      previewContext.putImageData(pixels,0,0);baseURLs.push(preview.toDataURL());
      pmPix.push(pp); texRGB.push(tex(rgb[v])); texD.push(tex(dp)); texPM.push(tex(pp)); texBase.push(tex(bp)); });
    Ds.forEach(function(D,v){
      var input=el('div','builder-input-card'), pair=el('div','builder-input-pair');input.appendChild(el('h5',null,PMX.labels[v]));
      [D.rgb,baseURLs[v]].forEach(function(url,k){var fig=el('figure'),im=el('img');im.src=url;im.alt=PMX.labels[v]+(k?' robot-base XYZ pointmap':' RGB observation');fig.appendChild(im);fig.appendChild(el('figcaption',null,k?'Robot-base pointmap':'RGB'));pair.appendChild(fig);});
      input.appendChild(pair);finalGrid.appendChild(input);finalCards.push(input);
    });
    var KW = 256, KH = 256, texK = Ds.map(function () { var c = document.createElement('canvas'); c.width = KW; c.height = KH; var x = c.getContext('2d');   /* camera-intrinsics icon: a camera with a K badge (transparent background) */
      x.clearRect(0, 0, KW, KH); x.fillStyle = '#6b4de6'; x.strokeStyle = '#6b4de6';
      function rr(X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
      rr(96, 40, 64, 34, 10); x.fill(); rr(24, 66, 208, 138, 22); x.fill();
      x.fillStyle = '#fff'; x.beginPath(); x.arc(128, 136, 48, 0, Math.PI * 2); x.fill(); x.fillStyle = '#6b4de6'; x.beginPath(); x.arc(128, 136, 36, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#fff'; x.font = 'italic 700 44px Times New Roman, serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('K', 128, 138);
      x.fillStyle = '#6b4de6'; x.font = '700 30px Noto Sans, Helvetica, Arial, sans-serif'; x.textBaseline = 'alphabetic'; x.fillText('intrinsics', 128, 244);
      var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; });
    var texE = (function () { var c = document.createElement('canvas'); c.width = KW; c.height = KH; var x = c.getContext('2d');   /* camera-extrinsics icon: camera → robot base, with an (R, t) badge */
      x.clearRect(0, 0, KW, KH); x.fillStyle = '#6b4de6'; x.strokeStyle = '#6b4de6'; x.lineCap = 'round'; x.lineJoin = 'round';
      function rr(X, Y, W, H, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath(); }
      rr(40, 22, 34, 18, 6); x.fill(); rr(14, 36, 86, 60, 12); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.arc(57, 66, 18, 0, Math.PI * 2); x.fill();   /* small camera, top-left */
      x.fillStyle = '#6b4de6'; rr(150, 150, 92, 22, 6); x.fill(); x.lineWidth = 14; x.beginPath(); x.moveTo(196, 150); x.lineTo(196, 108); x.lineTo(168, 72); x.stroke(); x.beginPath(); x.arc(168, 72, 14, 0, Math.PI * 2); x.fill();   /* robot base + arm, bottom-right */
      x.lineWidth = 9; x.setLineDash([2, 14]); x.beginPath(); x.moveTo(100, 100); x.quadraticCurveTo(150, 40, 190, 118); x.stroke(); x.setLineDash([]);   /* dashed pose arc camera → base */
      x.beginPath(); x.moveTo(190, 118); x.lineTo(176, 96); x.lineTo(203, 96); x.closePath(); x.fill();
      x.fillStyle = '#6b4de6'; x.font = 'italic 700 40px Times New Roman, serif'; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.fillText('(R, t)', 18, 150);
      x.font = '700 28px Noto Sans, Helvetica, Arial, sans-serif'; x.textAlign = 'center'; x.fillText('extrinsics', 128, 240);
      var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; })();
    /* a free rectangle in a camera's image plane: centre at pixel (cx + su*w, cy + sv*h), half size (hw_, hh_) pixels, at distance d */
    function rect(mvp, t, v, T, d, su, sv, hw_, hh_, alpha, flip) { if (alpha <= 0.01) return; var K = Ds[v].K, cxp = K[0][2] + su * w, cyp = K[1][2] + sv * h, q = [];
      var cc = [[cxp - hw_, cyp - hh_], [cxp + hw_, cyp - hh_], [cxp + hw_, cyp + hh_], [cxp - hw_, cyp + hh_]].map(function (uv) { return xf(T, [(uv[0] - K[0][2]) / K[0][0] * d, (uv[1] - K[1][2]) / K[1][1] * d, d]); });
      if (flip) cc = [cc[2], cc[3], cc[0], cc[1]];   /* image plane rolled 180° (wrist): rotate the quad so the text reads upright */
      [[0, 0, 0], [1, 1, 0], [2, 1, 1], [0, 0, 0], [2, 1, 1], [3, 0, 1]].forEach(function (x) { q.push(cc[x[0]][0], cc[x[0]][1], cc[x[0]][2], x[1], x[2]); });
      gl.useProgram(Q); gl.uniformMatrix4fv(lq.mvp, false, mvp); gl.uniform1i(lq.tex, 0); gl.uniform1f(lq.alpha, alpha); gl.uniform1f(lq.cut, 1); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.bindBuffer(gl.ARRAY_BUFFER, qbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(q), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(lq.pos); gl.vertexAttribPointer(lq.pos, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(lq.uv); gl.vertexAttribPointer(lq.uv, 2, gl.FLOAT, false, 20, 12);
      // The caller owns depth-write state for the entire card pass. Restoring it
      // here made later cameras' depth cards occlude their coplanar XYZ overlays.
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(lq.pos); gl.disableVertexAttribArray(lq.uv); }

    /* ---- per-point buffers: on-card position (flat), camera-frame position at a detached staging pose (cam), robot-frame (pos) ---- */
    var flat = new Float32Array(3 * N * 3), camA = new Float32Array(3 * N * 3), pos = new Float32Array(3 * N * 3), col = new Uint8Array(3 * N * 3), pmc = new Uint8Array(3 * N * 3), vid = new Float32Array(3 * N), n = 0;
    /* Lanes for steps 1-2: three virtual cameras in a row along y, all looking toward -x (the viewer sits at -x) and slightly down.
       Columns of R = camera axes in base coords: cam x (image right) = +y, cam z (forward) = -x tilted down, cam y = z x x. */
    var LANE_Y = [1.45, 0, -1.45], LANE_X = -0.6, LANE_Z = 0.9, LP = 12 * Math.PI / 180;   /* cards tilt slightly up toward the raised camera */   /* upright cards, three lanes well apart */
    var LY = 0;   /* all three lanes face the viewer squarely, in one level row */   /* lane yaw: the lifted cloud recedes to one side so its depth is visible next to the card */
    var stageT = Ds.map(function (D, v) { var isW = v === nV - 1, f = 1, lp = LP;   /* wrist image is mounted upside down → its display is rolled 180° about the optical axis; same lane pose otherwise */
      var lcx = [Math.sin(LY), -Math.cos(LY), 0], lcz = [Math.cos(lp) * Math.cos(LY), Math.cos(lp) * Math.sin(LY), -Math.sin(lp)], lcy = cross(lcz, lcx);
      var mx = f;   /* mirrored x: the lane is viewed from the scene side, so the relief pops out toward the viewer while the image still reads left-to-right */
      return [[mx * lcx[0], f * lcy[0], lcz[0], LANE_X], [mx * lcx[1], f * lcy[1], lcz[1], LANE_Y[v]], [mx * lcx[2], f * lcy[2], lcz[2], LANE_Z], [0, 0, 0, 1]]; });
    var LC = Ds.map(function (D) { return LANE_CARD * D.K[0][0] / Ds[0].K[0][0]; });   /* per-lane card distance: equal card width whatever the lens */
    var LANE_SPAN = 0.9, LANE_HALFW = 0.5, LANE_GAP = [1.2, 0.7, 0.7];   /* per lane: the left camera's cloud sits further back */   /* the lifted cloud floats well behind the card stack */   /* every lane's relief: same depth span behind the card plane, never wider than the slot */
    function inWS(rp) { return !(Math.hypot(rp[0] - 0.35, rp[1]) > 1.25 || rp[2] < -0.45 || rp[2] > 1.25); }   /* workspace crop: table, objects, robot; drops the backdrop curtain */
    var laneFit = Ds.map(function (D, v) { var K = D.K, zs = [], xs = []; for (var i = 0; i < N; i += 7) { var z = depth[v][i] / 1000; if (z <= 0) continue; var u0 = i % w, v0 = (i - u0) / w, c0 = [(u0 - K[0][2]) / K[0][0] * z, (v0 - K[1][2]) / K[1][1] * z, z]; if (!inWS(xf(D.T, c0))) continue; zs.push(z); xs.push(Math.abs(c0[0])); }
      zs.sort(function (a, b) { return a - b; }); xs.sort(function (a, b) { return a - b; }); var z0 = zs[Math.floor(zs.length * 0.10)] || 0, z1 = zs[Math.floor(zs.length * 0.90)] || 1, x95 = xs[Math.floor(xs.length * 0.95)] || 1;
      return { z0: z0, s: Math.min(LANE_SPAN / Math.max(z1 - z0, 1e-3), LANE_HALFW / Math.max(x95, 1e-3)) }; });   /* uniform scale: camera-frame shape kept, size equalised */
    var PSTAR = [0.354, 0.166, 0.046];   /* tracked point: the carrot on the table (robot-base frame, m) — visible in all three cameras */
    var PCAM = Ds.map(function (D) { var T = D.T, d = [PSTAR[0] - T[0][3], PSTAR[1] - T[1][3], PSTAR[2] - T[2][3]]; return [T[0][0] * d[0] + T[1][0] * d[1] + T[2][0] * d[2], T[0][1] * d[0] + T[1][1] * d[1] + T[2][1] * d[2], T[0][2] * d[0] + T[1][2] * d[1] + T[2][2] * d[2]]; });   /* R^T (P - t): same point in each camera frame */
    function coordRow(items) { return '<div class="coords">' + items.map(function (it) { var c = 'rgb(' + it[1].map(function (x) { return Math.round(x * 255); }).join(',') + ')'; return '<span style="border-color:' + c + '"><i style="background:' + c + '"></i>P = (' + it[0].map(function (x) { return x.toFixed(2); }).join(', ') + ') <small>' + it[2] + '</small></span>'; }).join('') + '</div>'; }
    var SLOT = 1.1;   /* second card slot, in card widths, beside the RGB card (depth in step 2, pointmap from step 3) */
    Ds.forEach(function (D, v) { var first = n; var K = D.K, T = D.T, S = stageT[v], isW = v === nV - 1, f = 1, sU = isW ? WR_X : 0, sZ = isW ? WR_Z : 0, z0 = laneFit[v].z0, sc = laneFit[v].s;
      for (var vv = 0; vv < h; vv++) for (var u = 0; u < w; u++) { var i = vv * w + u, z = depth[v][i] / 1000; if (z <= 0) continue;
        var c = [(u+0.5 - K[0][2]) / K[0][0] * z, (vv+0.5 - K[1][2]) / K[1][1] * z, z], rp = [xyz[v][i*3]/1000,xyz[v][i*3+1]/1000,xyz[v][i*3+2]/1000]; if (!inWS(rp)) continue;
        var cl = [c[0] * sc, c[1] * sc, LC[v] + LANE_GAP[v] + (z - z0) * sc];   /* in-lane relief: compressed depth so each lane stays compact */
        var fp = xf(S, [(u + f * SLOT * w - K[0][2]) / K[0][0] * LC[v], (vv - K[1][2]) / K[1][1] * LC[v], LC[v]]); cl[0] += f * SLOT * w / K[0][0] * LC[v]; var cp = xf(S, cl);
        flat[n * 3] = fp[0]; flat[n * 3 + 1] = fp[1]; flat[n * 3 + 2] = fp[2]; camA[n * 3] = cp[0]; camA[n * 3 + 1] = cp[1]; camA[n * 3 + 2] = cp[2]; pos[n * 3] = rp[0]; pos[n * 3 + 1] = rp[1]; pos[n * 3 + 2] = rp[2];
        col[n * 3] = rgb[v][i * 3]; col[n * 3 + 1] = rgb[v][i * 3 + 1]; col[n * 3 + 2] = rgb[v][i * 3 + 2]; pmc[n * 3] = pmPix[v][i * 3]; pmc[n * 3 + 1] = pmPix[v][i * 3 + 1]; pmc[n * 3 + 2] = pmPix[v][i * 3 + 2];   /* a_pm = pointmap-card colour: the start colour of the lift */ vid[n] = v; n++; } ranges.push({first:first,count:n-first}); });
    function buf(a) { var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW); return b; }
    var B = { flat: buf(flat), cam: buf(camA), pos: buf(pos), rgb: buf(col), pm: buf(pmc), view: buf(vid) }, bDyn = gl.createBuffer(), qbuf = gl.createBuffer();
    // Final inputs live in the full-size panel, so the scene can show true camera poses.
    var showT = Ds.map(function (D) { return D.T; });
    var fixed = []; for (var gi = -10; gi <= 10; gi++) { var k = gi / 10, gc = 0.9; fixed.push(-1, k, 0, gc, gc, gc, 1, k, 0, gc, gc, gc, k, -1, 0, gc, gc, gc, k, 1, 0, gc, gc, gc); }
    var bFixed = buf(new Float32Array(fixed)), nFixed = fixed.length / 6;
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0);   /* transparent: the stage's CSS gradient shows through */
    var CAM_NEAR = { az: 150, el: 26, t: [0.3, 0, 0.35], d: 2.8, fov: 50 }, CAM_WIDE = { az: 180, el: 24, t: [0.1, -0.3, 0.75], d: 3.0, fov: 30 };   /* a little from above so the lifted cloud shows behind each card */   /* y offset: the yawed lanes extend further to screen-left */
    var camv = JSON.parse(JSON.stringify(CAM_WIDE)); root.__pmx = { st: st, cam: camv };   /* QA hook */
    function autoCam(u) { var k = 1 - ease((u - 0.88) / 0.09), lf = ease((u - 0.53) / 0.07), sw = ease((u - 0.56) / 0.09), wAz = CAM_WIDE.az - 18 * sw, wEl = CAM_WIDE.el + 12 * sw, zoom = 0.84 + 0.16 * lf, asp =   /* after the lift the lane view swings a little to the side: the clouds read as 3D */ canvas.width / Math.max(1, canvas.height), dFit = (2.35 + 0.4 * lf) / (Math.tan(CAM_WIDE.fov * Math.PI / 360) * asp);   /* row half-width: cards only before the lift, cards + cloud after */
      return { az: CAM_NEAR.az + (wAz - CAM_NEAR.az) * k, fov: CAM_NEAR.fov + (CAM_WIDE.fov - CAM_NEAR.fov) * k, el: CAM_NEAR.el + (wEl - CAM_NEAR.el) * k, t: [CAM_NEAR.t[0] + (CAM_WIDE.t[0] - 0.35 * sw - CAM_NEAR.t[0]) * k, (CAM_WIDE.t[1] + 0.2 * sw) * k, CAM_NEAR.t[2] + (CAM_WIDE.t[2] - 0.12 * lf - CAM_NEAR.t[2]) * k], d: CAM_NEAR.d + (Math.max(CAM_WIDE.d * zoom, dFit) * (1 + 0.12 * sw) - CAM_NEAR.d) * k }; }
    function phases(u) { return { depthCard: ease((u - 0.19) / 0.04), kIn: ease((u - 0.34) / 0.03), pmCard: ease((u - 0.37) / 0.08), kOut: ease((u - 0.45) / 0.02), merge: ease((u - 0.49) / 0.03), lift: ease((u - 0.53) / 0.07),
      /* pause 0.60-0.66 on the lifted scene, then step 4: extrinsics icon in, hold, out; cards fade; swing; grid; cards back; dolly; pause at the end */
      eIn: ease((u - 0.66) / 0.03), eOut: ease((u - 0.73) / 0.03), fadeOut: ease((u - 0.74) / 0.03), rot: ease((u - 0.78) / 0.12), grid: ease((u - 0.84) / 0.05), fadeIn: ease((u - 0.905) / 0.025), pm: 0, act: u < 0.18 ? 0 : u < 0.34 ? 1 : u < 0.78 ? 2 : 3 }; }
    function fit() { var dpr = Math.min(devicePixelRatio || 1, 2), cw = Math.floor(canvas.clientWidth * dpr), ch = Math.floor(canvas.clientHeight * dpr); if (cw && ch && (canvas.width !== cw || canvas.height !== ch)) { canvas.width = cw; canvas.height = ch; } }
    function draw() { if (!st.dirty) { st.dirty = true; requestAnimationFrame(render); } }
    function lines(arr, mvp) { gl.useProgram(L); gl.uniformMatrix4fv(ll.mvp, false, mvp); gl.bindBuffer(gl.ARRAY_BUFFER, bDyn); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(ll.pos); gl.vertexAttribPointer(ll.pos, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(ll.col); gl.vertexAttribPointer(ll.col, 3, gl.FLOAT, false, 24, 12); gl.drawArrays(gl.LINES, 0, arr.length / 6); gl.disableVertexAttribArray(ll.pos); gl.disableVertexAttribArray(ll.col); }
    var outl = [];
    function card(mvp, t, v, shiftU, shiftZ, alpha, T, cd, frame, cut) { if (alpha <= 0.01 || (cut != null && cut <= 0)) return; var D = Ds[v], cc = corners(D.K, hw, T || D.T, cd || CARD, shiftU, shiftZ), q = [];
      var oc = (frame || [0.72, 0.73, 0.78]).map(function (x) { return x + (1 - x) * (1 - alpha); }); if (alpha > 0.35) for (var i = 0; i < 4; i++) { var a = cc[i], b = cc[(i + 1) % 4]; outl.push(a[0], a[1], a[2], oc[0], oc[1], oc[2], b[0], b[1], b[2], oc[0], oc[1], oc[2]); }
      [[0, 0, 0], [1, 1, 0], [2, 1, 1], [0, 0, 0], [2, 1, 1], [3, 0, 1]].forEach(function (x) { q.push(cc[x[0]][0], cc[x[0]][1], cc[x[0]][2], x[1], x[2]); });
      gl.useProgram(Q); gl.uniformMatrix4fv(lq.mvp, false, mvp); gl.uniform1i(lq.tex, 0); gl.uniform1f(lq.alpha, alpha); gl.uniform1f(lq.cut, cut == null ? 1 : cut); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.bindBuffer(gl.ARRAY_BUFFER, qbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(q), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(lq.pos); gl.vertexAttribPointer(lq.pos, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(lq.uv); gl.vertexAttribPointer(lq.uv, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(lq.pos); gl.disableVertexAttribArray(lq.uv); }
    function render() { st.dirty = false; fit(); var W = canvas.width, H = canvas.height; if (!W || !H) return;
      var ph = phases(st.u); root.dataset.phase=ph.act;root.dataset.lift=ph.lift.toFixed(3);root.dataset.visibleViews=visibleViews.map(Number).join(',');root.dataset.colors=colorByCamera?'camera':'rgb';
      finalPanel.hidden=ph.rot<0.9;
      finalCards.forEach(function(card,v){card.hidden=!visibleViews[v];});
      var label = ph.act===0 ? 'RGB observations' : ph.act===1 ? 'RGB + Depth images'  : ph.act===2 ? (ph.lift > 0 ? 'RGB + camera-frame pointmaps · each camera has its own origin' : 'RGB + camera-frame pointmap · XYZ encoded as color') : (ph.rot < 1 ? 'Transforming camera-frame points into the robot-base frame' : 'RGB + robot-frame pointmap · one shared coordinate frame');
      representation.textContent=label;
      stepEls.forEach(function (b, i) { b.classList.toggle('on', i === ph.act); b.classList.toggle('done', i < ph.act); });
      if (root.dataset.act !== String(ph.act)) { root.dataset.act = ph.act; root.dispatchEvent(new CustomEvent('pmstep', { detail: ph.act })); }   /* page syncs the step's code */
      Array.prototype.forEach.call(flow.querySelectorAll('.arrow'), function (a, i) { a.classList.toggle('on', i < ph.act); });
      var captionKey = ph.act === 2 && ph.lift > 0.95 ? 'camera-origins' : ph.act === 3 && ph.rot < 1 ? 'aligning' : String(ph.act);
      if (capt.dataset.act !== captionKey) {
        capt.dataset.act = captionKey;
        var title = ACTS[ph.act].key, description = ACTS[ph.act].sub;
        if (captionKey === 'camera-origins') {
          title = 'RGB + camera-frame pointmaps.';
          description = 'Each pointmap measures XYZ from its own camera origin, (0, 0, 0). The three views use different coordinate frames.';
        } else if (captionKey === 'aligning') {
          title = 'Align the camera frames with the robot base.';
          description = 'Each camera’s extrinsics (R, t) transform its points into the shared robot-base frame.';
        }
        capt.innerHTML = '<b>' + title + '</b> <span>' + description + '</span>' + (ACTS[ph.act].eq ? '<code class="eq">' + ACTS[ph.act].eq + '</code>' : '');
      }
      eq.style.opacity = ph.act >= 1 ? 1 : 0; prog_.value = st.u;
      if (!st.userMoved) { var ac = autoCam(st.u); if (!st.orbit) camv.az += (ac.az - camv.az) * 0.3; camv.fov += (ac.fov - camv.fov) * 0.3; camv.el += (ac.el - camv.el) * 0.3; camv.d += (ac.d - camv.d) * 0.3; for (var q = 0; q < 3; q++) camv.t[q] += (ac.t[q] - camv.t[q]) * 0.3; }
      gl.viewport(0, 0, W, H); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); var mvp = mul(persp((camv.fov || 50) * Math.PI / 180, W / H, 0.02, 60), view(camv));
      if (ph.grid > 0.01) { var gcol = 1 - 0.1 * ph.grid, garr = new Float32Array(fixed); for (var gi2 = 3; gi2 < garr.length; gi2 += 6) { garr[gi2] = garr[gi2 + 1] = garr[gi2 + 2] = gcol; } gl.bindBuffer(gl.ARRAY_BUFFER, bFixed); gl.bufferData(gl.ARRAY_BUFFER, garr, gl.DYNAMIC_DRAW); gl.useProgram(L); gl.uniformMatrix4fv(ll.mvp, false, mvp); gl.bindBuffer(gl.ARRAY_BUFFER, bFixed); gl.enableVertexAttribArray(ll.pos); gl.vertexAttribPointer(ll.pos, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(ll.col); gl.vertexAttribPointer(ll.col, 3, gl.FLOAT, false, 24, 12); gl.drawArrays(gl.LINES, 0, nFixed); gl.disableVertexAttribArray(ll.pos); gl.disableVertexAttribArray(ll.col); }
      /* frustums at the true camera poses + a tether to the staged cloud while it is detached */
      var camA = Math.max(0, Math.min(1, 1 - ph.fadeOut + ph.fadeIn));   /* cards + frustums: out before the swing, back once the clouds have settled */   /* lane pose is a mirror image; cards/frustums fade out, the pose switches unseen, they fade back in at the real cameras */
      var fr = [], poseNow = Ds.map(function (D, v) { return ph.rot < 0.5 ? stageT[v] : showT[v]; });
      if (camA > 0.05) Ds.forEach(function (D, v) { if(!visibleViews[v])return; var Tn = poseNow[v], sU = 0, sZ = 0, o = xf(Tn, [0, 0, 0]), cc = corners(D.K, hw, Tn, ph.rot < 0.5 ? LC[v] : CARD, sU + (ph.rot < 0.5 ? (1) * (SLOT - 0.5) * ph.merge : 0), sZ + (ph.rot < 0.5 ? -0.02 * LC[v] / CARD * ph.merge : 0)), c = VIEW_COL[v].map(function (x) { return x + (1 - x) * (1 - camA); });
        for (var i = 0; i < 4; i++) { var a = cc[i], b = cc[(i + 1) % 4]; fr.push(o[0], o[1], o[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], c[0], c[1], c[2]); } });
      if (ph.rot > 0.5 && visibleViews[nV-1]) { var tw = xf(Ds[nV - 1].T, [0, 0, 0]), sw = xf(poseNow[nV - 1], [0, 0, 0]), c3 = VIEW_COL[nV - 1].map(function (x) { return x + (1 - x) * (1 - camA); }); fr.push(sw[0], sw[1], sw[2], c3[0], c3[1], c3[2], tw[0], tw[1], tw[2], c3[0], c3[1], c3[2]); }
      /* coordinate origins (SVG overlay, always on top): one triad per camera from step 3 (each pointmap is measured from its own camera), the robot-base triad from step 4 (one shared origin) */
      var triads = [];
      if (ph.lift > 0.95 && ph.rot === 0) Ds.forEach(function(D,v) {
        if (!visibleViews[v]) return;
        // Apply the very same display translation as the staged cloud to P_cam=(0,0,0).
        var origin = xf(stageT[v], [SLOT*w/D.K[0][0]*LC[v], 0, LC[v]+LANE_GAP[v]-laneFit[v].z0*laneFit[v].s]);
        var T = stageT[v].map(function(row) { return row.slice(); });
        for (var a=0;a<3;a++) T[a][3]=origin[a];
        var color = 'rgb('+VIEW_COL[v].map(function(c){return Math.round(c*255);}).join(',')+')';
        triads.push({T:T,len:0.27,w:3,op:1,color:color,label:PMX.labels[v],detail:'Camera origin (0, 0, 0)',kind:'camera',view:v});
      });
      if(ph.rot>0.9) triads.push({T:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],len:0.3,w:3,op:1,color:'#252536',label:'Robot base',detail:'Shared origin (0, 0, 0)',kind:'robot'});
      lines(new Float32Array(fr), mvp);
      function scr(o) { var cx = mvp[0] * o[0] + mvp[4] * o[1] + mvp[8] * o[2] + mvp[12], cy = mvp[1] * o[0] + mvp[5] * o[1] + mvp[9] * o[2] + mvp[13], cw = mvp[3] * o[0] + mvp[7] * o[1] + mvp[11] * o[2] + mvp[15]; return cw <= 0 ? null : [(cx / cw + 1) / 2 * canvas.clientWidth, (1 - cy / cw) / 2 * canvas.clientHeight]; }
      var AXC = ['#e03131', '#2f9e44', '#1c7ed6'], svgs = '';
      triads.forEach(function (tr) {
        var so = scr(xf(tr.T, [0,0,0])); if (!so) return;
        svgs += '<g data-origin="'+tr.kind+'">';
        for (var k=0;k<3;k++) {
          var se=scr(xf(tr.T,[k===0?tr.len:0,k===1?tr.len:0,k===2?tr.len:0])); if(!se)continue;
          svgs += '<line x1="'+so[0]+'" y1="'+so[1]+'" x2="'+se[0]+'" y2="'+se[1]+'" stroke="'+AXC[k]+'" stroke-width="3" stroke-linecap="round"/>';
          svgs += '<text x="'+(se[0]+5)+'" y="'+(se[1]-5)+'" fill="'+AXC[k]+'" font-size="11" font-weight="700" stroke="white" stroke-width="3" paint-order="stroke">'+['X','Y','Z'][k]+'</text>';
        }
        /* compact origin tag next to the dot (camera: to its left, clear of the X/Y/Z arms; robot base: below) */
        var txt = tr.kind === 'camera' ? '(0, 0, 0)' : 'robot base \u00b7 (0, 0, 0)', bw = 6.9 * txt.length + 20, bh = 22;   /* the colour (legend above) names the camera */
        var bx = tr.kind === 'camera' ? so[0] - bw - 8 : so[0] - bw / 2, by = tr.kind === 'camera' ? so[1] + 8 : so[1] + 14;   /* lower-left of the dot: X points right, Y down, Z away */
        bx = Math.max(6, Math.min(canvas.clientWidth - bw - 6, bx)); by = Math.max(6, Math.min(canvas.clientHeight - bh - 6, by));
        svgs += '<circle cx="'+so[0]+'" cy="'+so[1]+'" r="5.5" fill="'+tr.color+'" stroke="white" stroke-width="2"/>';
        svgs += '<rect x="'+bx+'" y="'+by+'" width="'+bw+'" height="'+bh+'" rx="12" fill="white" fill-opacity="0.95" stroke="'+tr.color+'" stroke-width="1.5"/>';
        svgs += '<text x="'+(bx+11)+'" y="'+(by+16.5)+'" fill="'+tr.color+'" font-size="12" font-weight="700">'+txt+'</text></g>';
      });
      if (svg.innerHTML !== svgs) svg.innerHTML = svgs;
      /* points */
      gl.useProgram(P); gl.uniformMatrix4fv(lp.u_mvp, false, mvp); gl.uniform1f(lp.u_lift, ph.lift); gl.uniform1f(lp.u_bycam,colorByCamera?1:0); gl.uniform1f(lp.u_rot, ph.rot); gl.uniform1f(lp.u_pmcol, ph.pm); gl.uniform1f(lp.u_psize, 6.0 * CAM_NEAR.d * (H / 600) * Math.min(devicePixelRatio || 1, 2));
      [['flat', 'a_flat', 3, gl.FLOAT, false], ['cam', 'a_cam', 3, gl.FLOAT, false], ['pos', 'a_pos', 3, gl.FLOAT, false], ['rgb', 'a_rgb', 3, gl.UNSIGNED_BYTE, true], ['pm', 'a_pm', 3, gl.UNSIGNED_BYTE, true], ['view', 'a_view', 1, gl.FLOAT, false]].forEach(function (a) { gl.bindBuffer(gl.ARRAY_BUFFER, B[a[0]]); gl.enableVertexAttribArray(lp[a[1]]); gl.vertexAttribPointer(lp[a[1]], a[2], a[3], a[4], 0, 0); });
      if (ph.lift > 0.01) ranges.forEach(function(range,v){if(visibleViews[v])gl.drawArrays(gl.POINTS,range.first,range.count);}); ['a_flat', 'a_cam', 'a_pos', 'a_rgb', 'a_pm', 'a_view'].forEach(function (a) { gl.disableVertexAttribArray(lp[a]); });
      /* cards, stacked like section1: pointmap (back, act 3+) → depth (middle, act 2+) → RGB (front, fades as points lift) */
      gl.depthMask(false);
      var sweep = [];
      Ds.forEach(function (D, v) { if(!visibleViews[v])return; var Tn = poseNow[v], sU = 0, sZ = 0, cd = ph.rot < 0.5 ? LC[v] : CARD, k = cd / CARD, f = 1, lane = ph.rot < 0.5 ? 1 : 0;   /* wrist pose is rolled 180°: flip its in-plane offsets so the stack reads the same way */
        if(!lane)return; // Final RGB/pointmap pairs are displayed at full size below the scene.
        var lx = lane ? SLOT : OFF_X, lz = lane ? 0 : OFF_Z * k;   /* one slot beside the RGB card: depth in step 2, the pointmap takes its place in step 3 */
        card(mvp, texD[v], v, f * (sU + lx), lz, ph.depthCard * (1 - ph.lift) * camA, Tn, cd);   /* only the in-plane shift flips; depth offset is along the optical axis */
        card(mvp, lane ? texPM[v] : texBase[v], v, f * (sU + lx), lz, lane ? camA : ph.pmCard * camA, Tn, cd, null, lane ? ph.pmCard : 1);   /* the pointmap card stays, stacked behind the RGB card, while its points lift out */   /* step 3a: a sweep converts the depth card into the pointmap card column by column; 3b: that card lifts into points */
        if (lane && ph.eIn > 0 && ph.eOut < 1) { var ew = 0.3 * w; rect(mvp, texE, v, Tn, cd, f * (lx - 0.5) * 0.5, f * (-1.25 + 0.3 * ph.eIn), ew, ew * KH / KW, ph.eIn * (1 - ph.eOut), f < 0); }   /* extrinsics icon: hold above the lane before the swing */
        if (lane && ph.kIn > 0 && ph.kOut < 1) { var kx = f * (sU + lx) + f * (ph.pmCard - 0.5) * 0.9, ky = f * (-1.05 + 0.3 * ph.kIn), kw = 0.2 * w, kh = kw * KH / KW;   /* f: the wrist's image plane is rolled 180°, so 'above' flips too */ rect(mvp, texK[v], v, Tn, cd, kx, ky, kw, kh, ph.kIn * (1 - ph.kOut), f < 0); }   /* the intrinsics card: appears above the depth card and sweeps across it as the pixels are converted */
        if (lane && ph.pmCard > 0 && ph.pmCard < 1) { var sc = corners(D.K, hw, Tn, cd, f * (sU + lx), lz), cu = f > 0 ? ph.pmCard : 1 - ph.pmCard, o = xf(Tn, [0, 0, 0]), SW = [0.42, 0.2, 0.85];   /* the sweep line on the card + rays from the camera origin through it: K maps pixels to rays, depth fixes the point */
          var top = [sc[0][0] + (sc[1][0] - sc[0][0]) * cu, sc[0][1] + (sc[1][1] - sc[0][1]) * cu, sc[0][2] + (sc[1][2] - sc[0][2]) * cu], bot = [sc[3][0] + (sc[2][0] - sc[3][0]) * cu, sc[3][1] + (sc[2][1] - sc[3][1]) * cu, sc[3][2] + (sc[2][2] - sc[3][2]) * cu];
          sweep.push(top[0], top[1], top[2], SW[0], SW[1], SW[2], bot[0], bot[1], bot[2], SW[0], SW[1], SW[2]);
          for (var r = 0; r <= 4; r++) { var q = r / 4, e = [top[0] + (bot[0] - top[0]) * q, top[1] + (bot[1] - top[1]) * q, top[2] + (bot[2] - top[2]) * q]; sweep.push(o[0], o[1], o[2], SW[0], SW[1], SW[2], e[0], e[1], e[2], SW[0], SW[1], SW[2]); } }
        var rx = lane ? f * (lx - 0.5) * ph.merge : 0, rz = lane ? -0.02 * k * ph.merge : 0;   /* the RGB card slides over the pointmap card: pointmap + RGB → coloured 3D points */
        card(mvp, texRGB[v], v, sU + rx, sZ * k + rz, camA, Tn, cd, VIEW_COL[v]); });
      if (outl.length) { gl.depthMask(false); lines(new Float32Array(outl), mvp); gl.depthMask(true); outl = []; }
      if (sweep.length) { gl.disable(gl.DEPTH_TEST); lines(new Float32Array(sweep), mvp); gl.enable(gl.DEPTH_TEST); }
      gl.depthMask(true); }
    (function tick(now) { requestAnimationFrame(tick); var dt=st.last?Math.min(now-st.last,100):0;st.last=now;if(!st.visible)return;
      if(st.playing){st.u+=dt/LOOP;if(st.stopAt!=null && st.u>=st.stopAt){st.u=st.stopAt;st.playing=false;play.textContent='Play';}else st.u%=1;}
      if(st.orbit)camv.az+=dt*0.008;
      if(st.playing || st.orbit || !st.userMoved)draw();
    })(performance.now());
    play.onclick=function(){st.stopAt=null;st.playing=!st.playing;play.textContent=st.playing?'Pause':'Play';};
    prog_.oninput=function(){st.playing=false;st.stopAt=null;play.textContent='Play';st.u=+prog_.value;draw();};
    orbit.onclick=function(){st.orbit=!st.orbit;orbit.classList.toggle('on',st.orbit);};
    reset.onclick=function(){st.userMoved=false;st.orbit=false;orbit.classList.remove('on');draw();};
    new IntersectionObserver(function(entries){st.visible=entries[0].isIntersecting;if(st.visible)draw();},{rootMargin:'80px'}).observe(root);
    var drag = null;
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('pointerdown', function (e) { st.userMoved = true; drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', function (e) { if (!drag) return; var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { var a = camAxes(camv), k = camv.d * 0.0015; for (var i = 0; i < 3; i++) camv.t[i] += (-a.r[i] * dx + a.u[i] * dy) * k; } else { camv.az -= dx * 0.3; camv.el = Math.max(-89, Math.min(89, camv.el + dy * 0.3)); } draw(); });
    canvas.addEventListener('pointerup', function () { drag = null; }); canvas.addEventListener('pointercancel', function () { drag = null; });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); st.userMoved = true; camv.d = Math.max(0.1, Math.min(30, camv.d * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
    addEventListener('resize', draw); draw();
    return { state: st };
  }
  window.PMPointmapBuilder = { mount: mount };
})();
