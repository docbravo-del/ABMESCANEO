/* ABMESCANEO — escáner de documentos a PDF (aplicación web progresiva).
 * Todo el procesamiento ocurre en el dispositivo: las fotos no se envían a ningún servidor.
 * Módulos: utilidades de UI · imágenes (importar, recorte con perspectiva, filtros) ·
 * PDF propio (layout, DNI, numeración, marca de agua) · almacenamiento (IndexedDB) ·
 * editor táctil · flujo principal. */
'use strict';
(function () {

  // =============================================================== constantes
  var SRC_MAX = 3000, OUT_MAX = 2400, SRC_Q = 0.9, OUT_Q = 0.85, VIEW_MAX = 1000, EDIT_MAX = 1400;
  var A4_W = 595.28, A4_H = 841.89, MARGIN = 14, MARGIN_BOTTOM_NUM = 30, NUM_SIZE = 9, NUM_Y = 12;
  var CARD_W = 85.6 * 72 / 25.4, CARD_H = 53.98 * 72 / 25.4, CARD_GAP = 28;
  var WM_OPACITY = 0.22, WM_GRAY = 0.40, NUM_GRAY = 0.35, CAP_HEIGHT = 718;
  var FULL = [0, 0, 1, 0, 1, 1, 0, 1];
  var F_ORIGINAL = 0, F_ENHANCED = 1, F_BW = 2;
  var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function $(id) { return document.getElementById(id); }

  // =============================================================== preferencias
  function load(key, def) {
    try { var v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
  }
  function store(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* sin almacenamiento: se ignora */ }
  }
  var prefs = { numbers: !!load('abm.numbers', false), filter: load('abm.filter', F_ORIGINAL) | 0 };

  // =============================================================== UI básica
  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 3500);
  }

  var busyCount = 0;
  function busy(text) {
    busyCount++;
    $('busyText').textContent = text || 'Procesando…';
    $('busy').hidden = false;
  }
  function busyText(text) { $('busyText').textContent = text; }
  function done() {
    busyCount = Math.max(0, busyCount - 1);
    if (!busyCount) $('busy').hidden = true;
  }

  /** Hoja de opciones. Las acciones se ejecutan de forma sincrónica dentro del toque
   *  (necesario en iOS para abrir la cámara o el menú Compartir). */
  function sheet(opts) {
    var bg = $('sheetBg'), el = $('sheet');
    el.innerHTML = '';
    if (opts.title) { var h = document.createElement('h4'); h.textContent = opts.title; el.appendChild(h); }
    if (opts.message) { var p = document.createElement('p'); p.textContent = opts.message; el.appendChild(p); }
    var closed = false;
    function close() { if (closed) return; closed = true; bg.hidden = true; bg.onclick = null; }
    (opts.actions || []).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'btn ' + (a.style || 'outline');
      b.textContent = a.label;
      b.onclick = function () { close(); if (a.fn) a.fn(); };
      el.appendChild(b);
    });
    if (opts.cancel !== false) {
      var c = document.createElement('button');
      c.className = 'btn text';
      c.textContent = opts.cancel || 'Cancelar';
      c.onclick = function () { close(); if (opts.onCancel) opts.onCancel(); };
      el.appendChild(c);
    }
    bg.onclick = function (e) { if (e.target === bg) { close(); if (opts.onCancel) opts.onCancel(); } };
    bg.hidden = false;
  }
  function choose(title, message, labels) {
    return new Promise(function (resolve) {
      sheet({
        title: title, message: message,
        actions: labels.map(function (l, i) { return { label: l, style: i === 0 ? 'primary' : 'outline', fn: function () { resolve(i); } }; }),
        onCancel: function () { resolve(-1); }
      });
    });
  }
  function confirmBox(title, message, okLabel) {
    return new Promise(function (resolve) {
      sheet({
        title: title, message: message,
        actions: [{ label: okLabel, style: 'danger', fn: function () { resolve(true); } }],
        onCancel: function () { resolve(false); }
      });
    });
  }
  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); });
  }
  function errMsg(e) { return 'Ocurrió un error: ' + ((e && e.message) || e || 'desconocido'); }

  // =============================================================== imágenes
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        resolve({ img: img, w: img.naturalWidth, h: img.naturalHeight, done: function () { URL.revokeObjectURL(url); } });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('no se pudo leer la imagen')); };
      img.src = url;
    });
  }
  function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  /** iOS limita la memoria total de los canvas: se liberan apenas dejan de usarse. */
  function free(c) { if (c) { c.width = 0; c.height = 0; } }
  function toJpeg(c, q) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('no se pudo generar la imagen')); }, 'image/jpeg', q);
    });
  }
  function blobBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /** Foto original: el navegador aplica la rotación EXIF; se limita a SRC_MAX px. */
  function importPhoto(file) {
    return loadImage(file).then(function (im) {
      var s = Math.min(1, SRC_MAX / Math.max(im.w, im.h));
      var c = mkCanvas(im.w * s, im.h * s);
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im.img, 0, 0, c.width, c.height);
      im.done();
      return toJpeg(c, SRC_Q).then(function (b) { free(c); return b; }, function (e) { free(c); throw e; });
    });
  }

  function dist(q, a, b) { return Math.hypot(q[2 * a] - q[2 * b], q[2 * a + 1] - q[2 * b + 1]); }
  function isFull(c) { for (var i = 0; i < 8; i++) if (Math.abs(c[i] - FULL[i]) > 1e-4) return false; return true; }

  /** Resuelve la homografía que lleva src (4 puntos) a dst (4 puntos). */
  function homography(src, dst) {
    var A = [], i, r, k;
    for (i = 0; i < 4; i++) {
      var x = src[2 * i], y = src[2 * i + 1], u = dst[2 * i], v = dst[2 * i + 1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (k = 0; k < 8; k++) {
      var piv = k;
      for (r = k + 1; r < 8; r++) if (Math.abs(A[r][k]) > Math.abs(A[piv][k])) piv = r;
      if (Math.abs(A[piv][k]) < 1e-10) return null;
      var tmp = A[k]; A[k] = A[piv]; A[piv] = tmp;
      for (r = 0; r < 8; r++) {
        if (r === k) continue;
        var f = A[r][k] / A[k][k];
        if (f === 0) continue;
        for (var c = k; c < 9; c++) A[r][c] -= f * A[k][c];
      }
    }
    var h = [];
    for (k = 0; k < 8; k++) h.push(A[k][8] / A[k][k]);
    return h;
  }

  /** Imagen final de una parte: rotación + recorte con perspectiva + filtro. */
  function renderPart(part) {
    return loadImage(part.src).then(function (im) {
      var bw = im.w, bh = im.h;
      var rot = ((part.rot % 360) + 360) % 360;
      var rw = rot % 180 === 0 ? bw : bh, rh = rot % 180 === 0 ? bh : bw;
      var c = part.corners, q = [], i;
      for (i = 0; i < 4; i++) { q.push(c[2 * i] * rw, c[2 * i + 1] * rh); }
      var ow = Math.max(dist(q, 0, 1), dist(q, 3, 2)), oh = Math.max(dist(q, 0, 3), dist(q, 1, 2));
      if (ow < 16 || oh < 16) { c = FULL; ow = rw; oh = rh; }
      var s = Math.min(1, OUT_MAX / Math.max(ow, oh));
      var w = Math.max(1, Math.round(ow * s)), h = Math.max(1, Math.round(oh * s));
      var out = mkCanvas(w, h), ctx = out.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);

      if (isFull(c)) {
        // Sin recorte: alcanza con una transformación del canvas.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.save();
        ctx.scale(w / rw, h / rh);
        if (rot === 90) { ctx.translate(rw, 0); ctx.rotate(Math.PI / 2); }
        else if (rot === 180) { ctx.translate(rw, rh); ctx.rotate(Math.PI); }
        else if (rot === 270) { ctx.translate(0, rh); ctx.rotate(-Math.PI / 2); }
        ctx.drawImage(im.img, 0, 0, bw, bh);
        ctx.restore();
        im.done();
      } else {
        // Recorte con perspectiva: mapeo inverso píxel a píxel con interpolación bilineal.
        var sc = mkCanvas(bw, bh), sctx = sc.getContext('2d');
        sctx.drawImage(im.img, 0, 0, bw, bh);
        im.done();
        var sd = sctx.getImageData(0, 0, bw, bh).data;
        free(sc);
        var srcPts = [];
        for (i = 0; i < 4; i++) {
          var u = c[2 * i], v = c[2 * i + 1], x, y;
          if (rot === 90) { x = v; y = 1 - u; }
          else if (rot === 180) { x = 1 - u; y = 1 - v; }
          else if (rot === 270) { x = 1 - v; y = u; }
          else { x = u; y = v; }
          srcPts.push(x * bw, y * bh);
        }
        var H = homography([0, 0, w, 0, w, h, 0, h], srcPts);
        if (!H) { free(out); throw new Error('las esquinas elegidas no forman una hoja válida'); }
        var od = ctx.createImageData(w, h);
        warp(sd, bw, bh, od.data, w, h, H);
        ctx.putImageData(od, 0, 0);
      }

      if (part.filter === F_ENHANCED || part.filter === F_BW) {
        var id = ctx.getImageData(0, 0, w, h);
        docFilter(id.data, w, h, part.filter);
        ctx.putImageData(id, 0, 0);
      }
      return toJpeg(out, OUT_Q).then(function (blob) {
        free(out);
        part.out = blob;
        part.ow = w;
        part.oh = h;
        part.v = (part.v || 0) + 1;
        return part;
      }, function (e) { free(out); throw e; });
    });
  }

  function warp(sd, bw, bh, od, w, h, H) {
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
    var maxX = bw - 1.001, maxY = bh - 1.001, row = bw * 4, o = 0;
    for (var y = 0; y < h; y++) {
      var yc = y + 0.5;
      for (var x = 0; x < w; x++) {
        var xc = x + 0.5;
        var Z = g * xc + hh * yc + 1;
        var sx = (a * xc + b * yc + c) / Z - 0.5;
        var sy = (d * xc + e * yc + f) / Z - 0.5;
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
        var x0 = sx | 0, y0 = sy | 0, tx = sx - x0, ty = sy - y0;
        var i00 = y0 * row + x0 * 4, i01 = i00 + 4, i10 = i00 + row, i11 = i10 + 4;
        for (var ch = 0; ch < 3; ch++) {
          var p00 = sd[i00 + ch], p01 = sd[i01 + ch], p10 = sd[i10 + ch], p11 = sd[i11 + ch];
          var top = p00 + (p01 - p00) * tx, bot = p10 + (p11 - p10) * tx;
          od[o + ch] = top + (bot - top) * ty;
        }
        od[o + 3] = 255;
        o += 4;
      }
    }
  }

  // --------------------------------------------------------------- filtros de escáner
  var LUT_N = 1024, LUT_COLOR = new Uint8Array(LUT_N + 1), LUT_BW = new Uint8Array(LUT_N + 1);
  (function () {
    for (var i = 0; i <= LUT_N; i++) {
      var n = i / LUT_N;
      var t = (n - 0.12) / (0.90 - 0.12);
      LUT_COLOR[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(Math.pow(t, 1.25) * 255);
      var u = (n - 0.45) / (0.88 - 0.45);
      LUT_BW[i] = u <= 0 ? 0 : u >= 1 ? 255 : Math.round(u * u * (3 - 2 * u) * 255);
    }
  })();

  /** Estima el color del papel por zonas y lo lleva a blanco (quita sombras y tono amarillento). */
  function docFilter(d, w, h, mode) {
    if ((mode !== F_ENHANCED && mode !== F_BW) || w < 2 || h < 2) return;
    var bs = Math.max(8, Math.floor(Math.max(w, h) / 40));
    var gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
    var br = new Float32Array(gw * gh), bg = new Float32Array(gw * gh), bb = new Float32Array(gw * gh);
    var x, y, i, gx, gy;
    for (gy = 0; gy < gh; gy++) {
      var y0 = gy * bs, y1 = Math.min(h, y0 + bs);
      for (gx = 0; gx < gw; gx++) {
        var x0 = gx * bs, x1 = Math.min(w, x0 + bs), sumL = 0, cnt = 0;
        for (y = y0; y < y1; y += 2) for (x = x0; x < x1; x += 2) {
          i = (y * w + x) * 4; sumL += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; cnt++;
        }
        var meanL = cnt ? Math.floor(sumL / cnt) : 255, sr = 0, sg = 0, sb = 0, n = 0;
        for (y = y0; y < y1; y += 2) for (x = x0; x < x1; x += 2) {
          i = (y * w + x) * 4;
          if (((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8) >= meanL) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
        }
        var gi = gy * gw + gx;
        if (n) { br[gi] = sr / n; bg[gi] = sg / n; bb[gi] = sb / n; } else { br[gi] = bg[gi] = bb[gi] = 255; }
      }
    }
    for (var k = 0; k < 2; k++) { br = blur3(br, gw, gh); bg = blur3(bg, gw, gh); bb = blur3(bb, gw, gh); }

    var rowR = new Float32Array(w), rowG = new Float32Array(w), rowB = new Float32Array(w);
    for (y = 0; y < h; y++) {
      var fy = (y + 0.5) / bs - 0.5, yy0 = Math.floor(fy), ty = fy - yy0;
      var ya = clampi(yy0, 0, gh - 1), yb = clampi(yy0 + 1, 0, gh - 1);
      for (x = 0; x < w; x++) {
        var fx = (x + 0.5) / bs - 0.5, xx0 = Math.floor(fx), tx = fx - xx0;
        var xa = clampi(xx0, 0, gw - 1), xb = clampi(xx0 + 1, 0, gw - 1);
        var i00 = ya * gw + xa, i01 = ya * gw + xb, i10 = yb * gw + xa, i11 = yb * gw + xb;
        rowR[x] = bilerp(br[i00], br[i01], br[i10], br[i11], tx, ty);
        rowG[x] = bilerp(bg[i00], bg[i01], bg[i10], bg[i11], tx, ty);
        rowB[x] = bilerp(bb[i00], bb[i01], bb[i10], bb[i11], tx, ty);
      }
      var o = y * w * 4;
      for (x = 0; x < w; x++, o += 4) {
        var r = d[o], g = d[o + 1], b = d[o + 2];
        if (mode === F_ENHANCED) {
          d[o] = LUT_COLOR[lutIdx(r / Math.max(24, rowR[x]))];
          d[o + 1] = LUT_COLOR[lutIdx(g / Math.max(24, rowG[x]))];
          d[o + 2] = LUT_COLOR[lutIdx(b / Math.max(24, rowB[x]))];
        } else {
          var l = (0.299 * r + 0.587 * g + 0.114 * b) / Math.max(24, 0.299 * rowR[x] + 0.587 * rowG[x] + 0.114 * rowB[x]);
          var vv = LUT_BW[lutIdx(l)];
          d[o] = d[o + 1] = d[o + 2] = vv;
        }
      }
    }
  }
  function lutIdx(n) { return n >= 1 ? LUT_N : (n <= 0 ? 0 : (n * LUT_N) | 0); }
  function clampi(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function bilerp(a, b, c, d, tx, ty) { var t = a + (b - a) * tx, u = c + (d - c) * tx; return t + (u - t) * ty; }
  function blur3(s, gw, gh) {
    var d = new Float32Array(s.length);
    for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) {
      var sum = 0;
      for (var dy = -1; dy <= 1; dy++) {
        var yy = clampi(y + dy, 0, gh - 1);
        for (var dx = -1; dx <= 1; dx++) sum += s[yy * gw + clampi(x + dx, 0, gw - 1)];
      }
      d[y * gw + x] = sum / 9;
    }
    return d;
  }

  // =============================================================== PDF
  /* Anchos de Helvetica / Helvetica-Bold (1/1000) en WinAnsiEncoding, códigos 32 a 255. */
  var HELV = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500
  ];
  var HELV_B = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
    556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556
  ];
  var WINANSI_EXTRA = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };

  function toWinAnsi(ch) {
    var c = ch.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7E) return c;
    if (c >= 0xA0 && c <= 0xFF) return c;
    return WINANSI_EXTRA[c] || 63; // '?'
  }
  function textWidth(s, bold) {
    var t = bold ? HELV_B : HELV, w = 0;
    for (var i = 0; i < s.length; i++) { var c = toWinAnsi(s[i]); if (c >= 32 && c <= 255) w += t[c - 32]; }
    return w;
  }

  function layout(isId, infos, o) {
    var l = { pw: A4_W, ph: A4_H, boxes: [] }, i;
    if (isId) {
      var ws = [], hs = [], total = 0;
      for (i = 0; i < infos.length; i++) {
        var ji = infos[i], land = ji.w >= ji.h;
        var bw = land ? CARD_W : CARD_H, bh = land ? CARD_H : CARD_W;
        var s = Math.min(bw / ji.w, bh / ji.h);
        ws.push(ji.w * s); hs.push(ji.h * s); total += ji.h * s;
      }
      total += CARD_GAP * Math.max(0, infos.length - 1);
      var top = l.ph / 2 + total / 2;
      for (i = 0; i < infos.length; i++) {
        var y = top - hs[i];
        l.boxes.push([(l.pw - ws[i]) / 2, y, ws[i], hs[i]]);
        top = y - CARD_GAP;
      }
      return l;
    }
    var j = infos[0], landscape = j.w > j.h;
    l.pw = landscape ? A4_H : A4_W;
    l.ph = landscape ? A4_W : A4_H;
    var bottom = o && o.numbers ? MARGIN_BOTTOM_NUM : MARGIN;
    var aw = l.pw - 2 * MARGIN, ah = l.ph - MARGIN - bottom;
    var sc = Math.min(aw / j.w, ah / j.h), w = j.w * sc, hgt = j.h * sc;
    l.boxes.push([(l.pw - w) / 2, bottom + (ah - hgt) / 2, w, hgt]);
    return l;
  }

  function watermarkGeom(text, pw, ph) {
    var t = text.trim(), angle = Math.atan2(ph, pw), diag = Math.hypot(pw, ph);
    var units = Math.max(1, textWidth(t, true));
    var size = Math.max(14, Math.min(110, 0.72 * diag * 1000 / units));
    var tw = units * size / 1000, cap = CAP_HEIGHT * size / 1000, cos = Math.cos(angle), sin = Math.sin(angle);
    return {
      text: t, size: size, angle: angle, cx: pw / 2, cy: ph / 2,
      x: pw / 2 - (tw / 2) * cos + (cap / 2) * sin,
      y: ph / 2 - (tw / 2) * sin - (cap / 2) * cos
    };
  }
  function pageLabel(i, n) { return 'Página ' + (i + 1) + ' de ' + n; }

  function readJpegInfo(b) {
    if (b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('imagen JPEG inválida');
    var p = 2;
    while (p < b.length) {
      if (b[p] !== 0xFF) { p++; continue; }
      var m = b[p + 1];
      while (m === 0xFF) { p++; m = b[p + 1]; }
      p += 2;
      if (m === 0x00 || m === 0x01 || m === 0xD8 || (m >= 0xD0 && m <= 0xD7)) continue;
      if (m === 0xD9 || m === 0xDA) break;
      var len = (b[p] << 8) | b[p + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { h: (b[p + 3] << 8) | b[p + 4], w: (b[p + 5] << 8) | b[p + 6], comps: b[p + 7] };
      }
      p += len;
    }
    throw new Error('JPEG sin dimensiones');
  }

  function num(v) { return v.toFixed(2); }
  function num4(v) { return v.toFixed(4); }
  function pdfLiteral(s) {
    var out = '(';
    for (var i = 0; i < s.length; i++) {
      var c = toWinAnsi(s[i]);
      if (c === 40 || c === 41 || c === 92) out += '\\' + String.fromCharCode(c);
      else if (c < 32 || c > 126) out += '\\' + ('00' + c.toString(8)).slice(-3);
      else out += String.fromCharCode(c);
    }
    return out + ')';
  }
  function textString(s) {
    var out = '<FEFF';
    for (var i = 0; i < s.length; i++) out += ('000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    return out + '>';
  }
  function ascii(s) {
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
    return u;
  }
  function pdfDate() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
  }

  /** Arma el PDF: cada JPEG se incrusta tal cual (DCTDecode), sin recomprimir. */
  function buildPdf(pages, o, title) {
    var partsList = [];
    pages.forEach(function (p) { p.parts.forEach(function (x) { partsList.push(x); }); });
    return Promise.all(partsList.map(function (x) { return blobBytes(x.out); })).then(function (bytesList) {
      var chunks = [], pos = 0, offsets = [], bi = 0;
      function add(x) { var u = typeof x === 'string' ? ascii(x) : x; chunks.push(u); pos += u.length; }
      var CAT = 1, PAGES = 2, FONT = 3, FONTB = 4, GS = 5, INFO = 6, next = 7;
      var n = pages.length, pageObj = [], contObj = [], imgObj = [];
      pages.forEach(function (p, i) {
        pageObj[i] = next++; contObj[i] = next++; imgObj[i] = [];
        p.parts.forEach(function () { imgObj[i].push(next++); });
      });
      var size = next;

      add('%PDF-1.4\n');
      add(new Uint8Array([37, 0xE2, 0xE3, 0xCF, 0xD3, 10]));
      offsets[CAT] = pos; add(CAT + ' 0 obj\n<< /Type /Catalog /Pages ' + PAGES + ' 0 R >>\nendobj\n');
      offsets[PAGES] = pos;
      add(PAGES + ' 0 obj\n<< /Type /Pages /Kids [' + pageObj.map(function (k) { return k + ' 0 R'; }).join(' ') + '] /Count ' + n + ' >>\nendobj\n');
      offsets[FONT] = pos; add(FONT + ' 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
      offsets[FONTB] = pos; add(FONTB + ' 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');
      offsets[GS] = pos; add(GS + ' 0 obj\n<< /Type /ExtGState /ca ' + num(WM_OPACITY) + ' /CA ' + num(WM_OPACITY) + ' >>\nendobj\n');

      pages.forEach(function (p, i) {
        var bytes = [], infos = [];
        p.parts.forEach(function () { var by = bytesList[bi++]; bytes.push(by); infos.push(readJpegInfo(by)); });
        var l = layout(p.type === 'id', infos, o);
        var xo = infos.map(function (_, k) { return '/Im' + k + ' ' + imgObj[i][k] + ' 0 R '; }).join('');
        offsets[pageObj[i]] = pos;
        add(pageObj[i] + ' 0 obj\n<< /Type /Page /Parent ' + PAGES + ' 0 R /MediaBox [0 0 ' + num(l.pw) + ' ' + num(l.ph) +
          '] /Resources << /XObject << ' + xo + '>> /Font << /F1 ' + FONT + ' 0 R /F2 ' + FONTB + ' 0 R >> /ExtGState << /GS1 ' + GS +
          ' 0 R >> /ProcSet [/PDF /Text /ImageB /ImageC] >> /Contents ' + contObj[i] + ' 0 R >>\nendobj\n');

        var c = '';
        l.boxes.forEach(function (b, k) {
          c += 'q\n' + num(b[2]) + ' 0 0 ' + num(b[3]) + ' ' + num(b[0]) + ' ' + num(b[1]) + ' cm\n/Im' + k + ' Do\nQ\n';
        });
        if (o.watermark) {
          var wm = watermarkGeom(o.watermark, l.pw, l.ph), cs = Math.cos(wm.angle), sn = Math.sin(wm.angle);
          c += 'q\n/GS1 gs\n' + num(WM_GRAY) + ' g\nBT\n/F2 ' + num(wm.size) + ' Tf\n' + num4(cs) + ' ' + num4(sn) + ' ' +
            num4(-sn) + ' ' + num4(cs) + ' ' + num(wm.x) + ' ' + num(wm.y) + ' Tm\n' + pdfLiteral(wm.text) + ' Tj\nET\nQ\n';
        }
        if (o.numbers) {
          var label = pageLabel(i, n), tw = textWidth(label, false) * NUM_SIZE / 1000;
          c += 'q\n' + num(NUM_GRAY) + ' g\nBT\n/F1 ' + num(NUM_SIZE) + ' Tf\n' + num((l.pw - tw) / 2) + ' ' + num(NUM_Y) +
            ' Td\n' + pdfLiteral(label) + ' Tj\nET\nQ\n';
        }
        offsets[contObj[i]] = pos;
        add(contObj[i] + ' 0 obj\n<< /Length ' + c.length + ' >>\nstream\n');
        add(c);
        add('endstream\nendobj\n');

        bytes.forEach(function (by, k) {
          var ji = infos[k];
          var cspace = ji.comps === 1 ? '/DeviceGray' : ji.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
          offsets[imgObj[i][k]] = pos;
          add(imgObj[i][k] + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + ji.w + ' /Height ' + ji.h +
            ' /ColorSpace ' + cspace + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + by.length + ' >>\nstream\n');
          add(by);
          add('\nendstream\nendobj\n');
        });
      });

      offsets[INFO] = pos;
      add(INFO + ' 0 obj\n<< /Title ' + textString(title) + ' /Producer (ABMESCANEO) /Creator (ABMESCANEO) /CreationDate (D:' +
        pdfDate() + ') >>\nendobj\n');
      var xref = pos, x = 'xref\n0 ' + size + '\n0000000000 65535 f \n';
      for (var k = 1; k < size; k++) x += ('0000000000' + offsets[k]).slice(-10) + ' 00000 n \n';
      x += 'trailer\n<< /Size ' + size + ' /Root ' + CAT + ' 0 R /Info ' + INFO + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
      add(x);
      return new Blob(chunks, { type: 'application/pdf' });
    });
  }

  // =============================================================== almacenamiento (IndexedDB)
  var DB = {
    db: null,
    open: function () {
      var self = this;
      return new Promise(function (resolve) {
        try {
          var r = indexedDB.open('abmescaneo', 1);
          r.onupgradeneeded = function () { r.result.createObjectStore('pages', { keyPath: 'id' }); };
          r.onsuccess = function () { self.db = r.result; resolve(true); };
          r.onerror = function () { resolve(false); };
          r.onblocked = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    },
    run: function (mode, fn) {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (!self.db) { resolve(null); return; }
        var t = self.db.transaction('pages', mode), req = fn(t.objectStore('pages'));
        t.oncomplete = function () { resolve(req ? req.result : null); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('almacenamiento cancelado')); };
      });
    },
    all: function () { return this.run('readonly', function (s) { return s.getAll(); }); },
    put: function (rec) { return this.run('readwrite', function (s) { return s.put(rec); }); },
    del: function (id) { return this.run('readwrite', function (s) { return s.delete(id); }); },
    clear: function () { return this.run('readwrite', function (s) { return s.clear(); }); }
  };
  var persistWarned = false;
  function persist(page) {
    if (!DB.db) return Promise.resolve();
    return Promise.all(page.parts.map(function (x) {
      return Promise.all([blobBytes(x.src), blobBytes(x.out)]).then(function (b) {
        return { src: b[0].buffer, out: b[1].buffer, corners: x.corners, rot: x.rot, filter: x.filter, ow: x.ow, oh: x.oh };
      });
    })).then(function (parts) {
      return DB.put({ id: page.id, type: page.type, parts: parts });
    }).catch(function () {
      if (!persistWarned) { persistWarned = true; toast('Aviso: no se pudo guardar el progreso en el teléfono (espacio).'); }
    });
  }
  function fromRecord(r) {
    return {
      id: r.id, type: r.type === 'id' ? 'id' : 'single',
      parts: (r.parts || []).map(function (x) {
        return {
          src: new Blob([x.src], { type: 'image/jpeg' }), out: new Blob([x.out], { type: 'image/jpeg' }),
          corners: x.corners || FULL.slice(), rot: x.rot | 0, filter: x.filter | 0, ow: x.ow, oh: x.oh, v: 1
        };
      })
    };
  }

  // =============================================================== estado del documento
  var st = { pages: [], sel: -1, delivered: false, capture: null, pdf: { key: null, blob: null }, building: null, pdfTimer: 0 };
  var seq = 0;
  function newPage(type) {
    var id = ('0000000000000' + Date.now()).slice(-13) + '_' + ('00' + (seq++ % 1000)).slice(-3);
    return { id: id, type: type, parts: [] };
  }
  function findPage(id) { for (var i = 0; i < st.pages.length; i++) if (st.pages[i].id === id) return st.pages[i]; return null; }
  function options() { return { numbers: $('swNumbers').checked, watermark: $('wmInput').value.trim() }; }
  function defaultName() {
    var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'Documento ' + z(d.getDate()) + '-' + z(d.getMonth() + 1) + '-' + d.getFullYear() + ' ' + z(d.getHours()) + '.' + z(d.getMinutes());
  }
  function baseName() {
    var n = ($('nameInput').value || '').trim();
    if (/\.pdf$/i.test(n)) n = n.slice(0, -4).trim();
    n = n.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/^\.+/, '');
    if (n.length > 80) n = n.slice(0, 80).trim();
    if (!n) { n = defaultName(); $('nameInput').value = n; }
    return n;
  }
  function saveMeta() {
    store('abm.doc', { name: $('nameInput').value, wm: $('wmInput').value, sel: st.sel, delivered: st.delivered });
  }
  function fmtSize(b) {
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }

  // =============================================================== vista previa
  var viewCache = {};
  function partView(page, idx) {
    var part = page.parts[idx], key = page.id + ':' + idx + ':' + part.v;
    if (viewCache[key]) return Promise.resolve(viewCache[key]);
    return loadImage(part.out).then(function (im) {
      var s = Math.min(1, VIEW_MAX / Math.max(im.w, im.h));
      var c = mkCanvas(im.w * s, im.h * s), ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(im.img, 0, 0, c.width, c.height);
      im.done();
      var prefix = page.id + ':' + idx + ':';
      Object.keys(viewCache).forEach(function (k) { if (k.indexOf(prefix) === 0) { free(viewCache[k]); delete viewCache[k]; } });
      viewCache[key] = c;
      return c;
    });
  }
  function dropViews(pageId) {
    Object.keys(viewCache).forEach(function (k) {
      if (!pageId || k.indexOf(pageId + ':') === 0) { free(viewCache[k]); delete viewCache[k]; }
    });
  }

  /** Dibuja la página tal como va a quedar en el PDF (mismo layout). */
  function drawPage(target, page, o, i, n, targetW, stillValid) {
    return Promise.all(page.parts.map(function (_, k) { return partView(page, k); })).then(function (views) {
      if (stillValid && !stillValid()) return;
      var infos = page.parts.map(function (x) { return { w: x.ow, h: x.oh }; });
      var l = layout(page.type === 'id', infos, o), sc = targetW / l.pw;
      target.width = Math.round(targetW);
      target.height = Math.round(l.ph * sc);
      var ctx = target.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, target.width, target.height);
      ctx.imageSmoothingQuality = 'high';
      l.boxes.forEach(function (b, k) {
        ctx.drawImage(views[k], b[0] * sc, (l.ph - b[1] - b[3]) * sc, b[2] * sc, b[3] * sc);
      });
      if (o.watermark) {
        var wm = watermarkGeom(o.watermark, l.pw, l.ph), g = Math.round(WM_GRAY * 255);
        ctx.save();
        ctx.translate(wm.cx * sc, (l.ph - wm.cy) * sc);
        ctx.rotate(-wm.angle);
        ctx.font = 'bold ' + (wm.size * sc) + 'px Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',' + WM_OPACITY + ')';
        ctx.fillText(wm.text, 0, CAP_HEIGHT / 1000 * wm.size * sc / 2);
        ctx.restore();
      }
      if (o.numbers) {
        var gn = Math.round(NUM_GRAY * 255);
        ctx.font = (NUM_SIZE * sc) + 'px Helvetica, Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgb(' + gn + ',' + gn + ',' + gn + ')';
        ctx.fillText(pageLabel(i, n), l.pw / 2 * sc, (l.ph - NUM_Y) * sc);
      }
    });
  }

  function showEmpty() { $('result').hidden = true; $('empty').hidden = false; }
  function showResult() {
    var wasHidden = $('result').hidden;
    $('empty').hidden = true;
    $('result').hidden = false;
    if (wasHidden) $('scroll').scrollTop = 0;
  }

  var refreshSeq = 0;
  function refresh() {
    var my = ++refreshSeq, n = st.pages.length;
    saveMeta();
    if (!n) { showEmpty(); return Promise.resolve(); }
    if (st.sel < 0 || st.sel >= n) st.sel = n - 1;
    showResult();
    var o = options(), page = st.pages[st.sel];
    $('pageLabel').textContent = 'Página ' + (st.sel + 1) + ' de ' + n + (page.type === 'id' ? ' · DNI' : '');
    var dpr = window.devicePixelRatio || 1;
    var box = $('previewCanvas').parentElement;
    var targetW = Math.max(200, Math.min(VIEW_MAX, Math.round((box.clientWidth - 20) * dpr)));
    var valid = function () { return my === refreshSeq; };
    schedulePdf();

    var thumbs = $('thumbs');
    thumbs.innerHTML = '';
    thumbs.hidden = n < 2;
    var canvases = [];
    if (n > 1) {
      st.pages.forEach(function (p, i) {
        var d = document.createElement('button');
        d.className = 'thumb' + (i === st.sel ? ' sel' : '');
        d.setAttribute('aria-label', 'Página ' + (i + 1));
        var c = document.createElement('canvas');
        c.width = 10; c.height = 14;
        d.appendChild(c);
        d.onclick = function () { if (i !== st.sel) { st.sel = i; refresh(); } };
        thumbs.appendChild(d);
        canvases.push(c);
      });
    }
    return drawPage($('previewCanvas'), page, o, st.sel, n, targetW, valid).then(function () {
      var chain = Promise.resolve();
      canvases.forEach(function (c, i) {
        chain = chain.then(function () {
          if (!valid()) return;
          return drawPage(c, st.pages[i], o, i, n, Math.round(60 * dpr), valid);
        });
      });
      return chain;
    }).catch(function (e) { toast(errMsg(e)); });
  }

  // =============================================================== PDF listo para compartir
  function pdfKey() {
    return JSON.stringify([st.pages.map(function (p) { return p.id + ':' + p.parts.map(function (x) { return x.v; }).join(','); }), options(), baseName()]);
  }
  function setBadge(ready) {
    var n = st.pages.length;
    $('badge').classList.toggle('wait', !ready);
    $('badgeText').textContent = ready && st.pdf.blob
      ? 'PDF listo · ' + (n === 1 ? '1 página' : n + ' páginas') + ' · ' + fmtSize(st.pdf.blob.size)
      : 'Preparando PDF…';
  }
  function schedulePdf() {
    clearTimeout(st.pdfTimer);
    if (!st.pages.length) return;
    if (st.pdf.key === pdfKey() && st.pdf.blob) { setBadge(true); return; }
    setBadge(false);
    st.pdfTimer = setTimeout(function () { ensurePdf().catch(function () {}); }, 350);
  }
  function ensurePdf() {
    var key = pdfKey();
    if (st.pdf.key === key && st.pdf.blob) { setBadge(true); return Promise.resolve(st.pdf.blob); }
    if (st.building && st.building.key === key) return st.building.promise;
    var promise = buildPdf(st.pages.slice(), options(), baseName()).then(function (blob) {
      if (pdfKey() === key) { st.pdf = { key: key, blob: blob }; setBadge(true); }
      return blob;
    });
    st.building = { key: key, promise: promise };
    var clear = function () { if (st.building && st.building.key === key) st.building = null; };
    promise.then(clear, clear);
    return promise;
  }

  var LABELS = { save: 'Guardar en el iPhone', whatsapp: 'Enviar por WhatsApp', other: 'Compartir' };
  function onSend(kind) {
    if (!st.pages.length) return;
    var key = pdfKey();
    if (st.pdf.key === key && st.pdf.blob) { deliver(kind, st.pdf.blob); return; }
    busy('Generando PDF…');
    ensurePdf().then(function (blob) {
      done();
      // El menú Compartir de iOS exige un toque "fresco": se pide confirmar.
      sheet({ title: 'PDF listo', actions: [{ label: LABELS[kind], style: kind === 'whatsapp' ? 'whats' : 'primary', fn: function () { deliver(kind, blob); } }] });
    }, function (e) { done(); toast(errMsg(e)); });
  }
  function download(file) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  function deliver(kind, blob) {
    var file = new File([blob], baseName() + '.pdf', { type: 'application/pdf', lastModified: Date.now() });
    var canShare = false;
    try { canShare = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { canShare = false; }
    if (kind === 'save' && !IS_IOS) {
      download(file); st.delivered = true; saveMeta(); toast('PDF descargado: ' + file.name); return;
    }
    if (canShare) {
      if (kind === 'save') toast('En el menú, elegí «Guardar en Archivos»', 5000);
      else if (kind === 'whatsapp') toast('En el menú, elegí WhatsApp', 5000);
      navigator.share({ files: [file] }).then(function () {
        st.delivered = true; saveMeta();
      }, function (err) {
        if (err && err.name === 'AbortError') return;
        if (err && err.name === 'NotAllowedError') {
          sheet({ title: 'PDF listo', actions: [{ label: LABELS[kind], style: 'primary', fn: function () { deliver(kind, blob); } }] });
          return;
        }
        download(file); st.delivered = true; saveMeta();
        toast('No se pudo abrir el menú Compartir: se descargó el PDF.');
      });
      return;
    }
    download(file); st.delivered = true; saveMeta();
    toast(kind === 'whatsapp' ? 'Este navegador no permite compartir archivos: se descargó el PDF para adjuntarlo en WhatsApp.' : 'PDF descargado: ' + file.name, 6000);
  }

  // =============================================================== editor táctil
  var Editor = (function () {
    var cv = $('cropCanvas'), stage = $('stage'), chips = document.querySelectorAll('.chip');
    var part = null, resolver = null, base = null, disp = null, rot = 0, filter = 0, corners = FULL.slice();
    var active = -1, grabX = 0, grabY = 0, rect = { x: 0, y: 0, w: 0, h: 0 }, token = 0, dpr = 1;

    function spin(on) { $('edSpin').hidden = !on; }
    function updateChips() { chips.forEach(function (c) { c.classList.toggle('sel', (c.getAttribute('data-f') | 0) === filter); }); }

    function open(p, title) {
      part = p; rot = p.rot | 0; filter = p.filter | 0; corners = p.corners.slice(); active = -1;
      $('edTitle').textContent = title;
      $('editor').hidden = false;
      updateChips();
      spin(true);
      var pr = new Promise(function (r) { resolver = r; });
      fit(); draw();
      loadImage(p.src).then(function (im) {
        if (part !== p) { im.done(); return; }
        var s = Math.min(1, EDIT_MAX / Math.max(im.w, im.h));
        base = mkCanvas(im.w * s, im.h * s);
        var ctx = base.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(im.img, 0, 0, base.width, base.height);
        im.done();
        return updateDisplay();
      }).catch(function (e) { toast(errMsg(e)); finish(null); });
      return pr;
    }

    function rotated(src, deg) {
      var c = deg % 180 ? mkCanvas(src.height, src.width) : mkCanvas(src.width, src.height), ctx = c.getContext('2d');
      if (deg === 90) { ctx.translate(c.width, 0); ctx.rotate(Math.PI / 2); }
      else if (deg === 180) { ctx.translate(c.width, c.height); ctx.rotate(Math.PI); }
      else if (deg === 270) { ctx.translate(0, c.height); ctx.rotate(-Math.PI / 2); }
      ctx.drawImage(src, 0, 0);
      return c;
    }

    function updateDisplay() {
      if (!base) return Promise.resolve();
      var my = ++token;
      spin(true);
      return nextFrame().then(function () {
        if (my !== token || !base) return;
        var d = rotated(base, rot);
        if (filter) {
          var ctx = d.getContext('2d'), id = ctx.getImageData(0, 0, d.width, d.height);
          docFilter(id.data, d.width, d.height, filter);
          ctx.putImageData(id, 0, 0);
        }
        if (my !== token) { free(d); return; }
        if (disp && disp !== base) free(disp);
        disp = d;
        spin(false);
        fit(); draw();
      });
    }

    function fit() {
      dpr = window.devicePixelRatio || 1;
      var cw = stage.clientWidth, ch = stage.clientHeight;
      cv.width = Math.max(1, Math.round(cw * dpr));
      cv.height = Math.max(1, Math.round(ch * dpr));
      if (!disp) { rect = { x: 0, y: 0, w: 0, h: 0 }; return; }
      var pad = 22, s = Math.min((cw - 2 * pad) / disp.width, (ch - 2 * pad) / disp.height);
      var w = disp.width * s, h = disp.height * s;
      rect = { x: (cw - w) / 2, y: (ch - h) / 2, w: w, h: h };
    }
    function px(i) { return rect.x + corners[2 * i] * rect.w; }
    function py(i) { return rect.y + corners[2 * i + 1] * rect.h; }
    function quadPath(ctx) {
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (var i = 1; i < 4; i++) ctx.lineTo(px(i), py(i));
      ctx.closePath();
    }

    function draw() {
      var ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!disp || !rect.w) return;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(disp, rect.x, rect.y, rect.w, rect.h);
      // oscurece lo que queda fuera del recorte
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.moveTo(px(0), py(0));
      for (var i = 1; i < 4; i++) ctx.lineTo(px(i), py(i));
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fill('evenodd');
      quadPath(ctx);
      ctx.strokeStyle = '#3D8BFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      for (i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(px(i), py(i), 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(61,139,255,0.33)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      if (active >= 0) drawLoupe(ctx);
    }

    function drawLoupe(ctx) {
      var cw = cv.width / dpr, ch = cv.height / dpr, lr = 58, zoom = 2.2, m = 16;
      var ax = px(active), ay = py(active);
      var lx = ax < cw / 2 ? cw - m - lr : m + lr, ly = m + lr;
      if (ay < 3 * lr) ly = ch - m - lr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, lr, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#000';
      ctx.fillRect(lx - lr, ly - lr, 2 * lr, 2 * lr);
      ctx.translate(lx, ly);
      ctx.scale(zoom, zoom);
      ctx.translate(-ax, -ay);
      ctx.drawImage(disp, rect.x, rect.y, rect.w, rect.h);
      quadPath(ctx);
      ctx.strokeStyle = '#3D8BFF';
      ctx.lineWidth = 2.5 / zoom;
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly);
      ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10);
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(lx, ly, lr, 0, Math.PI * 2);
      ctx.stroke();
    }

    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    cv.addEventListener('pointerdown', function (e) {
      if (!disp) return;
      var p = pos(e), best = 44;
      active = -1;
      for (var i = 0; i < 4; i++) {
        var d = Math.hypot(p.x - px(i), p.y - py(i));
        if (d < best) { best = d; active = i; }
      }
      if (active < 0) return;
      grabX = px(active) - p.x;
      grabY = py(active) - p.y;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignorar */ }
      e.preventDefault();
      draw();
    });
    cv.addEventListener('pointermove', function (e) {
      if (active < 0) return;
      var p = pos(e);
      corners[2 * active] = Math.max(0, Math.min(1, (p.x + grabX - rect.x) / rect.w));
      corners[2 * active + 1] = Math.max(0, Math.min(1, (p.y + grabY - rect.y) / rect.h));
      e.preventDefault();
      draw();
    });
    function up() { if (active >= 0) { active = -1; draw(); } }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    window.addEventListener('resize', function () { if (!$('editor').hidden) { fit(); draw(); } });

    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        var f = c.getAttribute('data-f') | 0;
        if (f === filter) return;
        filter = f; updateChips(); updateDisplay();
      });
    });
    $('edRotate').addEventListener('click', function () {
      var o = corners, n = [];
      for (var i = 0; i < 4; i++) { var j = (i + 3) % 4; n.push(1 - o[2 * j + 1], o[2 * j]); }
      corners = n;
      rot = (rot + 90) % 360;
      updateDisplay();
    });
    $('edFull').addEventListener('click', function () { corners = FULL.slice(); draw(); });
    $('edApply').addEventListener('click', function () { finish({ corners: normalizeOrder(corners), rot: rot, filter: filter }); });
    $('edCancel').addEventListener('click', function () { finish(null); });

    function finish(res) {
      $('editor').hidden = true;
      token++;
      if (disp && disp !== base) free(disp);
      free(base);
      base = disp = null; part = null;
      var r = resolver;
      resolver = null;
      if (r) r(res);
    }
    return { open: open };
  })();

  /** Reordena las esquinas (sup-izq, sup-der, inf-der, inf-izq) por si se cruzaron. */
  function normalizeOrder(c) {
    var cx = (c[0] + c[2] + c[4] + c[6]) / 4, cy = (c[1] + c[3] + c[5] + c[7]) / 4;
    var idx = [0, 1, 2, 3].sort(function (a, b) {
      return Math.atan2(c[2 * a + 1] - cy, c[2 * a] - cx) - Math.atan2(c[2 * b + 1] - cy, c[2 * b] - cx);
    });
    var start = 0, best = Infinity;
    idx.forEach(function (i, k) { var s = c[2 * i] + c[2 * i + 1]; if (s < best) { best = s; start = k; } });
    var out = [];
    for (var k = 0; k < 4; k++) { var i = idx[(start + k) % 4]; out.push(c[2 * i], c[2 * i + 1]); }
    return out;
  }

  // =============================================================== flujo principal
  function addImage(page, idx, file, filter) {
    return importPhoto(file).then(function (src) {
      var part = { src: src, corners: FULL.slice(), rot: 0, filter: filter, v: 0 };
      return renderPart(part).then(function () { page.parts[idx] = part; });
    });
  }

  function startCapture(mode, targetId) {
    st.capture = { mode: mode, targetId: targetId || null };
    var f = $('fileCam');
    f.value = '';
    f.click();
  }
  function pickGallery() {
    var f = $('fileLib');
    f.value = '';
    f.click();
  }

  function onCaptured(file, cap) {
    var page, idx, isNew = false;
    if (cap.mode === 'back') {
      page = findPage(cap.targetId); idx = 1;
      if (!page) { page = newPage('single'); idx = 0; isNew = true; }
    } else {
      page = newPage(cap.mode === 'front' ? 'id' : 'single'); idx = 0; isNew = true;
    }
    busy('Procesando…');
    return nextFrame().then(function () {
      return addImage(page, idx, file, page.type === 'id' ? F_ORIGINAL : prefs.filter);
    }).then(function () {
      if (isNew) st.pages.push(page);
      st.sel = st.pages.indexOf(page);
      st.delivered = false;
      return persist(page);
    }).then(function () {
      done();
      return refresh();
    }).then(function () {
      return editPart(page, idx);
    }).then(function () {
      if (cap.mode === 'front') {
        sheet({
          title: 'DNI · Dorso', message: 'Frente listo. Ahora sacá una foto del dorso del DNI.',
          actions: [{ label: 'Sacar dorso', style: 'primary', fn: function () { startCapture('back', page.id); } }],
          cancel: 'Solo frente'
        });
      }
    }, function (e) { done(); toast(errMsg(e)); });
  }

  function editPart(page, idx) {
    var part = page.parts[idx];
    if (!part) return Promise.resolve();
    var title = page.type === 'id' ? (idx === 0 ? 'DNI · Frente' : 'DNI · Dorso') : 'Ajustar página ' + (st.pages.indexOf(page) + 1);
    return Editor.open(part, title).then(function (res) {
      if (!res) return;
      part.corners = res.corners; part.rot = res.rot; part.filter = res.filter;
      busy('Procesando…');
      return nextFrame().then(function () { return renderPart(part); }).then(function () {
        if (page.type !== 'id') { prefs.filter = res.filter; store('abm.filter', res.filter); }
        st.delivered = false;
        return persist(page);
      }).then(function () { done(); return refresh(); }, function (e) { done(); toast(errMsg(e)); return refresh(); });
    });
  }

  function importFiles(files, asId) {
    var added = [], failed = 0, chain;
    busy('Importando imágenes…');
    if (asId) {
      var page = newPage('id'), idx = 0;
      chain = files.slice(0, 2).reduce(function (p, f) {
        return p.then(function () { return nextFrame(); }).then(function () {
          return addImage(page, idx, f, F_ORIGINAL).then(function () { idx++; }, function () { failed++; });
        });
      }, Promise.resolve()).then(function () {
        if (idx > 0) { st.pages.push(page); added.push(page); return persist(page); }
      });
    } else {
      chain = files.reduce(function (p, f, i) {
        return p.then(function () {
          busyText('Importando ' + (i + 1) + ' de ' + files.length + '…');
          return nextFrame();
        }).then(function () {
          var page = newPage('single');
          return addImage(page, 0, f, prefs.filter).then(function () {
            st.pages.push(page); added.push(page); return persist(page);
          }, function () { failed++; });
        });
      }, Promise.resolve());
    }
    return chain.then(function () {
      done();
      if (failed) toast(failed + ' imagen(es) no se pudieron leer.');
      if (!added.length) return;
      st.sel = st.pages.indexOf(added[added.length - 1]);
      st.delivered = false;
      return refresh().then(function () {
        if (asId) {
          return editPart(added[0], 0).then(function () { if (added[0].parts[1]) return editPart(added[0], 1); });
        }
        if (files.length === 1) return editPart(added[0], 0);
      });
    }, function (e) { done(); toast(errMsg(e)); });
  }

  function resetDoc() {
    st.pages = []; st.sel = -1; st.delivered = false; st.pdf = { key: null, blob: null };
    dropViews(null);
    DB.clear().catch(function () {});
    $('nameInput').value = defaultName();
    $('wmInput').value = '';
    saveMeta();
    showEmpty();
    $('scroll').scrollTop = 0;
  }

  // =============================================================== eventos
  $('btnTake').addEventListener('click', function () { startCapture('single'); });
  $('btnGallery').addEventListener('click', pickGallery);
  $('btnDni').addEventListener('click', function () { startCapture('front'); });

  $('fileCam').addEventListener('change', function () {
    var f = $('fileCam'), file = f.files && f.files[0], cap = st.capture || { mode: 'single' };
    st.capture = null;
    if (!file) return;
    onCaptured(file, cap);
    f.value = '';
  });
  $('fileLib').addEventListener('change', function () {
    var f = $('fileLib'), files = Array.prototype.slice.call(f.files || []);
    f.value = '';
    if (!files.length) return;
    if (files.length === 2) {
      choose('¿Cómo agrego las 2 imágenes?', '', ['Como 2 páginas', 'DNI: frente y dorso en una hoja']).then(function (c) {
        if (c >= 0) importFiles(files, c === 1);
      });
    } else {
      importFiles(files, false);
    }
  });

  $('btnEditPage').addEventListener('click', function () {
    var p = st.pages[st.sel];
    if (!p) return;
    if (p.type !== 'id') { editPart(p, 0); return; }
    sheet({
      actions: [
        { label: 'Ajustar frente', fn: function () { editPart(p, 0); } },
        p.parts[1]
          ? { label: 'Ajustar dorso', fn: function () { editPart(p, 1); } }
          : { label: 'Sacar foto del dorso', fn: function () { startCapture('back', p.id); } }
      ]
    });
  });
  $('btnDeletePage').addEventListener('click', function () {
    var p = st.pages[st.sel];
    if (!p) return;
    confirmBox('Eliminar página', '¿Querés eliminar la página ' + (st.sel + 1) + '?', 'Eliminar').then(function (ok) {
      if (!ok) return;
      var i = st.pages.indexOf(p);
      if (i >= 0) st.pages.splice(i, 1);
      dropViews(p.id);
      DB.del(p.id).catch(function () {});
      st.sel = Math.max(0, st.sel - 1);
      st.delivered = false;
      refresh();
    });
  });
  $('btnAdd').addEventListener('click', function () {
    sheet({
      title: 'Agregar página',
      actions: [
        { label: 'Sacar foto', style: 'primary', fn: function () { startCapture('single'); } },
        { label: 'Elegir de Fotos', fn: pickGallery },
        { label: 'DNI (frente y dorso en una hoja)', fn: function () { startCapture('front'); } }
      ]
    });
  });
  $('btnNew').addEventListener('click', function () {
    if (st.delivered) { resetDoc(); return; }
    confirmBox('Nuevo documento', 'Se descartará el PDF actual. Si no lo guardaste ni lo enviaste, se pierde.', 'Descartar')
      .then(function (ok) { if (ok) resetDoc(); });
  });
  $('btnSave').addEventListener('click', function () { onSend('save'); });
  $('btnWhats').addEventListener('click', function () { onSend('whatsapp'); });
  $('btnShare').addEventListener('click', function () { onSend('other'); });

  $('swNumbers').addEventListener('change', function () {
    prefs.numbers = $('swNumbers').checked;
    store('abm.numbers', prefs.numbers);
    st.delivered = false;
    refresh();
  });
  var shownWm = '';
  function wmChanged() {
    var w = $('wmInput').value.trim();
    if (w === shownWm) return;
    shownWm = w;
    st.delivered = false;
    refresh();
  }
  $('wmInput').addEventListener('change', wmChanged);
  $('wmInput').addEventListener('blur', wmChanged);
  [$('wmInput'), $('nameInput')].forEach(function (el) {
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
  });
  var nameTimer = 0;
  $('nameInput').addEventListener('input', function () {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(function () { saveMeta(); schedulePdf(); }, 400);
  });
  $('nameInput').addEventListener('blur', function () { baseName(); saveMeta(); schedulePdf(); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveMeta(); });

  // =============================================================== arranque
  function init() {
    $('swNumbers').checked = prefs.numbers;
    var standalone = navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (IS_IOS && !standalone && !load('abm.tipClosed', false)) $('installTip').hidden = false;
    $('installClose').addEventListener('click', function () { $('installTip').hidden = true; store('abm.tipClosed', true); });

    DB.open().then(function (ok) {
      return ok ? DB.all().catch(function () { return []; }) : [];
    }).then(function (recs) {
      recs = (recs || []).slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      st.pages = recs.map(fromRecord).filter(function (p) { return p.parts.length && p.parts[0].out; });
      var meta = load('abm.doc', null);
      if (st.pages.length && meta) {
        $('nameInput').value = meta.name || defaultName();
        $('wmInput').value = meta.wm || '';
        shownWm = $('wmInput').value.trim();
        st.sel = typeof meta.sel === 'number' ? meta.sel : st.pages.length - 1;
        st.delivered = !!meta.delivered;
      } else {
        $('nameInput').value = defaultName();
      }
      if (st.pages.length) {
        refresh();
        toast('Se recuperó el documento en curso.');
      } else {
        showEmpty();
      }
    });

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* sin modo offline */ });
    }
  }

  // Para pruebas automatizadas (no afecta el uso normal).
  window.__abm = { st: st, buildPdf: buildPdf, docFilter: docFilter, layout: layout, normalizeOrder: normalizeOrder };

  init();
})();
