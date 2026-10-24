/* Scraveit photo editor engine: filters, adjustments and effects for stories and posts.
 *
 * Every look is built from the same few honest tools a photo app uses: per-channel tone
 * curves, white balance, vibrance, a "food" colour boost that only touches reds, oranges
 * and yellows, split toning, clarity, bloom and grain. Effects read the photo first
 * (where the shiny bits are, where the dish is, which colours glow) so sparkles land on
 * real highlights and the spotlight finds the food. Everything is seeded, so the preview
 * and the shared photo are pixel-for-pixel the same look.
 */
(function () {
  "use strict";

  // ---------- small maths ----------
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function rng(seed) { let s = seed >>> 0; return () => { s = s + 0x6D2B79F5 >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hexRgb(hex) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) || [0, "ff", "ff", "ff"]; return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]; }
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  const FILTER_OK = (() => { try { const x = canvas(2, 2).getContext("2d"); return typeof x.filter === "string"; } catch (_) { return false; } })();
  /** A blurred copy of `src` (canvas filter where supported, otherwise down-and-up scaling). */
  function blurred(src, W, H, radius, opaque) {
    const out = canvas(W, H), x = out.getContext("2d");
    // A photo (opaque) gets its sharp self underneath, so the blur doesn't fade to transparent at the edges.
    if (opaque) x.drawImage(src, 0, 0, W, H);
    if (FILTER_OK && radius > 0) { x.filter = "blur(" + radius.toFixed(1) + "px)"; x.drawImage(src, 0, 0, W, H); x.filter = "none"; return out; }
    const k = Math.max(2, radius / 2), s = canvas(W / k, H / k); s.getContext("2d").drawImage(src, 0, 0, s.width, s.height);
    x.imageSmoothingQuality = "high"; x.drawImage(s, 0, 0, W, H); return out;
  }

  /** Monotone cubic through control points (Fritsch-Carlson): curves never overshoot or band. */
  function curve(points) {
    const p = points.slice().sort((a, b) => a[0] - b[0]), n = p.length;
    if (n < 2) return v => v;
    const dx = [], dy = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx.push(p[i + 1][0] - p[i][0]); dy.push((p[i + 1][1] - p[i][1]) / (dx[i] || 1e-6)); }
    m.push(dy[0]);
    for (let i = 1; i < n - 1; i++) m.push(dy[i - 1] * dy[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / dy[i - 1] + (dx[i] + 2 * dx[i - 1]) / dy[i]));
    m.push(dy[n - 2]);
    return v => {
      if (v <= p[0][0]) return p[0][1];
      if (v >= p[n - 1][0]) return p[n - 1][1];
      let i = 0; while (v > p[i + 1][0]) i++;
      const h = dx[i], t = (v - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
    };
  }

  // ---------- the looks ----------
  // curve: all/r/g/b control points (0..1). wb: [warmth, tint] -1..1. sat, vib, food: extra amounts.
  // split: shadows [r,g,b] and highlights [r,g,b] colour pushes. mono: [r,g,b] channel mix for black & white.
  const FILTERS = [
    { id: "none", name: "Original", use: "Your photo, untouched." },
    { id: "fresh", name: "Fresh", use: "Clean daylight for salads, fruit and juices.",
      curve: { all: [[0, .02], [.25, .24], [.5, .53], [.78, .82], [1, 1]] }, wb: [-.08, -.05], vib: .35, sat: .05, clarity: .15, greens: .25 },
    { id: "spicy", name: "Spicy", use: "Curries and tandoori glow red-hot; whites stay clean.",
      curve: { all: [[0, 0], [.22, .17], [.5, .52], [.8, .85], [1, 1]], r: [[0, 0], [.4, .43], [.85, .87], [1, 1]] }, wb: [.05, .02], food: .85, vib: .15, split: { s: [18, 2, -8], h: [0, 0, 0] }, clarity: .22, vig: .2 },
    { id: "golden", name: "Golden Hour", use: "That low-sun warmth on an evening table.",
      curve: { all: [[0, .03], [.3, .32], [.65, .7], [1, .98]], b: [[0, .02], [.5, .44], [1, .9]] }, wb: [.32, .06], vib: .15, split: { s: [10, 2, -10], h: [22, 12, -14] }, bloom: .35, vig: .2 },
    { id: "chai", name: "Masala Chai", use: "Cosy café browns for tea, coffee and snacks.",
      curve: { all: [[0, .08], [.3, .3], [.7, .7], [1, .94]] }, wb: [.22, .02], sat: -.18, split: { s: [22, 10, -4], h: [14, 8, -6] }, grain: .25, vig: .25 },
    { id: "kaapi", name: "Kaapi", use: "Deep, moody browns like filter coffee.",
      curve: { all: [[0, 0], [.2, .12], [.5, .48], [.8, .84], [1, .96]] }, wb: [.12, 0], sat: -.1, greens: -.6, split: { s: [10, 4, 0], h: [10, 6, -2] }, clarity: .3, vig: .45 },
    { id: "biryani", name: "Biryani", use: "Saffron rice and golden fried onions sing.",
      curve: { all: [[0, .01], [.25, .23], [.55, .6], [1, 1]], g: [[0, 0], [.5, .52], [1, 1]] }, wb: [.2, -.04], food: .55, vib: .2, split: { s: [6, 2, -6], h: [16, 12, -16] }, clarity: .25, bloom: .15 },
    { id: "lassi", name: "Mango Lassi", use: "Soft, sunny and creamy, for sweets and shakes.",
      curve: { all: [[0, .1], [.3, .4], [.7, .82], [1, 1]] }, wb: [.15, -.02], sat: -.08, vib: .12, split: { s: [8, 6, 0], h: [14, 10, -10] }, bloom: .2 },
    { id: "monsoon", name: "Monsoon", use: "Cool, rainy and cinematic.",
      curve: { all: [[0, .04], [.3, .27], [.7, .72], [1, .96]], b: [[0, .08], [.5, .53], [1, .96]] }, wb: [-.3, -.04], sat: -.2, greens: -.3, split: { s: [-10, 6, 16], h: [-4, 2, 6] }, clarity: .1, vig: .25 },
    { id: "bazaar", name: "Night Bazaar", use: "Neon street food: teal shadows, orange lights.",
      curve: { all: [[0, 0], [.2, .14], [.5, .5], [.8, .87], [1, 1]] }, wb: [.05, 0], vib: .4, food: .3, split: { s: [-14, 8, 22], h: [22, 8, -18] }, clarity: .3, vig: .4 },
    { id: "dhaba", name: "Dhaba", use: "Warm roadside lamps and late-night dinners.",
      curve: { all: [[0, .04], [.25, .2], [.6, .64], [1, .95]] }, wb: [.45, .05], sat: .05, food: .3, split: { s: [14, 4, -10], h: [18, 8, -14] }, grain: .3, vig: .35 },
    { id: "butter", name: "Butter", use: "Silky highlights for cakes, ghee and bakes.",
      curve: { all: [[0, .06], [.35, .4], [.75, .82], [1, 1]] }, wb: [.12, .06], sat: -.05, split: { s: [6, 2, 4], h: [14, 10, 2] }, bloom: .45 },
    { id: "berry", name: "Berry", use: "Pinks and purples pop for desserts and smoothies.",
      curve: { all: [[0, .02], [.5, .52], [1, 1]], r: [[0, .02], [.5, .55], [1, 1]], b: [[0, .04], [.5, .52], [1, .98]] }, wb: [0, .2], vib: .35, split: { s: [10, -4, 14], h: [12, 0, 10] } },
    { id: "mint", name: "Mint", use: "Cool and crisp for drinks, ice and greens.",
      curve: { all: [[0, .02], [.3, .3], [.7, .75], [1, 1]], g: [[0, .02], [.5, .53], [1, 1]] }, wb: [-.25, -.1], vib: .2, greens: .3, split: { s: [-6, 6, 10], h: [-4, 6, 8] }, clarity: .2 },
    { id: "pop", name: "Pop", use: "Every colour, louder. Great for thalis.",
      curve: { all: [[0, 0], [.22, .17], [.5, .5], [.78, .84], [1, 1]] }, vib: .55, sat: .15, food: .2, clarity: .35 },
    { id: "gold200", name: "Film Gold", use: "Warm analogue film with soft, rolled highlights.",
      curve: { all: [[0, .06], [.25, .24], [.6, .64], [.9, .9], [1, .95]], r: [[0, .02], [.5, .53], [1, 1]], b: [[0, .05], [.5, .45], [1, .9]] }, wb: [.15, -.06], sat: -.05, grain: .45 },
    { id: "portra", name: "Film Soft", use: "Gentle film tones that flatter faces and food.",
      curve: { all: [[0, .05], [.3, .32], [.7, .72], [1, .97]], g: [[0, .03], [.5, .51], [1, .98]] }, wb: [.08, -.02], sat: -.12, vib: .1, split: { s: [-4, 6, 6], h: [12, 6, -4] }, grain: .3 },
    { id: "instant", name: "Instant", use: "Washed-out instant camera charm.",
      curve: { all: [[0, .14], [.4, .44], [.8, .82], [1, .92]], b: [[0, .12], [.5, .5], [1, .86]] }, wb: [.05, 0], sat: -.15, split: { s: [-8, 6, 12], h: [14, 10, -8] }, vig: .35, grain: .2 },
    { id: "matte", name: "Matte", use: "Flat, modern look for a tidy feed.",
      curve: { all: [[0, .12], [.25, .27], [.75, .76], [1, .93]] }, sat: -.15, vib: .1 },
    { id: "diwali", name: "Diwali", use: "Festive gold glow for sweets and celebrations.",
      curve: { all: [[0, .02], [.3, .3], [.65, .72], [1, 1]] }, wb: [.3, .08], vib: .25, food: .35, split: { s: [12, 2, -8], h: [26, 16, -18] }, bloom: .5, vig: .3 },
    { id: "mono", name: "Clean Mono", use: "Crisp black and white; warm food stays bright.",
      curve: { all: [[0, 0], [.25, .21], [.5, .52], [.8, .86], [1, 1]] }, mono: [.5, .4, .1], clarity: .25 },
    { id: "noir", name: "Noir", use: "Dramatic shadows, deep blacks, film grain.",
      curve: { all: [[0, 0], [.25, .14], [.5, .47], [.75, .84], [1, 1]] }, mono: [.35, .5, .15], clarity: .4, vig: .55, grain: .4 },
    { id: "sepia", name: "Memories", use: "Old family-photo warmth.",
      curve: { all: [[0, .08], [.5, .5], [1, .92]] }, mono: [.35, .5, .15], split: { s: [46, 24, -6], h: [40, 26, 2] }, vig: .35, grain: .3 }
  ];

  // Adjustments: -100..100 (or 0..100). Each one is shaped to look natural at every value.
  const I = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  const ADJUST = [
    { k: "exposure", name: "Exposure", min: -100, note: "Overall light, with highlights protected.", icon: I('<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8v16.4M12 3.8a8.2 8.2 0 0 1 0 16.4" fill="currentColor" stroke="none"/>') },
    { k: "brilliance", name: "Brilliance", min: -100, note: "Opens shadows and calms highlights in one go.", icon: I('<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>') },
    { k: "highlights", name: "Highlights", min: -100, note: "Bring back a bright sky or a white plate.", icon: I('<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 1 7.1 4.1H12z" fill="currentColor" stroke="none"/>') },
    { k: "shadows", name: "Shadows", min: -100, note: "See into the dark corners.", icon: I('<circle cx="12" cy="12" r="8.2"/><path d="M12 20.2a8.2 8.2 0 0 1-7.1-4.1H12z" fill="currentColor" stroke="none"/>') },
    { k: "contrast", name: "Contrast", min: -100, note: "Punchy or soft.", icon: I('<circle cx="12" cy="12" r="8.2"/><path d="M12 3.8a8.2 8.2 0 0 0 0 16.4z" fill="currentColor" stroke="none"/>') },
    { k: "brightness", name: "Brightness", min: -100, note: "Mid-tones up or down.", icon: I('<path d="M12 3v2M12 19v2M3 12h2M19 12h2"/><circle cx="12" cy="12" r="5.5"/>') },
    { k: "blacks", name: "Black point", min: -100, note: "Deeper blacks, or a lifted film look.", icon: I('<circle cx="12" cy="12" r="8.2" fill="currentColor"/>') },
    { k: "saturation", name: "Saturation", min: -100, note: "All colours stronger or weaker.", icon: I('<circle cx="9" cy="10" r="5.2"/><circle cx="15" cy="10" r="5.2"/><circle cx="12" cy="15" r="5.2"/>') },
    { k: "vibrance", name: "Vibrance", min: -100, note: "Boosts dull colours, spares the bright ones.", icon: I('<path d="M12 3.5c3 3.6 5.6 6.6 5.6 9.9a5.6 5.6 0 0 1-11.2 0c0-3.3 2.6-6.3 5.6-9.9Z"/><path d="M9.2 14a2.8 2.8 0 0 0 2.8 2.8"/>') },
    { k: "food", name: "Food", min: 0, note: "Scraveit special: richer curries, golden fries, red chillies.", icon: I('<path d="M4 12h16a8 8 0 0 1-16 0Z"/><path d="M9 8.5c0-1.4 1.2-1.6 1.2-3M13 8.5c0-1.4 1.2-1.6 1.2-3"/>') },
    { k: "warmth", name: "Warmth", min: -100, note: "Cool blue to warm gold.", icon: I('<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0Z"/><path d="M12 9v7"/>') },
    { k: "tint", name: "Tint", min: -100, note: "Fix a green or pink colour cast.", icon: I('<path d="M12 3.5 5 12a7 7 0 0 0 14 0Z"/>') },
    { k: "clarity", name: "Clarity", min: -100, note: "Texture and crunch, or a soft glow.", icon: I('<path d="m12 3 7.5 4.5v9L12 21l-7.5-4.5v-9Z"/><path d="M12 12 19.5 7.5M12 12v9M12 12 4.5 7.5"/>') },
    { k: "sharpness", name: "Sharpness", min: 0, note: "Fine detail: crumbs, sesame, steam.", icon: I('<path d="M4 20 20 4M4 14l6 6M10 4l10 10"/>') },
    { k: "glow", name: "Glow", min: 0, note: "Soft light around the brightest parts.", icon: I('<circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2.6"/>') },
    { k: "fade", name: "Fade", min: 0, note: "Lift the blacks for a vintage wash.", icon: I('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 15 20 9" />') },
    { k: "vignette", name: "Vignette", min: -100, note: "Darken (or lighten) the edges to frame the dish.", icon: I('<rect x="3.5" y="5" width="17" height="14" rx="3"/><ellipse cx="12" cy="12" rx="5" ry="3.8"/>') },
    { k: "grain", name: "Grain", min: 0, note: "Real film texture.", icon: I('<circle cx="7" cy="7" r="1"/><circle cx="12" cy="9" r="1"/><circle cx="17" cy="6" r="1"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="13" r="1"/><circle cx="6" cy="18" r="1"/><circle cx="12" cy="18" r="1"/><circle cx="18" cy="18" r="1"/>') }
  ];
  function adjDefaults() { const o = {}; ADJUST.forEach(a => { o[a.k] = 0; }); return o; }

  const EFFECTS = [
    { id: "none", name: "None", use: "No effect." },
    { id: "glow", name: "Glow", use: "A soft halo grows from the brightest spots." },
    { id: "dreamy", name: "Dreamy", use: "Hazy, romantic edges; the dish stays sharp." },
    { id: "sparkle", name: "Sparkle", use: "Twinkles land on the photo's real shiny bits." },
    { id: "bokeh", name: "Bokeh", use: "Fairy-light circles in the photo's own colours." },
    { id: "steam", name: "Steam", use: "Hot-from-the-kitchen wisps rise off the food." },
    { id: "sizzle", name: "Sizzle", use: "Embers and heat rising from the bottom." },
    { id: "hearts", name: "Hearts", use: "Glossy hearts floating up, near and far." },
    { id: "confetti", name: "Confetti", use: "Party confetti, ribbons and sequins." },
    { id: "leak", name: "Light Leak", use: "Warm film light bleeding in from the edge." },
    { id: "prism", name: "Prism", use: "A rainbow streak and crystal colour fringes." },
    { id: "rays", name: "Sun Rays", use: "Light beams and a lens flare from the brightest area." },
    { id: "rain", name: "Rain Glass", use: "Real-looking drops on a rainy window." },
    { id: "snow", name: "Snow", use: "Soft flakes drifting down." },
    { id: "spotlight", name: "Spotlight", use: "Finds the dish and puts it centre stage." },
    { id: "tilt", name: "Miniature", use: "Tilt-shift blur makes the table look tiny." },
    { id: "neon", name: "Neon", use: "Glowing neon outlines traced from your photo." },
    { id: "comic", name: "Comic", use: "Pop-art inks, halftone dots and bold lines." },
    { id: "glitch", name: "Glitch", use: "Digital RGB slices and scan noise." },
    { id: "duotone", name: "Duotone", use: "Two-colour poster in midnight and peach." },
    { id: "retro", name: "Retro TV", use: "VHS scanlines, colour bleed and a timestamp." },
    { id: "strip", name: "Film Strip", use: "35 mm frame with sprockets and edge code." },
    { id: "polaroid", name: "Polaroid", use: "Instant frame with the date written in." },
    { id: "magazine", name: "Cover Star", use: "Your dish on a food magazine cover." }
  ];

  // ---------- reading the photo ----------
  // Small analysis of the unedited photo: specular highlights, the brightest region, where the dish is,
  // its glowing colours and an edge map. Cached per source canvas.
  const analyses = new WeakMap();
  function analyze(base) {
    const cached = analyses.get(base); if (cached) return cached;
    const W = 96, H = Math.max(24, Math.round(96 * base.height / base.width)), s = canvas(W, H), x = s.getContext("2d");
    x.drawImage(base, 0, 0, W, H);
    const p = x.getImageData(0, 0, W, H).data, Y = new Float32Array(W * H), S = new Float32Array(W * H);
    let sx = 0, sy = 0, sw = 0, bx = 0, by = 0, bw = 0;
    const palette = [];
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const r = p[i], g = p[i + 1], b = p[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), y = .2126 * r + .7152 * g + .0722 * b, sat = mx ? (mx - mn) / mx : 0;
      Y[j] = y; S[j] = sat;
      const px = j % W, py = (j / W) | 0, centre = 1 - .7 * Math.hypot(px / W - .5, py / H - .52);
      const interest = sat * (y / 255) * centre; sx += interest * px; sy += interest * py; sw += interest;
      const bright = Math.pow(y / 255, 6); bx += bright * px; by += bright * py; bw += bright;
      if (sat > .35 && y > 90) palette.push([r, g, b, sat * y]);
    }
    // Specular points: local maxima that are bright and nearly white.
    const spots = [];
    for (let yy = 1; yy < H - 1; yy++) for (let xx = 1; xx < W - 1; xx++) {
      const j = yy * W + xx, v = Y[j];
      if (v < 175 || S[j] > .45) continue;
      let peak = true; for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && Y[j + dy * W + dx] > v) { peak = false; break; }
      if (peak) spots.push({ x: (xx + .5) / W, y: (yy + .5) / H, v: v / 255 });
    }
    spots.sort((a, b) => b.v - a.v);
    palette.sort((a, b) => b[3] - a[3]);
    const pal = []; for (const c of palette) { if (pal.length >= 6) break; if (pal.every(q => Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]) + Math.abs(q[2] - c[2]) > 90)) pal.push(c.slice(0, 3)); }
    if (pal.length < 3) pal.push([255, 196, 120], [255, 150, 90], [255, 236, 200]);
    // Sobel edges for Neon and Comic, at a modest size.
    const EW = 240, EH = Math.max(24, Math.round(240 * base.height / base.width)), e = canvas(EW, EH), ex = e.getContext("2d");
    ex.drawImage(base, 0, 0, EW, EH);
    const ed = ex.getImageData(0, 0, EW, EH), q = ed.data, L = new Float32Array(EW * EH);
    for (let i = 0, j = 0; i < q.length; i += 4, j++) L[j] = .2126 * q[i] + .7152 * q[i + 1] + .0722 * q[i + 2];
    const edges = new Float32Array(EW * EH); let emax = 1;
    for (let yy = 1; yy < EH - 1; yy++) for (let xx = 1; xx < EW - 1; xx++) {
      const j = yy * EW + xx, gx = L[j - EW + 1] + 2 * L[j + 1] + L[j + EW + 1] - L[j - EW - 1] - 2 * L[j - 1] - L[j + EW - 1], gy = L[j + EW - 1] + 2 * L[j + EW] + L[j + EW + 1] - L[j - EW - 1] - 2 * L[j - EW] - L[j - EW + 1];
      const m = Math.hypot(gx, gy); edges[j] = m; if (m > emax) emax = m;
    }
    const a = {
      spots: spots.slice(0, 40),
      subject: sw > 0 ? { x: clamp((sx / sw + .5) / W, .2, .8), y: clamp((sy / sw + .5) / H, .2, .8) } : { x: .5, y: .5 },
      light: bw > 0 ? { x: (bx / bw + .5) / W, y: (by / bw + .5) / H } : { x: .2, y: .1 },
      palette: pal, edges, ew: EW, eh: EH, emax
    };
    analyses.set(base, a); return a;
  }

  // ---------- colour pipeline ----------
  function lerpCurve(points, t) { const c = curve(points); return v => v + (c(v) - v) * t; }
  function buildLuts(f, t, a) {
    const ex = a.exposure / 100, br = a.brilliance / 100, hi = a.highlights / 100, sh = a.shadows / 100, co = a.contrast / 100, bt = a.brightness / 100, bp = a.blacks / 100, fd = a.fade / 100;
    const cAll = f.curve && f.curve.all ? lerpCurve(f.curve.all, t) : null;
    const cCh = ["r", "g", "b"].map(k => f.curve && f.curve[k] ? lerpCurve(f.curve[k], t) : null);
    const gain = Math.pow(2, ex * .9), knee = .78, gamma = Math.pow(2, -bt * .75), k = 1 + co * .9;
    const luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
    // Shadow and highlight moves keep black at black and white at white, and can never fold back on
    // themselves (a fold is what turns dark reds teal).
    const lift = (u, s) => s >= 0 ? u + s * 1.6 * u * Math.pow(1 - u, 3) : u + s * .7 * u * Math.pow(1 - u, 3);
    const shoulder = v => v > knee ? knee + (1 - knee) * (1 - Math.exp(-(v - knee) / (1 - knee))) : v, top = gain > 1 ? shoulder(gain) : 1;
    for (let v = 0; v < 256; v++) {
      let x = v / 255;
      // Exposure: brighter with a soft shoulder (whites stay white, highlights roll off), darker by plain gain.
      x = gain > 1 ? shoulder(x * gain) / top : x * gain;
      // Brilliance: open the shadows and calm the highlights together.
      if (br) { x = lift(x, br * .6); x = 1 - lift(1 - x, br * .35); }
      if (hi) x = 1 - lift(1 - x, -hi * .6);
      if (sh) x = lift(x, sh);
      x = clamp(x, 0, 1);
      if (bt) x = Math.pow(x, gamma);
      if (co) x = x < .5 ? .5 * Math.pow(2 * x, k) : 1 - .5 * Math.pow(2 * (1 - x), k);
      if (bp > 0) x = clamp((x - bp * .12) / (1 - bp * .12), 0, 1); else if (bp < 0) x = -bp * .12 + x * (1 + bp * .12);
      if (fd) x = .13 * fd + x * (1 - .17 * fd);
      if (cAll) x = cAll(x);
      for (let c = 0; c < 3; c++) luts[c][v] = Math.round(clamp(cCh[c] ? cCh[c](x) : x, 0, 1) * 255);
    }
    return luts;
  }

  function colour(c, d, base) {
    const W = c.width, H = c.height, x = c.getContext("2d"), f = filterById(d.filter), t = clamp((+d.amount || 0) / 100, 0, 1), a = Object.assign(adjDefaults(), d.adj || {});
    x.drawImage(base, 0, 0, W, H);
    const warm = clamp((f.wb ? f.wb[0] * t : 0) + a.warmth / 100 * .8, -1.2, 1.2), tint = clamp((f.wb ? f.wb[1] * t : 0) + a.tint / 100 * .6, -1, 1);
    const sat = 1 + (f.sat || 0) * t + a.saturation / 100, vib = (f.vib || 0) * t + a.vibrance / 100, food = (f.food || 0) * t + a.food / 100, greens = (f.greens || 0) * t;
    const mono = f.mono ? t : 0, mw = f.mono || [0, 0, 0];
    const ss = f.split ? f.split.s.map(v => v * t) : null, sh = f.split ? f.split.h.map(v => v * t) : null;
    const luts = buildLuts(f, t, a);
    const plain = !warm && !tint && sat === 1 && !vib && !food && !greens && !mono && !ss && luts.every(l => l.every((v, i) => v === i));
    if (plain) return;
    const wr = 1 + .13 * warm + .04 * tint, wg = 1 + .02 * warm - .08 * tint, wb = 1 - .16 * warm + .04 * tint;
    const img = x.getImageData(0, 0, W, H), p = img.data, LR = luts[0], LG = luts[1], LB = luts[2];
    for (let i = 0; i < p.length; i += 4) {
      let r = LR[clamp(p[i] * wr, 0, 255) | 0], g = LG[clamp(p[i + 1] * wg, 0, 255) | 0], b = LB[clamp(p[i + 2] * wb, 0, 255) | 0];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b), dl = mx - mn;
      if (dl > 0 && (sat !== 1 || vib || food || greens)) {
        const Y = .2126 * r + .7152 * g + .0722 * b, s = dl / (mx + 1);
        let f2 = sat * (1 + vib * (1 - s) * .95);
        // Warm-hue weight (red→orange→yellow) for the Food boost, green weight for fresh herbs.
        let hue;
        if (mx === r) hue = 60 * (g - b) / dl; else if (mx === g) hue = 60 * (2 + (b - r) / dl); else hue = 60 * (4 + (r - g) / dl);
        if (hue < 0) hue += 360;
        if (food) { const wf = hue < 70 ? 1 - Math.abs(hue - 28) / 45 : hue > 345 ? .6 : 0; if (wf > 0) { f2 *= 1 + food * wf * .65 * (.4 + s); const lift = 1 + food * wf * .05; r *= lift; g *= lift; b *= lift; } }
        if (greens) { const wgc = hue > 70 && hue < 170 ? 1 - Math.abs(hue - 115) / 50 : 0; if (wgc > 0) f2 *= 1 + greens * wgc * .7; }
        r = Y + (r - Y) * f2; g = Y + (g - Y) * f2; b = Y + (b - Y) * f2;
      }
      if (mono) { const m = r * mw[0] + g * mw[1] + b * mw[2]; r += (m - r) * mono; g += (m - g) * mono; b += (m - b) * mono; }
      if (ss) { const y = (.2126 * r + .7152 * g + .0722 * b) / 255, ws = (1 - y) * (1 - y), wh = y * y; r += ws * ss[0] + wh * sh[0]; g += ws * ss[1] + wh * sh[1]; b += ws * ss[2] + wh * sh[2]; }
      p[i] = r; p[i + 1] = g; p[i + 2] = b;
    }
    x.putImageData(img, 0, 0);
  }

  /** Clarity (large-radius local contrast, mid-tones only) and sharpening (small radius). */
  function detail(c, clarity, sharp) {
    if (!clarity && !sharp) return;
    const W = c.width, H = c.height, x = c.getContext("2d"), M = Math.min(W, H), img = x.getImageData(0, 0, W, H), p = img.data;
    const passes = [];
    if (clarity) passes.push([blurred(c, W, H, M * .025, true).getContext("2d").getImageData(0, 0, W, H).data, clarity, true]);
    if (sharp) passes.push([blurred(c, W, H, Math.max(.8, M / 900), true).getContext("2d").getImageData(0, 0, W, H).data, sharp * 1.6, false]);
    for (const [b, amt, mid] of passes) for (let i = 0; i < p.length; i += 4) {
      let k = amt;
      if (mid) { const y = (.2126 * p[i] + .7152 * p[i + 1] + .0722 * p[i + 2]) / 255; k *= 1 - Math.abs(y - .5) * 1.5; }
      p[i] += (p[i] - b[i]) * k; p[i + 1] += (p[i + 1] - b[i + 1]) * k; p[i + 2] += (p[i + 2] - b[i + 2]) * k;
    }
    x.putImageData(img, 0, 0);
  }

  /** Bloom: only light above a threshold spreads, in its own colour. */
  function bloom(x, c, W, H, amt, warm) {
    if (amt <= 0) return;
    const sw = Math.max(16, Math.round(W / 6)), shh = Math.max(16, Math.round(H / 6)), s = canvas(sw, shh), sx = s.getContext("2d");
    sx.drawImage(c, 0, 0, sw, shh);
    const d = sx.getImageData(0, 0, sw, shh), p = d.data;
    for (let i = 0; i < p.length; i += 4) { const y = .2126 * p[i] + .7152 * p[i + 1] + .0722 * p[i + 2], k = smooth(150, 245, y); p[i] *= k * (warm ? 1.05 : 1); p[i + 1] *= k; p[i + 2] *= k * (warm ? .9 : 1); }
    sx.putImageData(d, 0, 0);
    const M = Math.min(W, H);
    x.save(); x.globalCompositeOperation = "screen";
    x.globalAlpha = clamp(amt * .85, 0, 1); x.drawImage(blurred(s, W, H, M * .018), 0, 0, W, H);
    x.globalAlpha = clamp(amt * .55, 0, 1); x.drawImage(blurred(s, W, H, M * .06), 0, 0, W, H);
    x.restore();
  }
  function vignette(x, W, H, v) {
    if (!v) return;
    const g = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .3, W / 2, H / 2, Math.hypot(W, H) / 2), dark = v > 0, a = Math.min(.9, Math.abs(v));
    const col = dark ? "0,0,0" : "255,255,255";
    g.addColorStop(0, "rgba(" + col + ",0)"); g.addColorStop(.6, "rgba(" + col + "," + (a * .3).toFixed(3) + ")"); g.addColorStop(1, "rgba(" + col + "," + a.toFixed(3) + ")");
    x.save(); x.globalCompositeOperation = dark ? "multiply" : "screen"; x.fillStyle = g; x.fillRect(0, 0, W, H); x.restore();
  }
  let noiseTile = null;
  function noise() {
    if (noiseTile) return noiseTile;
    const c = canvas(256, 256), x = c.getContext("2d"), d = x.createImageData(256, 256), R = rng(11);
    for (let i = 0; i < d.data.length; i += 4) { const v = 128 + ((R() + R() + R()) / 3 - .5) * 230; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0); noiseTile = c; return c;
  }
  /** Film grain: clumpy, strongest in the mid-tones, scaled to the photo. */
  function grain(x, W, H, g) {
    if (g <= 0) return;
    const k = Math.max(W, H) / 900;
    x.save(); x.globalCompositeOperation = "overlay"; x.globalAlpha = clamp(g * .85, 0, 1); x.scale(k, k);
    x.fillStyle = x.createPattern(noise(), "repeat"); x.fillRect(0, 0, W / k + 1, H / k + 1); x.restore();
  }

  // ---------- effect helpers ----------
  function glint(x, cx, cy, r, rot, warm) {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r * 2.4);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(.12, "rgba(255,255,255,.85)"); g.addColorStop(.35, warm ? "rgba(255,236,190,.35)" : "rgba(220,235,255,.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r * 2.4, 0, 7); x.fill();
    x.save(); x.translate(cx, cy); x.rotate(rot); x.lineCap = "round";
    // Four long rays and four short ones, each fading out like light through a lens.
    for (let k = 0; k < 8; k++) {
      const len = r * (k % 2 ? 2.6 : 6.5), ray = x.createLinearGradient(0, 0, len, 0);
      ray.addColorStop(0, "rgba(255,255,255,.95)"); ray.addColorStop(1, "rgba(255,255,255,0)");
      x.strokeStyle = ray; x.lineWidth = Math.max(.6, r * (k % 2 ? .14 : .2));
      x.beginPath(); x.moveTo(0, 0); x.lineTo(len, 0); x.stroke(); x.rotate(Math.PI / 4);
    }
    x.restore();
  }
  function heartPath(x, s) { x.beginPath(); x.moveTo(0, -.35 * s); x.bezierCurveTo(-.5 * s, -1.05 * s, -1.35 * s, -.2 * s, 0, .78 * s); x.bezierCurveTo(1.35 * s, -.2 * s, .5 * s, -1.05 * s, 0, -.35 * s); x.closePath(); }
  function glossyHeart(x, cx, cy, s, rot, col) {
    x.save(); x.translate(cx, cy); x.rotate(rot);
    x.shadowColor = "rgba(120,0,40,.35)"; x.shadowBlur = s * .4; x.shadowOffsetY = s * .12;
    const g = x.createLinearGradient(-s, -s, s, s); g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
    heartPath(x, s); x.fillStyle = g; x.fill(); x.shadowColor = "transparent";
    x.globalAlpha = .55; x.fillStyle = "#fff"; x.beginPath(); x.ellipse(-s * .42, -s * .42, s * .2, s * .1, -.7, 0, 7); x.fill();
    x.restore();
  }
  function roundRect(x, X, Y, w, h, r) { x.beginPath(); r = Math.max(0, Math.min(r, w / 2, h / 2)); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
  const css = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";

  // ---------- effects ----------
  const FX = {
    glow(x, c, W, H, t) { bloom(x, c, W, H, 1.1 * t, true); x.save(); x.globalCompositeOperation = "soft-light"; x.globalAlpha = .25 * t; x.fillStyle = "#ffd9a0"; x.fillRect(0, 0, W, H); x.restore(); },
    dreamy(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), soft = blurred(c, W, H, M * .03, true), m = canvas(W, H), mx = m.getContext("2d");
      mx.drawImage(soft, 0, 0);
      const g = mx.createRadialGradient(A.subject.x * W, A.subject.y * H, M * .18, A.subject.x * W, A.subject.y * H, Math.hypot(W, H) * .55);
      g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
      mx.globalCompositeOperation = "destination-out"; mx.fillStyle = g; mx.fillRect(0, 0, W, H);
      x.save(); x.globalAlpha = t; x.drawImage(m, 0, 0);
      x.globalCompositeOperation = "screen"; x.globalAlpha = .28 * t; x.drawImage(soft, 0, 0);
      const h = x.createLinearGradient(0, 0, W, H); h.addColorStop(0, "#ffd1e8"); h.addColorStop(1, "#d6d1ff");
      x.globalCompositeOperation = "soft-light"; x.globalAlpha = .35 * t; x.fillStyle = h; x.fillRect(0, 0, W, H); x.restore();
    },
    sparkle(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), spots = A.spots.length >= 4 ? A.spots : A.spots.concat([{ x: A.light.x, y: A.light.y, v: 1 }]);
      x.save(); x.globalCompositeOperation = "screen";
      const n = Math.round(4 + 12 * t);
      spots.slice(0, n).forEach((s, i) => glint(x, s.x * W, s.y * H, M * (.007 + .014 * s.v * (i < 3 ? 1.6 : 1)) * (.7 + .5 * t), (R() - .5) * .3, i % 2 === 0));
      for (let i = 0; i < 50 * t; i++) { const s = spots[i % spots.length], cx = s.x * W + (R() - .5) * M * .25, cy = s.y * H + (R() - .5) * M * .25, r = M * (.0015 + R() * .003); x.fillStyle = "rgba(255,250,235," + (.4 + R() * .6).toFixed(2) + ")"; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill(); }
      x.restore();
    },
    bokeh(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), far = canvas(W, H), fx = far.getContext("2d"), near = canvas(W, H), nx = near.getContext("2d"), cols = A.palette.concat([[255, 214, 150], [255, 245, 225]]);
      const n = Math.round(14 + 26 * t);
      for (let i = 0; i < n; i++) {
        let px, py, tries = 0; do { px = R(); py = R() * .9; tries++; } while (tries < 6 && Math.hypot(px - A.subject.x, py - A.subject.y) < .28);
        const big = R() < .4, r = M * (big ? .07 + R() * .08 : .025 + R() * .045), col = cols[(R() * cols.length) | 0], ctx = big ? nx : fx, hex = R() < .3;
        const g = ctx.createRadialGradient(px * W, py * H, r * .2, px * W, py * H, r);
        g.addColorStop(0, css(col, .38)); g.addColorStop(.8, css(col, .5)); g.addColorStop(.94, css(col, .78)); g.addColorStop(1, css(col, 0));
        ctx.fillStyle = g; ctx.beginPath();
        if (hex) for (let k = 0; k < 6; k++) { const ang = k * Math.PI / 3 + .3; ctx[k ? "lineTo" : "moveTo"](px * W + Math.cos(ang) * r, py * H + Math.sin(ang) * r); }
        else ctx.arc(px * W, py * H, r, 0, 7);
        ctx.fill();
      }
      // Background softens a touch so the lights read as out-of-focus.
      x.save(); x.globalAlpha = .35 * t; x.drawImage(blurred(c, W, H, M * .008, true), 0, 0);
      x.globalCompositeOperation = "screen"; x.globalAlpha = Math.min(1, .7 + .4 * t);
      x.drawImage(blurred(far, W, H, M * .004), 0, 0); x.drawImage(blurred(near, W, H, M * .012), 0, 0); x.restore();
    },
    steam(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), s = canvas(W, H), sx = s.getContext("2d"), base = A.subject;
      sx.lineCap = "round";
      for (let i = 0; i < 6; i++) {
        const x0 = (base.x + (i - 2.5) * .06 + (R() - .5) * .04) * W, y0 = Math.min(.92, base.y + .12 + R() * .06) * H, top = (base.y - .45 - R() * .15) * H;
        const g = sx.createLinearGradient(0, y0, 0, top); g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(.22, "rgba(255,255,255,.75)"); g.addColorStop(.7, "rgba(255,255,255,.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
        sx.strokeStyle = g; sx.lineWidth = M * (.02 + R() * .025);
        sx.beginPath(); sx.moveTo(x0, y0);
        let px = x0; const steps = 5;
        for (let k = 1; k <= steps; k++) { const y = y0 + (top - y0) * k / steps, nx = x0 + Math.sin(k * 1.3 + i * 2) * M * .05 * (k / steps + .3); sx.quadraticCurveTo((px + nx) / 2 + (R() - .5) * M * .06, y + (y0 - top) / steps / 2, nx, y); px = nx; }
        sx.stroke();
      }
      const soft = blurred(s, W, H, M * .02), crisp = blurred(s, W, H, M * .006);
      // A faint grey underneath lets white steam show up even over a white plate.
      x.save(); x.globalCompositeOperation = "multiply"; x.globalAlpha = .12 * t; x.filter = FILTER_OK ? "invert(1)" : "none"; x.drawImage(soft, M * .004, M * .004); x.filter = "none";
      x.globalCompositeOperation = "screen"; x.globalAlpha = .8 + .2 * t; x.drawImage(soft, 0, 0); x.globalAlpha = .6 * t; x.drawImage(crisp, 0, 0); x.restore();
    },
    sizzle(x, c, W, H, t, R) {
      const M = Math.min(W, H);
      x.save(); x.globalCompositeOperation = "screen";
      const g = x.createLinearGradient(0, H, 0, H * .5); g.addColorStop(0, "rgba(255,90,10," + (.55 * t).toFixed(2) + ")"); g.addColorStop(.5, "rgba(255,150,30," + (.18 * t).toFixed(2) + ")"); g.addColorStop(1, "rgba(255,180,60,0)");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 70 * t + 10; i++) {
        const ex = R() * W, ey = H * (.35 + R() * .65), len = M * (.01 + R() * .03), r = M * (.002 + R() * .005), ang = -Math.PI / 2 + (R() - .5) * .6;
        x.strokeStyle = "rgba(255," + (140 + (R() * 100 | 0)) + ",40," + (.5 + R() * .5).toFixed(2) + ")"; x.lineWidth = r * 2; x.lineCap = "round";
        x.shadowColor = "rgba(255,120,0,.9)"; x.shadowBlur = r * 6;
        x.beginPath(); x.moveTo(ex, ey); x.lineTo(ex + Math.cos(ang) * len, ey + Math.sin(ang) * len); x.stroke();
      }
      x.restore();
    },
    hearts(x, c, W, H, t, R) {
      const M = Math.min(W, H), back = canvas(W, H), bx = back.getContext("2d"), cols = [["#ff6b8a", "#e0154d"], ["#ff9ec0", "#ff4f8b"], ["#ffd1dc", "#ff7aa2"], ["#ff4d6d", "#b5003a"]];
      const n = Math.round(6 + 14 * t);
      for (let i = 0; i < n; i++) {
        const u = i / n, px = .1 + R() * .8, py = 1 - u * .95 + (R() - .5) * .12, near = R() < .45, s = M * (near ? .035 + R() * .04 : .015 + R() * .02);
        glossyHeart(near ? x : bx, px * W, py * H, s, (R() - .5) * .7, cols[(R() * cols.length) | 0]);
      }
      x.save(); x.globalAlpha = .85; x.drawImage(blurred(back, W, H, M * .004), 0, 0); x.restore();
    },
    confetti(x, c, W, H, t, R) {
      const M = Math.min(W, H), back = canvas(W, H), bx = back.getContext("2d"), cols = ["#ff3b30", "#ffcc00", "#34c759", "#007aff", "#af52de", "#ff9500", "#ff2d55", "#5ac8fa"];
      const n = Math.round(40 + 90 * t);
      for (let i = 0; i < n; i++) {
        const ctx = R() < .35 ? bx : x, px = R() * W, py = Math.pow(R(), 1.4) * H, col = cols[(R() * cols.length) | 0], kind = R(), s = M * (.008 + R() * .012) * (ctx === x ? 1.2 : .8);
        ctx.save(); ctx.translate(px, py); ctx.rotate(R() * Math.PI * 2);
        if (kind < .5) { ctx.scale(1, Math.abs(Math.cos(R() * 3)) + .15); ctx.fillStyle = col; ctx.fillRect(-s, -s * .4, s * 2, s * .8); }
        else if (kind < .75) { ctx.strokeStyle = col; ctx.lineWidth = s * .45; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(-s * 2, 0); ctx.bezierCurveTo(-s, -s * 1.6, s, s * 1.6, s * 2, 0); ctx.stroke(); }
        else { const g = ctx.createRadialGradient(-s * .25, -s * .25, 0, 0, 0, s * .7); g.addColorStop(0, "#fff"); g.addColorStop(.35, col); g.addColorStop(1, col); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, s * .7, 0, 7); ctx.fill(); }
        ctx.restore();
      }
      x.save(); x.globalAlpha = .9; x.drawImage(blurred(back, W, H, M * .005), 0, 0); x.restore();
    },
    leak(x, c, W, H, t, R) {
      const L = Math.max(W, H), v = (R() * 3) | 0;
      x.save(); x.globalCompositeOperation = "screen";
      const spots = v === 0 ? [[W, H * .1, "255,110,30", 1], [W * .85, 0, "255,50,110", .55]] : v === 1 ? [[0, H * .3, "255,70,130", .9], [0, H * .7, "255,180,60", .75]] : [[W * .3, -H * .1, "255,170,60", 1], [W, H * .9, "255,80,50", .6]];
      // Light leaks burn warm into the photo before glowing on top.
      for (const [cx, cy, col, al] of spots) { const g = x.createRadialGradient(cx, cy, 0, cx, cy, L * .6); g.addColorStop(0, "rgba(" + col + "," + (al * .5 * t).toFixed(3) + ")"); g.addColorStop(1, "rgba(" + col + ",0)"); x.globalCompositeOperation = "multiply"; x.fillStyle = g; x.fillRect(0, 0, W, H); }
      x.globalCompositeOperation = "screen";
      for (const [cx, cy, col, al] of spots) { const g = x.createRadialGradient(cx, cy, 0, cx, cy, L * .75); g.addColorStop(0, "rgba(" + col + "," + (al * t).toFixed(3) + ")"); g.addColorStop(.5, "rgba(" + col + "," + (al * .35 * t).toFixed(3) + ")"); g.addColorStop(1, "rgba(" + col + ",0)"); x.fillStyle = g; x.fillRect(0, 0, W, H); }
      x.globalAlpha = .5 * t; grain(x, W, H, .3); x.restore();
    },
    prism(x, c, W, H, t, R) {
      const M = Math.min(W, H), img = x.getImageData(0, 0, W, H), src = new Uint8ClampedArray(img.data), p = img.data, k = M * .006 * t;
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        const dx = xx / W - .5, dy = y / H - .5, d = Math.hypot(dx, dy) * 2, o = Math.round(k * d * d * 2) | 0;
        if (!o) continue;
        const i = (y * W + xx) * 4, ir = (y * W + clamp(xx - o, 0, W - 1)) * 4, ib = (y * W + clamp(xx + o, 0, W - 1)) * 4;
        p[i] = src[ir]; p[i + 2] = src[ib + 2];
      }
      x.putImageData(img, 0, 0);
      const s = canvas(W, H), sx = s.getContext("2d"), a = -.5 + R() * .3, cx = W * (.2 + R() * .6), cy = H * (.2 + R() * .3);
      sx.translate(cx, cy); sx.rotate(a);
      const g = sx.createLinearGradient(0, -M * .08, 0, M * .08);
      ["#ff0040", "#ff8a00", "#ffe600", "#3dff6e", "#00c8ff", "#7a4dff"].forEach((col, i) => g.addColorStop(i / 5, col));
      sx.fillStyle = g; sx.globalAlpha = .9; sx.fillRect(-Math.hypot(W, H), -M * .08, Math.hypot(W, H) * 2, M * .16);
      x.save(); x.globalCompositeOperation = "soft-light"; x.globalAlpha = .9 * t; x.drawImage(blurred(s, W, H, M * .03), 0, 0); x.globalCompositeOperation = "screen"; x.globalAlpha = .75 * t; x.drawImage(blurred(s, W, H, M * .03), 0, 0); x.restore();
    },
    rays(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), L = Math.hypot(W, H) * 1.3;
      let ox = A.light.x * W, oy = A.light.y * H;
      if (A.light.y > .55) { ox = W * .15; oy = -H * .05; }
      const s = canvas(W, H), sx = s.getContext("2d");
      for (let i = 0; i < 16; i++) { const a0 = R() * Math.PI * 2, a1 = a0 + .03 + R() * .06; sx.fillStyle = "rgba(255,236,196," + (.3 + R() * .3).toFixed(2) + ")"; sx.beginPath(); sx.moveTo(ox, oy); sx.lineTo(ox + Math.cos(a0) * L, oy + Math.sin(a0) * L); sx.lineTo(ox + Math.cos(a1) * L, oy + Math.sin(a1) * L); sx.closePath(); sx.fill(); }
      const fade = sx.createRadialGradient(ox, oy, 0, ox, oy, L * .7); fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(1, "rgba(0,0,0,1)");
      sx.globalCompositeOperation = "destination-out"; sx.fillStyle = fade; sx.fillRect(0, 0, W, H);
      x.save(); x.globalCompositeOperation = "multiply"; x.globalAlpha = .18 * t; x.fillStyle = "#6b5a4a"; x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = "screen"; x.globalAlpha = t; x.drawImage(blurred(s, W, H, M * .008), 0, 0); x.drawImage(blurred(s, W, H, M * .03), 0, 0);
      const sun = x.createRadialGradient(ox, oy, 0, ox, oy, M * .5); sun.addColorStop(0, "rgba(255,244,214,.85)"); sun.addColorStop(.25, "rgba(255,220,160,.35)"); sun.addColorStop(1, "rgba(255,220,160,0)");
      x.fillStyle = sun; x.fillRect(0, 0, W, H);
      // Lens-flare ghosts along the line through the centre.
      const vx = W / 2 - ox, vy = H / 2 - oy;
      [[.6, .05, "120,200,255"], [1.0, .025, "255,180,120"], [1.35, .08, "160,255,200"], [1.7, .04, "255,140,220"]].forEach(([k, r, col]) => { const gx = ox + vx * k, gy = oy + vy * k, g = x.createRadialGradient(gx, gy, 0, gx, gy, M * r); g.addColorStop(0, "rgba(" + col + ",.0)"); g.addColorStop(.75, "rgba(" + col + ",.25)"); g.addColorStop(1, "rgba(" + col + ",0)"); x.fillStyle = g; x.beginPath(); x.arc(gx, gy, M * r, 0, 7); x.fill(); });
      x.restore();
    },
    rain(x, c, W, H, t, R) {
      const M = Math.min(W, H), snap = canvas(W, H); snap.getContext("2d").drawImage(c, 0, 0);
      x.save(); x.globalAlpha = .5 * t; x.drawImage(blurred(snap, W, H, M * .004, true), 0, 0);
      x.globalAlpha = 1; x.globalCompositeOperation = "multiply"; x.fillStyle = "rgba(210,225,245," + (.5 * t).toFixed(2) + ")"; x.fillRect(0, 0, W, H); x.restore();
      const n = Math.round(18 + 40 * t);
      for (let i = 0; i < n; i++) {
        const r = M * (.006 + Math.pow(R(), 2) * .03), cx = R() * W, cy = R() * H;
        // Each drop shows a tiny flipped view of the scene, like real water on glass.
        x.save(); x.beginPath(); x.ellipse(cx, cy, r, r * 1.12, 0, 0, 7); x.clip();
        x.translate(cx, cy); x.scale(-.5, -.5); x.drawImage(snap, -cx, -cy, W, H);
        x.restore();
        x.save(); x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = Math.max(1, r * .14); x.beginPath(); x.ellipse(cx, cy + r * .05, r, r * 1.12, 0, .2, Math.PI - .2); x.stroke();
        x.fillStyle = "rgba(255,255,255,.85)"; x.beginPath(); x.ellipse(cx - r * .35, cy - r * .45, r * .22, r * .13, -.6, 0, 7); x.fill(); x.restore();
        if (r > M * .018 && R() < .5) { x.save(); x.strokeStyle = "rgba(255,255,255,.25)"; x.lineWidth = r * .35; x.lineCap = "round"; x.beginPath(); x.moveTo(cx, cy + r); x.lineTo(cx + (R() - .5) * r, cy + r + M * (.05 + R() * .1)); x.stroke(); x.restore(); }
      }
    },
    snow(x, c, W, H, t, R) {
      const M = Math.min(W, H), back = canvas(W, H), bx = back.getContext("2d");
      x.save(); x.globalCompositeOperation = "screen"; x.fillStyle = "rgba(200,220,255," + (.12 * t).toFixed(2) + ")"; x.fillRect(0, 0, W, H); x.restore();
      for (let i = 0; i < 90 * t + 30; i++) {
        const near = R() < .2, ctx = near ? bx : x, r = M * (near ? .012 + R() * .014 : .002 + R() * .005), g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, "rgba(255,255,255,.95)"); g.addColorStop(.6, "rgba(255,255,255,.6)"); g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.save(); ctx.translate(R() * W, R() * H); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill(); ctx.restore();
      }
      x.drawImage(blurred(back, W, H, M * .006), 0, 0);
    },
    spotlight(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), cx = A.subject.x * W, cy = A.subject.y * H;
      const g = x.createRadialGradient(cx, cy, M * .16, cx, cy, Math.hypot(W, H) * .55);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(.5, "rgba(0,0,0," + (.35 * t).toFixed(2) + ")"); g.addColorStop(1, "rgba(0,0,0," + (.85 * t).toFixed(2) + ")");
      x.save(); x.fillStyle = g; x.fillRect(0, 0, W, H);
      const s = x.createRadialGradient(cx, cy - M * .05, 0, cx, cy, M * .4); s.addColorStop(0, "rgba(255,246,225,.6)"); s.addColorStop(1, "rgba(255,246,225,0)");
      x.globalCompositeOperation = "soft-light"; x.globalAlpha = t; x.fillStyle = s; x.fillRect(0, 0, W, H); x.restore();
    },
    tilt(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), b1 = blurred(c, W, H, M * .01, true), b2 = blurred(c, W, H, M * .024, true), fy = A.subject.y;
      if (FILTER_OK) { const pop = canvas(W, H), px = pop.getContext("2d"); px.filter = "saturate(" + (1 + .35 * t).toFixed(2) + ") contrast(" + (1 + .08 * t).toFixed(2) + ")"; px.drawImage(c, 0, 0); x.drawImage(pop, 0, 0); }
      for (const [b, inner, outer] of [[b1, .1, .22], [b2, .2, .42]]) {
        const m = canvas(W, H), mx = m.getContext("2d"); mx.drawImage(b, 0, 0);
        const g = mx.createLinearGradient(0, 0, 0, H);
        const st = (v) => clamp(v, 0, 1);
        g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(st(fy - outer), "rgba(0,0,0,1)"); g.addColorStop(st(fy - inner), "rgba(0,0,0,0)");
        g.addColorStop(st(fy + inner), "rgba(0,0,0,0)"); g.addColorStop(st(fy + outer), "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,1)");
        mx.globalCompositeOperation = "destination-in"; mx.fillStyle = g; mx.fillRect(0, 0, W, H);
        x.save(); x.globalAlpha = t; x.drawImage(m, 0, 0); x.restore();
      }
    },
    neon(x, c, W, H, t, R, A) {
      const M = Math.min(W, H), e = canvas(A.ew, A.eh), ex = e.getContext("2d"), d = ex.createImageData(A.ew, A.eh), q = d.data, hueA = R() * 360;
      for (let j = 0; j < A.edges.length; j++) {
        const v = smooth(.12, .5, A.edges[j] / A.emax); if (!v) continue;
        const px = j % A.ew, hue = (hueA + px / A.ew * 140) % 360, h6 = hue / 60, f = h6 - Math.floor(h6), sel = Math.floor(h6) % 6;
        const rgb = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][sel];
        const i = j * 4; q[i] = 60 + 195 * rgb[0]; q[i + 1] = 60 + 195 * rgb[1]; q[i + 2] = 60 + 195 * rgb[2]; q[i + 3] = 255 * v;
      }
      ex.putImageData(d, 0, 0);
      x.save(); x.fillStyle = "rgba(5,0,20," + (.55 * t).toFixed(2) + ")"; x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = "screen"; x.globalAlpha = t;
      x.drawImage(blurred(e, W, H, M * .012), 0, 0, W, H); x.drawImage(blurred(e, W, H, M * .003), 0, 0, W, H); x.drawImage(e, 0, 0, W, H); x.restore();
    },
    comic(x, c, W, H, t, R, A) {
      const img = x.getImageData(0, 0, W, H), p = img.data, levels = 7, step = 255 / (levels - 1), src = new Uint8ClampedArray(p);
      // Posterise brightness only (colours keep their hue), then push saturation like printed inks.
      for (let i = 0; i < p.length; i += 4) {
        const r = src[i], g = src[i + 1], b = src[i + 2], Y = .2126 * r + .7152 * g + .0722 * b + .01, k = Math.round(Y / step) * step / Y;
        for (let c2 = 0; c2 < 3; c2++) { const v = src[i + c2] * k, inked = Y * k + (v - Y * k) * 1.35; p[i + c2] = src[i + c2] + (inked - src[i + c2]) * t; }
      }
      x.putImageData(img, 0, 0);
      // Halftone dots in the shadows.
      const M = Math.min(W, H), cell = Math.max(4, M / 90), sm = canvas(Math.ceil(W / cell), Math.ceil(H / cell)), smx = sm.getContext("2d"); smx.drawImage(c, 0, 0, sm.width, sm.height);
      const sd = smx.getImageData(0, 0, sm.width, sm.height).data;
      x.save(); x.fillStyle = "rgba(20,10,40," + (.55 * t).toFixed(2) + ")";
      for (let yy = 0; yy < sm.height; yy++) for (let xx = 0; xx < sm.width; xx++) { const i = (yy * sm.width + xx) * 4, y = (.2126 * sd[i] + .7152 * sd[i + 1] + .0722 * sd[i + 2]) / 255, r = cell * .55 * Math.max(0, .55 - y) * 1.6; if (r > .3) { x.beginPath(); x.arc((xx + .5) * cell, (yy + .5) * cell + (xx % 2) * cell * .5, r, 0, 7); x.fill(); } }
      // Ink lines.
      const e = canvas(A.ew, A.eh), ex = e.getContext("2d"), d = ex.createImageData(A.ew, A.eh), q = d.data;
      for (let j = 0; j < A.edges.length; j++) { const v = smooth(.18, .45, A.edges[j] / A.emax); q[j * 4 + 3] = 255 * v; }
      ex.putImageData(d, 0, 0); x.globalAlpha = .85 * t; x.drawImage(e, 0, 0, W, H); x.restore();
    },
    glitch(x, c, W, H, t, R) {
      const snap = canvas(W, H); snap.getContext("2d").drawImage(c, 0, 0);
      const bands = Math.round(6 + 10 * t);
      for (let i = 0; i < bands; i++) {
        const y = R() * H, h = H * (.008 + R() * .05), off = (R() - .5) * W * .12 * t;
        x.drawImage(snap, 0, y, W, h, off, y, W, h);
        if (R() < .5) { x.save(); x.globalCompositeOperation = "screen"; x.globalAlpha = .6; x.fillStyle = R() < .5 ? "rgba(255,0,80,.5)" : "rgba(0,220,255,.5)"; x.fillRect(off * .5, y, W, h); x.restore(); }
      }
      x.save(); x.globalCompositeOperation = "lighter"; x.globalAlpha = .25 * t;
      const red = canvas(W, H), rx = red.getContext("2d"); rx.drawImage(snap, 0, 0); rx.globalCompositeOperation = "multiply"; rx.fillStyle = "#ff0000"; rx.fillRect(0, 0, W, H);
      x.drawImage(red, W * .008, 0); x.restore();
      x.save(); x.fillStyle = "rgba(0,0,0,.18)"; for (let y = 0; y < H; y += Math.max(2, H / 300)) x.fillRect(0, y, W, Math.max(1, H / 900)); x.restore();
    },
    duotone(x, c, W, H, t) {
      const img = x.getImageData(0, 0, W, H), p = img.data, A = [26, 16, 72], B = [255, 196, 150];
      for (let i = 0; i < p.length; i += 4) { const y = smooth(0, 1, (.2126 * p[i] + .7152 * p[i + 1] + .0722 * p[i + 2]) / 255); for (let k = 0; k < 3; k++) p[i + k] += (A[k] + (B[k] - A[k]) * y - p[i + k]) * t; }
      x.putImageData(img, 0, 0); grain(x, W, H, .3 * t);
    },
    retro(x, c, W, H, t, R, A, stamp) {
      const M = Math.min(W, H), snap = canvas(W, H); snap.getContext("2d").drawImage(c, 0, 0);
      x.save(); x.globalCompositeOperation = "screen"; x.globalAlpha = .35 * t;
      const red = canvas(W, H), rx = red.getContext("2d"); rx.drawImage(snap, 0, 0); rx.globalCompositeOperation = "multiply"; rx.fillStyle = "#ff2020"; rx.fillRect(0, 0, W, H);
      x.drawImage(red, M * .006, 0); x.restore();
      x.save(); x.fillStyle = "rgba(0,0,0," + (.25 * t).toFixed(2) + ")"; const step = Math.max(2, H / 260); for (let y = 0; y < H; y += step) x.fillRect(0, y, W, step * .45); x.restore();
      vignette(x, W, H, .55 * t);
      const fs = Math.max(9, Math.round(M * .05)); x.save(); x.font = "700 " + fs + "px monospace"; x.fillStyle = "rgba(255,255,235,.95)"; x.shadowColor = "rgba(0,0,0,.7)"; x.shadowBlur = fs * .25;
      x.textBaseline = "top"; x.fillText("▶ PLAY", W * .06, H * .05);
      x.fillStyle = "#ff3b30"; x.beginPath(); x.arc(W * .94 - fs * 2.2, H * .05 + fs * .5, fs * .28, 0, 7); x.fill(); x.fillStyle = "rgba(255,255,235,.95)"; x.textAlign = "right"; x.fillText("REC", W * .94, H * .05);
      x.textBaseline = "bottom"; x.fillText(String(stamp && stamp.date || "").toUpperCase(), W * .94, H * .95 - fs * 1.2); x.fillText(String(stamp && stamp.time || "").toUpperCase(), W * .94, H * .95); x.restore();
    },
    strip(x, c, W, H, t, R) {
      const bh = H * .08; x.save(); x.fillStyle = "#0d0c0b"; x.fillRect(0, 0, W, bh); x.fillRect(0, H - bh, W, bh);
      const hw = bh * .4, hh = bh * .46, gap = hw * 1.9; x.fillStyle = "#efe9dc";
      for (let px = gap * .5; px < W; px += gap) { roundRect(x, px, bh * .27, hw, hh, hh * .25); x.fill(); roundRect(x, px, H - bh + bh * .27, hw, hh, hh * .25); x.fill(); }
      const fs = Math.max(7, bh * .22); x.font = "700 " + fs + "px monospace"; x.fillStyle = "#f59e0b"; x.textBaseline = "middle";
      x.fillText("SCRAVEIT 400", W * .06, bh * .13 + fs * .2); x.textAlign = "right"; x.fillText((12 + (R() * 20 | 0)) + "  ▸  " + (12 + (R() * 20 | 0)) + "A", W * .94, H - bh * .13 - fs * .2);
      x.restore(); grain(x, W, H, .35 * t);
    },
    polaroid(x, c, W, H, t, R, A, stamp) {
      const sp = W * .05, bp = Math.min(H * .2, W * .22);
      x.save(); x.fillStyle = "rgba(255,248,235," + (.12 * t).toFixed(2) + ")"; x.globalCompositeOperation = "screen"; x.fillRect(sp, sp, W - 2 * sp, H - sp - bp); x.restore();
      x.save(); x.fillStyle = "#fbfaf6"; x.fillRect(0, 0, W, sp); x.fillRect(0, 0, sp, H); x.fillRect(W - sp, 0, sp, H); x.fillRect(0, H - bp, W, bp);
      x.strokeStyle = "rgba(0,0,0,.12)"; x.lineWidth = Math.max(1, W * .002); x.strokeRect(sp, sp, W - 2 * sp, H - sp - bp);
      const inner = x.createLinearGradient(0, sp, 0, sp + H * .04); inner.addColorStop(0, "rgba(0,0,0,.12)"); inner.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = inner; x.fillRect(sp, sp, W - 2 * sp, H * .04);
      const fs = Math.max(10, bp * .28); x.font = "italic 600 " + fs + "px cursive, 'Comic Sans MS', serif"; x.fillStyle = "rgba(30,40,90,.85)"; x.textAlign = "center"; x.textBaseline = "middle";
      x.save(); x.translate(W / 2, H - bp / 2); x.rotate(-.025); x.fillText(String(stamp && stamp.date || "Yum!"), 0, 0); x.restore(); x.restore();
    },
    magazine(x, c, W, H, t, R, A, stamp) {
      const M = Math.min(W, H);
      x.save(); const top = x.createLinearGradient(0, 0, 0, H * .3); top.addColorStop(0, "rgba(0,0,0," + (.45 * t).toFixed(2) + ")"); top.addColorStop(1, "rgba(0,0,0,0)"); x.fillStyle = top; x.fillRect(0, 0, W, H * .3);
      const bot = x.createLinearGradient(0, H * .65, 0, H); bot.addColorStop(0, "rgba(0,0,0,0)"); bot.addColorStop(1, "rgba(0,0,0," + (.55 * t).toFixed(2) + ")"); x.fillStyle = bot; x.fillRect(0, H * .65, W, H * .35);
      const fs = Math.round(W * .17); x.font = "900 " + fs + "px Georgia, 'Times New Roman', serif"; x.textAlign = "center"; x.textBaseline = "top"; x.fillStyle = "#fff"; x.shadowColor = "rgba(0,0,0,.35)"; x.shadowBlur = fs * .08;
      if ("letterSpacing" in x) x.letterSpacing = (fs * .02).toFixed(1) + "px";
      x.fillText("SCRAVEIT", W / 2, H * .035);
      if ("letterSpacing" in x) x.letterSpacing = "0px";
      const small = Math.max(8, Math.round(W * .03)); x.font = "700 " + small + "px sans-serif"; x.fillStyle = "#ffd60a"; x.shadowBlur = 0;
      x.fillText("THE FOOD ISSUE  ·  " + String(stamp && stamp.date || "").toUpperCase(), W / 2, H * .035 + fs * 1.02);
      x.textAlign = "left"; x.textBaseline = "alphabetic"; x.font = "900 " + Math.round(W * .065) + "px Georgia, serif"; x.fillStyle = "#fff"; x.fillText("Hot &", W * .06, H * .82); x.fillText("Fresh", W * .06, H * .82 + W * .07);
      x.font = "600 " + small + "px sans-serif"; x.fillStyle = "#ffd60a"; x.fillText("10 dishes we can't stop eating", W * .06, H * .82 + W * .115);
      const bw = W * .16, bh = W * .085, bx = W * .94 - bw, by = H * .95 - bh; x.fillStyle = "#fff"; x.fillRect(bx, by, bw, bh); x.fillStyle = "#000";
      for (let i = 0, px = bx + bw * .06; px < bx + bw * .94; i++) { const w = bw * (.008 + R() * .02); x.fillRect(px, by + bh * .1, w, bh * .62); px += w + bw * (.01 + R() * .02); }
      x.restore();
    }
  };

  function filterById(id) { return FILTERS.find(f => f.id === id) || FILTERS[0]; }
  function effectById(id) { return EFFECTS.find(f => f.id === id) || EFFECTS[0]; }

  /** The whole look on canvas `c` (already sized) from `base` (the photo at the same size). */
  function paint(c, d, base) {
    const W = c.width, H = c.height, x = c.getContext("2d"), f = filterById(d.filter), t = clamp((+d.amount || 0) / 100, 0, 1), a = Object.assign(adjDefaults(), d.adj || {});
    x.save(); x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = "source-over"; x.globalAlpha = 1; x.clearRect(0, 0, W, H);
    colour(c, d, base);
    detail(c, (f.clarity || 0) * t + a.clarity / 100 * .9, a.sharpness / 100);
    bloom(x, c, W, H, (f.bloom || 0) * t + a.glow / 100, true);
    vignette(x, W, H, (f.vig || 0) * t + a.vignette / 100 * .85);
    grain(x, W, H, (f.grain || 0) * t + a.grain / 100 * .7);
    const fx = effectById(d.fx);
    if (fx.id !== "none" && FX[fx.id]) {
      const ft = clamp((d.fxAmount == null ? 100 : +d.fxAmount) / 100, 0, 1);
      if (ft > 0) { x.save(); try { FX[fx.id](x, c, W, H, ft, rng(d.seed || 1), analyze(base), d.stamp); } finally { x.restore(); } }
    }
    x.restore();
  }

  window.ScraveitFx = { FILTERS, ADJUST, EFFECTS, adjDefaults, paint, analyze, filterById, effectById };
})();
