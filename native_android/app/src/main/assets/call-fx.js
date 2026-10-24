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
    { id: "lasers", emoji: "🤘", name: "Lasers", how: "Rock on 🤟" },
    { id: "rain", emoji: "🌧️", name: "Rain", how: "Two thumbs down" },
    { id: "thumbsdown", emoji: "👎", name: "Thumbs down", how: "Thumbs down" }
  ];
  const DURATION = { thumbs: 2.4, thumbsdown: 2.4, hearts: 3.2, balloons: 4.2, confetti: 4, fireworks: 4.2, lasers: 3.6, rain: 4 };

  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const sprites = new Map();
  /** Emoji drawn once into a bitmap, then stamped (much faster than text every frame). */
  function emojiSprite(ch, size) {
    const key = ch + size; if (sprites.has(key)) return sprites.get(key);
    const c = document.createElement("canvas"); c.width = c.height = Math.ceil(size * 1.3);
    const x = c.getContext("2d"); x.font = size + "px sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(ch, c.width / 2, c.height / 2 + size * .06);
    sprites.set(key, c); return c;
  }
  function heart(x, s) { x.beginPath(); x.moveTo(0, -.35 * s); x.bezierCurveTo(-.5 * s, -1.05 * s, -1.35 * s, -.2 * s, 0, .78 * s); x.bezierCurveTo(1.35 * s, -.2 * s, .5 * s, -1.05 * s, 0, -.35 * s); x.closePath(); }

  /** One overlay canvas; any number of reactions can play on it at once. */
  function Layer(canvas) {
    this.c = canvas; this.x = canvas.getContext("2d"); this.parts = []; this.washes = []; this.raf = 0; this.last = 0;
  }
  Layer.prototype.size = function () {
    const r = this.c.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1), w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    this.W = w; this.H = h; this.M = Math.min(w, h);
  };
  Layer.prototype.loop = function () {
    if (this.raf) return;
    const step = (t) => {
      const dt = Math.min(.05, this.last ? (t - this.last) / 1000 : .016); this.last = t;
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
      for (let i = 0; i < 42; i++) {
        const s = rnd(.025, .07) * L.M, col = pick(cols), a = rnd(-Math.PI * .95, -Math.PI * .05), v = rnd(.35, .9) * L.M, sway = rnd(1.5, 3.5), ph = rnd(0, 6);
        L.parts.push({ x: ox + rnd(-.05, .05) * L.W, y: oy, vx: Math.cos(a) * v * .6, vy: Math.sin(a) * v, t: 0, d: i * .03, update(dt) { this.t += dt; if (this.t < this.d) return true; this.x += (this.vx + Math.sin(this.t * sway + ph) * L.M * .12) * dt; this.y += this.vy * dt; this.vx *= .985; this.vy = this.vy * .985 - L.M * .05 * dt; return this.t < 3.1; },
          draw(x) { if (this.t < this.d) return; const k = this.t - this.d, sc = k < .2 ? k / .2 : 1, al = k > 2.2 ? Math.max(0, 1 - (k - 2.2) / .8) : 1;
            x.save(); x.globalAlpha = al; x.translate(this.x, this.y); x.rotate(Math.sin(k * 3 + ph) * .25); x.scale(sc, sc);
            const g = x.createLinearGradient(-s, -s, s, s); g.addColorStop(0, col[0]); g.addColorStop(1, col[1]); heart(x, s); x.fillStyle = g; x.fill();
            x.globalAlpha = al * .55; x.fillStyle = "#fff"; x.beginPath(); x.ellipse(-s * .42, -s * .42, s * .2, s * .1, -.7, 0, 7); x.fill(); x.restore(); } });
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
      const cols = ["#ff3b30", "#ffcc00", "#34c759", "#007aff", "#af52de", "#ff9500", "#ff2d55", "#5ac8fa", "#ffffff"];
      for (const side of [0, 1]) for (let i = 0; i < 70; i++) {
        const a = side ? rnd(-Math.PI * .85, -Math.PI * .6) : rnd(-Math.PI * .4, -Math.PI * .15), v = rnd(.9, 1.6) * L.H, s = rnd(.012, .022) * L.M, col = pick(cols), kind = Math.random(), spin = rnd(4, 12);
        L.parts.push({ x: side ? L.W : 0, y: L.H, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, update(dt) { this.t += dt; this.vy += L.H * 1.1 * dt; this.vx *= .985; this.vy = Math.min(this.vy, L.H * .28); this.x += this.vx * dt + Math.sin(this.t * 5) * s * .6; this.y += this.vy * dt; return this.y < L.H + 40 && this.t < 4.2; },
          draw(x) { x.save(); x.translate(this.x, this.y); x.rotate(this.t * spin); x.fillStyle = col; x.globalAlpha = this.t > 3.4 ? Math.max(0, 1 - (this.t - 3.4) / .8) : 1;
            if (kind < .65) { x.scale(1, Math.abs(Math.cos(this.t * spin * .7)) + .1); x.fillRect(-s, -s * .45, s * 2, s * .9); }
            else { const g = x.createRadialGradient(-s * .2, -s * .2, 0, 0, 0, s * .6); g.addColorStop(0, "#fff"); g.addColorStop(.4, col); g.addColorStop(1, col); x.fillStyle = g; x.beginPath(); x.arc(0, 0, s * .6, 0, 7); x.fill(); }
            x.restore(); } });
      }
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
        for (let i = 0; i < 90; i++) {
          const a = i / 90 * Math.PI * 2 + rnd(-.05, .05), v = rnd(.3, .55) * Lr.M, life = rnd(1.3, 2), trail = [];
          Lr.parts.push({ x: bx, y: by, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, update(dt) { this.t += dt; trail.push([this.x, this.y]); if (trail.length > 7) trail.shift(); this.vx *= .97; this.vy = this.vy * .97 + Lr.M * .18 * dt; this.x += this.vx * dt; this.y += this.vy * dt; return this.t < life; },
            draw(x) { const al = Math.max(0, 1 - this.t / life); x.save(); x.globalCompositeOperation = "lighter"; x.strokeStyle = "rgba(" + col + "," + (al * .8).toFixed(3) + ")"; x.lineWidth = Lr.M * .006; x.lineCap = "round"; x.beginPath(); trail.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.lineTo(this.x, this.y); x.stroke();
              x.fillStyle = "rgba(255,250,235," + al.toFixed(3) + ")"; x.beginPath(); x.arc(this.x, this.y, Lr.M * .006 * (Math.sin(this.t * 30) > .6 ? 1.7 : 1), 0, 7); x.fill(); x.restore(); } });
        }
      }
    },
    rain(L) {
      L.washes.push({ t: 0, life: 4, draw(x, l, k) { const a = k < .15 ? k / .15 : k > .8 ? (1 - k) / .2 : 1; const g = x.createLinearGradient(0, 0, 0, l.H); g.addColorStop(0, "rgba(30,40,60," + (.55 * a).toFixed(3) + ")"); g.addColorStop(1, "rgba(30,40,60," + (.25 * a).toFixed(3) + ")"); x.fillStyle = g; x.fillRect(0, 0, l.W, l.H); } });
      for (let i = 0; i < 160; i++) {
        const d = rnd(0, 3.2), len = rnd(.03, .07) * L.H, sp = rnd(1.1, 1.6) * L.H, x0 = rnd(-.1, 1) * L.W, ground = rnd(.82, 1) * L.H;
        L.parts.push({ x: x0, y: -len, t: 0, update(dt) { this.t += dt; if (this.t < d) return true; this.y += sp * dt; this.x += sp * .12 * dt;
            if (this.y > ground && !this.sp) { this.sp = true; for (let k = 0; k < 3; k++) { const a = rnd(-Math.PI * .9, -Math.PI * .1), v = rnd(.04, .1) * L.M; L.parts.push({ x: this.x, y: this.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, update(dt2) { this.t += dt2; this.vy += L.M * .6 * dt2; this.x += this.vx * dt2; this.y += this.vy * dt2; return this.t < .35; }, draw(x) { x.fillStyle = "rgba(200,225,255,.7)"; x.beginPath(); x.arc(this.x, this.y, L.M * .003, 0, 7); x.fill(); } }); } return false; }
            return true; },
          draw(x) { if (this.t < d) return; x.strokeStyle = "rgba(200,225,255,.65)"; x.lineWidth = Math.max(1, L.M * .0025); x.lineCap = "round"; x.beginPath(); x.moveTo(this.x, this.y); x.lineTo(this.x - len * .12, this.y - len); x.stroke(); } });
      }
    },
    lasers(L) {
      const cols = ["255,40,90", "40,200,255", "120,255,90", "255,220,40", "200,80,255", "255,120,40"];
      L.washes.push({ t: 0, life: 3.6, draw(x, l, k) { const a = k < .1 ? k / .1 : k > .85 ? (1 - k) / .15 : 1; x.fillStyle = "rgba(8,0,24," + (.55 * a).toFixed(3) + ")"; x.fillRect(0, 0, l.W, l.H); } });
      // Stage lights along the top edge, each sweeping its beam back and forth across the screen.
      for (let i = 0; i < 6; i++) {
        const col = cols[i], ox = (i + .5) / 6 * L.W, sp = rnd(1.6, 2.8) * (i % 2 ? 1 : -1), ph = rnd(0, 6), reach = .55 + rnd(0, .25);
        L.parts.push({ t: 0, update(dt) { this.t += dt; return this.t < 3.5; }, draw(x) {
          const al = this.t < .3 ? this.t / .3 : this.t > 3 ? (3.5 - this.t) / .5 : 1, ang = Math.PI / 2 + Math.sin(this.t * sp + ph) * reach, len = Math.hypot(L.W, L.H) * 1.2;
          x.save(); x.globalCompositeOperation = "lighter"; x.lineCap = "round";
          for (const [w, a] of [[L.M * .045, .1], [L.M * .016, .3], [L.M * .005, 1]]) { x.strokeStyle = "rgba(" + col + "," + (a * al).toFixed(3) + ")"; x.lineWidth = w; x.beginPath(); x.moveTo(ox, -4); x.lineTo(ox + Math.cos(ang) * len, Math.sin(ang) * len); x.stroke(); }
          const g = x.createRadialGradient(ox, 0, 0, ox, 0, L.M * .08); g.addColorStop(0, "rgba(255,255,255," + (.9 * al).toFixed(3) + ")"); g.addColorStop(.3, "rgba(" + col + "," + (.6 * al).toFixed(3) + ")"); g.addColorStop(1, "rgba(" + col + ",0)");
          x.fillStyle = g; x.beginPath(); x.arc(ox, 0, L.M * .08, 0, 7); x.fill(); x.restore(); } });
      }
    }
  };

  const layers = new WeakMap();
  /** Plays a reaction over `canvas`. origin {x,y} 0..1 places hand-based ones near the hand. */
  function play(canvas, id, origin) {
    if (!canvas || !SPAWN[id]) return;
    let L = layers.get(canvas); if (!L) { L = new Layer(canvas); layers.set(canvas, L); }
    L.size(); SPAWN[id](L, origin || null); L.loop();
    try { navigator.vibrate && navigator.vibrate(id === "fireworks" ? [20, 60, 20, 60, 20] : 18); } catch (_) { }
  }
  function clear(canvas) { const L = canvas && layers.get(canvas); if (L) L.clear(); }

  // ---- gestures ----
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";
  let recognizerPromise = null;
  async function modelBytes() {
    let cache = null;
    try { cache = await caches.open("scraveit-gestures-v1"); const hit = await cache.match(MODEL_URL); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (_) { cache = null; }
    const res = await fetch(MODEL_URL, { mode: "cors" });
    if (!res.ok) throw new Error("GESTURE_MODEL_HTTP_" + res.status);
    const buf = await res.clone().arrayBuffer();
    if (buf.byteLength < 1000000) throw new Error("GESTURE_MODEL_SHORT");
    if (cache) cache.put(MODEL_URL, res).catch(() => { });
    return new Uint8Array(buf);
  }
  function recognizer() {
    if (recognizerPromise) return recognizerPromise;
    recognizerPromise = (async () => {
      const vision = await import("./mediapipe/vision_bundle.mjs");
      const base = new URL("mediapipe/wasm/", location.href).href;
      const fileset = { wasmLoaderPath: base + "vision_wasm_internal.js", wasmBinaryPath: base + "vision_wasm_internal.wasm" };
      const bytes = await modelBytes();
      const opts = (delegate) => ({ baseOptions: { modelAssetBuffer: bytes, delegate }, runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: .6, minHandPresenceConfidence: .6, minTrackingConfidence: .5 });
      try { return await vision.GestureRecognizer.createFromOptions(fileset, opts("GPU")); }
      catch (_) { return await vision.GestureRecognizer.createFromOptions(fileset, opts("CPU")); }
    })();
    recognizerPromise.catch(() => { recognizerPromise = null; });
    return recognizerPromise;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /** Heart hands: two hands, index tips touching above touching thumb tips. */
  function isHeart(lms) {
    if (!lms || lms.length < 2) return false;
    const [a, b] = lms, span = dist(a[0], a[9]) || .1;
    return dist(a[8], b[8]) < span * .9 && dist(a[4], b[4]) < span * .9 && (a[8].y + b[8].y) / 2 < (a[4].y + b[4].y) / 2 - span * .25;
  }
  function classify(res) {
    const lms = res.landmarks || [], g = (res.gestures || []).map(list => list && list[0] && list[0].score > .6 ? list[0].categoryName : "None");
    const n = (name) => g.filter(x => x === name).length;
    let id = null;
    if (isHeart(lms)) id = "hearts";
    else if (n("Thumb_Up") >= 2) id = "fireworks";
    else if (n("Victory") >= 2) id = "confetti";
    else if (n("Thumb_Down") >= 2) id = "rain";
    else if (n("ILoveYou") >= 1) id = "lasers";
    else if (n("Thumb_Up") === 1) id = "thumbs";
    else if (n("Victory") === 1) id = "balloons";
    else if (n("Thumb_Down") === 1) id = "thumbsdown";
    if (!id) return null;
    const pts = lms.map(l => l[0]).filter(Boolean), cx = pts.length ? pts.reduce((s, p) => s + p.x, 0) / pts.length : .5, cy = pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : .6;
    return { id, x: cx, y: cy };
  }
  /**
   * Watches the front camera for gestures. onReaction(id, origin) fires once a gesture is held
   * for about a third of a second, then rests 3 seconds. onState("loading" | "ready" | "off").
   */
  function watchGestures(video, onReaction, onState) {
    let stopped = false, timer = 0, streak = { id: null, n: 0 }, rest = 0;
    onState && onState("loading");
    recognizer().then(rec => {
      if (stopped) return; onState && onState("ready");
      const tick = () => {
        if (stopped) return;
        try {
          if (video.readyState >= 2 && video.videoWidth && !video.paused) {
            const now = performance.now(), hit = classify(rec.recognizeForVideo(video, now));
            if (now > rest && hit) {
              if (streak.id === hit.id) streak.n++; else streak = { id: hit.id, n: 1 };
              if (streak.n >= 4) { rest = now + 3000; streak = { id: null, n: 0 }; onReaction(hit.id, { x: 1 - hit.x, y: hit.y }); }
            } else if (!hit) streak = { id: null, n: 0 };
          }
        } catch (_) { }
        timer = setTimeout(tick, 90);
      };
      tick();
    }).catch(() => { if (!stopped) onState && onState("off"); });
    return { stop() { stopped = true; clearTimeout(timer); } };
  }

  window.ScraveitCallFx = { REACTIONS, play, clear, watchGestures, preload() { recognizer().catch(() => { }); } };
})();
