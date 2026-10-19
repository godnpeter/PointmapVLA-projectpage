/* pm-fuse-anim.js — section 2 subsection "combining RGB and pointmap tokens": the token-wise addition, animated patch by patch, in the
   visual language of figure 2a (bottom-to-top; grey Vision Encoder, purple Pointmap Encoder; ⊕; PointmapVLA input-token row).
   Per patch k: patch k lights in both images → RGB token and pointmap token appear → ⊕ → one token → token k of the input row lights.
   Real data: left camera of window.PMX. window.PMFuseAnim.mount(root, PMX). */
(function () {
  'use strict';
  var G = 4, N = G * G, LO = [-0.6, -0.9, -0.5], HI = [0.9, 0.9, 1.2], STEP = 2600;
  function bytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function pmURL(D) { var xyz = new Int16Array(bytes(D.xyz).buffer), dep = new Uint16Array(bytes(D.depth).buffer), c = document.createElement('canvas'); c.width = D.w; c.height = D.h;
    var x = c.getContext('2d'), im = x.createImageData(D.w, D.h);
    for (var i = 0; i < D.w * D.h; i++) { var ok = dep[i] > 0; for (var a = 0; a < 3; a++) im.data[i * 4 + a] = ok ? Math.max(0, Math.min(255, (xyz[i * 3 + a] / 1000 - LO[a]) / (HI[a] - LO[a]) * 255)) : 0; im.data[i * 4 + 3] = 255; }
    x.putImageData(im, 0, 0); return c.toDataURL('image/jpeg', 0.9); }

  function mount(root, PMX) {
    var D = PMX.data[PMX.cams[0]], S = 128, L = 125, R = 395, C = 260, yI = 296, s = '';
    function branch(cx, href, kind, l1, l2, cap) { var x = cx - S / 2, g = '';
      for (var k = 1; k < G; k++) g += 'M' + (x + k * S / G) + ' ' + yI + 'v' + S + ' M' + x + ' ' + (yI + k * S / G) + 'h' + S + ' ';
      return '<image href="' + href + '" x="' + x + '" y="' + yI + '" width="' + S + '" height="' + S + '" preserveAspectRatio="none"/><path class="grid" d="' + g + '"/>' +
        '<rect class="hl" width="' + S / G + '" height="' + S / G + '" data-x="' + x + '"/>' +
        '<text class="cap" x="' + cx + '" y="' + (yI + S + 18) + '">' + cap + '</text>' +
        '<polygon class="te ' + kind + '" points="' + (x - 4) + ',290 ' + (x + S + 4) + ',290 ' + (x + S - 16) + ',236 ' + (x + 16) + ',236"/>' +
        '<text class="en ' + kind + '" x="' + cx + '" y="259">' + l1 + '</text><text class="en ' + kind + '" x="' + cx + '" y="276">' + l2 + '</text>' +
        '<path class="ln" d="M' + cx + ' 232V214" marker-end="url(#pfa-arr)"/>' +
        '<rect class="tk ' + kind + '" x="' + (cx - 14) + '" y="184" width="28" height="28" rx="6"/>'; }
    s += '<defs><marker id="pfa-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="#6d28d9"/></marker></defs>';
    var BW = 470, bx = C - BW / 2, tw = (BW - 28 - (N - 1) * 4) / N;
    s += '<rect class="blk" x="' + bx + '" y="6" width="' + BW + '" height="74" rx="14"/><rect class="core" x="' + (bx + 12) + '" y="14" width="' + (BW - 24) + '" height="34" rx="10"/><text class="ct" x="' + C + '" y="37">PointmapVLA</text>';
    for (var k = 0; k < N; k++) s += '<rect class="row r' + k + '" x="' + (bx + 14 + k * (tw + 4)) + '" y="56" width="' + tw + '" height="16" rx="4"/>';
    s += branch(L, D.rgb, 'rgb', 'RGB', 'Encoder', 'RGB image') + branch(R, pmURL(D), 'pm', 'Pointmap', 'Encoder', 'Pointmap');
    s += '<path class="ln j" d="M' + L + ' 182V150H' + (C - 14) + ' M' + R + ' 182V150H' + (C + 14) + '"/><circle class="plus" cx="' + C + '" cy="150" r="14"/><path class="pls" d="M' + (C - 8) + ' 150h16 M' + C + ' 142v16"/>';
    s += '<path class="ln j" d="M' + C + ' 135V122" marker-end="url(#pfa-arr)"/><rect class="tk sum" x="' + (C - 15) + '" y="90" width="30" height="30" rx="6"/>';
    s += '<path class="ln up" d="M' + C + ' 88V84" />';
    s += '<text class="lbl" x="' + (L + 22) + '" y="203">RGB token <tspan class="k">k</tspan></text><text class="lbl" x="' + (R - 22) + '" y="203" text-anchor="end">pointmap token <tspan class="k">k</tspan></text>';
    s += '<text class="lbl s" x="' + (C + 24) + '" y="110">input token <tspan class="k">k</tspan></text>';
    root.innerHTML = '<svg class="pfa" viewBox="0 0 520 448" role="img" aria-label="Patch k of the RGB image and patch k of the pointmap are encoded separately; the two tokens are added into input token k of PointmapVLA."></svg>';
    var svg = root.querySelector('svg'); svg.innerHTML = s;
    var hls = svg.querySelectorAll('.hl'), rows = svg.querySelectorAll('.row'), ks = svg.querySelectorAll('.k'), timers = [], cur = 0, visible = true;
    function at(ms, f) { timers.push(setTimeout(f, ms)); }
    function step() { timers.forEach(clearTimeout); timers = []; var k = cur;
      svg.setAttribute('class', 'pfa'); ks.forEach(function (e) { e.textContent = k + 1; });
      hls.forEach(function (h) { h.setAttribute('x', +h.dataset.x + (k % G) * S / G); h.setAttribute('y', yI + Math.floor(k / G) * S / G); });
      rows.forEach(function (r, j) { r.classList.toggle('done', j < k); r.classList.remove('on'); });
      at(350, function () { svg.classList.add('s1'); });                 /* tokens out of the encoders */
      at(1000, function () { svg.classList.add('s2'); });                /* added at ⊕ */
      at(1550, function () { svg.classList.add('s3'); rows[k].classList.add('on'); });   /* one token → row */
      cur = (k + 1) % N; }
    step(); setInterval(function () { if (visible) step(); }, STEP);
    if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { es.forEach(function (e) { visible = e.isIntersecting; }); }).observe(root);
    root.__pfa = { go: function (k) { cur = k; step(); } };
  }
  window.PMFuseAnim = { mount: mount };
})();
