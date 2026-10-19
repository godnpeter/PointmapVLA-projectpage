/* Pixel inspector: pick a pixel in the RGB image or its pointmap and see where that stored XYZ sits in the robot-base frame.
   Left: RGB over its pixel-aligned pointmap (same selection box). Right: the frame's cloud (all cameras, robot-base metres) drawn once
   from a fixed view, plus an overlay: base axes, the selected point, the ray from its camera, a drop line to the floor, the XYZ label.
   Autoplays a short tour (several pixels, then the mug from each camera: one point, three pixels); a click, key or camera change takes
   over and the tour resumes after a pause. Stored values only, nothing synthetic. */
(function () {
  'use strict';
  function bytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  var LO = [-0.6, -0.9, -0.5], HI = [0.9, 0.9, 1.2], VIEW = { az: 180, el: 22, t: [0.12, 0.0, 0.42], d: 1.75 }, FOV = 45;
  var CAM_COL = ['#2e7de0', '#12a694', '#d6731a'];
  var TOUR = [[0, 165, 140], [0, 60, 205], [0, 100, 55], [0, 85, 165], [0, 232, 205], 'mug'];   /* [camera, u, v] in 256² pixels; 'mug' = PM_STAR in each camera */
  var STEP_MS = 2400, RESUME_MS = 7000;

  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function mount(root, data) {
    var tb = root.querySelector('.visual-toolbar'), tabs = document.createElement('div'), auto = document.createElement('button'), tabEls = [];
    tabs.className = 'px-tabs'; tabs.setAttribute('role', 'tablist'); auto.type = 'button'; auto.className = 'px-auto'; tb.replaceChildren(tabs, auto);
    var out = root.querySelector('output'), canvases = Array.from(root.querySelectorAll('.pixel-pair canvas'));
    var c3 = root.querySelector('canvas.px3d'), ov = root.querySelector('svg.px3d-ov');
    var cache = data.cams.map(function (name) {
      var D = data.data[name], xyz = new Int16Array(bytes(D.xyz).buffer), depth = new Uint16Array(bytes(D.depth).buffer), rgb = bytes(D.rgb_flat);
      var images = [0, 1].map(function (type) {
        var c = document.createElement('canvas'); c.width = D.w; c.height = D.h; var ctx = c.getContext('2d'), im = ctx.createImageData(D.w, D.h);
        for (var i = 0; i < D.w * D.h; i++) { var valid = depth[i] > 0 && (xyz[i * 3] || xyz[i * 3 + 1] || xyz[i * 3 + 2]);
          for (var a = 0; a < 3; a++) im.data[i * 4 + a] = type ? (valid ? Math.max(0, Math.min(255, (xyz[i * 3 + a] / 1000 - LO[a]) / (HI[a] - LO[a]) * 255)) : 0) : rgb[i * 3 + a];
          im.data[i * 4 + 3] = 255; }
        ctx.putImageData(im, 0, 0); return c; });
      return { D: D, xyz: xyz, depth: depth, rgb: rgb, images: images, o: [D.T[0][3], D.T[1][3], D.T[2][3]] };
    });
    function nearest(ci, P) { var c = cache[ci], best = Infinity, bu = 128, bv = 128;
      for (var k = 0; k < c.D.w * c.D.h; k++) { if (!c.depth[k]) continue; var d = 0; for (var a = 0; a < 3; a++) d += Math.pow(c.xyz[k * 3 + a] / 1000 - P[a], 2); if (d < best) { best = d; bu = k % c.D.w; bv = Math.floor(k / c.D.w); } }
      return [bu, bv]; }
    var stops = []; TOUR.forEach(function (s) { if (s === 'mug') { if (window.PM_STAR) cache.forEach(function (c, ci) { var p = nearest(ci, window.PM_STAR); stops.push([ci, p[0], p[1], true]); }); } else stops.push(s); });
    var v = 0, u = 128, r = 128;
    data.labels.forEach(function (label, i) { var t = document.createElement('button'); t.type = 'button'; t.setAttribute('role', 'tab'); t.textContent = label; t.style.setProperty('--cc', CAM_COL[i]);
      t.onclick = function () { manual(); v = i; draw(); }; tabs.appendChild(t); tabEls.push(t); });

    /* ---- 3D: fixed perspective view (same as the episode figures), cloud splatted once ---- */
    /* orbitable view: drag to rotate (cheap re-splat while dragging, full quality on release), double-click to reset */
    var cam = { az: VIEW.az, el: VIEW.el, d: VIEW.d }, eye, F, R, U, W3 = 0, H3 = 0, fl = 1;
    function setView() { var a0 = cam.az * Math.PI / 180, e0 = cam.el * Math.PI / 180; eye = [VIEW.t[0] + cam.d * Math.cos(e0) * Math.cos(a0), VIEW.t[1] + cam.d * Math.cos(e0) * Math.sin(a0), VIEW.t[2] + cam.d * Math.sin(e0)];
      F = norm([VIEW.t[0] - eye[0], VIEW.t[1] - eye[1], VIEW.t[2] - eye[2]]); R = norm(cross(F, [0, 0, 1])); U = cross(R, F); } setView();
    function proj(p) { var d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]], z = dot(d, F); if (z < 0.05) return null; return [W3 / 2 + dot(d, R) / z * fl, H3 / 2 - dot(d, U) / z * fl, z]; }
    var zs = []; cache.forEach(function (c) { for (var i = 0; i < c.D.w * c.D.h; i += 13) if (c.depth[i]) zs.push(c.xyz[i * 3 + 2] / 1000); }); zs.sort(function (a, b) { return a - b; }); var zFloor = zs[Math.floor(zs.length * 0.01)] || 0;
    var fast = false, pts2 = null, pid = [];
    function splat() { var dpr = Math.min(devicePixelRatio || 1, 2), cw = c3.clientWidth, ch = c3.clientHeight; if (!cw || !ch) return false;
      c3.width = Math.round(cw * dpr); c3.height = Math.round(ch * dpr); W3 = cw; H3 = ch; fl = (H3 / 2) / Math.tan(FOV * Math.PI / 360);
      var ctx = c3.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch); var pts = [];
      ctx.strokeStyle = '#dcdde3'; ctx.lineWidth = 1; for (var g = -10; g <= 10; g++) { var k = g * 0.1; [[[-0.4, k, zFloor], [1.2, k, zFloor]], [[k + 0.4, -1, zFloor], [k + 0.4, 1, zFloor]]].forEach(function (ln) { var A = proj(ln[0]), B = proj(ln[1]); if (A && B) { ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); } }); }
      pid = []; cache.forEach(function (c, ci) { for (var i = 0; i < c.D.w * c.D.h; i += (fast ? 3 : 1)) { if (!c.depth[i]) continue; var p = [c.xyz[i * 3] / 1000, c.xyz[i * 3 + 1] / 1000, c.xyz[i * 3 + 2] / 1000];
        if (p[0] < LO[0] || p[0] > HI[0] || p[1] < LO[1] || p[1] > HI[1] || p[2] < LO[2] || p[2] > HI[2]) continue; var s = proj(p); if (s) { pts.push(s[0], s[1], s[2], c.rgb[i * 3], c.rgb[i * 3 + 1], c.rgb[i * 3 + 2]); pid.push(ci * 65536 + i); } } });
      pts2 = pts; var n = pts.length / 6, ord = new Uint32Array(n); for (var j = 0; j < n; j++) ord[j] = j; ord.sort(function (a, b) { return pts[b * 6 + 2] - pts[a * 6 + 2]; });
      for (var q = 0; q < n; q++) { var o = ord[q] * 6, sz = Math.max(fast ? 2.6 : 1.6, (fast ? 5.5 : 3.6) / pts[o + 2]); ctx.fillStyle = 'rgb(' + pts[o + 3] + ',' + pts[o + 4] + ',' + pts[o + 5] + ')'; ctx.fillRect(pts[o] - sz / 2, pts[o + 1] - sz / 2, sz, sz); }
      ov.setAttribute('viewBox', '0 0 ' + cw + ' ' + ch); return true; }

    function overlay(p, ok) { var s = '', O = proj([0, 0, 0]);
      [[[0.25, 0, 0], '#e03131'], [[0, 0.25, 0], '#2f9e44'], [[0, 0, 0.25], '#1c7ed6']].forEach(function (a) { var B = proj(a[0]); if (O && B) s += '<line x1="' + O[0] + '" y1="' + O[1] + '" x2="' + B[0] + '" y2="' + B[1] + '" stroke="' + a[1] + '" stroke-width="2.5" stroke-linecap="round"/>'; });
      if (O) s += '<circle cx="' + O[0] + '" cy="' + O[1] + '" r="3.5" fill="#1b2024"/><text x="' + (O[0] + 7) + '" y="' + (O[1] + 15) + '" class="lb">robot base</text>';
      if (ok) { var P = proj(p), C = proj(cache[v].o), Fl = proj([p[0], p[1], zFloor]), col = CAM_COL[v] || '#6d28d9';
        var D = cache[v].D, K = D.K, T = D.T, FD = 0.12, cc = [[0, 0], [D.w, 0], [D.w, D.h], [0, D.h]].map(function (q) { var x = (q[0] - K[0][2]) / K[0][0] * FD, y = (q[1] - K[1][2]) / K[1][1] * FD, z = FD;
          return proj([T[0][0] * x + T[0][1] * y + T[0][2] * z + T[0][3], T[1][0] * x + T[1][1] * y + T[1][2] * z + T[1][3], T[2][0] * x + T[2][1] * y + T[2][2] * z + T[2][3]]); });
        if (C && cc.every(Boolean)) { s += '<polygon points="' + cc.map(function (q) { return q[0] + ',' + q[1]; }).join(' ') + '" fill="' + col + '" fill-opacity=".18" stroke="' + col + '" stroke-width="1.6"/>';   /* camera frustum (12 cm deep) at its true pose */
          cc.forEach(function (q) { s += '<line x1="' + C[0] + '" y1="' + C[1] + '" x2="' + q[0] + '" y2="' + q[1] + '" stroke="' + col + '" stroke-width="1.6"/>'; }); }
        if (C && P) s += '<line x1="' + C[0] + '" y1="' + C[1] + '" x2="' + P[0] + '" y2="' + P[1] + '" stroke="' + col + '" stroke-width="1.8" stroke-dasharray="6 4"/>';
        if (P && Fl) s += '<line x1="' + P[0] + '" y1="' + P[1] + '" x2="' + Fl[0] + '" y2="' + Fl[1] + '" stroke="#6d28d9" stroke-width="1.2" stroke-dasharray="2 3"/>';
        if (P) s += '<circle cx="' + P[0] + '" cy="' + P[1] + '" r="9" fill="none" stroke="#fff" stroke-width="4"/><circle cx="' + P[0] + '" cy="' + P[1] + '" r="9" fill="none" stroke="#6d28d9" stroke-width="2.5"/><circle cx="' + P[0] + '" cy="' + P[1] + '" r="2.5" fill="#6d28d9"/>' +
          '<g class="tag" transform="translate(' + Math.max(4, Math.min(W3 - 192, P[0] + 14)) + ',' + (P[1] - 14) + ')"><rect x="0" y="-15" width="186" height="22" rx="6"/><text x="8" y="0">(' + p.map(function (x) { return x.toFixed(2); }).join(', ') + ') m</text></g>'; }
      ov.innerHTML = s; }

    function draw() { var c = cache[v], D = c.D; u = Math.max(0, Math.min(D.w - 1, u)); r = Math.max(0, Math.min(D.h - 1, r)); tabEls.forEach(function (t, i) { t.classList.toggle('on', i === v); t.setAttribute('aria-selected', i === v); });
      canvases.forEach(function (canvas, j) { canvas.width = D.w; canvas.height = D.h; var ctx = canvas.getContext('2d'); ctx.drawImage(c.images[j], 0, 0);
        var x = Math.floor(u / 16) * 16, y = Math.floor(r / 16) * 16; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.strokeRect(x + .5, y + .5, 16, 16);
        ctx.strokeStyle = '#6d28d9'; ctx.lineWidth = 1.5; ctx.strokeRect(x + .5, y + .5, 16, 16); ctx.fillStyle = '#fff'; ctx.fillRect(u - 2, r - 2, 5, 5); ctx.fillStyle = '#6d28d9'; ctx.fillRect(u, r, 1, 1); });
      var i = r * D.w + u, p = Array.from(c.xyz.slice(i * 3, i * 3 + 3)).map(function (x) { return x / 1000; }), ok = c.depth[i] > 0 && p.some(Boolean);
      out.textContent = data.labels[v] + ' · pixel (' + u + ', ' + r + ')  →  ' + (ok ? 'XYZ = (' + p.map(function (x) { return x.toFixed(3); }).join(', ') + ') m · robot base' : 'no valid depth');
      if (W3) overlay(p, ok); root.dataset.pixel = u + ',' + r; root.dataset.camera = v; }

    /* ---- autoplay tour; any interaction pauses it ---- */
    /* autoplay tour until the reader interacts; then it waits (no auto-resume) until they press Autoplay again */
    var si = 0, playing = true, timer = null;
    function setAuto(on) { playing = on; auto.textContent = on ? '❚❚ Pause tour' : '▶ Autoplay'; auto.classList.toggle('on', on); }
    function manual() { setAuto(false); root.classList.remove('mug'); }
    auto.onclick = function () { setAuto(!playing); if (playing) next(); }; setAuto(true);
    function next() { if (!playing) return; var s = stops[si % stops.length]; si++; v = s[0]; u = s[1]; r = s[2]; root.classList.toggle('mug', !!s[3]); draw(); }
    canvases.forEach(function (canvas) {
      canvas.addEventListener('pointerdown', function (e) { manual(); var b = canvas.getBoundingClientRect(), D = cache[v].D; u = Math.floor((e.clientX - b.left) / b.width * D.w); r = Math.floor((e.clientY - b.top) / b.height * D.h); canvas.focus(); draw(); });
      canvas.addEventListener('keydown', function (e) { var step = e.shiftKey ? 16 : 1;
        if (e.key === 'ArrowLeft') u -= step; else if (e.key === 'ArrowRight') u += step; else if (e.key === 'ArrowUp') r -= step; else if (e.key === 'ArrowDown') r += step; else return;
        e.preventDefault(); manual(); draw(); }); });
    function start() { if (splat()) draw(); if (!timer) { next(); timer = setInterval(next, STEP_MS); } }
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { es.forEach(function (x) { if (x.isIntersecting) start(); }); }, { rootMargin: '200px' }).observe(root); else start();
    var drag = null, raf = 0; c3.style.cursor = 'grab';
    function redraw() { raf = 0; if (splat()) draw(); }
    c3.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; c3.setPointerCapture(e.pointerId); c3.style.cursor = 'grabbing'; fast = true; });
    c3.addEventListener('pointermove', function (e) { if (!drag) return; cam.az -= (e.clientX - drag.x) * 0.35; cam.el = Math.max(-5, Math.min(85, cam.el + (e.clientY - drag.y) * 0.3)); drag = { x: e.clientX, y: e.clientY }; setView(); if (!raf) raf = requestAnimationFrame(redraw); });
    function pick(cx, cy) {   /* nearest visible stored point to the click, preferring the nearest depth among close hits */
      if (!pts2) return; var b = c3.getBoundingClientRect(), x = cx - b.left, y = cy - b.top, best = -1, bd = 1e9;
      for (var k = 0; k < pts2.length / 6; k++) { var dx = pts2[k * 6] - x, dy = pts2[k * 6 + 1] - y, d2 = dx * dx + dy * dy; if (d2 > 49) continue; var sc = d2 + pts2[k * 6 + 2] * 40; if (sc < bd) { bd = sc; best = k; } }
      if (best < 0) return; var id = pid[best], ci = Math.floor(id / 65536), i = id % 65536, D = cache[ci].D; manual(); v = ci; u = i % D.w; r = Math.floor(i / D.w); draw(); }
    function endDrag(e) { if (!drag) return; var clicked = e && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4; drag = null; if (clicked) { c3.style.cursor = 'grab'; fast = false; redraw(); pick(e.clientX, e.clientY); return; } c3.style.cursor = 'grab'; fast = false; redraw(); }
    c3.addEventListener('pointerup', endDrag); c3.addEventListener('pointercancel', endDrag);
    c3.addEventListener('wheel', function (e) { e.preventDefault(); cam.d = Math.max(0.8, Math.min(4, cam.d * Math.exp(e.deltaY * 0.001))); setView(); fast = true; if (!raf) raf = requestAnimationFrame(redraw); clearTimeout(c3._wt); c3._wt = setTimeout(function () { fast = false; redraw(); }, 200); }, { passive: false });
    c3.addEventListener('dblclick', function () { cam = { az: VIEW.az, el: VIEW.el, d: VIEW.d }; setView(); redraw(); });
    var rt = null; addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (splat()) draw(); }, 150); });
    draw(); root.__px = { stops: stops, go: function (k) { si = k; setAuto(true); next(); } };
  }
  window.PMPixelInspector = { mount: mount };
})();
