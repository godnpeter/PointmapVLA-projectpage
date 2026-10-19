/* pm-stage.js — one RoboCasa frame as image cards: the RGB card at each camera → a depth card beside it → recoloured into a
   camera-frame pointmap → the card flies (camera extrinsics) to the robot base and recolours into the robot-base frame →
   the three cards sit side by side at the robot while the recorded episode plays. Raw WebGL, works from file://.
   window.PMStage.mount(root, PMX, ACTION, {mode:'build'|'problem', star:[x,y,z]})
   PMX: {cams, labels, data:{cam:{rgb_flat, depth(u16 mm), xyz(i16 mm, robot base), K, T(base<-cam), w, h}}}
   ACTION: {path, now, grasp, release, keyframe, keyframes, episode}; episode clouds come from static/episodes/<id>/ (pm-cards format). */
(function () {
  'use strict';
  var VS2 = 'attribute vec3 a_pos;attribute vec3 a_rgb;uniform mat4 u_mvp;uniform float u_psize,u_alpha,u_grey;varying vec3 v_col;varying float v_a;' +   /* u_grey: light-grey version that keeps the shading */
    'void main(){vec3 p=a_pos*0.001;gl_Position=u_mvp*vec4(p,1.0);gl_PointSize=clamp(u_psize/gl_Position.w,1.5,7.0);v_col=mix(a_rgb,vec3(0.6+0.34*dot(a_rgb,vec3(0.299,0.587,0.114))),u_grey);v_a=u_alpha;}';
  var FS = 'precision mediump float;varying vec3 v_col;varying float v_a;uniform float u_round;void main(){vec2 c=gl_PointCoord-0.5;if(u_round>0.5&&dot(c,c)>0.25)discard;gl_FragColor=vec4(v_col,v_a);}';
  var VSL = 'attribute vec3 a_pos;attribute vec3 a_col;uniform mat4 u_mvp;varying vec3 v_col;void main(){gl_Position=u_mvp*vec4(a_pos,1.0);v_col=a_col;}';
  var FSL = 'precision mediump float;varying vec3 v_col;uniform float u_alpha;void main(){gl_FragColor=vec4(v_col,u_alpha);}';
  var VST = 'attribute vec3 a_pos;attribute vec2 a_uv;uniform mat4 u_mvp;varying vec2 v_uv;void main(){gl_Position=u_mvp*vec4(a_pos,1.0);v_uv=a_uv;}';
  var FST = 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_t0,u_t1;uniform float u_mix,u_alpha;void main(){vec3 a=texture2D(u_t0,v_uv).rgb,b=texture2D(u_t1,v_uv).rgb;gl_FragColor=vec4(mix(a,b,u_mix),u_alpha);}';
  var VIEW_COL = [[0.18, 0.49, 0.88], [0.07, 0.65, 0.58], [0.84, 0.45, 0.10]], AXC = ['#e03131', '#2f9e44', '#1c7ed6'], PATH = [0.78, 0.12, 0.6];
  var CARD = 0.5, FOV = 45, OFF = [[-0.22, 0.30], [0.22, 0.18], [0, 0.45]], POP = [[-0.3, -0.04], [0.3, -0.04], [0, 0.15]];   /* card width (m); card offsets from its camera / pop-out offsets, in viewer right/up */
  var ACTS = [
    { node: 'RGB', key: 'A colour per pixel.', sub: 'Nothing about distance.' },
    { node: 'RGB + depth', key: 'A distance per pixel.', sub: 'A second image next to each RGB image: how far every pixel is from its camera.' },
    { node: 'Camera frame', key: 'With the intrinsics, distance becomes 3D coordinates in each camera’s own frame.', sub: 'One mug, three different (x, y, z).' },
    { node: 'Robot-base frame', key: 'With the extrinsics, every pointmap moves into the robot-base frame.', sub: 'One mug, one (x, y, z), whichever camera saw it.' },
    { node: 'Robot acts', key: 'The robot acts in this same frame.', sub: 'What it observes and what it does now share one set of coordinates.' }];
  var ARROWS = ['+ depth', '+ intrinsics', '+ extrinsics', 'same frame'];
  /* encoder fusion glyph (paper overview, Stage 1): RGB → Vision encoder (grey), pointmap → Pointmap encoder (purple), features added (⊕) */
  /* encoder glyphs, as in the paper's overview figure (Stage 1). First view: Vision Encoder (grey) and Pointmap Encoder (purple), straight up,
     joined by a horizontal bar with ⊕, then up into the token row. Other views: the same pair abbreviated as one grey→purple trapezoid. */
  var FUSE_SVG = '<svg viewBox="0 0 160 96" aria-hidden="true"><path class="ln" d="M40 56 V32 H71 M89 32 H120 V56"/>' +
    '<circle class="plus" cx="80" cy="32" r="9"/><path class="pl" d="M71 32 H89 M80 23 V41"/>' +
    '<polygon class="te rgb" points="2,94 78,94 66,56 14,56"/><polygon class="te pmt" points="82,94 158,94 146,56 94,56"/>' +
    '<text class="g" x="40" y="72">RGB</text><text class="g" x="40" y="86">Encoder</text><text class="p" x="120" y="72">Pointmap</text><text class="p" x="120" y="86">Encoder</text></svg>';
  var FUSE_C_SVG = '<svg viewBox="0 0 100 60" aria-hidden="true"><defs><linearGradient id="pvg" x1="0" x2="1"><stop offset="0" stop-color="#ececf1"/><stop offset="1" stop-color="#e2d6ff"/></linearGradient></defs>' +
    '<polygon class="te c" points="2,58 98,58 86,22 14,22" fill="url(#pvg)"/></svg>';
  var VIS_SVG = '<svg viewBox="0 0 100 60" aria-hidden="true"><polygon class="te rgb" points="2,58 98,58 86,22 14,22"/><text class="g enc2" x="50" y="38">RGB</text><text class="g enc2" x="50" y="52">Encoder</text></svg>';
  var PM_SHIFT = [-0.3, -0.5], FR_WD = 0.15, FR_D = 0.22, THINK = 1600, CHUNK_MS = 2400, N_CHUNKS = 11, CHUNK = 28, CHUNK_COL = [0.43, 0.16, 0.85];   /* paired (section 1): the action chunk = the next CHUNK recorded steps ahead of the gripper */
  var B = [0.10, 0.26, 0.44, 0.62], LOOP = 36000, FPS = 6, PMLO = [-0.6, -0.9, -0.5], PMHI = [0.9, 0.9, 1.2];   /* robot-base metres → colour, same as build/export_pm_thumbs.py */

  function el(t, c, x) { var e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }
  function prog(gl, vs, fs) { function sh(t, s) { var o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; }
    var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); return p; }
  function b64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function mul(a, b) { var o = new Float32Array(16); for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) { var s = 0; for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(f, a, n, fa) { var t = 1 / Math.tan(f / 2); return new Float32Array([t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]); }
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function add(a, b, s) { s = s == null ? 1 : s; return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s]; }
  function camAxes(c) { var az = c.az * Math.PI / 180, e = c.el * Math.PI / 180, eye = [c.t[0] + c.d * Math.cos(e) * Math.cos(az), c.t[1] + c.d * Math.cos(e) * Math.sin(az), c.t[2] + c.d * Math.sin(e)];
    var f = norm([c.t[0] - eye[0], c.t[1] - eye[1], c.t[2] - eye[2]]), r = norm(cross(f, [0, 0, 1])), u = cross(r, f); return { eye: eye, f: f, r: r, u: u }; }
  function view(c) { var a = camAxes(c), e = a.eye; return new Float32Array([a.r[0], a.u[0], -a.f[0], 0, a.r[1], a.u[1], -a.f[1], 0, a.r[2], a.u[2], -a.f[2], 0, -dot(a.r, e), -dot(a.u, e), dot(a.f, e), 1]); }
  function xf(T, p) { return [T[0][0] * p[0] + T[0][1] * p[1] + T[0][2] * p[2] + T[0][3], T[1][0] * p[0] + T[1][1] * p[1] + T[1][2] * p[2] + T[1][3], T[2][0] * p[0] + T[2][1] * p[1] + T[2][2] * p[2] + T[2][3]]; }
  function inv(T, p) { var d = [p[0] - T[0][3], p[1] - T[1][3], p[2] - T[2][3]]; return [T[0][0] * d[0] + T[1][0] * d[1] + T[2][0] * d[2], T[0][1] * d[0] + T[1][1] * d[1] + T[2][1] * d[2], T[0][2] * d[0] + T[1][2] * d[1] + T[2][2] * d[2]]; }
  function ease(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
  function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function lerpCam(a, b, t) { return { az: a.az + (b.az - a.az) * t, el: a.el + (b.el - a.el) * t, d: a.d + (b.d - a.d) * t, t: mix3(a.t, b.t, t) }; }
  function rgbs(c) { return 'rgb(' + c.map(function (x) { return Math.round(x * 255); }).join(',') + ')'; }
  function f2(x) { return (x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
  /* purple pixel / 3D-point markers (section 01 explore); k = svg units per css px, live = picked by the viewer (stronger) */
  function mark2(x, y, k, live) { var r = (live ? 6 : 5) * k, o = live ? 1 : 0.8, c = 'cx="' + x + '" cy="' + y + '"';
    return '<circle ' + c + ' r="' + r + '" fill="none" stroke="#fff" stroke-width="' + 4 * k + '" opacity="' + o + '"/><circle ' + c + ' r="' + r + '" fill="' + (live ? 'rgba(124,58,237,.25)' : 'none') + '" stroke="#7c3aed" stroke-width="' + (live ? 2 : 1.6) * k + '" opacity="' + o + '"/>' +
      '<circle ' + c + ' r="' + 1.6 * k + '" fill="#7c3aed" opacity="' + o + '"/>'; }
  function mark3(s, live) { var c = 'cx="' + s[0].toFixed(1) + '" cy="' + s[1].toFixed(1) + '"', o = live ? 1 : 0.75, r = live ? 7.5 : 6;
    return (live ? '<circle ' + c + ' r="15" fill="none" stroke="#7c3aed" stroke-width="1.5" opacity=".35"/>' : '') + '<circle ' + c + ' r="' + r + '" fill="none" stroke="#fff" stroke-width="4.5" opacity="' + o + '"/>' +
      '<circle ' + c + ' r="' + r + '" fill="rgba(124,58,237,' + (live ? 0.3 : 0.15) + ')" stroke="#7c3aed" stroke-width="' + (live ? 2.4 : 1.8) + '" opacity="' + o + '"/><circle ' + c + ' r="2.2" fill="#7c3aed" opacity="' + o + '"/>'; }
  /* binary assets (open-source build): <name>.bin.gz = gzip of the raw point buffers; fetched and inflated in the browser
     (needs http(s), not file://, and DecompressionStream). The base64 .js form is still accepted. */
  function loadBin(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + url);
    if (!/\.gz$/.test(url)) return r.arrayBuffer(); if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot inflate ' + url);
    return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(); }, function (e) { throw new Error((location.protocol === 'file:' ? 'serve the page over http (e.g. python -m http.server): ' : '') + e.message); }); }
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

  function mount(root, PMX, ACT, opts) {
    opts = opts || {}; var build = opts.mode !== 'problem', paired = !build && opts.paired, withPM = paired && opts.pm, geo = paired && opts.geo, motion = paired && opts.motionTitle;   /* motion: section 01, the arrow under the action chunk leads into robot motion */   /* geo (candidate, 2026-10-19): mug in image -> mug in 3D, inferred (dashed) vs provided (solid + xyz) */   /* withPM: section 2, the VLA is also given pointmaps */
    var cams = PMX.cams, nV = cams.length, Ds = cams.map(function (c) { return PMX.data[c]; }), w = Ds[0].w, h = Ds[0].h, N = w * h;
    var depth = Ds.map(function (D) { return new Uint16Array(b64(D.depth).buffer); }), xyz = Ds.map(function (D) { return new Int16Array(b64(D.xyz).buffer); }), rgb = Ds.map(function (D) { return b64(D.rgb_flat); });
    root.classList.add('pms'); root.classList.add(build ? 'build' : 'problem');
    /* ---- DOM ---- */
    var steps = el('div', 'pmx-steps pms-steps'), flow = el('div', 'flow'), capt = el('div', 'capt'), nodes = [], arrows = [];
    ACTS.forEach(function (a, i) { var n = el('button', 'node'); n.innerHTML = '<i>' + (i + 1) + '</i><span>' + a.node + '</span>'; n.onclick = function () { st.u = B[i - 1] || 0; if (i) st.u += 0.001; draw(); }; flow.appendChild(n); nodes.push(n);
      if (i < ACTS.length - 1) { var ar = el('div', 'arrow'); ar.innerHTML = '<em>' + ARROWS[i] + '</em><b></b>'; flow.appendChild(ar); arrows.push(ar); } });
    steps.appendChild(flow); steps.appendChild(capt);
    var stage = el('div', 'pms-stage'), canvas = el('canvas'), svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), pills = el('div', 'pms-pills'), legend = el('div', 'pms-legend'), msg = el('div', 'msg');
    svg.setAttribute('class', 'pms-svg'); legend.innerHTML = PMX.labels.map(function (l, i) { return '<span><i style="background:' + rgbs(VIEW_COL[i]) + '"></i>' + l + '</span>'; }).join('') + '<span><i style="background:' + rgbs(PATH) + '"></i>gripper path</span>';
    var bar = el('div', 'pms-bar'), play = el('button', null, '❚❚'), prog_ = document.createElement('input'), orbit = el('button', null, 'Auto-orbit'), reset = el('button', null, 'Reset view');
    prog_.type = 'range'; prog_.min = 0; prog_.max = 1; prog_.step = 0.001; prog_.value = 0; [play, prog_, el('span', 'sep'), orbit, reset].forEach(function (e) { bar.appendChild(e); });
    stage.appendChild(canvas); stage.appendChild(svg); stage.appendChild(pills); stage.appendChild(legend); stage.appendChild(msg); stage.appendChild(bar);
    /* strip: RGB row (always) + pointmap row (build only), one column per camera */
    var strip = el('div', 'pms-strip'), stripImgs = [], stripPM = [], stripPMwrap = [];
    strip.appendChild(el('span', 'rl', 'RGB')); PMX.labels.forEach(function (l, v) { var c = el('div', 'col'); var im = el('img'); im.src = Ds[v].rgb; im.style.borderColor = rgbs(VIEW_COL[v]); c.appendChild(im); stripImgs.push(im); strip.appendChild(c); });
    if (build) { strip.appendChild(el('span', 'rl', 'Pointmap')); PMX.labels.forEach(function (l, v) { var c = el('div', 'col'); var wrap = el('div', 'pmw'); var im = el('img'); im.style.borderColor = rgbs(VIEW_COL[v]); var none = el('div', 'none', 'not given'); wrap.appendChild(im); wrap.appendChild(none); c.appendChild(wrap); stripPM.push(im); stripPMwrap.push(wrap); strip.appendChild(c); }); }
    strip.appendChild(el('span', 'rl', '')); PMX.labels.forEach(function (l, v) { var c = el('div', 'col cap'); c.innerHTML = '<i style="background:' + rgbs(VIEW_COL[v]) + '"></i>' + l; strip.appendChild(c); });
    if (build) { root.appendChild(steps); root.appendChild(stage); root.appendChild(strip); } else { root.appendChild(strip); root.appendChild(stage); }
    var st = { u: 0, playing: true, orbit: !build, dirty: false, last: 0, userMoved: false, visible: true, frames: null, fi: -1, ftime: 0, fcur: 0, off: { az: 0, el: 0 } };
    root.__pms = st;
    var pairedImage, pairedSVG, pairedView, pairFrame = '', activeView = 0, pmSvg0 = null, geoSvg = null;
    /* pixel -> 3D (section 01, PointmapVLA side): a pixel of a pointmap (or its RGB image) and its robot-base point, same purple.
       pick = the explored pixel {v, gx, gy} on the exact-XYZ grid (xyz.js, S px stride); null = the subtle default pixel (the mug, left camera) */
    var pmSvgs = [], pickT = [], pick = null, tip = null, xyzEP = null, PS = 4, PG = Math.round(w / PS), hov3 = null, touchPick = false, cards3 = [];   /* hov3: pointer over the 3D view, resolved in render */
    if (paired) {
      root.classList.add('paired'); root.replaceChildren();
      /* section 1 framing (2026-10-18): input = the RGB images of every camera; output = 3D actions in the robot frame. The scene is
         drawn faint: it is the geometry the VLA must infer from pixels, never given to it. */
      var left = el('div', 'paired-left'), right = el('div', 'paired-right'), rgbCol = el('div', 'paired-rgbs');
      var tl = el('h3', 'paired-title'), tr = el('h3', 'paired-title'); tl.innerHTML = withPM ? '<span>Input</span> RGB images + pointmaps + instruction' : '<span>Input</span> RGB images + instruction'; tr.innerHTML = motion ? '<span class="mv">Robot executes the actions</span>' : '<span>Output</span> 3D actions <small>robot frame, metres</small>'; if (motion) tr.classList.add('motion'); right.appendChild(tr);
      /* one plain sentence under the output title (user 2026-10-19): is the 3D scene given to the model or not */
      var note = el('p', 'paired-note'); if (!motion) right.appendChild(note); note.innerHTML = (withPM ? '<b>3D is given.</b> PointmapVLA receives every pixel\'s 3D position in the robot-base frame as input.'
                                                       : '<b>3D is implicit.</b> The VLA never receives this scene; it must infer where things are from RGB pixels.');
      pairedImage = []; pairedSVG = []; var pairedPM = [], patchHL = []; pmSvgs = []; pickT = [];
      Ds.forEach(function (D, v) { var box = el('div', 'paired-rgb'), im = el('img'), sv0 = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), lb = el('span', 'paired-cam', PMX.labels[v]);
        im.alt = 'Recorded RGB observation, ' + PMX.labels[v]; im.src = D.rgb; sv0.setAttribute('viewBox', '0 0 ' + w + ' ' + h); lb.style.background = rgbs(VIEW_COL[v]);
        box.appendChild(im); box.appendChild(sv0); box.appendChild(lb); pairedImage.push(im); pairedSVG.push(sv0);
        if (withPM) { var grp = el('div', 'pv-grp'), fus = el('div', 'pv-fuse'), th = el('div', 'pv-thumbs'), pbx = el('div', 'paired-rgb pm'), pim = el('img'), plb = el('span', 'paired-cam', 'pointmap');
          pim.alt = 'Robot-frame pointmap, ' + PMX.labels[v]; plb.style.background = rgbs(VIEW_COL[v]); lb.textContent = PMX.labels[v].replace(' camera', '');
          var psv = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); psv.setAttribute('viewBox', '0 0 ' + w + ' ' + h); pmSvgs.push(psv); if (geo && v === 0) pmSvg0 = psv;
          pbx.appendChild(pim); pbx.appendChild(plb); pbx.appendChild(psv); pickT.push([box, v], [pbx, v]); grp.appendChild(el('div', 'pv-stem'));
          /* every camera: its own Vision encoder (RGB) + Pointmap encoder, patch features added (⊕); labels only on the first */
          if (v === 0) { grp.classList.add('d'); fus.innerHTML = FUSE_SVG; th.appendChild(box); th.appendChild(pbx);
          }   /* (2a's patch grid + walking patch removed 2026-10-18: the fusion subsection below shows token-wise addition) */
          else { grp.classList.add('c'); fus.innerHTML = FUSE_C_SVG; th.className = 'pv-stack'; th.appendChild(pbx); th.appendChild(box); }
          grp.appendChild(fus); grp.appendChild(th); rgbCol.appendChild(grp); pairedPM.push(pim); }
        else { var g1 = el('div', 'pv-grp c'), f1 = el('div', 'pv-fuse'); f1.innerHTML = v === 0 ? VIS_SVG : VIS_SVG.replace(/<text[^>]*>[^<]*<\/text>/g, '');
          g1.appendChild(el('div', 'pv-stem')); g1.appendChild(f1); var t1 = el('div', 'pv-one'); t1.appendChild(box); g1.appendChild(t1); rgbCol.appendChild(g1); } });
      right.appendChild(stage);
      var mid = el('div', 'paired-mid'), ins = el('div', 'pv-ins'), vbox = el('div', 'pv-vla'), chunkEl = el('div', 'pv-chunk'), chipEls = [];
      ins.innerHTML = '<b>Instruction</b><small>“' + PMX.instruction + '”</small>'; vbox.innerHTML = '<b>VLA</b><small>vision-language-action model</small>';
      chunkEl.innerHTML = geo ? '<b><em class="out">Output</em> Action chunk</b><span></span>' : '<b>Action chunk</b><span></span>'; ['a₁', 'a₂', 'a₃', '…', 'aₖ'].forEach(function (t) { var c = el('i', null, t); chunkEl.querySelector('span').appendChild(c); chipEls.push(c); });
      /* left half, bottom → top: inputs (three RGB images in a row + instruction) → VLA layer → action chunk layer (→ 3D actions on the right) */
      var inRow = el('div', 'pv-inrow'), inBox = el('div', 'pv-inputs'); inRow.appendChild(rgbCol); inRow.appendChild(ins); inBox.appendChild(tl); inBox.appendChild(inRow);
      var encRow = null;
      if (true) {   /* model block in the paper's style (both sections): optional token rows (opts.tok = 'both' | 'bottom' | 'none'), inputs plugging in from below */
        var TOK = opts.tok || 'bottom'; root.classList.add('vla'); if (!withPM) inBox.classList.add('rgbonly'); else root.classList.add('pmv');   /* grey tokens/instruction at rest; PointmapVLA keeps its RGB+pointmap tokens lavender */
        inBox.classList.add('pm'); vbox.classList.add('pm'); var insCol = el('div', 'pv-inscol'); insCol.appendChild(el('div', 'pv-stem')); inRow.appendChild(insCol); insCol.appendChild(ins);
        function tokRow(cls) { var r = el('div', 'pv-tok ' + cls); for (var ti = 0; ti < 14; ti++) r.appendChild(el('i', cls === 'in' ? (ti < 10 ? 'v' : 't') : 'o')); return r; }
        vbox.innerHTML = ''; var core = el('div', 'pv-core'); core.innerHTML = withPM ? '<b>PointmapVLA</b><small>vision-language-action model</small>' : '<b>VLA</b><small>vision-language-action model</small>'; vbox.classList.add('tok-' + TOK);
        var inRowEl = tokRow('in'); if (TOK === 'both') vbox.appendChild(tokRow('out')); vbox.appendChild(core); if (TOK !== 'none') vbox.appendChild(inRowEl);
        if (withPM && patchHL.length && !opts.manualPatch) {   /* token-wise fusion: patch k of the left RGB and of its pointmap (same 2×2 grid) light together with input token k */
          var pk = 0, toks = inRowEl.querySelectorAll('i'); setInterval(function () { pk = (pk + 1) % 4; patchHL.forEach(function (h) { h.style.left = (pk % 2) * 50 + '%'; h.style.top = Math.floor(pk / 2) * 50 + '%'; });
            toks.forEach(function (t, j) { t.classList.toggle('pk', j === pk); }); }, 800);
          patchHL.forEach(function (h) { h.style.left = '0%'; h.style.top = '0%'; }); toks[0].classList.add('pk'); }
        inBox.removeChild(tl); inBox.appendChild(tl); }
      [chunkEl, el('div', 'pv-up'), vbox, inBox].forEach(function (e) { left.appendChild(e); }); mid = left;
      var ghostKey = el('div', 'paired-ghost'); ghostKey.innerHTML = withPM ? '<i class="pm"></i><b>3D given</b> &middot; robot-base pointmaps' : '<em>?</em><b>3D implicit</b> &middot; must be inferred from RGB';   /* user 2026-10-19: make implied vs given explicit */ stage.appendChild(ghostKey);
      root.appendChild(left); root.appendChild(right); root.appendChild(bar);
      if (withPM) {   /* explore: hover (mouse) or tap (touch) a pixel of a pointmap / RGB image; both players hold while a pixel is picked */
        tip = el('div', 'pms-tip'); root.appendChild(tip);
        var pickAt = function (e, im, v) { var r = im.getBoundingClientRect(); if (!r.width) return;
          pick = { v: v, el: im, gx: Math.max(0, Math.min(PG - 1, Math.floor((e.clientX - r.left) / r.width * PG))), gy: Math.max(0, Math.min(PG - 1, Math.floor((e.clientY - r.top) / r.height * PG))) }; st.hold = true; draw(); };
        var unpick = function () { touchPick = false; if (!pick) return; pick = null; st.hold = false; draw(); };
        pickT.forEach(function (t) { var bx = t[0], im = bx.querySelector('img'); bx.classList.add('pick');
          bx.addEventListener('pointermove', function (e) { if (e.pointerType !== 'touch') pickAt(e, im, t[1]); });
          bx.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') { touchPick = true; pickAt(e, im, t[1]); } });
          bx.addEventListener('pointerleave', function (e) { if (e.pointerType !== 'touch') unpick(); }); });
        document.addEventListener('pointerdown', function (e) { if (touchPick && !pickT.some(function (t) { return t[0].contains(e.target); })) unpick(); });
        /* the 3D view too (user): a point of the scene, or a pointmap / RGB card on a camera frustum; resolved in render against the current view */
        var down3 = null;
        canvas.addEventListener('pointermove', function (e) { if (drag || e.pointerType === 'touch') return; var r = canvas.getBoundingClientRect(); hov3 = { x: e.clientX - r.left, y: e.clientY - r.top }; draw(); });
        canvas.addEventListener('pointerleave', function (e) { if (e.pointerType === 'touch') return; hov3 = null; if (pick && pick.src) unpick(); });
        canvas.addEventListener('pointerdown', function (e) { down3 = [e.clientX, e.clientY]; });
        canvas.addEventListener('pointerup', function (e) { if (e.pointerType !== 'touch' || !down3 || Math.hypot(e.clientX - down3[0], e.clientY - down3[1]) > 6) return;   /* a tap, not an orbit drag */
          var r = canvas.getBoundingClientRect(); hov3 = { x: e.clientX - r.left, y: e.clientY - r.top, touch: true }; draw(); });
      }
      play.textContent = 'Pause'; play.setAttribute('aria-label', 'Pause synchronized playback');
      prog_.setAttribute('aria-label', 'Recorded episode position');
      st.orbit = false; st.fcur = 0; st.pf = 0; st.mode = 'think'; st.t0 = 0; st.c0 = 0;
      st.playing = opts.autoplay !== false && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      play.textContent = st.playing ? 'Pause' : 'Play';
    }

    /* ---- GL ---- */
    var gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false }); if (!gl) { msg.textContent = 'WebGL unavailable'; return; }
    var P2 = prog(gl, VS2, FS), L = prog(gl, VSL, FSL), TX = prog(gl, VST, FST);
    var l2 = { pos: gl.getAttribLocation(P2, 'a_pos'), rgb: gl.getAttribLocation(P2, 'a_rgb'), mvp: gl.getUniformLocation(P2, 'u_mvp'), ps: gl.getUniformLocation(P2, 'u_psize'), alpha: gl.getUniformLocation(P2, 'u_alpha'), round: gl.getUniformLocation(P2, 'u_round'), grey: gl.getUniformLocation(P2, 'u_grey') };
    var ll = { pos: gl.getAttribLocation(L, 'a_pos'), col: gl.getAttribLocation(L, 'a_col'), mvp: gl.getUniformLocation(L, 'u_mvp'), alpha: gl.getUniformLocation(L, 'u_alpha') };
    var lt = { pos: gl.getAttribLocation(TX, 'a_pos'), uv: gl.getAttribLocation(TX, 'a_uv'), mvp: gl.getUniformLocation(TX, 'u_mvp'), t0: gl.getUniformLocation(TX, 'u_t0'), t1: gl.getUniformLocation(TX, 'u_t1'), mix: gl.getUniformLocation(TX, 'u_mix'), alpha: gl.getUniformLocation(TX, 'u_alpha') };
    function buf(a) { var b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW); return b; }
    /* the frame as one robot-frame cloud (valid pixels of all cameras) */
    var pos = new Int16Array(nV * N * 3), col = new Uint8Array(nV * N * 3), n = 0, zFloorArr = [];
    Ds.forEach(function (D, v) { for (var i = 0; i < N; i++) { var x = xyz[v][i * 3], y = xyz[v][i * 3 + 1], z = xyz[v][i * 3 + 2]; if (!x && !y && !z) continue; if (depth[v][i] > 3000) continue;
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z; col[n * 3] = rgb[v][i * 3]; col[n * 3 + 1] = rgb[v][i * 3 + 1]; col[n * 3 + 2] = rgb[v][i * 3 + 2]; if (n % 11 === 0) zFloorArr.push(z / 1000); n++; } });
    var BUF = { pos: buf(pos.subarray(0, n * 3)), rgb: buf(col.subarray(0, n * 3)) }, lbuf = gl.createBuffer(), tbuf = gl.createBuffer();
    zFloorArr.sort(function (a, b) { return a - b; }); var zFloor = zFloorArr[Math.floor(zFloorArr.length * 0.01)];
    /* ---- textures: still images per camera (rgb / depth grey / camera-frame xyz / robot-frame xyz) + lazily loaded episode thumbnails ---- */
    function texParams() { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    function texData(d) { var t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, d); texParams(); return t; }
    function img(fn) { var d = new Uint8Array(N * 3), c = document.createElement('canvas'); c.width = w; c.height = h; var x = c.getContext('2d'), im = x.createImageData(w, h), q = im.data;
      for (var i = 0; i < N; i++) { var o = fn(i); d[i * 3] = q[i * 4] = o[0]; d[i * 3 + 1] = q[i * 4 + 1] = o[1]; d[i * 3 + 2] = q[i * 4 + 2] = o[2]; q[i * 4 + 3] = 255; } x.putImageData(im, 0, 0); return { url: c.toDataURL('image/jpeg', 0.85), tex: texData(d) }; }
    var imRGB = Ds.map(function (D, v) { return { url: D.rgb, tex: texData(rgb[v]) }; });
    var imDepth = Ds.map(function (D, v) { var zs = []; for (var i = 0; i < N; i += 7) if (depth[v][i] > 0) zs.push(depth[v][i]); zs.sort(function (a, b) { return a - b; }); var lo = zs[Math.floor(zs.length * 0.02)], hi = zs[Math.floor(zs.length * 0.98)];
      return img(function (i) { var z = depth[v][i]; if (z <= 0) return [0, 0, 0]; var g = Math.round(30 + 225 * Math.max(0, Math.min(1, 1 - (z - lo) / Math.max(1, hi - lo)))); return [g, g, g]; }); });
    var imCam = Ds.map(function (D, v) { var K = D.K; return img(function (i) { var z = depth[v][i] / 1000; if (z <= 0) return [0, 0, 0]; var u = i % w, r = (i - u) / w, x = (u + 0.5 - K[0][2]) / K[0][0] * z, y = (r + 0.5 - K[1][2]) / K[1][1] * z;
      return [Math.max(0, Math.min(255, (x + 1.2) / 2.4 * 255)), Math.max(0, Math.min(255, (y + 1.0) / 2.0 * 255)), Math.max(0, Math.min(255, (z - 0.3) / 2.7 * 255))]; }); });
    var imBase = Ds.map(function (D, v) { var X = xyz[v]; return img(function (i) { var x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2]; if (!x && !y && !z) return [0, 0, 0]; return [x, y, z].map(function (q, a) { return Math.max(0, Math.min(255, (q / 1000 - PMLO[a]) / (PMHI[a] - PMLO[a]) * 255)); }); }); });
    var tcache = {};
    function texURL(url) { var t = tcache[url]; if (t) return t.ok ? t.tex : null; t = tcache[url] = { ok: false, tex: gl.createTexture() }; var im = new Image();
      im.onload = function () { gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, im); texParams(); t.ok = true; draw(); }; im.src = url; return null; }
    /* tracked point (the mug): pixel + camera-frame position in every camera */
    var star = opts.star, starC = Ds.map(function (D) { var pc = inv(D.T, star), K = D.K; return { pc: pc, uv: [K[0][0] * pc[0] / pc[2] + K[0][2], K[1][1] * pc[1] / pc[2] + K[1][2]] }; });
    var rep = { v: 0, gx: Math.max(0, Math.min(PG - 1, Math.floor(starC[0].uv[0] / PS))), gy: Math.max(0, Math.min(PG - 1, Math.floor(starC[0].uv[1] / PS))) };   /* default pixel: the mug in the left camera */
    function pick3(sx, sy, k) { var cw = canvas.clientWidth, ch = canvas.clientHeight, tf = Math.tan(FOV * Math.PI / 360), A = camAxes({ az: camv.az + st.off.az, el: Math.max(-89, Math.min(89, camv.el + st.off.el)), d: camv.d, t: camv.t });
      var d = add(add(A.f, A.r, (2 * sx / cw - 1) * tf * cw / ch), A.u, (1 - 2 * sy / ch) * tf), i, gx, gy, v;
      for (i = cards3.length - 1; i >= 0; i--) { var q = cards3[i].q, e1 = add(q[1], q[0], -1), e3 = add(q[3], q[0], -1), nn = cross(e1, e3), dn = dot(d, nn); if (!dn) continue;
        var P = add(A.eye, d, dot(add(q[0], A.eye, -1), nn) / dn), rl = add(P, q[0], -1), cu = dot(rl, e1) / dot(e1, e1), cv = dot(rl, e3) / dot(e3, e3);
        if (cu >= 0 && cu < 1 && cv >= 0 && cv < 1) return { v: cards3[i].v, gx: Math.floor(cu * PG), gy: Math.floor(cv * PG), src: 'card' }; }
      var M = mvp3, best = null, bw = 1e9; if (!M) return null;
      for (v = 0; v < nV; v++) for (gy = 0; gy < PG; gy++) for (gx = 0; gx < PG; gx++) { var p = pixXYZ(v, gx, gy, k); if (!p) continue;
        var X = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], Y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], W = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15]; if (W <= 0) continue;
        var ex = (X / W + 1) / 2 * cw - sx, ey = (1 - Y / W) / 2 * ch - sy; if (ex * ex + ey * ey < 81 && W < bw) { bw = W; best = { v: v, gx: gx, gy: gy, src: 'scene' }; } }
      return best; }
    function pixXYZ(v, gx, gy, k) {   /* robot-base metres at grid pixel (gx, gy) of camera v: episode keyframe k (xyz.js), or the still frame (k < 0); null = no depth */
      var X = window.PMVLA_XYZ && window.PMVLA_XYZ[epId], a, o;
      if (k >= 0) { if (!X) return null; a = xyzEP = xyzEP || new Int16Array(b64(X.b64).buffer); o = (((k * nV + v) * X.g + gy) * X.g + gx) * 3; }
      else { a = xyz[v]; o = ((gy * PS + PS / 2) * w + gx * PS + PS / 2) * 3; }
      return a[o] || a[o + 1] || a[o + 2] ? [a[o] / 1000, a[o + 1] / 1000, a[o + 2] / 1000] : null; }
    /* ---- cameras per state: overview while the cards sit at the cameras, then the scene view ---- */
    var C3 = opts.view || { az: 150, el: 26, t: [0.25, 0.05, 0.3], d: 2.3 }, CB = { az: 180, el: 18, t: [0.0, 0.05, 0.5], d: 3.0 };   /* build: straight behind the robot, cameras left/right as labelled */
    var camv = JSON.parse(JSON.stringify(build ? CB : C3));
    function phases(u) { if (!build) return { u1: 1, u2: 1, u3: 1, act: 4, play: 1 };
      var u1 = ease((u - B[0]) / 0.06), u2 = ease((u - B[1]) / 0.06), u3 = ease((u - B[2]) / 0.08);
      return { u1: u1, u2: u2, u3: u3, act: u < B[0] ? 0 : u < B[1] ? 1 : u < B[2] ? 2 : u < B[3] ? 3 : 4, play: u < B[3] ? 0 : (u - B[3]) / (1 - B[3]) }; }
    function autoCam(ph) { if (!build) return st.view || C3; var narrow = canvas.clientHeight && canvas.clientWidth / canvas.clientHeight < 1.6; return narrow ? { az: CB.az, el: CB.el, t: CB.t, d: 3.7 } : CB; }   /* tall (phone) stage: pull back so the slot row clears the control bar */
    /* ---- episode (robot acts) ---- */
    var meta = null, k0 = ACT.keyframe || 0, T = 0, epId = ACT.episode;
    var CUM = [0]; for (var ci = 1; ci < ACT.path.length; ci++) { var a0 = ACT.path[ci - 1], a1 = ACT.path[ci]; CUM.push(CUM[ci - 1] + Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2])); }
    var ARC = CUM[CUM.length - 1], CH_LEN = ARC / N_CHUNKS;
    function idxAt(sv) { var lo = 0, hi = CUM.length - 1; if (sv >= CUM[hi]) return hi; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (CUM[m] <= sv) lo = m; else hi = m; } return lo + (sv - CUM[lo]) / Math.max(1e-9, CUM[hi] - CUM[lo]); }
    function chunkEnd(c) { return Math.min(CUM.length - 1, Math.ceil(idxAt(CUM[Math.floor(c)] + CH_LEN))); }
    function loadEpisode() { var pre = window.PMVLA_EPISODES ? Promise.resolve() : loadScript('static/episodes/episodes.js'); var cache = window.__pmsEP = window.__pmsEP || {};
      pre.then(function () { meta = window.PMVLA_EPISODES.filter(function (m) { return m.id === epId; })[0]; T = meta.n.length;
        var need = []; if (!window.PMVLA_RGB || !window.PMVLA_RGB[epId]) need.push(loadScript(meta.dir + '/rgb.js')); if ((build || withPM) && (!window.PMVLA_PM || !window.PMVLA_PM[epId])) need.push(loadScript(meta.dir + '/pm.js'));
        if (withPM && !(window.PMVLA_XYZ && window.PMVLA_XYZ[epId])) need.push(loadScript(meta.dir + '/xyz.js').catch(function () {}));   /* exact pixel XYZ for the hover (optional) */
        return Promise.all(need).then(function () { return cache[epId] ? null : meta.bin ? loadBin(meta.dir + '/data.bin.gz').then(function (buf) { cache[epId] = { n: meta.n, bb: new Uint8Array(buf) }; }) : loadScript(meta.dir + '/data.js'); }); })
      .then(function () { if (!cache[epId]) { var d0 = window.PMVLA_EP[epId]; var bin = atob(d0.b64), bb0 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) bb0[i] = bin.charCodeAt(i); cache[epId] = { n: d0.n, bb: bb0 }; delete window.PMVLA_EP[epId]; }
        var d = cache[epId], bb = d.bb, off = 0, fr = [];
        for (var f = 0; f < d.n.length; f++) { var m = d.n[f], sl = bb.buffer.slice(off, off + m * 10); off += m * 10; fr.push({ n: m, p: buf(new Int16Array(sl, 0, m * 3)), c: buf(new Uint8Array(sl, m * 6, m * 3)) }); }
        st.frames = fr; msg.textContent = ''; draw(); }).catch(function (e) { msg.textContent = 'episode clouds unavailable: ' + e; });
    }
    msg.textContent = 'loading the episode…'; loadEpisode();
    var stripState = '';
    function setStrip(act, k) { var key = act + ':' + k; if (key === stripState) return; stripState = key;
      var R = window.PMVLA_RGB && window.PMVLA_RGB[epId]; stripImgs.forEach(function (im, v) { im.src = (act === 4 && R && R[k]) ? R[k][v] : Ds[v].rgb; });
      if (!build) return; var PM = window.PMVLA_PM && window.PMVLA_PM[epId];
      stripPM.forEach(function (im, v) { var wrap = stripPMwrap[v]; wrap.classList.toggle('off', act === 0); wrap.classList.toggle('dim', act === 1);
        im.src = act <= 1 ? imDepth[v].url : act === 2 ? imCam[v].url : act === 3 ? imBase[v].url : (PM && PM[k]) ? PM[k][v] : imBase[v].url; }); }
    /* ---- drawing ---- */
    function fit() { var dpr = Math.min(devicePixelRatio || 1, 2), cw = Math.floor(canvas.clientWidth * dpr), ch = Math.floor(canvas.clientHeight * dpr); if (cw && ch && (canvas.width !== cw || canvas.height !== ch)) { canvas.width = cw; canvas.height = ch; } }
    function draw() { if (!st.dirty) { st.dirty = true; requestAnimationFrame(render); } }
    function lines(arr, mvp, alpha, tri) { gl.useProgram(L); gl.uniformMatrix4fv(ll.mvp, false, mvp); gl.uniform1f(ll.alpha, alpha == null ? 1 : alpha); gl.bindBuffer(gl.ARRAY_BUFFER, lbuf); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(ll.pos); gl.vertexAttribPointer(ll.pos, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(ll.col); gl.vertexAttribPointer(ll.col, 3, gl.FLOAT, false, 24, 12); gl.drawArrays(tri ? gl.TRIANGLES : gl.LINES, 0, arr.length / 6); gl.disableVertexAttribArray(ll.pos); gl.disableVertexAttribArray(ll.col); }
    function quad(c, R, U, hw, hh) { return [add(add(c, R, -hw), U, hh), add(add(c, R, hw), U, hh), add(add(c, R, -hw), U, -hh), add(add(c, R, hw), U, -hh)]; }   /* TL TR BL BR */
    function card(mvp, c, R, U, t0, t1, mx, alpha, bc) { var hw = CARD / 2, bw = 0.012, q = quad(c, R, U, hw + bw, hw + bw), tri = [];
      [q[0], q[1], q[2], q[1], q[3], q[2]].forEach(function (p) { tri.push(p[0], p[1], p[2], bc[0], bc[1], bc[2]); }); lines(new Float32Array(tri), mvp, alpha, true);
      q = quad(c, R, U, hw, hw); var uv = [[0, 0], [1, 0], [0, 1], [1, 1]], vb = []; [0, 1, 2, 1, 3, 2].forEach(function (k) { vb.push(q[k][0], q[k][1], q[k][2], uv[k][0], uv[k][1]); });
      gl.useProgram(TX); gl.uniformMatrix4fv(lt.mvp, false, mvp); gl.uniform1f(lt.mix, mx); gl.uniform1f(lt.alpha, alpha);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t0); gl.uniform1i(lt.t0, 0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t1 || t0); gl.uniform1i(lt.t1, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, tbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vb), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(lt.pos); gl.vertexAttribPointer(lt.pos, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(lt.uv); gl.vertexAttribPointer(lt.uv, 2, gl.FLOAT, false, 20, 12);
      gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(lt.pos); gl.disableVertexAttribArray(lt.uv); }
    var grid = []; for (var gi = -10; gi <= 10; gi++) { var k = gi / 10 * 1.5, g = 0.86; grid.push(-1.5, k, 0, g, g, g, 1.5, k, 0, g, g, g, k, -1.5, 0, g, g, g, k, 1.5, 0, g, g, g); } grid = new Float32Array(grid);
    function scr(mvp, o) { var cx = mvp[0] * o[0] + mvp[4] * o[1] + mvp[8] * o[2] + mvp[12], cy = mvp[1] * o[0] + mvp[5] * o[1] + mvp[9] * o[2] + mvp[13], cw = mvp[3] * o[0] + mvp[7] * o[1] + mvp[11] * o[2] + mvp[15]; return cw <= 0 ? null : [(cx / cw + 1) / 2 * canvas.clientWidth, (1 - cy / cw) / 2 * canvas.clientHeight]; }
    function ribbon(path, from, to, wpx, c, ax) { var tri = [], fl = (canvas.height / 2) / Math.tan(FOV * Math.PI / 360);
      for (var i = from + 1; i <= to; i++) { var p0 = path[i - 1], p1 = path[i], dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
        var nx = dy * ax.f[2] - dz * ax.f[1], ny = dz * ax.f[0] - dx * ax.f[2], nz = dx * ax.f[1] - dy * ax.f[0], nn = Math.hypot(nx, ny, nz) || 1e-6;
        var zc = (p0[0] - ax.eye[0]) * ax.f[0] + (p0[1] - ax.eye[1]) * ax.f[1] + (p0[2] - ax.eye[2]) * ax.f[2], hw = wpx * zc / fl / 2 * Math.min(devicePixelRatio || 1, 2); nx *= hw / nn; ny *= hw / nn; nz *= hw / nn;
        [[p0[0] - nx, p0[1] - ny, p0[2] - nz], [p0[0] + nx, p0[1] + ny, p0[2] + nz], [p1[0] + nx, p1[1] + ny, p1[2] + nz], [p0[0] - nx, p0[1] - ny, p0[2] - nz], [p1[0] + nx, p1[1] + ny, p1[2] + nz], [p1[0] - nx, p1[1] - ny, p1[2] - nz]].forEach(function (q) { tri.push(q[0], q[1], q[2], c[0], c[1], c[2]); }); }
      return new Float32Array(tri); }
    /* card anchors: the RGB card floats above its camera; the pointmap card pops out toward the viewer, then flies to a slot at the robot */
    var SLOT0 = [-0.6, 0.05, 0.12], ARC = 0.3;
    function arcPos(a, b, t, F) { return add(mix3(a, b, t), F, -ARC * Math.sin(Math.PI * t)); }   /* swoops toward the viewer on the way */
    var lastAct = -1, mvp3 = null;
    function render() { st.dirty = false; fit(); var W = canvas.width, H = canvas.height; if (!W || !H) return;
      var ph = phases(st.u), act = ph.act; prog_.value = paired ? st.pf / Math.max(1, ACT.path.length - 1) : st.u;
      if (build && act !== lastAct) { lastAct = act; nodes.forEach(function (b, i) { b.classList.toggle('on', i === act); b.classList.toggle('done', i < act); }); arrows.forEach(function (a, i) { a.classList.toggle('on', i < act); }); capt.innerHTML = '<b>' + ACTS[act].key + '</b> <span>' + ACTS[act].sub + '</span>'; }
      /* episode frame index */
      var fr = null, kf = k0;
      if (act === 4 && st.frames) { if (build) { kf = Math.min(T - 1, k0 + Math.floor(ph.play * (T - k0 + 0.999))); } else kf = st.fcur; fr = st.frames[kf]; }
      setStrip(act, kf);
      var ac = autoCam(ph); if (!st.userMoved) { camv.az += (ac.az - camv.az) * 0.25; camv.el += (ac.el - camv.el) * 0.25; camv.d += (ac.d - camv.d) * 0.25; for (var q = 0; q < 3; q++) camv.t[q] += (ac.t[q] - camv.t[q]) * 0.25; }
      var cv = { az: camv.az + st.off.az, el: Math.max(-89, Math.min(89, camv.el + st.off.el)), d: camv.d, t: camv.t }, ax = camAxes(cv);
      gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      var mvp = mvp3 = mul(persp(FOV * Math.PI / 180, W / H, 0.03, 60), view(cv)), dpr = Math.min(devicePixelRatio || 1, 2), fl = (H / 2) / Math.tan(FOV * Math.PI / 360);
      /* floor grid + base axes once the pointmaps are in the robot frame */
      if (ph.u3 > 0.02) { var g2 = new Float32Array(grid); for (var i2 = 2; i2 < g2.length; i2 += 6) g2[i2] = zFloor; lines(g2, mvp, ph.u3 * 0.9);
        var A = 0.32, axl = [0, 0, 0, 0.88, 0.19, 0.19, A, 0, 0, 0.88, 0.19, 0.19, 0, 0, 0, 0.18, 0.62, 0.27, 0, A, 0, 0.18, 0.62, 0.27, 0, 0, 0, 0.11, 0.49, 0.84, 0, 0, A, 0.11, 0.49, 0.84]; gl.disable(gl.DEPTH_TEST); lines(new Float32Array(axl), mvp, ph.u3); gl.enable(gl.DEPTH_TEST); }
      /* points: the built frame, or the episode frame while the robot acts */
      gl.useProgram(P2); gl.uniformMatrix4fv(l2.mvp, false, mvp); gl.uniform1f(l2.ps, 2.6 * fl * 0.0042 * dpr); gl.uniform1f(l2.alpha, paired && !withPM ? (opts.ghost || 0.13) : 1); gl.uniform1f(l2.round, 1); gl.uniform1f(l2.grey, paired && !withPM ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, fr ? fr.p : BUF.pos); gl.enableVertexAttribArray(l2.pos); gl.vertexAttribPointer(l2.pos, 3, gl.SHORT, false, 0, 0); gl.bindBuffer(gl.ARRAY_BUFFER, fr ? fr.c : BUF.rgb); gl.enableVertexAttribArray(l2.rgb); gl.vertexAttribPointer(l2.rgb, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(gl.POINTS, 0, fr ? fr.n : n); gl.disableVertexAttribArray(l2.pos); gl.disableVertexAttribArray(l2.rgb);
      /* camera frustums at the true poses (robot frame) */
      var fr3 = [], Tv = Ds.map(function (D, v) { return (fr && meta && meta.poses && meta.poses[kf]) ? meta.poses[kf][v] : D.T; }),
        imgCorners = function (v, du, dv, ds) { var K = Ds[v].K, dd = (paired ? (v === 2 ? FR_WD : FR_D) : 0.16) * (ds || 1), ou = (du || 0) * w, ov = (dv || 0) * h;   /* wrist image on its true frustum, a bit smaller; (du, dv, ds) = offset card */
          return [[0, 0], [w, 0], [w, h], [0, h]].map(function (uv) { return xf(Tv[v], [(uv[0] + ou - K[0][2]) / K[0][0] * dd, (uv[1] + ov - K[1][2]) / K[1][1] * dd, dd]); }); }, org = Tv.map(function (t) { return xf(t, [0, 0, 0]); });
      Ds.forEach(function (D, v) { var o = org[v], c = VIEW_COL[v], cc = imgCorners(v);
        for (var i = 0; i < 4; i++) { var a = cc[i], b = cc[(i + 1) % 4]; fr3.push(o[0], o[1], o[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], c[0], c[1], c[2]); } });
      if (paired) { var RgbF = window.PMVLA_RGB && window.PMVLA_RGB[epId]; gl.disable(gl.DEPTH_TEST);   /* each camera's live image on its frustum's image plane, drawn over the faint scene */
        var PMF = window.PMVLA_PM && window.PMVLA_PM[epId], pmBorder = [];
        function texQuad(q, t) { var uvs = [[0, 0], [1, 0], [1, 1], [0, 1]], vb = []; [0, 1, 2, 0, 2, 3].forEach(function (k) { vb.push(q[k][0], q[k][1], q[k][2], uvs[k][0], uvs[k][1]); });
          gl.useProgram(TX); gl.uniformMatrix4fv(lt.mvp, false, mvp); gl.uniform1f(lt.mix, 0); gl.uniform1f(lt.alpha, 1);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(lt.t0, 0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(lt.t1, 1);
          gl.bindBuffer(gl.ARRAY_BUFFER, tbuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vb), gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(lt.pos); gl.vertexAttribPointer(lt.pos, 3, gl.FLOAT, false, 20, 0); gl.enableVertexAttribArray(lt.uv); gl.vertexAttribPointer(lt.uv, 2, gl.FLOAT, false, 20, 12);
          gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disableVertexAttribArray(lt.pos); gl.disableVertexAttribArray(lt.uv); }
        cards3 = []; Ds.forEach(function (D, v) { var q = imgCorners(v); cards3.push({ v: v, q: q });
          texQuad(q, (fr && RgbF && RgbF[kf] && texURL(RgbF[kf][v])) || imRGB[v].tex);
          if (withPM) {   /* the pointmap card stacked on the RGB card: shifted up-left in the image plane, a little nearer the camera (drawn on top) */
            var qp = imgCorners(v, PM_SHIFT[0], PM_SHIFT[1], 0.94); cards3.push({ v: v, q: qp, pm: true }); texQuad(qp, (fr && PMF && PMF[kf] && texURL(PMF[kf][v])) || imBase[v].tex);
            var c = VIEW_COL[v]; for (var e2 = 0; e2 < 4; e2++) { var a2 = qp[e2], b2 = qp[(e2 + 1) % 4]; pmBorder.push(a2[0], a2[1], a2[2], c[0], c[1], c[2], b2[0], b2[1], b2[2], c[0], c[1], c[2]); } } });
        if (pmBorder.length) lines(new Float32Array(pmBorder), mvp, 1); gl.enable(gl.DEPTH_TEST); }
      gl.disable(gl.DEPTH_TEST); lines(new Float32Array(fr3), mvp, 1); gl.enable(gl.DEPTH_TEST);   /* camera frustums at their true poses, over the images (the wrist one starts on the gripper) */
      /* gripper path: faint whole path, bold travelled part, while the robot acts */
      var pidx = null;
      if (act === 4 && meta) { pidx = paired ? Math.floor(st.pf) : meta.path_idx[kf]; var pw = paired ? 1.3 : 1;   /* section 01: path a bit bolder (user: gripper and path clearly visible on both sides) */
        gl.disable(gl.DEPTH_TEST); lines(ribbon(ACT.path, 0, ACT.path.length - 1, 4 * pw, [1, 1, 1], ax), mvp, 0.9, true); lines(ribbon(ACT.path, 0, ACT.path.length - 1, 1.5 * pw, [0.93, 0.78, 0.93], ax), mvp, 1, true);
        lines(ribbon(ACT.path, 0, pidx, 6.5 * pw, [1, 1, 1], ax), mvp, 1, true); lines(ribbon(ACT.path, 0, pidx, 3.2 * pw, PATH, ax), mvp, 1, true);
        if (paired) { var cend = chunkEnd(st.c0), ce = st.mode === 'think' ? Math.round(st.c0 + (cend - st.c0) * ease((performance.now() - st.t0) / (THINK * 0.8))) : st.mode === 'act' ? cend : pidx; if (ce > pidx) { lines(ribbon(ACT.path, pidx, ce, 11, [1, 1, 1], ax), mvp, 1, true); lines(ribbon(ACT.path, pidx, ce, 7, CHUNK_COL, ax), mvp, 1, true); } }
        gl.enable(gl.DEPTH_TEST); }
      /* ---- cards (build only): RGB card at each camera, pointmap card popping out and flying to the robot ---- */
      var sv = '', pl = '', R = ax.r, U = ax.u, F = ax.f, ringPts = [];
      function pill(p, html, cls) { var s = scr(mvp, p); if (!s) return; pl += '<div class="pill ' + (cls || '') + '" style="left:' + s[0].toFixed(1) + 'px;top:' + s[1].toFixed(1) + 'px">' + html + '</div>'; }
      function ring(p, c, r, op) { var s = scr(mvp, p); if (!s) return null; sv += '<circle cx="' + s[0].toFixed(1) + '" cy="' + s[1].toFixed(1) + '" r="' + r + '" fill="none" stroke="#fff" stroke-width="4.5" opacity="' + op + '"/><circle cx="' + s[0].toFixed(1) + '" cy="' + s[1].toFixed(1) + '" r="' + r + '" fill="none" stroke="' + c + '" stroke-width="2.5" opacity="' + op + '"/>'; return s; }
      function onCard(c, uv) { return add(add(c, R, (uv[0] / w - 0.5) * CARD), U, -(uv[1] / h - 0.5) * CARD); }
      if (build) { gl.disable(gl.DEPTH_TEST);
        var Rr = window.PMVLA_RGB && window.PMVLA_RGB[epId], PM = window.PMVLA_PM && window.PMVLA_PM[epId];
        var cRGB = org.map(function (o, v) { return add(add(o, R, OFF[v][0]), U, OFF[v][1]); });
        var cPop = cRGB.map(function (c, v) { return add(add(add(c, R, POP[v][0]), U, POP[v][1]), F, -0.2); });
        var slot0 = [SLOT0[0], SLOT0[1], SLOT0[2] + (canvas.clientWidth / canvas.clientHeight < 1.6 ? 0.25 : 0)], cSlot = Ds.map(function (D, v) { return add(slot0, R, (v - 1) * CARD * 1.15); });
        Ds.forEach(function (D, v) { var t = (act === 4 && Rr && Rr[kf]) ? texURL(Rr[kf][v]) : null; card(mvp, cRGB[v], R, U, t || imRGB[v].tex, null, 0, 1, VIEW_COL[v]); });
        if (ph.u1 > 0) Ds.forEach(function (D, v) { var c = ph.u3 > 0 ? arcPos(cPop[v], cSlot[v], ph.u3, F) : mix3(cRGB[v], cPop[v], ph.u1), t0, t1, mx;
          if (ph.u3 > 0) { var live = (act === 4 && PM && PM[kf]) ? texURL(PM[kf][v]) : null; t0 = imCam[v].tex; t1 = live || imBase[v].tex; mx = ph.u3; } else if (ph.u2 > 0) { t0 = imDepth[v].tex; t1 = imCam[v].tex; mx = ph.u2; } else { t0 = imRGB[v].tex; t1 = imDepth[v].tex; mx = ph.u1; }
          card(mvp, c, R, U, t0, t1, mx, ph.u1, VIEW_COL[v]); ringPts.push(c);
          /* dashed arc camera → robot while the pointmap is carried over */
          if (act === 3) { var d = ''; for (var k2 = 0; k2 <= 24; k2++) { var s = scr(mvp, arcPos(cPop[v], cSlot[v], k2 / 24, F)); if (!s) { d = ''; break; } d += (k2 ? 'L' : 'M') + s[0].toFixed(1) + ' ' + s[1].toFixed(1); }
            if (d) sv += '<path d="' + d + '" fill="none" stroke="#fff" stroke-width="4" opacity=".9"/><path d="' + d + '" fill="none" stroke="' + rgbs(VIEW_COL[v]) + '" stroke-width="2" stroke-dasharray="6 5"/>';
            if (v === 0) pill(arcPos(cPop[v], cSlot[v], 0.5, F), '<b>camera frame &rarr; robot-base frame</b><small>camera extrinsics</small>', 'high'); } });
        gl.enable(gl.DEPTH_TEST);
      }
      /* the mug in the scene, the base axes, the gripper */
      var mugOp = 1; if (act === 4 && meta) mugOp = Math.max(0, Math.min(1, (ACT.grasp - pidx) / 30 + 0.2));
      if (mugOp > 0) { if (!paired) ring(star, '#111', 9, mugOp); if (!paired && (!build || act === 4)) pill(star, '<b>the mug</b><small>target</small>', 'below'); }
      if (paired) {
        var pairKey = String(kf), Rgb = window.PMVLA_RGB && window.PMVLA_RGB[epId], newFrame = pairFrame !== pairKey; pairFrame = pairKey;
        var PMs = window.PMVLA_PM && window.PMVLA_PM[epId]; if (withPM && newFrame) pairedPM.forEach(function (im, v) { im.src = fr && PMs && PMs[kf] ? PMs[kf][v] : imBase[v].url; });
        Ds.forEach(function (D, v) { if (newFrame) pairedImage[v].src = fr && Rgb && Rgb[kf] ? Rgb[kf][v] : D.rgb; });
        if (withPM) {   /* pixel -> 3D: the picked (or default) pixel on its RGB + pointmap images and its robot-base point in the scene, same purple; xyz only while picked */
          if (hov3 && !hov3.done) { var hp = pick3(hov3.x, hov3.y, fr ? kf : -1);   /* pointer over the 3D view -> the grid pixel under it */
            if (hp) { pick = hp; st.hold = true; touchPick = !!hov3.touch; } else if (pick && pick.src && !hov3.touch) { pick = null; st.hold = false; }
            if (hov3.touch) hov3 = null; else hov3.done = true; canvas.style.cursor = pick && pick.src ? 'crosshair' : ''; }
          var pk = pick || rep, live = !!pick, P3 = pixXYZ(pk.v, pk.gx, pk.gy, fr ? kf : -1), pcx = pk.gx * PS + PS / 2, pcy = pk.gy * PS + PS / 2;
          [pairedSVG, pmSvgs].forEach(function (Ls) { Ls.forEach(function (s, v) { var hm = v === pk.v ? mark2(pcx, pcy, w / (s.getBoundingClientRect().width || w), live) : '';
            if (s.__h !== hm) { s.__h = hm; s.innerHTML = hm; } }); });
          cards3.forEach(function (c) { if (!c.pm || c.v !== pk.v) return; var q = c.q, sc = scr(mvp, add(add(q[0], add(q[1], q[0], -1), pcx / w), add(q[3], q[0], -1), pcy / h));   /* same pixel on the pointmap card in the scene */
            if (sc) sv += '<circle cx="' + sc[0].toFixed(1) + '" cy="' + sc[1].toFixed(1) + '" r="3.6" fill="#7c3aed" stroke="#fff" stroke-width="2" opacity="' + (live ? 1 : 0.8) + '"/>'; });
          var s3p = P3 && scr(mvp, P3); if (s3p) sv += mark3(s3p, live);
          if (live && P3 && (pick.el || s3p)) { var RR2 = root.getBoundingClientRect(), IR2 = (pick.el || canvas).getBoundingClientRect(), tx, ty;   /* tooltip above the hovered pixel, or above the 3D point */
            if (pick.el) { tx = IR2.left - RR2.left + pcx / w * IR2.width; ty = IR2.top - RR2.top + pcy / h * IR2.height; } else { tx = IR2.left - RR2.left + s3p[0]; ty = IR2.top - RR2.top + s3p[1] - 6; }
            var th = '<span><i>x</i>' + f2(P3[0]) + '<i>y</i>' + f2(P3[1]) + '<i>z</i>' + f2(P3[2]) + '</span><small>Robot-base frame · meters</small>';
            if (tip.__h !== th) { tip.__h = th; tip.innerHTML = th; } var tw = tip.offsetWidth, tH = tip.offsetHeight;
            tip.style.left = Math.max(4, Math.min(RR2.width - tw - 4, tx - tw / 2)) + 'px'; tip.style.top = (ty - tH - 12 < 2 || pick.src === 'card' ? ty + 14 : ty - tH - 12) + 'px';   /* a hovered frustum card sits above its point: tooltip below */ tip.classList.add('on'); }
          else tip.classList.remove('on'); }
        if (geo) {   /* the mug: box in the left-camera image (and its pointmap), connector along the card edge to the mug in 3D */
          if (!geoSvg) { geoSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); geoSvg.setAttribute('class', 'pms-geo'); root.appendChild(geoSvg); }
          var gp = inv(Tv[0], star), gK = Ds[0].K, gu = gK[0][0] * gp[0] / gp[2] + gK[0][2], gv = gK[1][1] * gp[1] / gp[2] + gK[1][2], gb = w * 0.16, gs = '', gcol = withPM ? '#7c3aed' : '#6b6f7c';
          var box = '<rect x="' + (gu - gb / 2) + '" y="' + (gv - gb / 2) + '" width="' + gb + '" height="' + gb + '" rx="4" fill="none" stroke="white" stroke-width="5" opacity="' + mugOp + '"/><rect x="' + (gu - gb / 2) + '" y="' + (gv - gb / 2) + '" width="' + gb + '" height="' + gb + '" rx="4" fill="none" stroke="' + gcol + '" stroke-width="2.6"' + (withPM ? '' : ' stroke-dasharray="5 4"') + ' opacity="' + mugOp + '"/>';
          pairedSVG[0].innerHTML = box; if (pmSvg0) pmSvg0.innerHTML = box;
          var s3 = scr(mvp, star), RR = root.getBoundingClientRect(), IR = pairedImage[0].getBoundingClientRect(), CR = canvas.getBoundingClientRect();
          if (s3 && mugOp > 0.05 && IR.width) { var x0 = IR.left - RR.left + (gu - gb / 2) / w * IR.width, y0 = IR.top - RR.top + gv / h * IR.height, x3 = CR.left - RR.left + s3[0], y3 = CR.top - RR.top + s3[1], xm = 6;
            var d = 'M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + 'H' + xm + 'V' + y3.toFixed(1) + 'H' + (x3 - 11).toFixed(1);
            gs += '<path d="' + d + '" fill="none" stroke="white" stroke-width="5" opacity="' + mugOp + '"/><path d="' + d + '" fill="none" stroke="' + gcol + '" stroke-width="' + (withPM ? 2.4 : 2) + '"' + (withPM ? '' : ' stroke-dasharray="6 5"') + ' opacity="' + mugOp + '"/>';
            gs += '<circle cx="' + x3.toFixed(1) + '" cy="' + y3.toFixed(1) + '" r="10" fill="none" stroke="white" stroke-width="5" opacity="' + mugOp + '"/><circle cx="' + x3.toFixed(1) + '" cy="' + y3.toFixed(1) + '" r="10" fill="' + (withPM ? 'rgba(124,58,237,.18)' : 'none') + '" stroke="' + gcol + '" stroke-width="2.4"' + (withPM ? '' : ' stroke-dasharray="4 3"') + ' opacity="' + mugOp + '"/>';
            gs += '<text x="' + (xm + 8) + '" y="' + (y3 - 8).toFixed(1) + '" class="gl ' + (withPM ? 'pm' : '') + '" opacity="' + mugOp + '">' + (withPM ? '3D position provided' : 'Infer 3D position') + '</text>';
            if (withPM) gs += '<text x="' + (x3 + 15).toFixed(1) + '" y="' + (y3 + 4).toFixed(1) + '" class="gx" opacity="' + mugOp + '">(' + star.map(function (q) { return q.toFixed(2); }).join(', ') + ') m</text>';
            else gs += '<text x="' + (x3 + 15).toFixed(1) + '" y="' + (y3 + 4).toFixed(1) + '" class="gx q" opacity="' + mugOp + '">(?, ?, ?)</text>'; }
          if (geoSvg.innerHTML !== gs) geoSvg.innerHTML = gs; }
        root.dataset.frame = kf; var thinking = st.mode === 'think', tp = thinking ? (performance.now() - st.t0) / THINK : 1;
        vbox.classList.toggle('on', thinking); mid.classList.toggle('flow', thinking); ins.classList.toggle('on', thinking);
        chunkEl.classList.toggle('on', st.mode === 'act' || (thinking && tp > 0.6)); chipEls.forEach(function (c, i) { c.classList.toggle('lit', thinking ? tp > 0.55 + i * 0.08 : st.mode === 'act'); });
        rgbCol.classList.toggle('flow', thinking); if (encRow) encRow.classList.toggle('on', thinking);
      }
      if (ph.u3 > 0.5) { var A2 = 0.32; if (!build && !paired) { pill([A2 + 0.08, 0, 0], 'x forward', 'ax'); pill([0, A2 + 0.08, 0], 'y left', 'ax'); pill([0, 0, A2 + 0.08], 'z up', 'ax'); } if (!paired) pill([0, 0, 0], '<b>robot base</b><small>(0, 0, 0)</small>', build ? '' : 'below'); }
      if (act === 4 && meta) { var e = ACT.path[pidx], se = paired ? null : ring(e, rgbs(PATH), 7, 1); var gs = meta.actions[kf].grip > 0.5 ? 'closed' : 'open';
        var sg = paired && scr(mvp, e); if (sg) sv = '<circle cx="' + sg[0].toFixed(1) + '" cy="' + sg[1].toFixed(1) + '" r="6.5" fill="#2a2733" stroke="#fff" stroke-width="2.5"/>' + sv;   /* the gripper, both players (under the purple point) */
        if (!paired && se) pill(e, '<b>gripper</b><small>' + gs + '</small>', 'top'); }
      if (svg.innerHTML !== sv) svg.innerHTML = sv; if (pills.innerHTML !== pl) pills.innerHTML = pl;
    }
    (function tick(now) { requestAnimationFrame(tick); var dt = st.last ? now - st.last : 0; st.last = now; if (!st.visible) return;
      if (build) { if (st.playing) st.u = (st.u + dt / LOOP) % 1; }
      else if (paired) { if (!(st.playing && !st.hold) && st.t0) st.t0 += dt;   /* paused or exploring a pixel: hold the think/act clock too */
        if (st.playing && !st.hold && st.frames && meta) { var L = ACT.path.length - 1; if (!st.t0) st.t0 = now;
          if (st.mode === 'think' && now - st.t0 > THINK) { st.mode = 'act'; st.t0 = now; }
          else if (st.mode === 'act') { var cE = chunkEnd(st.c0), sNow = Math.min(CUM[cE], CUM[Math.floor(st.pf)] + (st.pf % 1) * ((CUM[Math.min(L, Math.floor(st.pf) + 1)] - CUM[Math.floor(st.pf)])) + dt * CH_LEN / CHUNK_MS);
            st.pf = Math.min(cE, idxAt(sNow));
            if (st.pf >= cE - 1e-6) { st.pf = cE; if (st.pf >= L) { st.mode = 'end'; st.t0 = now; } else { st.mode = 'think'; st.c0 = st.pf; st.t0 = now; } } }
          else if (st.mode === 'end' && now - st.t0 > 1500) { st.mode = 'think'; st.pf = st.c0 = 0; st.t0 = now; }
          var kk = 0; while (kk + 1 < T && meta.path_idx[kk + 1] <= st.pf) kk++; st.fcur = kk; } }
      else if (st.playing && st.frames && now - st.ftime > 1000 / FPS) { st.ftime = now; st.fcur = (st.fcur + 1) % T; }
      if (st.orbit) { if (paired) st.off.az += Math.min(dt, 100) * 0.008; else camv.az += 0.08; } draw(); })(performance.now());
    play.onclick = function () { st.playing = !st.playing; play.textContent = paired ? (st.playing ? 'Pause' : 'Play') : (st.playing ? '❚❚' : '▶'); play.setAttribute('aria-label', st.playing ? 'Pause synchronized playback' : 'Play synchronized playback'); };
    prog_.oninput = function () { if (paired) { st.pf = st.c0 = Math.round(+prog_.value * (ACT.path.length - 1)); st.mode = 'think'; st.t0 = 0; st.playing = false; play.textContent = 'Play'; play.setAttribute('aria-label', 'Play synchronized playback'); } else st.u = +prog_.value; draw(); };
    orbit.onclick = function () { st.orbit = !st.orbit; orbit.classList.toggle('on', st.orbit); };
    reset.onclick = function () { st.userMoved = false; st.off = { az: 0, el: 0 }; draw(); };
    var drag = null;
    canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', function (e) { if (!drag) return; var dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; st.off.az -= dx * 0.3; st.off.el += dy * 0.3; draw(); });
    canvas.addEventListener('pointerup', function () { drag = null; }); canvas.addEventListener('pointercancel', function () { drag = null; });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); st.userMoved = true; camv.d = Math.max(0.3, Math.min(30, camv.d * Math.exp(e.deltaY * 0.001))); draw(); }, { passive: false });
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { es.forEach(function (e) { st.visible = e.isIntersecting; }); }, { rootMargin: '120px' }).observe(root);
    addEventListener('resize', draw); draw();
    return { state: st };
  }
  window.PMStage = { mount: mount };
})();
