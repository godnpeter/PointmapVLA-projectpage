/* Compact patch-level detail for the section 2 overview. Uses recorded RoboCasa data. */
(function () {
  'use strict';
  var instance = 0;
  var LO = [-0.6, -0.9, -0.5], HI = [0.9, 0.9, 1.2];
  function bytes(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function pmURL(D) { var xyz = new Int16Array(bytes(D.xyz).buffer), dep = new Uint16Array(bytes(D.depth).buffer), c = document.createElement('canvas'); c.width = D.w; c.height = D.h;
    var x = c.getContext('2d'), im = x.createImageData(D.w, D.h);
    for (var i = 0; i < D.w * D.h; i++) { var ok = dep[i] > 0; for (var a = 0; a < 3; a++) im.data[i * 4 + a] = ok ? Math.max(0, Math.min(255, (xyz[i * 3 + a] / 1000 - LO[a]) / (HI[a] - LO[a]) * 255)) : 0; im.data[i * 4 + 3] = 255; }
    x.putImageData(im, 0, 0); return c.toDataURL('image/jpeg', 0.9); }

  function mount(root, PMX) {
    var D = PMX.data[PMX.cams[0]];
    function branch(cx, label, image, kind) {
      var x = cx - 64, y = 193;
      var out = '<image href="' + image + '" x="' + x + '" y="' + y + '" width="128" height="128"/>';
      for (var k = 1; k < 4; k++) {
        out += '<path d="M' + (x+k*32) + ' ' + y + 'v128 M' + x + ' ' + (y+k*32) + 'h128" stroke="white" stroke-opacity=".65"/>';
      }
      out += '<rect class="hl" x="' + (x+32) + '" y="257" width="32" height="32"/>';
      out += '<text class="cap" x="' + cx + '" y="343">' + label + '</text>';
      out += '<polygon class="te ' + kind + '" points="' + x + ',187 ' + (x+128) + ',187 ' + (x+110) + ',133 ' + (x+18) + ',133"/>';
      out += '<text class="en ' + kind + '" x="' + cx + '" y="155">' + (kind==='rgb'?'Vision':'Pointmap') + '</text>';
      out += '<text class="en ' + kind + '" x="' + cx + '" y="173">Encoder</text>';
      out += '<path class="ln" d="M' + cx + ' 127V113" marker-end="url(#pf-detail-arrow)"/>';
      out += '<rect class="tok ' + kind + ' on" x="' + (cx-12) + '" y="82" width="24" height="24" rx="4"/>';
      return out;
    }
    root.innerHTML = '<svg class="pf-svg" viewBox="0 0 500 355" role="img" aria-label="Bottom-to-top flow: matching patches in RoboCasa RGB and pointmap images pass through separate encoders, and their features are added into a fused feature.">' +
      '<defs><marker id="pf-detail-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z" fill="#6d28d9"/></marker></defs>' +
      branch(110, 'RGB image', D.rgb, 'rgb') + branch(390, 'Pointmap', pmURL(D), 'pm') +
      '<path class="ln" d="M110 76V61H235 M390 76V61H265"/>' +
      '<circle class="plus" cx="250" cy="61" r="13"/><path class="pls" d="M242 61h16 M250 53v16"/>' +
      '<path class="ln" d="M250 44V31" marker-end="url(#pf-detail-arrow)"/>' +
      '<rect class="tok fu on" x="237" y="2" width="26" height="26" rx="5"/>' +
      '<text class="cap" x="322" y="20">Fused feature</text></svg>';
    var marker = 'pf-detail-arrow-' + (++instance);
    root.querySelector('svg').innerHTML = root.querySelector('svg').innerHTML.replace(/pf-detail-arrow/g, marker);
  }
  window.PMFuse = { mount: mount };
})();
