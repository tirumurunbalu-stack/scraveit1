/* Scraveit call reactions: animated effects over a video call, and hand-gesture detection.
 *
 * Reactions mirror what people know from iPhone FaceTime: thumbs up, two thumbs up for
 * fireworks, peace for balloons, two peace signs for confetti, heart hands for hearts,
 * two thumbs down for rain and rock-on for lasers. They play on both phones (the call
 * sends the reaction over its data channel). Gestures are read on this phone only, by
 * Google's MediaPipe model; no video leaves the phone for this.
 */
(function () {
  "use strict";

  const REACTIONS = [
    { id: "thumbs", emoji: "👍", name: "Thumbs up", how: "Thumbs up" },
    { id: "hearts", emoji: "🫶", name: "Hearts", how: "Heart hands" },
    { id: "balloons", emoji: "🎈", name: "Balloons", how: "Peace sign ✌️" },
    { id: "confetti", emoji: "🎉", name: "Confetti", how: "Two peace signs" },
    { id: "fireworks", emoji: "🎆", name: "Fireworks", how: "Two thumbs up" },
    { id: "lasers", emoji: "🤘", name: "Lasers", how: "Rock on 🤘 or 🤟" },
    { id: "rain", emoji: "🌧️", name: "Rain", how: "Two thumbs down" },
    { id: "thumbsdown", emoji: "👎", name: "Thumbs down", how: "Thumbs down" }
  ];
  const DURATION = { thumbs: 2.4, thumbsdown: 2.4, hearts: 3.2, balloons: 5, confetti: 5.6, fireworks: 4.4, lasers: 4.8, rain: 4 };

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const sprites = new Map();
  /**
   * Phones with little memory (a Galaxy M12) can't draw full-resolution effects at full speed: they
   * get a lower-resolution canvas and fewer particles, and gesture reading pauses while effects play.
   */
  const LOW_END = (navigator.deviceMemory || 4) < 6 || (navigator.hardwareConcurrency || 8) < 6;
  const many = (k) => Math.max(1, Math.round(k * (LOW_END ? .6 : 1)));
  let playingUntil = 0;
  /** Emoji drawn once into a bitmap, then stamped (much faster than text every frame). */
  function emojiSprite(ch, size) {
    const key = ch + size; if (sprites.has(key)) return sprites.get(key);
    const c = document.createElement("canvas"); c.width = c.height = Math.ceil(size * 1.3);
    const x = c.getContext("2d"); x.font = size + "px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(ch, c.width / 2, c.height / 2 + size * .06);
    sprites.set(key, c); return c;
  }
  /** A shaded heart drawn once per colour; s0 is its size in the bitmap. */
  function heartSprite(col) {
    const key = "heart" + col[0]; if (sprites.has(key)) return sprites.get(key);
    const s0 = 40, c = document.createElement("canvas"); c.width = c.height = s0 * 2.4;
    const x = c.getContext("2d"); x.translate(s0 * 1.2, s0 * 1.2);
    const g = x.createLinearGradient(-s0, -s0, s0, s0); g.addColorStop(0, col[0]); g.addColorStop(1, col[1]); heart(x, s0); x.fillStyle = g; x.fill();
    x.globalAlpha = .55; x.fillStyle = "#fff"; x.beginPath(); x.ellipse(-s0 * .42, -s0 * .42, s0 * .2, s0 * .1, -.7, 0, 7); x.fill();
    sprites.set(key, c); return c;
  }
  /** A round confetti piece with a highlight, drawn once per colour. */
  function dotSprite(col) {
    const key = "dot" + col; if (sprites.has(key)) return sprites.get(key);
    const c = document.createElement("canvas"); c.width = c.height = 32;
    const x = c.getContext("2d"), g = x.createRadialGradient(13, 13, 0, 16, 16, 16); g.addColorStop(0, "#fff"); g.addColorStop(.4, col); g.addColorStop(1, col);
    x.fillStyle = g; x.beginPath(); x.arc(16, 16, 15, 0, 7); x.fill();
    sprites.set(key, c); return c;
  }
  function heart(x, s) { x.beginPath(); x.moveTo(0, -.35 * s); x.bezierCurveTo(-.5 * s, -1.05 * s, -1.35 * s, -.2 * s, 0, .78 * s); x.bezierCurveTo(1.35 * s, -.2 * s, .5 * s, -1.05 * s, 0, -.35 * s); x.closePath(); }

  /** One overlay canvas; any number of reactions can play on it at once. */
  function Layer(canvas) {
    this.c = canvas; this.x = canvas.getContext("2d"); this.parts = []; this.washes = []; this.raf = 0; this.last = 0; this.scale = 1; this.slow = 16; this.frames = 0;
  }
  Layer.prototype.size = function () {
    // Resolution only changes between effects: particles keep pixel positions.
    if (!this.parts.length && !this.washes.length && this.frames > 20 && this.slow > 30) { this.scale = Math.max(.5, this.scale * .75); this.frames = 0; }
    const r = this.c.getBoundingClientRect(), d = Math.min(LOW_END ? 1.25 : 2, window.devicePixelRatio || 1) * this.scale, w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    this.W = w; this.H = h; this.M = Math.min(w, h);
  };
  Layer.prototype.loop = function () {
    if (this.raf) return;
    const step = (t) => {
      // Up to a tenth of a second per frame, so a slow phone still finishes an effect on time.
      const dt = Math.min(.1, this.last ? (t - this.last) / 1000 : .016);
      if (this.last) { this.slow = this.slow * .9 + (t - this.last) * .1; this.frames++; }
      this.last = t;
      this.size(); const x = this.x; x.clearRect(0, 0, this.W, this.H);
      this.washes = this.washes.filter(w => (w.t += dt) < w.life);
      for (const w of this.washes) w.draw(x, this, w.t / w.life, dt);
      // Particles may spawn others (a firework's burst, a raindrop's splash) while updating: they join the new list.
      const current = this.parts; this.parts = [];
      for (const p of current) if (p.update(dt, this) !== false) this.parts.push(p);
      for (const p of this.parts) p.draw(x, this);
      if (this.parts.length || this.washes.length) this.raf = requestAnimationFrame(step); else { this.raf = 0; this.last = 0; x.clearRect(0, 0, this.W, this.H); }
    };
    this.raf = requestAnimationFrame(step);
  };
  Layer.prototype.clear = function () { this.parts = []; this.washes = []; };

  /** A beam along +x from the origin: narrow and bright at the start, wide and faded at the end. */
  function taper(x, len, w0, w1, col, a) {
    const g = x.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, col + a.toFixed(3) + ")"); g.addColorStop(.55, col + (a * .45).toFixed(3) + ")"); g.addColorStop(1, col + "0)");
    x.fillStyle = g; x.beginPath(); x.moveTo(0, -w0 / 2); x.lineTo(len, -w1 / 2); x.lineTo(len, w1 / 2); x.lineTo(0, w0 / 2); x.closePath(); x.fill();
  }
  /** Where a video drawn with object-fit: cover sits on the layer, in layer pixels. */
  function coverRect(video, L) {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
    const vr = video.getBoundingClientRect(), cr = L.c.getBoundingClientRect(), k = L.W / (cr.width || 1), s = Math.max(vr.width / vw, vr.height / vh), dw = vw * s, dh = vh * s;
    return { x: (vr.left - cr.left + (vr.width - dw) / 2) * k, y: (vr.top - cr.top + (vr.height - dh) / 2) * k, w: dw * k, h: dh * k };
  }
  const lerp = (a, b, k) => a + (b - a) * k;
  /**
   * Follows the person in a video while an effect plays, in 0–1 video coordinates: their face and
   * eyes (for the glasses and where the show starts) and a soft cut-out mask (so beams go behind them).
   */
  function personTracker(video) {
    const st = { seg: null, finder: null, mask: null, segOk: false, head: null, face: null, eyes: null, faceAt: 0, last: 0, src: document.createElement("canvas"), out: document.createElement("canvas"), faceOut: document.createElement("canvas") };
    faceFinder().then(f => { st.finder = f; }).catch(() => { });
    segmenter().then(s => { st.seg = s; }).catch(() => { });
    function readFace(res, w, h, now) {
      let best = null;
      for (const d of (res && res.detections) || []) { const b = d.boundingBox; if (b && d.keypoints && d.keypoints.length > 1 && (!best || b.width * b.height > best.boundingBox.width * best.boundingBox.height)) best = d; }
      if (!best) { if (now - st.faceAt > 600) { st.face = null; st.eyes = null; st.parts = null; } return; }
      const b = best.boundingBox, k = best.keypoints, k1 = st.face ? .5 : 1;
      const face = { x: b.originX / w, y: b.originY / h, w: b.width / w, h: b.height / h };
      // The eyes and mouth must sit where a face has them inside its box; if they don't (some phones'
      // live feeds gave points well below the eyes), they're placed from the box instead.
      const inBox = (p, y0, y1) => p && p.x > face.x - face.w * .15 && p.x < face.x + face.w * 1.15 && p.y > face.y + face.h * y0 && p.y < face.y + face.h * y1;
      const good = k.length > 3 && inBox(k[0], .05, .6) && inBox(k[1], .05, .6) && inBox(k[3], .45, 1.05) && k[3].y > Math.max(k[0].y, k[1].y);
      const P = (u, v) => ({ x: face.x + face.w * u, y: face.y + face.h * v });
      const e0 = good ? k[0] : P(.3, .38), e1 = good ? k[1] : P(.7, .38), mo = good ? k[3] : P(.5, .76);
      const eyes = { ax: e0.x, ay: e0.y, bx: e1.x, by: e1.y };
      const parts = { mx: mo.x, my: mo.y, ex: e0.x, ey: e0.y };
      status.points = good ? "face" : "box";
      st.parts = parts && st.parts ? { mx: lerp(st.parts.mx, parts.mx, k1), my: lerp(st.parts.my, parts.my, k1), ex: lerp(st.parts.ex, parts.ex, k1), ey: lerp(st.parts.ey, parts.ey, k1) } : parts;
      st.face = st.face ? { x: lerp(st.face.x, face.x, k1), y: lerp(st.face.y, face.y, k1), w: lerp(st.face.w, face.w, k1), h: lerp(st.face.h, face.h, k1) } : face;
      st.eyes = st.eyes ? { ax: lerp(st.eyes.ax, eyes.ax, k1), ay: lerp(st.eyes.ay, eyes.ay, k1), bx: lerp(st.eyes.bx, eyes.bx, k1), by: lerp(st.eyes.by, eyes.by, k1) } : eyes;
      st.faceAt = now;
      status.face = { w, h, box: [face.x, face.y, face.w, face.h].map(v => +v.toFixed(3)), kp: k.slice(0, 4).map(p => [+p.x.toFixed(3), +p.y.toFixed(3)]), vid: [video.videoWidth, video.videoHeight] };
    }
    function readMask(res) {
      const masks = (res && res.confidenceMasks) || [], m = masks[masks.length - 1]; if (!m) return;
      const conf = m.getAsFloat32Array(), mw = m.width, mh = m.height;
      masks.forEach(k => { try { k.close(); } catch (_) { } });
      // Two masks are background then person; a single one should be the person. If its top corners
      // (almost always background) read as "person", it's the other way round.
      let corner = 0, cn = 0;
      for (let y = 0; y < 3; y++) for (let xx = 0; xx < mw * .15; xx++) { corner += conf[y * mw + xx] + conf[y * mw + mw - 1 - xx]; cn += 2; }
      const flip = cn && corner / cn > .5, out = st.out;
      // A mask with almost nobody (or almost everybody) in it is a bad read, not a person.
      let on = 0; for (let i = 0; i < conf.length; i += 7) if ((flip ? 1 - conf[i] : conf[i]) > .5) on++;
      const cover = on / Math.ceil(conf.length / 7); st.segOk = cover > .03 && cover < .92; status.mask = "segment " + cover.toFixed(2);
      if (!st.segOk) return;
      if (out.width !== mw || out.height !== mh) { out.width = mw; out.height = mh; }
      const ox = out.getContext("2d"), img = ox.createImageData(mw, mh);
      let top = -1, sx = 0, n = 0;
      for (let y = 0; y < mh; y++) {
        let row = 0;
        for (let xx = 0; xx < mw; xx++) {
          const i = y * mw + xx, c = flip ? 1 - conf[i] : conf[i];
          img.data[i * 4 + 3] = Math.max(0, Math.min(255, (c - .3) / .4 * 255));
          if (c > .5) { row++; if (top >= 0 && y < top + mh * .1) { sx += xx; n++; } }
        }
        if (top < 0 && row > mw * .08) top = y;
      }
      ox.putImageData(img, 0, 0);
      st.head = top >= 0 && n ? { x: sx / n / mw, y: Math.min(1, (top + mh * .09) / mh) } : null;
    }
    /** Without a good cut-out, a soft head-and-shoulders shape from the face still puts the beams behind them. */
    function faceMask() {
      const f = st.face, c = st.faceOut, w = 96, h = Math.max(24, Math.round(w * video.videoHeight / video.videoWidth));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const g = c.getContext("2d"); g.clearRect(0, 0, w, h); g.filter = "blur(" + Math.max(1, Math.round(w * .02)) + "px)"; g.fillStyle = "#000";
      const cx = (f.x + f.w / 2) * w, fw = f.w * w, fh = f.h * h, top = f.y * h;
      g.beginPath(); g.ellipse(cx, top + fh * .38, fw * .64, fh * .86, 0, 0, 7); g.fill();
      g.beginPath(); g.moveTo(cx - fw * .32, top + fh * .9); g.lineTo(cx + fw * .32, top + fh * .9); g.quadraticCurveTo(cx + fw * 1.45, top + fh * 1.15, cx + fw * 1.55, h + 4); g.lineTo(cx - fw * 1.55, h + 4); g.quadraticCurveTo(cx - fw * 1.45, top + fh * 1.15, cx - fw * .32, top + fh * .9); g.fill();
      g.filter = "none"; status.mask = "face";
      return c;
    }
    st.update = (now) => {
      if ((st.seg || st.finder) && now - st.last > (LOW_END ? 140 : 80) && video.readyState >= 2 && video.videoWidth) {
        st.last = now;
        const w = 192, h = Math.max(48, Math.round(w * video.videoHeight / video.videoWidth)), src = st.src;
        if (src.width !== w || src.height !== h) { src.width = w; src.height = h; }
        try {
          src.getContext("2d").drawImage(video, 0, 0, w, h);
          if (st.finder) try { readFace(st.finder.detect(src), w, h, now); } catch (e) { note("face", e); }
          if (st.seg) try { readMask(st.seg.segment(src)); } catch (e) { st.segOk = false; note("segment", e); }
        } catch (_) { }
        st.mask = st.segOk ? st.out : st.face ? faceMask() : null;
      }
      return !!(st.mask || st.face);
    };
    /** Where the show starts: behind the head (hidden by the cut-out), or just above it without one. */
    st.origin = () => {
      if (st.face) return { x: st.face.x + st.face.w / 2, y: st.mask ? st.face.y + st.face.h * .15 : st.face.y - st.face.h * .25 };
      return st.head;
    };
    return st;
  }
  /**
   * Glowing neon party glasses (like EL-wire glasses) over the eyes a and b, in layer pixels.
   * style: "shades" (wide party shades with swept-up outer corners) or "hearts". They flicker on like
   * a neon tube, glow brighter on the beat, have lights chasing round the frame, and throw pink light
   * on the face.
   */
  const railTube = document.createElement("canvas"), railCore = document.createElement("canvas");
  function neonGlasses(x, a, b, t, life, flash, style, rgb) {
    rgb = rgb || [255, 63, 150];
    const C = (k, al2) => "rgba(" + Math.round(rgb[0] * k + 255 * (1 - k)) + "," + Math.round(rgb[1] * k + 255 * (1 - k)) + "," + Math.round(rgb[2] * k + 255 * (1 - k)) + "," + al2 + ")";
    let ang = Math.atan2(b.y - a.y, b.x - a.x); if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
    // d is the size unit: a little more than the distance between the eyes, so the glasses (arms
    // included, about 2.3d) come out a bit wider than the face, like real party glasses.
    const eyes = Math.hypot(b.x - a.x, b.y - a.y); if (eyes < 8) return;
    const d = eyes * 1.2;
    const k = Math.min(1, t / .45), pop = k < 1 ? 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2) : 1;
    const on = t < .5 ? (t < .12 || (t > .2 && t < .26) || t > .34 ? 1 : .15) : 1, al = (t > life - .5 ? Math.max(0, (life - t) / .5) : 1) * on;
    if (al <= 0) return;
    const w = d * .86, h = d * .54, gap = d * .57, path = new Path2D(), slats = new Path2D();
    if (style === "visor") {
      // One wraparound LED visor across both eyes, with a notch for the nose and glowing slats inside.
      const vw = d * .98, top = -d * .27, bot = d * .22;
      path.moveTo(-vw, top + d * .06); path.quadraticCurveTo(0, top - d * .08, vw, top + d * .06);
      path.quadraticCurveTo(vw + d * .08, (top + bot) / 2, vw - d * .08, bot); path.lineTo(d * .2, bot);
      path.quadraticCurveTo(0, bot - d * .24, -d * .2, bot); path.lineTo(-vw + d * .08, bot);
      path.quadraticCurveTo(-vw - d * .08, (top + bot) / 2, -vw, top + d * .06); path.closePath();
      for (const s of [-1, 1]) { path.moveTo(s * vw, top + d * .08); path.quadraticCurveTo(s * (vw + d * .07), top + d * .05, s * (vw + d * .12), top + d * .14); }
      for (let i = 1; i <= 3; i++) { const y = top + (bot - top) * i / 4.2, ins = i === 3 ? d * .24 : d * .04; slats.moveTo(-vw + d * .11, y); slats.lineTo(-ins, y); slats.moveTo(ins, y); slats.lineTo(vw - d * .11, y); }
    } else for (const s of [-1, 1]) {
      const cx = s * gap, P = (u, v) => [cx + s * u * w, v * h];
      if (style === "hearts") {
        const hs = w / 1.85, p = new Path2D();
        p.moveTo(0, -14); p.bezierCurveTo(-20, -42, -54, -8, 0, 31); p.bezierCurveTo(54, -8, 20, -42, 0, -14); p.closePath();
        path.addPath(p, new DOMMatrix().translate(cx, -h * .02).scale(hs / 40, hs / 40));
      } else {
        // u runs from the nose (-0.5) to the temple (+0.5); v from the brow (-) to the cheek (+).
        path.moveTo(...P(-.47, -.38));
        path.bezierCurveTo(...P(-.15, -.5), ...P(.25, -.56), ...P(.47, -.66));
        path.bezierCurveTo(...P(.6, -.7), ...P(.58, -.15), ...P(.46, .12));
        path.bezierCurveTo(...P(.34, .44), ...P(.02, .56), ...P(-.22, .46));
        path.bezierCurveTo(...P(-.42, .38), ...P(-.52, .15), ...P(-.53, -.05));
        path.bezierCurveTo(...P(-.54, -.25), ...P(-.52, -.36), ...P(-.47, -.38));
        path.closePath();
      }
      // The arm, heading back toward the ear.
      const arm = style === "hearts" ? P(.48, -.25) : P(.5, -.6);
      path.moveTo(...arm); path.quadraticCurveTo(arm[0] + s * d * .07, arm[1] - h * .02, arm[0] + s * d * .12, arm[1] + h * .1);
    }
    // Bridge over the nose.
    const ix = gap - w * .5; path.moveTo(-ix, -h * .3); path.bezierCurveTo(-ix * .4, -h * .52, ix * .4, -h * .52, ix, -h * .3);
    x.save(); x.translate((a.x + b.x) / 2, (a.y + b.y) / 2); x.rotate(ang); x.scale(pop, pop);
    // Pink light falling on the face around the glasses.
    const spill = x.createRadialGradient(0, h * .2, 0, 0, h * .2, d * 1.4);
    spill.addColorStop(0, C(1, (.28 * al).toFixed(3))); spill.addColorStop(1, C(1, 0));
    x.fillStyle = spill; x.fillRect(-d * 1.6, -d * 1.3, d * 3.2, d * 2.9);
    x.fillStyle = C(.9, (.12 * al).toFixed(3)); x.fill(path);
    // A chunky (not heavy) frame drawn as two slim neon rails with a hollow between them: each stroke
    // is drawn wide and its middle cut out, on a canvas of its own, so the glow can wrap both rails.
    const cw = Math.ceil(d * 3.6), ch = Math.ceil(d * 2), rails = (c, outer, inner, extra) => {
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const r = c.getContext("2d"); r.setTransform(1, 0, 0, 1, 0, 0); r.clearRect(0, 0, cw, ch); r.translate(cw / 2, ch / 2); r.lineJoin = r.lineCap = "round";
      r.strokeStyle = outer[0]; r.lineWidth = d * outer[1]; r.stroke(path);
      if (extra) extra(r);
      r.globalCompositeOperation = "destination-out"; r.lineWidth = d * inner; r.stroke(path); r.globalCompositeOperation = "source-over";
      return c;
    };
    const tube = rails(railTube, [C(1, 1), .15], .078), core = rails(railCore, [C(.15, .95), .124], .1, (r) => {
      // A few small lights chasing round the frame.
      r.setLineDash([d * .035, d * .42]); r.lineDashOffset = -t * d * 1.6; r.strokeStyle = "#fff"; r.lineWidth = d * .15; r.stroke(path); r.setLineDash([]);
    });
    const g = .8 + .35 * flash;
    // The frame's body between the rails, faintly lit.
    x.lineJoin = x.lineCap = "round"; x.strokeStyle = C(1, (.14 * al).toFixed(3)); x.lineWidth = d * .12; x.stroke(path);
    if (LOW_END) { x.strokeStyle = C(1, (.1 * al * g).toFixed(3)); x.lineWidth = d * .28; x.stroke(path); }
    else { x.shadowColor = C(1, Math.min(1, al * g).toFixed(3)); x.shadowBlur = d * .28; }
    x.globalAlpha = al; x.drawImage(tube, -cw / 2, -ch / 2); x.shadowBlur = 0;
    x.drawImage(tube, -cw / 2, -ch / 2); x.drawImage(core, -cw / 2, -ch / 2); x.globalAlpha = 1;
    if (style === "visor") {
      x.strokeStyle = C(1, (.55 * al).toFixed(3)); x.lineWidth = Math.max(1.5, d * .028); if (!LOW_END) { x.shadowColor = C(1, al.toFixed(3)); x.shadowBlur = d * .15; }
      x.stroke(slats); x.shadowBlur = 0; x.strokeStyle = C(.15, (.7 * al).toFixed(3)); x.lineWidth = Math.max(1, d * .01); x.stroke(slats);
    }
    x.fillStyle = "rgba(255,255,255," + al.toFixed(3) + ")"; x.beginPath(); x.arc(0, -h * .45, d * .022, 0, 7); x.fill();
    x.restore();
  }
  /**
   * A retro mic held up to the mouth, the way a singer holds it: a dark metal capsule with a slatted
   * grille, its top just under the lips, the handle running down and fading out. Rim-lit by the laser
   * show's colours. mouth in layer pixels; down is the face's downward direction; d the eye distance;
   * hue the show's colour.
   */
  function singerMic(x, L, mouth, down, d, t, life, flash, hue) {
    const al = Math.min(1, t / .3) * (t > life - .5 ? Math.max(0, (life - t) / .5) : 1); if (al <= 0 || d < 8) return;
    const s = Math.min(d, L.M * .26), W = s * .92, H = s * 1.5, Lh = s * 1.9, sway = Math.sin(t * Math.PI * BPM / 60) * .02;
    const ang = Math.atan2(down.y, down.x) - Math.PI / 2 + sway;
    // Top of the grille just under the lower lip, centred on the mouth; the head always stays on screen.
    const m = L.M * .04, cx = Math.max(m + W / 2, Math.min(L.W - m - W / 2, mouth.x + down.x * (H / 2 + s * .14))), cy = Math.min(L.H * .86 - H / 2, mouth.y + down.y * (H / 2 + s * .14));
    const left = "hsla(" + hue + ",100%,62%,", right = "hsla(" + ((hue + 60) % 360) + ",100%,66%,", lit = .75 + .25 * flash;
    const metal = (a, b) => { const g = x.createLinearGradient(a, 0, b, 0); g.addColorStop(0, left + (.95 * lit).toFixed(3) + ")"); g.addColorStop(.12, "#2a2133"); g.addColorStop(.45, "#0c0a10"); g.addColorStop(.78, "#1d1724"); g.addColorStop(.93, right + (.55 * lit).toFixed(3) + ")"); g.addColorStop(1, right + (.9 * lit).toFixed(3) + ")"); return g; };
    const pill = () => { const r = W / 2; x.beginPath(); x.moveTo(-r, -H / 2 + r); x.arc(0, -H / 2 + r, r, Math.PI, 0); x.lineTo(r, H / 2 - r * .8); x.arc(0, H / 2 - r * .8, r, 0, Math.PI); x.closePath(); };
    x.save(); x.globalAlpha = al; x.translate(cx, cy); x.rotate(ang);
    // Handle: tapering away below the capsule and fading out, as if held further down.
    const hw0 = W * .26, hw1 = W * .17, hb = H / 2 + Lh;
    x.save(); x.beginPath(); x.moveTo(-hw0, H / 2 - W * .3); x.lineTo(hw0, H / 2 - W * .3); x.lineTo(hw1, hb); x.lineTo(-hw1, hb); x.closePath(); x.clip();
    x.fillStyle = metal(-hw0, hw0); const y0 = H / 2 - W * .3, f0 = H / 2 + Lh * .35, n = 14;
    x.fillRect(-hw0, y0, hw0 * 2, f0 - y0 + 1);
    for (let i = 0; i < n; i++) { x.globalAlpha = al * (1 - i / n); x.fillRect(-hw0, f0 + i * (hb - f0) / n, hw0 * 2, (hb - f0) / n + 1); }
    x.restore();
    // The capsule, with a soft coloured haze behind it, and its slatted grille.
    x.shadowColor = left + ".55)"; x.shadowBlur = s * .4; pill(); x.fillStyle = metal(-W / 2, W / 2); x.fill(); x.shadowBlur = 0;
    x.save(); pill(); x.clip();
    const top = -H / 2 + W * .1, bars = 8, step = (H * .56) / bars;
    for (let i = 0; i < bars; i++) {
      const y = top + i * step + step * .5;
      x.fillStyle = "rgba(0,0,0,.75)"; x.beginPath(); x.ellipse(0, y + step * .32, W * .55, W * .09, 0, 0, Math.PI); x.ellipse(0, y + step * .12, W * .55, W * .09, 0, Math.PI, 0, true); x.fill();
      x.strokeStyle = left + (.6 * lit).toFixed(3) + ")"; x.lineWidth = Math.max(1, s * .016); x.beginPath(); x.ellipse(0, y - step * .02, W * .5, W * .085, 0, .2, Math.PI - .2); x.stroke();
    }
    x.strokeStyle = "rgba(255,255,255,.2)"; x.lineWidth = s * .02; x.beginPath(); x.ellipse(0, top + H * .58, W * .5, W * .09, 0, .1, Math.PI - .1); x.stroke();
    const sh = x.createLinearGradient(0, top + H * .6, 0, H / 2); sh.addColorStop(0, left + (.35 * lit).toFixed(3) + ")"); sh.addColorStop(1, left + "0)");
    x.fillStyle = sh; x.fillRect(-W * .36, top + H * .6, W * .1, H * .38);
    x.restore();
    pill(); x.strokeStyle = right + (.55 * lit).toFixed(3) + ")"; x.lineWidth = s * .02; x.stroke();
    x.restore();
  }
  // ---- sound ----
  const BPM = 128;
  let audio = null;
  // Nothing of ours plays while the app is in the background; the next beat wakes the sound up again.
  document.addEventListener("visibilitychange", () => { if (document.hidden && audio && audio.state === "running") audio.suspend().catch(() => { }); });
  /**
   * A short, original K-pop-style beat for the laser show, synthesised on the phone (no files).
   * Also sent to extra (a recording's audio) when given. With startAt (an audio-clock time) it plays
   * that stretch with no fade, so stretches can follow each other seamlessly. Returns a function that
   * stops it, carrying .end: when it finishes on the audio clock.
   */
  function partyBeat(seconds, extra, startAt) {
    if (document.hidden) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      if (!audio || audio.state === "closed") audio = new AC();
      if (audio.state === "suspended") audio.resume().catch(() => { });
      const ac = audio, seam = startAt != null, t0 = seam ? Math.max(startAt, ac.currentTime + .02) : ac.currentTime + .05, b = 60 / BPM, out = ac.createGain();
      if (seam) out.gain.setValueAtTime(.3, t0);
      else { out.gain.setValueAtTime(.0001, t0); out.gain.exponentialRampToValueAtTime(.3, t0 + .06); out.gain.setValueAtTime(.3, t0 + seconds - .7); out.gain.exponentialRampToValueAtTime(.0001, t0 + seconds); }
      out.connect(ac.destination); if (extra) out.connect(extra);
      const noise = ac.createBuffer(1, ac.sampleRate * .5, ac.sampleRate), nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      const env = (g, at, peak, len) => { g.gain.setValueAtTime(.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + .005); g.gain.exponentialRampToValueAtTime(.0001, at + len); };
      const tone = (type, f, at, len, peak, f2, filter) => {
        const o = ac.createOscillator(), g = ac.createGain(); o.type = type; o.frequency.setValueAtTime(f, at); if (f2) o.frequency.exponentialRampToValueAtTime(f2, at + len);
        env(g, at, peak, len); let n = o; if (filter) { const fl = ac.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = filter; o.connect(fl); n = fl; } n.connect(g); g.connect(out); o.start(at); o.stop(at + len + .05);
      };
      const hiss = (at, len, peak, type, freq) => { const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain(); s.buffer = noise; f.type = type; f.frequency.value = freq; env(g, at, peak, len); s.connect(f); f.connect(g); g.connect(out); s.start(at); s.stop(at + len + .05); };
      const end = t0 + seconds - (seam ? .01 : .3), A = 440, note = (n) => A * Math.pow(2, n / 12);
      // A minor: the bass walks A–F–C–G; the hook is a bright pentatonic line, two notes per beat.
      const bass = [-36, -40, -33, -38], hook = [7, 10, 12, 10, 7, 5, 3, 5, 7, 10, 12, 15, 12, 10, 7, 10];
      if (!seam) { tone("sine", 2400, t0, .35, .25, 180); tone("sawtooth", 1800, t0 + .02, .3, .08, 120, 3000); }
      for (let i = 0; t0 + i * b < end; i++) {
        const at = t0 + i * b;
        tone("sine", 150, at, .28, .9, 42);
        if (i % 2) { hiss(at, .16, .5, "bandpass", 1500); hiss(at + .012, .12, .35, "bandpass", 1200); }
        hiss(at + b / 2, .05, .18, "highpass", 7000);
        for (const k of [0, 1]) { const bn = bass[Math.floor(i / 4) % 4] + (k ? 12 : 0); tone("sawtooth", note(bn), at + k * b / 2, b / 2 - .02, .22, 0, 380); }
        for (const k of [0, 1]) { const hn = hook[(i * 2 + k) % hook.length]; tone("square", note(hn), at + k * b / 2, b / 2 - .03, .07, 0, 2600); tone("sawtooth", note(hn) * 1.006, at + k * b / 2, b / 2 - .03, .05, 0, 3200); }
        if (i % 4 === 3) tone("sine", 2200, at + b / 2, .25, .12, 200);
      }
      const stop = () => { try { const n = ac.currentTime; out.gain.cancelScheduledValues(n); out.gain.setValueAtTime(out.gain.value, n); out.gain.linearRampToValueAtTime(0, n + .15); setTimeout(() => { try { out.disconnect(); } catch (_) { } }, 300); } catch (_) { } };
      stop.end = t0 + seconds; stop.ac = ac;
      return stop;
    } catch (_) { return () => { }; }
  }

  /**
   * A party scene around the person in a video: the room dims and takes on a colour that changes
   * every bar, mirror-ball spots drift over the walls, laser beams fan out from behind their head,
   * and they can get neon glasses, a mic, hearts or a sparkle halo. Everything behind them is cut
   * around them, so they stay in front. The laser reaction and the story camera lenses both use it.
   * o: { dim, room, spots, beams, dust, glasses ("shades" | "hearts" | "visor" | "random"), mic,
   *      hearts, halo, spotlight }.
   */
  function partyScene(o) {
    const beat = 60 / BPM, bar = beat * 4, hue0 = rnd(0, 360), back = document.createElement("canvas"), bx = back.getContext("2d"), tint = document.createElement("canvas");
    const N = LOW_END ? 9 : 12, beams = [];
    for (let i = 0; i < N; i++) beams.push({ base: -Math.PI * .97 + i / (N - 1) * Math.PI * .94, grp: i % 2, hue: hue0 + i * 37 });
    const dust = Array.from({ length: many(46) }, () => ({ x: Math.random(), y: Math.random(), v: rnd(.015, .05), s: rnd(.002, .0055), ph: rnd(0, 6), hue: rnd(0, 360) }));
    const spots = Array.from({ length: many(70) }, () => ({ x: Math.random() * 1.3 - .15, y: Math.pow(Math.random(), 1.4) * .62, v: rnd(.05, .11), s: rnd(.006, .014), ph: rnd(0, 6) }));
    const floaters = Array.from({ length: many(26) }, () => ({ a: rnd(-Math.PI, 0), r: rnd(.8, 2.1), v: rnd(.12, .3), s: rnd(.12, .3), ph: rnd(0, 1), col: pick([["#ff6b8a", "#e0154d"], ["#ff9ec0", "#ff4f8b"], ["#ff4d6d", "#b5003a"], ["#c084fc", "#9333ea"]]) }));
    const stars = Array.from({ length: many(40) }, () => ({ a: rnd(-Math.PI * 1.1, Math.PI * .1), r: rnd(.75, 1.25), s: rnd(.03, .08), ph: rnd(0, 6), sp: rnd(2, 5) }));
    // Party-room colours, changing every bar: blue, magenta, green, cyan.
    const PAL = [[70, 80, 255], [255, 50, 210], [50, 255, 120], [40, 220, 255]], p0 = (Math.random() * 4) | 0;
    const roomAt = (t) => { const i = Math.floor(t / bar), k = Math.min(1, (t - i * bar) / .35), a = PAL[(p0 + i + 3) % 4], b = PAL[(p0 + i) % 4]; return a.map((v, j) => Math.round(v + (b[j] - v) * k)); };
    const look = o.glasses === "random" ? pick(["shades", "shades", "hearts", "visor", "visor"]) : o.glasses;
    let ox = 0, oy = 0, placed = false;
    return {
      look,
      /** Draws one frame onto x. L: {W, H, M}; view: where the video sits on x; person: its tracker (or null). */
      draw(x, L, t, life, view, person) {
        const W = L.W, H = L.H, M = L.M;
        if (!placed) { ox = W / 2; oy = H * .26; }
        if (back.width !== W || back.height !== H) { back.width = W; back.height = H; }
        const fade = t < .35 ? t / .35 : t > life - .7 ? Math.max(0, (life - t) / .7) : 1, flash = Math.exp(-((t % beat) / beat) * 4), pulse = .72 + .28 * flash;
        const spot = view && person && person.origin(), face = view && person && person.face;
        if (spot) { const tx = view.x + spot.x * view.w, ty = view.y + spot.y * view.h; ox = placed ? lerp(ox, tx, .3) : tx; oy = placed ? lerp(oy, ty, .3) : ty; placed = true; }
        const fw = face ? face.w * view.w : M * .3, room = roomAt(t), rc = "rgba(" + room.join(",") + ",", hh = (hue0 + t * 40) % 360;
        bx.setTransform(1, 0, 0, 1, 0, 0); bx.globalCompositeOperation = "source-over"; bx.clearRect(0, 0, W, H);
        if (o.dim) {
          const dim = bx.createLinearGradient(0, 0, 0, H); dim.addColorStop(0, "rgba(4,2,14," + (o.dim * fade).toFixed(3) + ")"); dim.addColorStop(1, "rgba(4,2,14," + (o.dim * .8 * fade).toFixed(3) + ")");
          bx.fillStyle = dim; bx.fillRect(0, 0, W, H);
        }
        if (o.room) {
          // The room's coloured light, strongest up top.
          const wash = bx.createLinearGradient(0, 0, 0, H); wash.addColorStop(0, rc + (.3 * fade * pulse).toFixed(3) + ")"); wash.addColorStop(.6, rc + (.14 * fade).toFixed(3) + ")"); wash.addColorStop(1, rc + (.08 * fade).toFixed(3) + ")");
          bx.fillStyle = wash; bx.fillRect(0, 0, W, H);
        }
        bx.globalCompositeOperation = "lighter";
        if (o.beams) {
          const hz = bx.createRadialGradient(ox, oy, 0, ox, oy, M * .9);
          hz.addColorStop(0, "hsla(" + hh + ",100%,60%," + (.24 * fade * pulse).toFixed(3) + ")"); hz.addColorStop(1, "hsla(" + hh + ",100%,50%,0)");
          bx.fillStyle = hz; bx.fillRect(0, 0, W, H);
          const reach = Math.hypot(W, H) * Math.min(1, Math.pow(Math.min(1, t / .5), .6)) * 1.1;
          // Two groups scissor against each other, a full swing every bar.
          for (const b of beams) {
            const ang = b.base + Math.sin(t * Math.PI / (2 * beat) + (b.grp ? 0 : Math.PI)) * .34, h = (b.hue + t * 70) % 360, a = fade * pulse;
            bx.save(); bx.translate(ox, oy); bx.rotate(ang);
            taper(bx, reach, M * .014, M * .32, "hsla(" + h + ",100%,60%,", .11 * a);
            taper(bx, reach, M * .014, M * .07, "hsla(" + h + ",100%,60%,", .45 * a);
            taper(bx, reach, M * .004, M * .016, "hsla(" + h + ",100%,88%,", .95 * a);
            bx.restore();
          }
        }
        if (o.spots) for (const sp of spots) {
          const px = (((sp.x + t * sp.v) % 1.3) + 1.3) % 1.3 - .15, py = sp.y + Math.sin(t * 1.1 + sp.ph) * .012, tw = .55 + .45 * Math.sin(t * 6 + sp.ph * 3), r = sp.s * M * (1 - py * .5);
          bx.fillStyle = rc + (.16 * tw * fade).toFixed(3) + ")"; bx.beginPath(); bx.ellipse(px * W, py * H, r * 3.6, r * 1.6, 0, 0, 7); bx.fill();
          bx.fillStyle = rc + (.85 * tw * fade).toFixed(3) + ")"; bx.beginPath(); bx.ellipse(px * W, py * H, r * 2, r * .7, 0, 0, 7); bx.fill();
        }
        if (o.dust) for (const d of dust) {
          const tw = .5 + .5 * Math.sin(t * 5 + d.ph), dy = ((d.y - t * d.v) % 1 + 1) % 1;
          bx.fillStyle = "hsla(" + ((d.hue + t * 60) % 360) + ",100%,80%," + (.75 * tw * fade).toFixed(3) + ")";
          bx.beginPath(); bx.arc(d.x * W, dy * H, d.s * M, 0, 7); bx.fill();
        }
        if (o.halo) for (const s of stars) {
          // A ring of twinkling stars round the head.
          const tw = Math.max(0, Math.sin(t * s.sp + s.ph)), r = fw * (.95 + .25 * s.r), sx = ox + Math.cos(s.a + t * .25) * r, sy = oy + fw * .35 + Math.sin(s.a + t * .25) * r * .9, z = fw * s.s * (.4 + tw);
          bx.fillStyle = "rgba(255,240,200," + (.9 * tw * fade).toFixed(3) + ")"; bx.beginPath(); bx.moveTo(sx, sy - z); bx.quadraticCurveTo(sx, sy, sx + z, sy); bx.quadraticCurveTo(sx, sy, sx, sy + z); bx.quadraticCurveTo(sx, sy, sx - z, sy); bx.quadraticCurveTo(sx, sy, sx, sy - z); bx.fill();
        }
        bx.globalCompositeOperation = "source-over";
        if (o.hearts) for (const f of floaters) {
          // Hearts drifting up from behind the head.
          const k = ((t * f.v + f.ph) % 1), sx = ox + Math.cos(f.a) * fw * f.r + Math.sin(t * 2 + f.ph * 9) * fw * .1, sy = oy + fw * .6 - k * H * .55, s = fw * f.s, al = fade * Math.min(1, k * 5) * Math.min(1, (1 - k) * 3);
          bx.globalAlpha = al; bx.drawImage(heartSprite(f.col), sx - s * 1.2, sy - s * 1.2, s * 2.4, s * 2.4);
        }
        bx.globalAlpha = 1;
        if (o.beams) {
          const fr = M * .2 * (.85 + .15 * flash), core = bx.createRadialGradient(ox, oy, 0, ox, oy, fr);
          core.addColorStop(0, "rgba(255,255,255," + (.95 * fade).toFixed(3) + ")"); core.addColorStop(.18, "hsla(" + hh + ",100%,70%," + (.55 * fade).toFixed(3) + ")"); core.addColorStop(1, "hsla(" + hh + ",100%,60%,0)");
          bx.globalCompositeOperation = "lighter"; bx.fillStyle = core; bx.beginPath(); bx.arc(ox, oy, fr, 0, 7); bx.fill();
          bx.save(); bx.translate(ox, oy); bx.scale(5, .09); const st = bx.createRadialGradient(0, 0, 0, 0, 0, fr);
          st.addColorStop(0, "rgba(200,230,255," + (.7 * fade).toFixed(3) + ")"); st.addColorStop(1, "rgba(120,170,255,0)");
          bx.fillStyle = st; bx.beginPath(); bx.arc(0, 0, fr, 0, 7); bx.fill(); bx.restore();
        }
        // The person stays in front of all of it.
        if (view && person && person.mask) { bx.globalCompositeOperation = "destination-out"; bx.drawImage(person.mask, view.x, view.y, view.w, view.h); }
        bx.globalCompositeOperation = "source-over";
        x.drawImage(back, 0, 0);
        // The room's light falls on the person too.
        if (o.room && view && person && person.mask) {
          const mk = person.mask; if (tint.width !== mk.width || tint.height !== mk.height) { tint.width = mk.width; tint.height = mk.height; }
          const tx = tint.getContext("2d"); tx.globalCompositeOperation = "source-over"; tx.clearRect(0, 0, tint.width, tint.height); tx.drawImage(mk, 0, 0);
          tx.globalCompositeOperation = "source-in"; tx.fillStyle = rc + (.24 * fade).toFixed(3) + ")"; tx.fillRect(0, 0, tint.width, tint.height);
          x.drawImage(tint, view.x, view.y, view.w, view.h);
        }
        if (o.spotlight && face) {
          // A stage spotlight: everything but the face falls into shadow.
          const cx = view.x + (face.x + face.w / 2) * view.w, cy = view.y + (face.y + face.h * .55) * view.h, r = fw * 1.25;
          const g = x.createRadialGradient(cx, cy, r * .55, cx, cy, r * 2.6); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(0,0,0," + (.62 * fade).toFixed(3) + ")");
          x.fillStyle = g; x.fillRect(0, 0, W, H);
        }
        const e = view && person && person.eyes;
        if (e) {
          const ea = { x: view.x + e.ax * view.w, y: view.y + e.ay * view.h }, eb = { x: view.x + e.bx * view.w, y: view.y + e.by * view.h }, p = person.parts;
          if (look) neonGlasses(x, ea, eb, t, life, flash, look, look === "visor" ? room : null);
          if (o.mic && p) {
            // Down the face: across the eye line, toward the mouth.
            const ed = Math.hypot(eb.x - ea.x, eb.y - ea.y) || 1, mouth = { x: view.x + p.mx * view.w, y: view.y + p.my * view.h };
            let down = { x: -(eb.y - ea.y) / ed, y: (eb.x - ea.x) / ed }; if (down.x * (mouth.x - (ea.x + eb.x) / 2) + down.y * (mouth.y - (ea.y + eb.y) / 2) < 0) down = { x: -down.x, y: -down.y };
            singerMic(x, L, mouth, down, ed, t, life, flash, hh);
          }
        }
      }
    };
  }
  /** The story camera's lenses: each a party scene with a different mix. */
  const LENSES = [
    { id: "none", name: "Normal", icon: "◯" },
    { id: "party", name: "Party", icon: "🪩", scene: { dim: .62, room: true, spots: true, beams: true, dust: true, glasses: "visor" }, music: true },
    { id: "neon", name: "Neon", icon: "🕶️", scene: { dim: .3, glasses: "shades", dust: true } },
    { id: "hearts", name: "Hearts", icon: "💖", scene: { dim: .18, glasses: "hearts", hearts: true } },
    { id: "lasers", name: "Lasers", icon: "🤘", scene: { dim: .6, beams: true, dust: true, glasses: "shades" }, music: true },
    { id: "stage", name: "Stage", icon: "🎤", scene: { dim: .35, room: true, spots: true, mic: true, spotlight: true }, music: true },
    { id: "disco", name: "Disco", icon: "✨", scene: { dim: .5, room: true, spots: true, glasses: "visor" } },
    { id: "halo", name: "Halo", icon: "🌟", scene: { dim: .12, halo: true, dust: true } }
  ];
  // ---- the reactions ----
  const SPAWN = {
    thumbs(L, o, down) {
      const ch = down ? "👎" : "👍", S = L.M * .32, sprite = emojiSprite(ch, 160);
      const ox = (o ? o.x : .5) * L.W, oy = (o ? o.y : .62) * L.H;
      L.parts.push({ t: 0, update(dt) { this.t += dt; return this.t < 2.3; }, draw(x) {
        const t = this.t, pop = t < .35 ? 1.25 * Math.sin(t / .35 * Math.PI / 2) : t < .55 ? 1.25 - (t - .35) / .2 * .25 : 1;
        const rise = t > 1.3 ? (t - 1.3) * L.H * .5 : 0, alpha = t > 1.6 ? Math.max(0, 1 - (t - 1.6) / .7) : 1;
        x.save(); x.globalAlpha = alpha; x.translate(ox, oy - rise); x.rotate(Math.sin(t * 6) * .06 * (t < 1.3 ? 1 : 0)); x.scale(pop, pop);
        x.shadowColor = "rgba(0,0,0,.35)"; x.shadowBlur = S * .12; x.drawImage(sprite, -S / 2, -S / 2, S, S); x.restore();
      } });
      for (let i = 0; i < 14; i++) {
        const a = rnd(0, Math.PI * 2), v = rnd(.25, .55) * L.M, s = rnd(.04, .08) * L.M, sp = emojiSprite(i % 3 ? ch : "✨", 64);
        L.parts.push({ x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - L.M * .2, t: 0, d: rnd(.05, .25), update(dt) { this.t += dt; if (this.t < this.d) return true; this.x += this.vx * dt; this.y += this.vy * dt; this.vy += L.M * .5 * dt; return this.t < 1.6; },
          draw(x) { if (this.t < this.d) return; x.save(); x.globalAlpha = Math.max(0, 1 - (this.t - this.d) / 1.4); x.drawImage(sp, this.x - s / 2, this.y - s / 2, s, s); x.restore(); } });
      }
    },
    thumbsdown(L, o) { SPAWN.thumbs(L, o, true); },
    hearts(L, o) {
      const cols = [["#ff6b8a", "#e0154d"], ["#ff9ec0", "#ff4f8b"], ["#ff4d6d", "#b5003a"], ["#ffd1dc", "#ff7aa2"], ["#c084fc", "#9333ea"]];
      const ox = (o ? o.x : .5) * L.W, oy = (o ? o.y : .7) * L.H;
      for (let i = 0, n = many(42); i < n; i++) {
        const s = rnd(.025, .07) * L.M, col = pick(cols), sprite = heartSprite(col), a = rnd(-Math.PI * .95, -Math.PI * .05), v = rnd(.35, .9) * L.M, sway = rnd(1.5, 3.5), ph = rnd(0, 6);
        L.parts.push({ x: ox + rnd(-.05, .05) * L.W, y: oy, vx: Math.cos(a) * v * .6, vy: Math.sin(a) * v, t: 0, d: i * .03, update(dt) { this.t += dt; if (this.t < this.d) return true; this.x += (this.vx + Math.sin(this.t * sway + ph) * L.M * .12) * dt; this.y += this.vy * dt; this.vx *= .985; this.vy = this.vy * .985 - L.M * .05 * dt; return this.t < 3.1; },
          draw(x) { if (this.t < this.d) return; const k = this.t - this.d, sc = k < .2 ? k / .2 : 1, al = k > 2.2 ? Math.max(0, 1 - (k - 2.2) / .8) : 1;
            x.save(); x.globalAlpha = al; x.translate(this.x, this.y); x.rotate(Math.sin(k * 3 + ph) * .25); x.scale(sc, sc);
            x.drawImage(sprite, -s * 1.2, -s * 1.2, s * 2.4, s * 2.4); x.restore(); } });
      }
    },
    balloons(L) {
      const cols = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#5ac8fa", "#007aff", "#af52de", "#ff2d55"];
      for (let i = 0; i < 11; i++) {
        const r = rnd(.06, .1) * L.M, col = cols[i % cols.length], x0 = rnd(.08, .92) * L.W, sp = rnd(.22, .34) * L.H, ph = rnd(0, 6), d = i * .18 + rnd(0, .2);
        L.parts.push({ x: x0, y: L.H + r * 2, t: 0, update(dt) { this.t += dt; if (this.t < d) return true; this.y -= sp * dt; this.x = x0 + Math.sin((this.t - d) * 1.4 + ph) * L.M * .04; return this.y > -r * 6; },
          draw(x) { if (this.t < d) return; x.save(); x.translate(this.x, this.y);
            x.strokeStyle = "rgba(255,255,255,.75)"; x.lineWidth = Math.max(1, r * .04); x.beginPath(); x.moveTo(0, r * 1.15);
            for (let k = 1; k <= 6; k++) x.quadraticCurveTo((k % 2 ? 1 : -1) * r * .25, r * 1.15 + r * .45 * (k - .5), Math.sin(this.t * 2 + k) * r * .1, r * 1.15 + r * .45 * k); x.stroke();
            const g = x.createRadialGradient(-r * .35, -r * .45, r * .05, 0, 0, r * 1.2); g.addColorStop(0, "rgba(255,255,255,.9)"); g.addColorStop(.22, col); g.addColorStop(1, col);
            x.fillStyle = g; x.beginPath(); x.ellipse(0, 0, r * .86, r, 0, 0, 7); x.fill();
            x.fillStyle = col; x.beginPath(); x.moveTo(-r * .1, r * .98); x.lineTo(r * .1, r * .98); x.lineTo(0, r * 1.15); x.closePath(); x.fill();
            x.restore(); } });
      }
    },
    confetti(L) {
      const cols = ["#ff3b30", "#ffcc00", "#34c759", "#007aff", "#af52de", "#ff9500", "#ff2d55", "#5ac8fa", "#ffffff"], life = 5.6;
      const piece = (x0, y0, a, v, d) => {
        const s = rnd(.013, .024) * L.M, col = pick(cols), kind = Math.random(), spin = rnd(3, 9), sway = rnd(2, 4), dot = kind < .65 ? null : dotSprite(col);
        L.parts.push({ x: x0, y: y0, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, update(dt) { this.t += dt; if (this.t < d) return true;
            // Thrown up, then drifting down slowly like paper.
            this.vy += L.H * .8 * dt; this.vx *= .98; this.vy = Math.min(this.vy, L.H * .14); this.x += this.vx * dt + Math.sin(this.t * sway) * s * .9; this.y += this.vy * dt; return this.y < L.H + 40 && this.t < life; },
          draw(x) { if (this.t < d) return; x.save(); x.translate(this.x, this.y); x.rotate(this.t * spin); x.globalAlpha = this.t > life - .8 ? Math.max(0, (life - this.t) / .8) : 1;
            if (dot) x.drawImage(dot, -s * .6, -s * .6, s * 1.2, s * 1.2);
            else { x.fillStyle = col; x.scale(1, Math.abs(Math.cos(this.t * spin * .7)) + .1); x.fillRect(-s, -s * .45, s * 2, s * .9); }
            x.restore(); } });
      };
      // Two cannons from the bottom corners, a second volley, and a shower from the top.
      for (const side of [0, 1]) for (let i = 0, n = many(90); i < n; i++) {
        const a = side ? rnd(-Math.PI * .85, -Math.PI * .6) : rnd(-Math.PI * .4, -Math.PI * .15);
        piece(side ? L.W : 0, L.H, a, rnd(.8, 1.35) * L.H, i < n * .6 ? 0 : .6);
      }
      for (let i = 0, n = many(70); i < n; i++) piece(rnd(0, 1) * L.W, -rnd(.02, .3) * L.H, Math.PI / 2, rnd(.05, .15) * L.H, rnd(.3, 1.6));
    },
    fireworks(L) {
      const cols = ["255,90,90", "255,210,80", "120,220,255", "190,120,255", "120,255,170", "255,140,220"];
      // Night falls for the show.
      L.washes.push({ t: 0, life: 4.4, draw(x, l, k) { const a = k < .1 ? k / .1 : k > .85 ? (1 - k) / .15 : 1; const g = x.createLinearGradient(0, 0, 0, l.H); g.addColorStop(0, "rgba(4,6,30," + (.7 * a).toFixed(3) + ")"); g.addColorStop(1, "rgba(4,6,30," + (.35 * a).toFixed(3) + ")"); x.fillStyle = g; x.fillRect(0, 0, l.W, l.H); } });
      for (let i = 0; i < 6; i++) {
        const tx = rnd(.15, .85) * L.W, ty = rnd(.12, .45) * L.H, col = pick(cols), d = i * .45 + rnd(0, .2), x0 = tx + rnd(-.1, .1) * L.W;
        L.parts.push({ x: x0, y: L.H, t: 0, done: false, update(dt, Lr) { this.t += dt; if (this.t < d) return true; const k = Math.min(1, (this.t - d) / .65); this.x = x0 + (tx - x0) * k; this.y = L.H + (ty - L.H) * (1 - Math.pow(1 - k, 2)); if (k >= 1 && !this.done) { this.done = true; burst(Lr, this.x, this.y, col); } return !this.done; },
          draw(x) { if (this.t < d) return; x.save(); x.globalCompositeOperation = "lighter"; x.fillStyle = "rgba(255,240,200,.95)"; x.shadowColor = "rgba(" + col + ",1)"; x.shadowBlur = L.M * .02; x.beginPath(); x.arc(this.x, this.y, L.M * .006, 0, 7); x.fill(); x.restore(); } });
      }
      function burst(Lr, bx, by, col) {
        Lr.washes.push({ t: 0, life: .5, draw(x, l, k) { const g = x.createRadialGradient(bx, by, 0, bx, by, l.M * .4); g.addColorStop(0, "rgba(" + col + "," + (.3 * (1 - k)).toFixed(3) + ")"); g.addColorStop(1, "rgba(" + col + ",0)"); x.fillStyle = g; x.fillRect(0, 0, l.W, l.H); } });
        for (let i = 0, n = many(90); i < n; i++) {
          const a = i / n * Math.PI * 2 + rnd(-.05, .05), v = rnd(.3, .55) * Lr.M, life = rnd(1.3, 2), trail = [];
          Lr.parts.push({ x: bx, y: by, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, update(dt) { this.t += dt; trail.push([this.x, this.y]); if (trail.length > 7) trail.shift(); this.vx *= .97; this.vy = this.vy * .97 + Lr.M * .18 * dt; this.x += this.vx * dt; this.y += this.vy * dt; return this.t < life; },
            draw(x) { const al = Math.max(0, 1 - this.t / life); x.save(); x.globalCompositeOperation = "lighter"; x.strokeStyle = "rgba(" + col + "," + (al * .8).toFixed(3) + ")"; x.lineWidth = Lr.M * .006; x.lineCap = "round"; x.beginPath(); trail.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.lineTo(this.x, this.y); x.stroke();
              x.fillStyle = "rgba(255,250,235," + al.toFixed(3) + ")"; x.beginPath(); x.arc(this.x, this.y, Lr.M * .006 * (Math.sin(this.t * 30) > .6 ? 1.7 : 1), 0, 7); x.fill(); x.restore(); } });
        }
      }
    },
    rain(L) {
      L.washes.push({ t: 0, life: 4, draw(x, l, k) { const a = k < .15 ? k / .15 : k > .8 ? (1 - k) / .2 : 1; const g = x.createLinearGradient(0, 0, 0, l.H); g.addColorStop(0, "rgba(30,40,60," + (.55 * a).toFixed(3) + ")"); g.addColorStop(1, "rgba(30,40,60," + (.25 * a).toFixed(3) + ")"); x.fillStyle = g; x.fillRect(0, 0, l.W, l.H); } });
      for (let i = 0, n = many(160); i < n; i++) {
        const d = rnd(0, 3.2), len = rnd(.03, .07) * L.H, sp = rnd(1.1, 1.6) * L.H, x0 = rnd(-.1, 1) * L.W, ground = rnd(.82, 1) * L.H;
        L.parts.push({ x: x0, y: -len, t: 0, update(dt) { this.t += dt; if (this.t < d) return true; this.y += sp * dt; this.x += sp * .12 * dt;
            if (this.y > ground && !this.sp) { this.sp = true; for (let k = 0; k < 3; k++) { const a = rnd(-Math.PI * .9, -Math.PI * .1), v = rnd(.04, .1) * L.M; L.parts.push({ x: this.x, y: this.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, update(dt2) { this.t += dt2; this.vy += L.M * .6 * dt2; this.x += this.vx * dt2; this.y += this.vy * dt2; return this.t < .35; }, draw(x) { x.fillStyle = "rgba(200,225,255,.7)"; x.beginPath(); x.arc(this.x, this.y, L.M * .003, 0, 7); x.fill(); } }); } return false; }
            return true; },
          draw(x) { if (this.t < d) return; x.strokeStyle = "rgba(200,225,255,.65)"; x.lineWidth = Math.max(1, L.M * .0025); x.lineCap = "round"; x.beginPath(); x.moveTo(this.x, this.y); x.lineTo(this.x - len * .12, this.y - len); x.stroke(); } });
      }
    },
    /**
     * A laser show from behind the head of the person on the big video, to a K-pop beat: the room
     * goes dark and coloured, beams fan out from behind their head and scissor on the beat, and they
     * get glowing neon party glasses and a retro mic at their mouth.
     */
    lasers(L, o, video) {
      const life = 4.8, person = video ? personTracker(video) : null, scene = partyScene({ dim: .7, room: true, spots: true, beams: true, dust: true, glasses: "random", mic: true });
      partyBeat(life);
      L.parts.push({ t: 0, update(dt) { this.t += dt; return this.t < life; }, draw(x) {
        const view = person && person.update(performance.now()) ? coverRect(video, L) : null;
        scene.draw(x, L, this.t, life, view, person);
      } });
    }
  };

  const layers = new WeakMap();
  /**
   * Plays a reaction over `canvas`. origin {x,y} 0..1 places hand-based ones near the hand; video is
   * the full-screen video under the canvas, so lasers can go behind the person in it.
   */
  function play(canvas, id, origin, video) {
    if (!canvas || !SPAWN[id]) return;
    let L = layers.get(canvas); if (!L) { L = new Layer(canvas); layers.set(canvas, L); }
    L.size(); SPAWN[id](L, origin || null, video || null); L.loop();
    playingUntil = Math.max(playingUntil, performance.now() + (DURATION[id] || 3) * 1000);
    try { navigator.vibrate && navigator.vibrate(id === "fireworks" ? [20, 60, 20, 60, 20] : 18); } catch (_) { }
  }
  function clear(canvas) { const L = canvas && layers.get(canvas); if (L) L.clear(); }

  // ---- gestures ----
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
  const SEGMENTER_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";
  const FACE_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite";
  let recognizerPromise = null, segmenterPromise = null, finderPromise = null, queue = Promise.resolve();
  /** What loaded and what failed, for checking a phone over USB: ScraveitCallFx.status(). */
  const status = {};
  const note = (what, e) => { status[what] = "error: " + String((e && e.message) || e).slice(0, 160); };
  /** A model file, from the phone's cache after the first download. */
  async function modelBytes(url, minBytes) {
    let cache = null;
    try { cache = await caches.open("scraveit-gestures-v1"); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (_) { cache = null; }
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error("MODEL_HTTP_" + res.status);
    const buf = await res.clone().arrayBuffer();
    if (buf.byteLength < minBytes) throw new Error("MODEL_SHORT");
    if (cache) cache.put(url, res).catch(() => { });
    return new Uint8Array(buf);
  }
  /**
   * Loads one MediaPipe task. One at a time: each load sets up and then clears a page-wide
   * ModuleFactory, so two loads at once made the second one fail.
   */
  function visionTask(make, url, minBytes, options, cpuOnly) {
    const run = queue.then(() => loadTask(make, url, minBytes, options, cpuOnly));
    queue = run.catch(() => { });
    run.then(() => { status[make] = "ready"; }, (e) => note(make, e));
    return run;
  }
  async function loadTask(make, url, minBytes, options, cpuOnly) {
    const vision = await import("./mediapipe/vision_bundle.mjs");
    const base = new URL("mediapipe/wasm/", location.href).href;
    const fileset = { wasmLoaderPath: base + "vision_wasm_internal.js", wasmBinaryPath: base + "vision_wasm_internal.wasm" };
    const bytes = await modelBytes(url, minBytes), opts = (delegate) => Object.assign({ baseOptions: { modelAssetBuffer: bytes, delegate } }, options);
    if (!cpuOnly) try { return await vision[make].createFromOptions(fileset, opts("GPU")); } catch (_) { }
    return await vision[make].createFromOptions(fileset, opts("CPU"));
  }
  /**
   * The hand-gesture model. Image mode looks for hands afresh in every frame: video mode follows
   * the first hand it finds and kept missing the second one, so two-hand reactions never came.
   */
  function recognizer() {
    if (recognizerPromise) return recognizerPromise;
    recognizerPromise = visionTask("GestureRecognizer", MODEL_URL, 1000000, { runningMode: "IMAGE", numHands: 2, minHandDetectionConfidence: .3, minHandPresenceConfidence: .3 });
    recognizerPromise.catch(() => { recognizerPromise = null; });
    return recognizerPromise;
  }
  /** Finds the person in a video frame, so effects can play behind them. */
  function segmenter() {
    if (segmenterPromise) return segmenterPromise;
    // On the processor: it's a small model, and on some phones' graphics chips its mask read back blank.
    segmenterPromise = visionTask("ImageSegmenter", SEGMENTER_URL, 50000, { runningMode: "IMAGE", outputConfidenceMasks: true, outputCategoryMask: false }, true);
    segmenterPromise.catch(() => { segmenterPromise = null; });
    return segmenterPromise;
  }
  /** Finds faces and eyes, so the laser show starts behind the head and the glasses sit on the eyes. */
  function faceFinder() {
    if (finderPromise) return finderPromise;
    finderPromise = visionTask("FaceDetector", FACE_URL, 50000, { runningMode: "IMAGE", minDetectionConfidence: .5 });
    finderPromise.catch(() => { finderPromise = null; });
    return finderPromise;
  }
  /** Hand points in pixels: the camera frame isn't square, so 0–1 coordinates stretch one way. */
  const toPx = (h, w, ht) => h.map(p => ({ x: p.x * w, y: p.y * ht, z: (p.z || 0) * w }));
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const len = (v) => Math.hypot(v.x, v.y, v.z);
  const dist = (a, b) => len(sub(a, b));
  const flat = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /** How far a finger bends at its middle joint, in degrees: about 0 straight, 90 or more folded. */
  function bend(h, mcp) {
    const a = sub(h[mcp + 1], h[mcp]), b = sub(h[mcp + 3], h[mcp + 1]), n = len(a) * len(b);
    return n ? Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / n))) * 57.3 : 0;
  }
  /**
   * Finger states, read from the 3D hand (in metres, so a hand turned sideways reads the same).
   * mcp is the finger's knuckle: 5 index, 9 middle, 13 ring, 17 pinky.
   */
  const straight = (h, mcp) => bend(h, mcp) < 45 && dist(h[0], h[mcp + 3]) > dist(h[0], h[mcp + 1]) * 1.1;
  const folded = (h, mcp) => bend(h, mcp) > 65 || dist(h[0], h[mcp + 3]) < dist(h[0], h[mcp + 1]);
  const MODEL = { Thumb_Up: "up", Thumb_Down: "down", Victory: "peace", ILoveYou: "horns" };
  /**
   * One hand's sign: "up", "down", "peace", "horns" (🤘 or 🤟) or "". The model decides when
   * it's sure; the shape checks catch the ones it misses (a sideways thumb, rock-on, a loose peace).
   */
  function handPose(top, img, world) {
    if (top && top.score > .5 && MODEL[top.categoryName]) return MODEL[top.categoryName];
    const h = world && world.length > 20 ? world : img;
    if (!h || h.length < 21) return "";
    const ext = [5, 9, 13, 17].map(m => straight(h, m)), fold = [5, 9, 13, 17].map(m => folded(h, m));
    if (ext[0] && ext[3] && fold[1] && fold[2]) return "horns";
    if (ext[0] && ext[1] && fold[2] && fold[3]) return "peace";
    if (fold.every(Boolean)) {
      // A fist with the thumb standing clear above (or below) everything else.
      const size = Math.max(flat(img[0], img[9]), flat(img[5], img[17])) || 1, t = img[4], v = sub(img[4], img[2]);
      let hi = Infinity, lo = -Infinity;
      for (let i = 5; i < 21; i++) { hi = Math.min(hi, img[i].y); lo = Math.max(lo, img[i].y); }
      if (v.y < 0 && -v.y > Math.abs(v.x) && t.y < hi - size * .25) return "up";
      if (v.y > 0 && v.y > Math.abs(v.x) * 1.3 && t.y > lo + size * .25) return "down";
    }
    return "";
  }
  /**
   * Heart hands 🫶: fingertips of both hands meet on one side, thumbs meet on the other, with
   * the knuckles apart (pressed-together palms are not a heart). Upside-down hearts count too.
   * Hands in a heart are hard for the model to find, so this takes what it can get.
   */
  function isHeart(hands, signed) {
    if (hands.length < 2) return 0;
    const [a, b] = hands, size = Math.max(flat(a[0], a[9]), flat(b[0], b[9])) || 1;
    let top = Infinity, ty = 0;
    for (const i of [6, 7, 8, 10, 11, 12]) for (const j of [6, 7, 8, 10, 11, 12]) {
      const d = flat(a[i], b[j]); if (d < top) { top = d; ty = (a[i].y + b[j].y) / 2; }
    }
    const thumbs = flat(a[4], b[4]), by = (a[4].y + b[4].y) / 2, knuckles = flat(a[5], b[5]);
    if (signed) return 0;
    // 2: a clear heart, fingertips and thumbs both meeting; 1: only the fingertip knot.
    if (top < size * .8 && thumbs < size * .9 && Math.abs(ty - by) > size * .3 && knuckles > size * .45) return 2;
    // Close to the camera the model only makes out the knot of fingertips at the top of the heart:
    // two hands whose fingers touch while their knuckles stay apart.
    return top < size * .35 && knuckles > size * .4 ? 1 : 0;
  }
  /** What the hands in one frame show: { id (or null), hands, poses, list, x, y }. Two-hand reactions come first. */
  function classify(res, w, ht) {
    const raw = res.landmarks || [], img = raw.map(h => toPx(h, w, ht)), world = res.worldLandmarks || [], g = res.gestures || [];
    const poses = img.map((h, i) => handPose(g[i] && g[i][0], h, world[i]));
    const n = (p) => poses.filter(x => x === p).length;
    // A sign the model is sure of (two thumbs up held close) is never a heart. Otherwise the heart comes
    // first: curled fingers with thumbs pointing down can look like two thumbs down to the shape checks.
    const signed = g.some(list => { const c = list && list[0]; return c && c.score > .6 && MODEL[c.categoryName]; });
    let id = null, sure = false;
    const heart = isHeart(img, signed);
    if (heart) { id = "hearts"; sure = heart === 2; }
    else if (n("up") >= 2) id = "fireworks";
    else if (n("peace") >= 2) id = "confetti";
    else if (n("down") >= 2) id = "rain";
    else if (n("horns")) id = "lasers";
    else if (n("up")) id = "thumbs";
    else if (n("peace")) id = "balloons";
    else if (n("down")) id = "thumbsdown";
    const list = img.map((h, i) => ({ pose: poses[i], x: h[0].x, size: Math.max(flat(h[0], h[9]), flat(h[5], h[17])) }));
    const pts = raw.map(l => l[0]).filter(Boolean);
    return { id, sure, hands: img.length, poses, list, x: pts.length ? pts.reduce((s, p) => s + p.x, 0) / pts.length : .5, y: pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : .6 };
  }
  /** Two-hand reactions need both hands in view, which the camera loses for a frame now and then. */
  const TWO_HANDS = { hearts: 1, fireworks: 1, confetti: 1, rain: 1 };
  const ONE_TO_TWO = { thumbs: ["up", "fireworks"], balloons: ["peace", "confetti"], thumbsdown: ["down", "rain"] };
  const FAMILY = { thumbs: "up", fireworks: "up", balloons: "peace", confetti: "peace", thumbsdown: "down", rain: "down", hearts: "heart", lasers: "horns" };
  /**
   * The camera sometimes finds only one of two hands per frame. The same sign seen at two places
   * a hand-width apart within 0.4 s is two hands, so it becomes the two-hand reaction.
   */
  function pairUp(hit, seen, now) {
    for (const h of hit.list) if (h.pose) seen.push({ t: now, pose: h.pose, x: h.x, size: h.size });
    while (seen.length && now - seen[0].t > 400) seen.shift();
    const pair = hit.id && ONE_TO_TWO[hit.id];
    if (!pair) return;
    const same = seen.filter(s => s.pose === pair[0]); if (same.length < 2) return;
    const xs = same.map(s => s.x), size = Math.max(...same.map(s => s.size));
    if (Math.max(...xs) - Math.min(...xs) > size * .9) hit.id = pair[1];
  }
  /**
   * The reaction the last few frames agree on, or null. Two-hand reactions need 2 of the last 8
   * frames (a clear heart just 1: the camera rarely sees both hands in one) and win; one-hand ones
   * need 4 of the last 6, and wait while a second hand is joining in.
   */
  function pickReaction(recent) {
    const count = {}, last6 = recent.slice(-6), joining = recent.slice(-2).some(r => r && TWO_HANDS[r.id]);
    recent.forEach((r, i) => { if (r && r.id && (TWO_HANDS[r.id] || i >= recent.length - 6)) count[r.id] = (count[r.id] || 0) + 1; });
    let best = null;
    for (const id in count) {
      const two = !!TWO_HANDS[id];
      const need = two ? (id === "hearts" && recent.some(r => r && r.id === id && r.sure) ? 1 : 2) : 4;
      if (count[id] < need || (!two && (last6.length < 6 || joining))) continue;
      if (!best || (two && !TWO_HANDS[best]) || (two === !!TWO_HANDS[best] && count[id] > count[best])) best = id;
    }
    return best;
  }
  /**
   * The story camera, live: the camera (mirrored for the front one) with a lens drawn on top, onto
   * canvas. Returns controls: set(lensId), mirror(bool), photo() for a still, record(micTrack) for a
   * stream with the lens and (for music lenses) the beat mixed in, and stop().
   */
  function lens(canvas, video, opts) {
    const x = canvas.getContext("2d"), S = document.createElement("canvas"), sx = S.getContext("2d");
    const st = { id: "none", def: LENSES[0], scene: null, t0: 0, raf: 0, mirror: !!(opts && opts.mirror), music: null, mix: null, tracker: personTracker(video), stopped: false };
    const size = () => {
      const r = canvas.getBoundingClientRect(), d = Math.min(LOW_END ? 1.25 : 2, window.devicePixelRatio || 1), w = Math.max(2, Math.round(r.width * d)), h = Math.max(2, Math.round(r.height * d));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      if (S.width !== w || S.height !== h) { S.width = w; S.height = h; }
      return { W: w, H: h, M: Math.min(w, h) };
    };
    // Music lenses play the beat in 4-bar stretches, each queued just before the last one ends.
    const music = (on) => {
      if (!on) { if (st.music) st.music(); st.music = null; return; }
      const next = () => { if (st.stopped || !st.def.music) return; const prev = st.music; st.music = partyBeat(60 / BPM * 16, st.mix, prev && prev.end); if (st.music && st.music.ac) st.musicTimer = setTimeout(next, Math.max(200, (st.music.end - st.music.ac.currentTime - .8) * 1000)); };
      clearTimeout(st.musicTimer); if (st.music) st.music(); st.music = null; next();
    };
    const frame = (now) => {
      if (st.stopped) return;
      st.raf = requestAnimationFrame(frame);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || video.readyState < 2) return;
      const L = size(), k = Math.max(L.W / vw, L.H / vh), view = { x: (L.W - vw * k) / 2, y: (L.H - vh * k) / 2, w: vw * k, h: vh * k };
      sx.setTransform(1, 0, 0, 1, 0, 0); sx.globalAlpha = 1; sx.drawImage(video, view.x, view.y, view.w, view.h);
      if (st.scene) { st.tracker.update(now); st.scene.draw(sx, L, (now - st.t0) / 1000, Infinity, view, st.tracker); }
      x.setTransform(1, 0, 0, 1, 0, 0);
      if (st.mirror) { x.translate(L.W, 0); x.scale(-1, 1); }
      x.drawImage(S, 0, 0);
    };
    st.raf = requestAnimationFrame(frame);
    // Leaving the app (home screen, lock, another app) stops the beat; coming back starts it again.
    const away = () => { clearTimeout(st.musicTimer); if (document.hidden) music(false); else if (!st.stopped && st.def.music) music(true); };
    document.addEventListener("visibilitychange", away);
    return {
      lenses: LENSES.map(l => ({ id: l.id, name: l.name, icon: l.icon })),
      set(id) {
        const def = LENSES.find(l => l.id === id) || LENSES[0];
        st.id = def.id; st.def = def; st.scene = def.scene ? partyScene(def.scene) : null; st.t0 = performance.now();
        clearTimeout(st.musicTimer); music(!!def.music);
      },
      mirror(on) { st.mirror = !!on; },
      /** The picture on screen as a JPEG small enough to share: {img, w, h}. */
      photo() {
        const W = canvas.width, H = canvas.height, k = Math.min(1, 1080 / W), c = document.createElement("canvas");
        c.width = Math.round(W * k); c.height = Math.round(H * k); c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
        for (const q of [.86, .78, .7, .62]) { const out = c.toDataURL("image/jpeg", q); if (out.length <= 700000) return { img: out, w: c.width, h: c.height }; }
        const s = document.createElement("canvas"); s.width = Math.round(c.width * .7); s.height = Math.round(c.height * .7); s.getContext("2d").drawImage(c, 0, 0, s.width, s.height);
        return { img: s.toDataURL("image/jpeg", .7), w: s.width, h: s.height };
      },
      /** A stream of what's on screen plus sound: the microphone, and the beat for music lenses. */
      record(micTrack) {
        const out = canvas.captureStream(30);
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!audio || audio.state === "closed") audio = new AC();
          if (audio.state === "suspended") audio.resume().catch(() => { });
          const dest = audio.createMediaStreamDestination();
          if (micTrack) audio.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
          st.mix = dest; if (st.def.music) music(true);
          dest.stream.getAudioTracks().forEach(t => out.addTrack(t));
        } catch (_) { if (micTrack) out.addTrack(micTrack); }
        return out;
      },
      /** Recording finished: the beat goes back to the speaker only. */
      endRecord() { st.mix = null; if (st.def.music) music(true); },
      stop() { st.stopped = true; document.removeEventListener("visibilitychange", away); cancelAnimationFrame(st.raf); clearTimeout(st.musicTimer); music(false); }
    };
  }

  let debugHook = null;
  /**
   * Watches the front camera for gestures. onReaction(id, origin) fires once a gesture is held
   * for about half a second. Holding it doesn't repeat it: the hand has to drop first (adding the
   * second hand still upgrades 👍 to fireworks). onState("loading" | "ready" | "off").
   */
  function watchGestures(video, onReaction, onState) {
    let stopped = false, timer = 0, recent = [], seen = [], rest = 0, fired = "", clearFrames = 0;
    onState && onState("loading");
    // The other phone's lasers need the face and person cut-out; load them while the call is quiet.
    setTimeout(() => { if (!stopped) { segmenter().catch(() => { }); faceFinder().catch(() => { }); } }, 4000);
    recognizer().then(rec => {
      if (stopped) return; onState && onState("ready");
      const tick = () => {
        if (stopped) return;
        try {
          // While an effect plays the phone's graphics are busy with it, and a new reaction can't start anyway.
          if (video.readyState >= 2 && video.videoWidth && !video.paused && performance.now() > playingUntil) {
            const now = performance.now(), res = rec.recognize(video), hit = classify(res, video.videoWidth, video.videoHeight);
            pairUp(hit, seen, now);
            recent.push(hit); if (recent.length > 8) recent.shift();
            if (fired) { if (hit.id && FAMILY[hit.id] === FAMILY[fired]) clearFrames = 0; else if (++clearFrames >= 3) fired = ""; }
            let pick = now > rest ? pickReaction(recent) : null;
            if (pick && fired && FAMILY[pick] === FAMILY[fired] && !(TWO_HANDS[pick] && !TWO_HANDS[fired])) pick = null;
            if (debugHook) try { debugHook({ hit, pick, res, ms: performance.now() - now }); } catch (_) { }
            if (pick) {
              const at = recent.filter(r => r.id === pick).pop();
              rest = now + 2000; recent = []; fired = pick; clearFrames = 0; onReaction(pick, { x: 1 - at.x, y: at.y });
            }
          }
        } catch (_) { }
        timer = setTimeout(tick, 70);
      };
      tick();
    }).catch(() => { if (!stopped) onState && onState("off"); });
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  window.ScraveitCallFx = { REACTIONS, play, clear, watchGestures, preload() { recognizer().catch(() => { }); }, debug(fn) { debugHook = fn || null; }, status: () => Object.assign({ lowEnd: LOW_END }, status), lens, LENSES: LENSES.map(l => ({ id: l.id, name: l.name, icon: l.icon })) };
})();
