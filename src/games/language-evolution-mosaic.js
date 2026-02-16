import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.languageMosaic.v1";
  const S = 12; // symbols
  const TAU = Math.PI * 2;

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild
      ? ctx.uiRoot
      : null;

  // ---------------- utils ----------------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;

  function nowSec() {
    return performance.now() * 0.001;
  }

  function fmt(n) {
    if (!isFinite(n)) return "0";
    const abs = Math.abs(n);
    if (abs < 1000) return n.toFixed(0);
    if (abs < 1e6) return (n / 1e3).toFixed(2) + "K";
    if (abs < 1e9) return (n / 1e6).toFixed(2) + "M";
    if (abs < 1e12) return (n / 1e9).toFixed(2) + "B";
    return (n / 1e12).toFixed(2) + "T";
  }

  // deterministic rng
  let rng = (Date.now() ^ 0x6d2b79f5) >>> 0;
  function rand01() {
    rng = (1664525 * rng + 1013904223) >>> 0;
    return rng / 4294967296;
  }
  function randInt(n) {
    return (rand01() * n) | 0;
  }
  function randSigned() {
    return rand01() * 2 - 1;
  }

  // fast exp approximation safe enough for small k (optional). We'll use Math.exp with small S.
  function safeExp(x) {
    // clamp to prevent blowups
    x = clamp(x, -8, 8);
    return Math.exp(x);
  }

  // ---------------- palette ----------------
  // Neon-ish palette: cyan/blue/purple/magenta with variation
  const PALETTE = new Uint8Array([
    0x3d, 0xfc, 0xff, // 0 cyan
    0x2a, 0xa2, 0xff, // 1 blue
    0xb0, 0x4b, 0xff, // 2 purple
    0xff, 0x4b, 0xd8, // 3 magenta
    0x6e, 0xff, 0xd4, // 4 mint
    0x49, 0x6b, 0xff, // 5 indigo
    0xcf, 0x6a, 0xff, // 6 violet
    0xff, 0x6a, 0xaa, // 7 pink
    0x3d, 0xff, 0x9a, // 8 neon greenish
    0x5f, 0xd8, 0xff, // 9 sky
    0xf0, 0x6b, 0xff, // 10 bright violet
    0xff, 0x92, 0x4b, // 11 orange accent (rare)
  ]);

  const SYMBOL_NAMES = [
    "Kya",
    "Veo",
    "Mira",
    "Zai",
    "Lun",
    "Tesh",
    "Oru",
    "Prax",
    "Soli",
    "Niva",
    "Hyo",
    "Arka",
  ];

  // ---------------- state ----------------
  const state = {
    paused: false,
    t: 0,

    // grid dims (simulation)
    gw: 180,
    gh: 100,
    n: 180 * 100,

    // parameters
    diffusion: 0.22,
    selK: 0.22,
    mutRate: 0.020,
    shockFreq: 0.06, // events per second (rare)
    shockStrength: 0.55,
    borders: true,
    crisp: true,

    seedSymbol: 0,

    // fields
    pA: null, // Float32Array n*S
    pB: null, // Float32Array n*S
    temp: null, // Float32Array n
    dom: null, // Uint8Array n
    conf: null, // Float32Array n (max prob)

    // payoff matrix
    M: null, // Float32Array S*S

    // render buffers (mosaic at grid resolution)
    img: null, // ImageData gw*gh
    imgData: null, // Uint8ClampedArray
    mosaicCanvas: null,
    mosaicCtx: null,

    // render cadence
    renderEvery: 1, // render mosaic every N frames
    frame: 0,

    // simulation fixed step
    simAcc: 0,
    simStep: 1 / 30,
    simMaxSub: 4,

    // stats cadence
    statsAt: 0,
    areaPct: new Float32Array(S),
    entropy: 0,

    // shock scheduling
    shockAt: 0,

    // autosave
    autosaveAt: 0,

    // status
    status: "",
    statusUntil: 0,

    // perf tracking
    perf: { fpsEMA: 60 },
  };

  function flash(msg) {
    state.status = msg || "";
    state.statusUntil = nowSec() + 1.2;
  }

  // ---------------- grid init / resize ----------------
  function chooseGrid() {
    const { w, h } = Engine.getSize();
    // Keep moderate cell count. Aim ~18k-30k cells.
    // Use aspect to pick gh, then gw.
    const aspect = w / Math.max(1, h);
    const targetCells = clamp(Math.floor((w * h) / (10 * 10)), 14000, 26000); // heuristic
    const gh = clamp(Math.floor(Math.sqrt(targetCells / Math.max(0.2, aspect))), 80, 150);
    const gw = clamp(Math.floor(gh * aspect), 140, 260);

    state.gw = gw;
    state.gh = gh;
    state.n = gw * gh;
  }

  function allocBuffers() {
    const n = state.n;
    const len = n * S;

    state.pA = new Float32Array(len);
    state.pB = new Float32Array(len);
    state.temp = new Float32Array(n);
    state.dom = new Uint8Array(n);
    state.conf = new Float32Array(n);

    state.img = new ImageData(state.gw, state.gh);
    state.imgData = state.img.data;

    // offscreen canvas for crisp scaling
    const c = document.createElement("canvas");
    c.width = state.gw;
    c.height = state.gh;
    state.mosaicCanvas = c;
    state.mosaicCtx = c.getContext("2d", { alpha: false });
  }

  // ---------------- payoff matrix ----------------
  function buildPayoffMatrix() {
    // Rock-paper-ish cyclic biases with small random flavour.
    // M[a,b] positive => a tends to grow when b present.
    const M = new Float32Array(S * S);
    for (let a = 0; a < S; a++) {
      for (let b = 0; b < S; b++) {
        let v = 0;
        if (a === b) v = 0.0;
        else {
          const d = (a - b + S) % S;
          // cyclic advantage: a beats a-1,a-2 ; loses to a+1,a+2
          if (d === 1) v = 0.55;
          else if (d === 2) v = 0.25;
          else if (d === S - 1) v = -0.55;
          else if (d === S - 2) v = -0.25;
          else v = (randSigned() * 0.08);
        }
        // slight asymmetry noise
        v += randSigned() * 0.04;
        M[a * S + b] = v;
      }
    }
    state.M = M;
  }

  // ---------------- initial conditions ----------------
  function initFields() {
    const n = state.n;
    const gw = state.gw;
    const gh = state.gh;
    const p = state.pA;
    const temp = state.temp;

    // base: smooth random mixture with regional seeds
    // We'll lay down a few seed centres and diffuse them once to create regions.
    const seeds = 18;
    const sx = new Float32Array(seeds);
    const sy = new Float32Array(seeds);
    const ss = new Uint8Array(seeds);
    for (let i = 0; i < seeds; i++) {
      sx[i] = rand01() * gw;
      sy[i] = rand01() * gh;
      ss[i] = randInt(S);
    }

    // fill initial p with gaussian influence from nearest few seeds (cheap)
    for (let i = 0; i < n; i++) {
      const x = i % gw;
      const y = (i / gw) | 0;

      // base temperature with faint structure
      temp[i] = clamp(0.12 + 0.10 * rand01(), 0, 1);

      // start small uniform
      const base = 1 / S;
      const off = i * S;
      for (let a = 0; a < S; a++) p[off + a] = base;

      // add 3 nearest-ish seeds (approx: sample a few seeds)
      let best1 = 0,
        best2 = 0,
        best3 = 0;
      let d1 = 1e9,
        d2 = 1e9,
        d3 = 1e9;
      for (let k = 0; k < seeds; k++) {
        const dx = x - sx[k];
        const dy = y - sy[k];
        const d = dx * dx + dy * dy;
        if (d < d1) {
          d3 = d2; best3 = best2;
          d2 = d1; best2 = best1;
          d1 = d; best1 = k;
        } else if (d < d2) {
          d3 = d2; best3 = best2;
          d2 = d; best2 = k;
        } else if (d < d3) {
          d3 = d; best3 = k;
        }
      }

      const k1 = best1, k2 = best2, k3 = best3;
      const w1 = 1 / (1 + d1 * 0.012);
      const w2 = 1 / (1 + d2 * 0.012);
      const w3 = 1 / (1 + d3 * 0.012);

      p[off + ss[k1]] += 0.65 * w1;
      p[off + ss[k2]] += 0.40 * w2;
      p[off + ss[k3]] += 0.25 * w3;

      // renorm
      let sum = 0;
      for (let a = 0; a < S; a++) sum += p[off + a];
      const inv = 1 / sum;
      for (let a = 0; a < S; a++) p[off + a] *= inv;
    }

    // run a couple diffusion-only passes to smooth
    for (let pass = 0; pass < 3; pass++) {
      diffusionPass(state.pA, state.pB, 0.35);
      // swap
      const t = state.pA; state.pA = state.pB; state.pB = t;
    }

    updateDomConf(state.pA);
  }

  // ---------------- simulation steps ----------------
  function diffusionPass(src, dst, d) {
    // 4-neighbour mixing for each symbol
    const gw = state.gw, gh = state.gh;
    const n = state.n;
    const invD = 1 - d;

    for (let i = 0; i < n; i++) {
      const x = i % gw;
      const y = (i / gw) | 0;

      const iL = x > 0 ? i - 1 : i;
      const iR = x < gw - 1 ? i + 1 : i;
      const iU = y > 0 ? i - gw : i;
      const iD = y < gh - 1 ? i + gw : i;

      const o = i * S;
      const oL = iL * S, oR = iR * S, oU = iU * S, oD = iD * S;

      for (let a = 0; a < S; a++) {
        const avg = (src[oL + a] + src[oR + a] + src[oU + a] + src[oD + a]) * 0.25;
        dst[o + a] = src[o + a] * invD + avg * d;
      }
    }
  }

  function replicatorPass(src, dst, k) {
    // For each cell: f[a] = sum_b M[a,b]*p[b]
    // Then p[a] <- p[a] * exp(k * f[a]), renorm
    const n = state.n;
    const M = state.M;
    const temp = state.temp;

    for (let i = 0; i < n; i++) {
      const o = i * S;

      // local p into small local array? avoid allocation: compute f on fly
      // We'll compute p[b] once in a tiny loop.
      // Then compute f[a] by dot with M row.
      // Complexity: n*S*S = n*144. With n~20k => ~2.9M ops, fine at 30Hz.

      // compute fitness and weighted update
      let sum = 0;
      // store updated unnorm in dst[o+a]
      for (let a = 0; a < S; a++) {
        let f = 0;
        const row = a * S;
        for (let b = 0; b < S; b++) {
          f += M[row + b] * src[o + b];
        }
        // temp slightly increases responsiveness (turbulence)
        const kk = k * (1 + 0.35 * temp[i]);
        const v = src[o + a] * safeExp(kk * f);
        dst[o + a] = v;
        sum += v;
      }
      const inv = 1 / Math.max(1e-9, sum);
      for (let a = 0; a < S; a++) dst[o + a] *= inv;
    }
  }

  function mutationPass(buf, mutRate) {
    const n = state.n;
    const temp = state.temp;
    for (let i = 0; i < n; i++) {
      // chance proportional to temp
      const t = temp[i];
      const pMut = mutRate * (0.15 + 0.85 * t);
      if (rand01() >= pMut) continue;

      const o = i * S;
      // bleed a little mass from dominant into random other
      const d = state.dom[i];
      let r = randInt(S - 1);
      if (r >= d) r++;

      const amt = clamp(0.02 + 0.06 * t * rand01(), 0.01, 0.10);
      const give = Math.min(buf[o + d], amt);
      buf[o + d] -= give;
      buf[o + r] += give;

      // tiny renorm drift correction (should still sum ~1)
      // compute sum and renorm (S=12)
      let sum = 0;
      for (let a = 0; a < S; a++) sum += buf[o + a];
      const inv = 1 / Math.max(1e-9, sum);
      for (let a = 0; a < S; a++) buf[o + a] *= inv;
    }
  }

  function updateDomConf(buf) {
    const n = state.n;
    const dom = state.dom;
    const conf = state.conf;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      let bestA = 0;
      let bestV = buf[o];
      for (let a = 1; a < S; a++) {
        const v = buf[o + a];
        if (v > bestV) {
          bestV = v;
          bestA = a;
        }
      }
      dom[i] = bestA;
      conf[i] = bestV;
    }
  }

  function doShock(cx, cy, sym, radius, strength) {
    // inject a burst: increase probability of sym in a circular mask
    const gw = state.gw, gh = state.gh;
    const r2 = radius * radius;
    const p = state.pA;
    const temp = state.temp;

    const x0 = clamp(Math.floor(cx - radius), 0, gw - 1);
    const x1 = clamp(Math.floor(cx + radius), 0, gw - 1);
    const y0 = clamp(Math.floor(cy - radius), 0, gh - 1);
    const y1 = clamp(Math.floor(cy + radius), 0, gh - 1);

    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = 1 - d2 / r2;
        const i = y * gw + x;
        const o = i * S;

        // blend toward sym
        const push = strength * (0.25 + 0.75 * t);
        for (let a = 0; a < S; a++) {
          p[o + a] *= (1 - push);
        }
        p[o + sym] += push;

        // turbulence spike
        temp[i] = clamp(temp[i] + 0.35 * push, 0, 1);

        // renorm
        let sum = 0;
        for (let a = 0; a < S; a++) sum += p[o + a];
        const inv = 1 / Math.max(1e-9, sum);
        for (let a = 0; a < S; a++) p[o + a] *= inv;
      }
    }

    updateDomConf(state.pA);
  }

  function scheduleNextShock() {
    // exponential-ish wait: mean 1/shockFreq
    const f = Math.max(0.0001, state.shockFreq);
    const u = clamp(rand01(), 1e-6, 1);
    const wait = -Math.log(u) / f;
    state.shockAt = state.t + wait;
  }

  function simStep() {
    // diffusion -> selection -> mutation -> dom/conf
    diffusionPass(state.pA, state.pB, state.diffusion);
    // swap
    let t = state.pA; state.pA = state.pB; state.pB = t;

    replicatorPass(state.pA, state.pB, state.selK);
    t = state.pA; state.pA = state.pB; state.pB = t;

    mutationPass(state.pA, state.mutRate);

    // temp relax + faint noise
    const temp = state.temp;
    const n = state.n;
    for (let i = 0; i < n; i++) {
      // relax toward baseline 0.12 with slight drift
      const base = 0.12;
      temp[i] = clamp(temp[i] + (base - temp[i]) * 0.015 + randSigned() * 0.002, 0, 1);
    }

    // shock
    if (state.t >= state.shockAt) {
      const cx = randRange(0, state.gw - 1);
      const cy = randRange(0, state.gh - 1);
      const sym = randInt(S);
      const radius = randRange(6, 18);
      doShock(cx, cy, sym, radius, state.shockStrength);
      scheduleNextShock();
      flash(`Meme invasion: ${SYMBOL_NAMES[sym]}`);
    } else {
      updateDomConf(state.pA);
    }
  }

  // ---------------- stats ----------------
  function computeStats() {
    // % area per symbol and simple entropy-like measure
    const n = state.n;
    const dom = state.dom;
    const conf = state.conf;
    const pct = state.areaPct;
    for (let a = 0; a < S; a++) pct[a] = 0;
    let ent = 0;

    for (let i = 0; i < n; i++) {
      pct[dom[i]] += 1;
      // confidence entropy approx: lower conf => more mixed
      // Use -log(conf) scaled
      const c = clamp(conf[i], 1e-6, 1);
      ent += -Math.log(c);
    }

    const invN = 1 / n;
    for (let a = 0; a < S; a++) pct[a] *= invN;
    state.entropy = ent * invN;
  }

  // ---------------- rendering ----------------
  function renderMosaic() {
    const dom = state.dom;
    const conf = state.conf;
    const data = state.imgData;
    const n = state.n;

    // fill pixels in mosaic resolution
    // use conf to darken uncertain regions, and slightly brighten very confident cores
    for (let i = 0; i < n; i++) {
      const s = dom[i];
      const base = s * 3;
      const r = PALETTE[base];
      const g = PALETTE[base + 1];
      const b = PALETTE[base + 2];

      const c = conf[i]; // 0..1
      const core = clamp((c - 0.55) * 2.0, 0, 1);
      const border = 1 - clamp((c - 0.70) * 3.0, 0, 1); // higher when uncertain
      const lum = 0.30 + 0.55 * c + 0.10 * core; // 0.3..~1.0
      const dim = 1 - 0.20 * border;

      const rr = clamp(Math.floor(r * lum * dim), 0, 255);
      const gg = clamp(Math.floor(g * lum * dim), 0, 255);
      const bb = clamp(Math.floor(b * lum * dim), 0, 255);

      const o = i * 4;
      data[o] = rr;
      data[o + 1] = gg;
      data[o + 2] = bb;
      data[o + 3] = 255;
    }

    // push to offscreen
    state.mosaicCtx.putImageData(state.img, 0, 0);
  }

  function overlayBorders() {
    if (!state.borders) return;

    const g = Engine.gfx;
    const { w, h } = Engine.getSize();
    const gw = state.gw, gh = state.gh;
    const dom = state.dom;
    const conf = state.conf;

    // scale from grid to canvas
    const sx = w / gw;
    const sy = h / gh;

    // draw border cracks (cheap): check right and down neighbour, draw short lines
    // Subsample: only every 2 cells for speed
    const step = state.perf.fpsEMA < 50 ? 3 : 2;

    for (let y = 0; y < gh; y += step) {
      const row = y * gw;
      for (let x = 0; x < gw; x += step) {
        const i = row + x;
        const a = dom[i];
        const c = conf[i];

        if (x + 1 < gw) {
          const j = i + 1;
          if (dom[j] !== a) {
            const bSym = dom[j];
            const hueBase = a;
            const col = `rgba(${PALETTE[hueBase * 3]},${PALETTE[hueBase * 3 + 1]},${PALETTE[hueBase * 3 + 2]},1)`;
            const alpha = 0.08 + 0.24 * (1 - clamp(Math.max(c, conf[j]), 0, 1));
            const x0 = x * sx;
            const y0 = y * sy;
            g.line(x0, y0, (x + 1) * sx, y0, col, 2, alpha);
          }
        }
        if (y + 1 < gh) {
          const j = i + gw;
          if (dom[j] !== a) {
            const hueBase = a;
            const col = `rgba(${PALETTE[hueBase * 3]},${PALETTE[hueBase * 3 + 1]},${PALETTE[hueBase * 3 + 2]},1)`;
            const alpha = 0.08 + 0.24 * (1 - clamp(Math.max(c, conf[j]), 0, 1));
            const x0 = x * sx;
            const y0 = y * sy;
            g.line(x0, y0, x0, (y + 1) * sy, col, 2, alpha);
          }
        }
      }
    }
  }

  function drawHUD() {
    const ctx2d = Engine.getCtx();
    const { w, h } = Engine.getSize();

    const sym = state.seedSymbol;
    const name = SYMBOL_NAMES[sym];
    const col = `rgb(${PALETTE[sym * 3]},${PALETTE[sym * 3 + 1]},${PALETTE[sym * 3 + 2]})`;

    // hover tooltip
    const m = Engine.mouse();
    const gx = clamp(Math.floor((m.x / w) * state.gw), 0, state.gw - 1);
    const gy = clamp(Math.floor((m.y / h) * state.gh), 0, state.gh - 1);
    const i = gy * state.gw + gx;
    const d = state.dom[i];
    const c = state.conf[i];
    const dName = SYMBOL_NAMES[d];
    const dCol = `rgb(${PALETTE[d * 3]},${PALETTE[d * 3 + 1]},${PALETTE[d * 3 + 2]})`;

    ctx2d.save();
    ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx2d.fillStyle = "rgba(223,246,255,0.92)";
    ctx2d.fillText(
      `Seed: ${name}  |  Diff ${state.diffusion.toFixed(2)}  Sel ${state.selK.toFixed(2)}  Mut ${state.mutRate.toFixed(3)}  Shock ${state.shockFreq.toFixed(
        2
      )}/s`,
      12,
      h - 18
    );

    // status
    if (nowSec() < state.statusUntil && state.status) {
      ctx2d.fillStyle = "rgba(255,75,216,0.9)";
      ctx2d.fillText(state.status, 12, 22);
    }

    // tooltip
    const tx = clamp(m.x + 14, 10, w - 210);
    const ty = clamp(m.y + 14, 10, h - 60);
    ctx2d.globalAlpha = 0.9;
    ctx2d.fillStyle = "rgba(0,0,0,0.55)";
    ctx2d.strokeStyle = "rgba(61,252,255,0.18)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.roundRect(tx, ty, 200, 44, 10);
    ctx2d.fill();
    ctx2d.stroke();

    ctx2d.globalAlpha = 1;
    ctx2d.fillStyle = dCol;
    ctx2d.fillText(`${dName}`, tx + 10, ty + 18);
    ctx2d.fillStyle = "rgba(223,246,255,0.85)";
    ctx2d.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx2d.fillText(`Confidence: ${(c * 100).toFixed(1)}%`, tx + 10, ty + 36);

    // seed swatch
    ctx2d.fillStyle = col;
    ctx2d.fillRect(12, h - 44, 18, 18);
    ctx2d.strokeStyle = "rgba(223,246,255,0.35)";
    ctx2d.strokeRect(12, h - 44, 18, 18);

    ctx2d.restore();
  }

  function render() {
    const gfx = Engine.gfx;
    const ctx2d = Engine.getCtx();
    const { w, h } = Engine.getSize();

    gfx.clearBlack();

    // update mosaic buffer occasionally
    state.frame++;
    if ((state.frame % state.renderEvery) === 0) {
      renderMosaic();
    }

    // draw mosaic scaled to full canvas
    ctx2d.save();
    ctx2d.imageSmoothingEnabled = !state.crisp ? true : false;
    ctx2d.drawImage(state.mosaicCanvas, 0, 0, w, h);
    ctx2d.restore();

    overlayBorders();

    // subtle scanline overlay (cheap)
    ctx2d.save();
    ctx2d.globalAlpha = 0.07;
    ctx2d.fillStyle = "rgba(0,0,0,1)";
    const lineH = 3;
    const offset = ((state.t * 18) | 0) % (lineH * 3);
    for (let y = -offset; y < h; y += lineH * 3) {
      ctx2d.fillRect(0, y, w, lineH);
    }
    ctx2d.restore();

    if (!uiRoot) drawHUD();
    else {
      // still show status on canvas if UI exists
      if (nowSec() < state.statusUntil && state.status) {
        ctx2d.save();
        ctx2d.fillStyle = "rgba(255,75,216,0.85)";
        ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx2d.fillText(state.status, 12, 22);
        ctx2d.restore();
      }
    }
  }

  // ---------------- interactivity ----------------
  function seedAt(px, py, sym, radius, strength, hotspot) {
    const { w, h } = Engine.getSize();
    const cx = (px / w) * state.gw;
    const cy = (py / h) * state.gh;
    const rad = radius;

    doShock(cx, cy, sym, rad, strength);

    if (hotspot) {
      // increase temp in region
      const gw = state.gw, gh = state.gh;
      const r2 = rad * rad;
      const x0 = clamp(Math.floor(cx - rad), 0, gw - 1);
      const x1 = clamp(Math.floor(cx + rad), 0, gw - 1);
      const y0 = clamp(Math.floor(cy - rad), 0, gh - 1);
      const y1 = clamp(Math.floor(cy + rad), 0, gh - 1);
      const temp = state.temp;

      for (let y = y0; y <= y1; y++) {
        const dy = y - cy;
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          const t = 1 - d2 / r2;
          const i = y * gw + x;
          temp[i] = clamp(temp[i] + 0.65 * t, 0, 1);
        }
      }
    }
  }

  function onClick(ev, pos) {
    if (!pos) return;
    const shift = !!(ev && ev.shiftKey);
    const sym = state.seedSymbol;
    seedAt(pos.x, pos.y, sym, shift ? 16 : 12, shift ? 0.55 : 0.45, shift);
    flash(shift ? `Hotspot: ${SYMBOL_NAMES[sym]}` : `Seeded: ${SYMBOL_NAMES[sym]}`);
  }

  function onKeyDown(ev) {
    const key = ev && ev.key ? ev.key : "";

    if (key === " " || key === "Spacebar") {
      Engine.togglePause();
      state.paused = Engine.isPaused();
      flash(state.paused ? "Paused." : "Running.");
      return;
    }

    if (key === "r" || key === "R") {
      const ok = confirm("Reset simulation?");
      if (!ok) return;
      initFields();
      scheduleNextShock();
      flash("Reset.");
      saveNow();
      return;
    }

    if (key === "q" || key === "Q") {
      state.seedSymbol = (state.seedSymbol + S - 1) % S;
      flash(`Seed: ${SYMBOL_NAMES[state.seedSymbol]}`);
      if (ui) updateUI();
      return;
    }
    if (key === "e" || key === "E") {
      state.seedSymbol = (state.seedSymbol + 1) % S;
      flash(`Seed: ${SYMBOL_NAMES[state.seedSymbol]}`);
      if (ui) updateUI();
      return;
    }

    // 1-9,0,- map to 0..11
    const map = {
      "1": 0,
      "2": 1,
      "3": 2,
      "4": 3,
      "5": 4,
      "6": 5,
      "7": 6,
      "8": 7,
      "9": 8,
      "0": 9,
      "-": 10,
      "=": 11, // plus key often shares "="
    };
    if (key in map) {
      state.seedSymbol = map[key];
      flash(`Seed: ${SYMBOL_NAMES[state.seedSymbol]}`);
      if (ui) updateUI();
    }
  }

  // ---------------- UI ----------------
  let ui = null;

  function makeButton(label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.display = "block";
    b.style.width = "100%";
    b.style.padding = "8px 10px";
    b.style.margin = "6px 0";
    b.style.borderRadius = "10px";
    b.style.border = "1px solid rgba(120,180,255,0.25)";
    b.style.background = "rgba(8,12,18,0.85)";
    b.style.color = "#dff6ff";
    b.style.cursor = "pointer";
    b.style.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    b.onmouseenter = () => (b.style.borderColor = "rgba(255,75,216,0.45)");
    b.onmouseleave = () => (b.style.borderColor = "rgba(120,180,255,0.25)");
    return b;
  }

  function makeToggle(label) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "10px";
    row.style.margin = "6px 0";

    const left = document.createElement("div");
    left.textContent = label;
    left.style.fontSize = "12px";
    left.style.opacity = "0.9";

    const right = document.createElement("button");
    right.textContent = "Off";
    right.style.padding = "6px 10px";
    right.style.borderRadius = "10px";
    right.style.border = "1px solid rgba(120,180,255,0.25)";
    right.style.background = "rgba(8,12,18,0.85)";
    right.style.color = "#dff6ff";
    right.style.cursor = "pointer";
    right.style.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    row.appendChild(left);
    row.appendChild(right);
    return { row, button: right };
  }

  function makeSlider(label, min, max, step, init) {
    const wrap = document.createElement("div");
    wrap.style.margin = "8px 0";

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.style.fontSize = "12px";
    top.style.opacity = "0.95";

    const l = document.createElement("div");
    l.textContent = label;

    const v = document.createElement("div");
    v.textContent = String(init);

    top.appendChild(l);
    top.appendChild(v);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(init);
    input.style.width = "100%";

    wrap.appendChild(top);
    wrap.appendChild(input);

    return { wrap, input, valueEl: v };
  }

  function buildSwatches() {
    const grid = document.createElement("div");
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "repeat(6, 1fr)";
    grid.style.gap = "6px";
    grid.style.margin = "8px 0";

    const sw = [];
    for (let i = 0; i < S; i++) {
      const b = document.createElement("button");
      b.title = SYMBOL_NAMES[i];
      b.style.height = "22px";
      b.style.borderRadius = "8px";
      b.style.border = "1px solid rgba(223,246,255,0.18)";
      b.style.background = `rgb(${PALETTE[i * 3]},${PALETTE[i * 3 + 1]},${PALETTE[i * 3 + 2]})`;
      b.style.cursor = "pointer";
      b.onclick = () => {
        state.seedSymbol = i;
        flash(`Seed: ${SYMBOL_NAMES[i]}`);
        updateUI();
      };
      grid.appendChild(b);
      sw.push(b);
    }
    return { grid, sw };
  }

  function buildUI() {
    if (!uiRoot) return null;
    uiRoot.innerHTML = "";

    const panel = document.createElement("div");
    panel.style.position = "absolute";
    panel.style.left = "12px";
    panel.style.top = "12px";
    panel.style.width = "320px";
    panel.style.padding = "12px";
    panel.style.borderRadius = "14px";
    panel.style.border = "1px solid rgba(120,180,255,0.25)";
    panel.style.background = "rgba(0,0,0,0.65)";
    panel.style.backdropFilter = "blur(6px)";
    panel.style.boxShadow = "0 0 24px rgba(40,120,255,0.10)";
    panel.style.color = "#dff6ff";
    panel.style.font = "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    panel.style.userSelect = "none";

    const title = document.createElement("div");
    title.textContent = "Language Evolution Mosaic";
    title.style.fontWeight = "800";
    title.style.fontSize = "16px";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.95";
    meta.style.lineHeight = "1.35";
    panel.appendChild(meta);

    const btnPause = makeButton("Pause");
    const btnReset = makeButton("Reset");
    const btnShock = makeButton("Meme Shock Now");

    const bordersToggle = makeToggle("Borders");
    const crispToggle = makeToggle("Pixel Crisp");

    const swatches = buildSwatches();

    const sDiff = makeSlider("Diffusion", 0, 1, 0.01, state.diffusion.toFixed(2));
    const sSel = makeSlider("Selection", 0, 1, 0.01, state.selK.toFixed(2));
    const sMut = makeSlider("Mutation", 0, 0.2, 0.001, state.mutRate.toFixed(3));
    const sShock = makeSlider("Shock freq (/s)", 0.0, 0.4, 0.01, state.shockFreq.toFixed(2));

    const stats = document.createElement("div");
    stats.style.marginTop = "10px";
    stats.style.fontSize = "12px";
    stats.style.opacity = "0.95";
    stats.style.whiteSpace = "pre-wrap";
    panel.appendChild(stats);

    const help = document.createElement("div");
    help.textContent = "Click: seed • Shift+Click: hotspot • 1..9 0 - = select • Q/E cycle • Space pause";
    help.style.marginTop = "10px";
    help.style.fontSize = "12px";
    help.style.opacity = "0.85";

    const status = document.createElement("div");
    status.style.marginTop = "8px";
    status.style.fontSize = "12px";
    status.style.color = "#ff4bd8";
    status.style.minHeight = "16px";

    const back = document.createElement("a");
    back.href = "/";
    back.textContent = "Back";
    back.style.display = "inline-block";
    back.style.marginTop = "10px";
    back.style.fontSize = "12px";
    back.style.color = "#2aa2ff";
    back.style.textDecoration = "none";
    back.style.border = "1px solid rgba(42,162,255,0.25)";
    back.style.padding = "6px 10px";
    back.style.borderRadius = "10px";
    back.onmouseenter = () => (back.style.borderColor = "rgba(255,75,216,0.45)");
    back.onmouseleave = () => (back.style.borderColor = "rgba(42,162,255,0.25)");

    panel.appendChild(btnPause);
    panel.appendChild(btnReset);
    panel.appendChild(btnShock);
    panel.appendChild(bordersToggle.row);
    panel.appendChild(crispToggle.row);

    const seedLab = document.createElement("div");
    seedLab.textContent = "Seed symbol";
    seedLab.style.marginTop = "10px";
    seedLab.style.fontSize = "12px";
    seedLab.style.opacity = "0.9";
    panel.appendChild(seedLab);
    panel.appendChild(swatches.grid);

    panel.appendChild(sDiff.wrap);
    panel.appendChild(sSel.wrap);
    panel.appendChild(sMut.wrap);
    panel.appendChild(sShock.wrap);

    panel.appendChild(help);
    panel.appendChild(status);
    panel.appendChild(back);

    uiRoot.appendChild(panel);

    // wire controls
    btnPause.onclick = () => {
      Engine.togglePause();
      state.paused = Engine.isPaused();
      flash(state.paused ? "Paused." : "Running.");
      updateUI();
    };
    btnReset.onclick = () => {
      const ok = confirm("Reset simulation?");
      if (!ok) return;
      initFields();
      scheduleNextShock();
      flash("Reset.");
      saveNow();
      updateUI();
    };
    btnShock.onclick = () => {
      const cx = randRange(0, state.gw - 1);
      const cy = randRange(0, state.gh - 1);
      const sym = state.seedSymbol;
      doShock(cx, cy, sym, randRange(8, 18), clamp(state.shockStrength + 0.15, 0, 0.9));
      scheduleNextShock();
      flash(`Manual shock: ${SYMBOL_NAMES[sym]}`);
      saveSoon();
      updateUI();
    };

    bordersToggle.button.onclick = () => {
      state.borders = !state.borders;
      bordersToggle.button.textContent = state.borders ? "On" : "Off";
      flash(state.borders ? "Borders on." : "Borders off.");
      saveSoon();
      updateUI();
    };
    crispToggle.button.onclick = () => {
      state.crisp = !state.crisp;
      crispToggle.button.textContent = state.crisp ? "On" : "Off";
      flash(state.crisp ? "Crisp pixels." : "Smoothed pixels.");
      saveSoon();
      updateUI();
    };

    sDiff.input.oninput = () => {
      state.diffusion = parseFloat(sDiff.input.value);
      sDiff.valueEl.textContent = state.diffusion.toFixed(2);
    };
    sDiff.input.onchange = () => saveSoon();

    sSel.input.oninput = () => {
      state.selK = parseFloat(sSel.input.value);
      sSel.valueEl.textContent = state.selK.toFixed(2);
    };
    sSel.input.onchange = () => saveSoon();

    sMut.input.oninput = () => {
      state.mutRate = parseFloat(sMut.input.value);
      sMut.valueEl.textContent = state.mutRate.toFixed(3);
    };
    sMut.input.onchange = () => saveSoon();

    sShock.input.oninput = () => {
      state.shockFreq = parseFloat(sShock.input.value);
      sShock.valueEl.textContent = state.shockFreq.toFixed(2);
      // reschedule to reflect new frequency
      scheduleNextShock();
    };
    sShock.input.onchange = () => saveSoon();

    return {
      meta,
      stats,
      status,
      btnPause,
      bordersBtn: bordersToggle.button,
      crispBtn: crispToggle.button,
      swatches: swatches.sw,
      sDiff,
      sSel,
      sMut,
      sShock,
    };
  }

  function updateUI() {
    if (!ui) return;

    const sym = state.seedSymbol;
    const name = SYMBOL_NAMES[sym];

    ui.btnPause.textContent = Engine.isPaused() ? "Play" : "Pause";
    ui.bordersBtn.textContent = state.borders ? "On" : "Off";
    ui.crispBtn.textContent = state.crisp ? "On" : "Off";

    // highlight seed swatch
    for (let i = 0; i < ui.swatches.length; i++) {
      ui.swatches[i].style.outline = i === sym ? "2px solid rgba(223,246,255,0.75)" : "none";
    }

    ui.meta.innerHTML =
      `Seed: <b style="color: rgb(${PALETTE[sym * 3]},${PALETTE[sym * 3 + 1]},${PALETTE[sym * 3 + 2]})">${name}</b><br>` +
      `Grid: <b>${state.gw}×${state.gh}</b>  |  Entropy: <b>${state.entropy.toFixed(3)}</b><br>` +
      `Diff: <b>${state.diffusion.toFixed(2)}</b>  Sel: <b>${state.selK.toFixed(2)}</b>  Mut: <b>${state.mutRate.toFixed(3)}</b>  Shock: <b>${state.shockFreq.toFixed(
        2
      )}/s</b>`;

    // stats text (top few)
    const pct = state.areaPct;
    // get top 6 without allocations: partial selection by simple scan
    const idx = new Int32Array(S);
    for (let i = 0; i < S; i++) idx[i] = i;

    // tiny insertion sort for S=12 (cheap)
    for (let i = 1; i < S; i++) {
      const k = idx[i];
      let j = i - 1;
      while (j >= 0 && pct[idx[j]] < pct[k]) {
        idx[j + 1] = idx[j];
        j--;
      }
      idx[j + 1] = k;
    }

    let txt = "Control (top):\n";
    for (let i = 0; i < 6; i++) {
      const s = idx[i];
      txt += `${SYMBOL_NAMES[s].padEnd(6)}  ${(pct[s] * 100).toFixed(1)}%\n`;
    }
    ui.stats.textContent = txt;

    ui.status.textContent = nowSec() < state.statusUntil ? state.status : "";
  }

  // ---------------- saving/loading ----------------
  // Keep saves practical: store dom + conf + temp (quantised) + params + rng seed.
  // Reconstruct p from dom/conf as: p[dom]=conf, others share remaining mass equally.
  function packFields() {
    const n = state.n;
    const dom = state.dom;
    const conf = state.conf;
    const temp = state.temp;

    const confQ = new Uint8Array(n);
    const tempQ = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      confQ[i] = clamp((conf[i] * 255) | 0, 0, 255);
      tempQ[i] = clamp((temp[i] * 255) | 0, 0, 255);
    }

    // base64 encode
    const domB64 = bytesToB64(dom);
    const confB64 = bytesToB64(confQ);
    const tempB64 = bytesToB64(tempQ);

    return { domB64, confB64, tempB64 };
  }

  function unpackFields(packed) {
    if (!packed || typeof packed !== "object") return false;
    const { domB64, confB64, tempB64 } = packed;
    if (typeof domB64 !== "string" || typeof confB64 !== "string" || typeof tempB64 !== "string") return false;

    const dom = b64ToBytes(domB64);
    const confQ = b64ToBytes(confB64);
    const tempQ = b64ToBytes(tempB64);

    if (!dom || !confQ || !tempQ) return false;
    if (dom.length !== state.n || confQ.length !== state.n || tempQ.length !== state.n) return false;

    state.dom.set(dom);
    for (let i = 0; i < state.n; i++) {
      state.conf[i] = confQ[i] / 255;
      state.temp[i] = tempQ[i] / 255;
    }

    // reconstruct pA
    const p = state.pA;
    const n = state.n;
    for (let i = 0; i < n; i++) {
      const o = i * S;
      const d = state.dom[i];
      const c = clamp(state.conf[i], 0.01, 0.99);
      const rem = (1 - c) / (S - 1);
      for (let a = 0; a < S; a++) p[o + a] = rem;
      p[o + d] = c;
    }
    return true;
  }

  // base64 helpers (no allocations in hot loops; used only on save/load)
  function bytesToB64(u8) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    try {
      const s = atob(b64);
      const u8 = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 255;
      return u8;
    } catch (_) {
      return null;
    }
  }

  function serialise() {
    const packed = packFields();
    return {
      v: 1,
      gw: state.gw,
      gh: state.gh,
      rng,
      params: {
        diffusion: state.diffusion,
        selK: state.selK,
        mutRate: state.mutRate,
        shockFreq: state.shockFreq,
        shockStrength: state.shockStrength,
        borders: state.borders ? 1 : 0,
        crisp: state.crisp ? 1 : 0,
        seedSymbol: state.seedSymbol | 0,
      },
      fields: packed,
      lastKnownEntropy: state.entropy,
      t: state.t,
    };
  }

  function applySave(obj) {
    if (!obj || typeof obj !== "object") return false;
    if ((obj.gw | 0) !== state.gw || (obj.gh | 0) !== state.gh) return false; // avoid mismatched buffer sizes

    if (obj.params && typeof obj.params === "object") {
      state.diffusion = clamp(+obj.params.diffusion || state.diffusion, 0, 1);
      state.selK = clamp(+obj.params.selK || state.selK, 0, 1);
      state.mutRate = clamp(+obj.params.mutRate || state.mutRate, 0, 0.3);
      state.shockFreq = clamp(+obj.params.shockFreq || state.shockFreq, 0, 0.6);
      state.shockStrength = clamp(+obj.params.shockStrength || state.shockStrength, 0.05, 0.95);
      state.borders = !!obj.params.borders;
      state.crisp = !!obj.params.crisp;
      state.seedSymbol = clamp(obj.params.seedSymbol | 0, 0, S - 1);
    }

    if (typeof obj.rng === "number") rng = obj.rng >>> 0;
    if (typeof obj.t === "number" && isFinite(obj.t)) state.t = obj.t;

    const ok = unpackFields(obj.fields);
    updateDomConf(state.pA);
    computeStats();
    return ok;
  }

  function saveNow() {
    Engine.save(SAVE_KEY, serialise());
  }
  function saveSoon() {
    state.autosaveAt = Math.min(state.autosaveAt, nowSec() + 0.4);
  }

  function doLoadAndOffline() {
    const saved = Engine.load(SAVE_KEY, null);
    const ok = applySave(saved);

    const lastTs = Engine.loadTimestamp(SAVE_KEY);
    const nowMs = Date.now();
    if (ok && lastTs > 0 && nowMs > lastTs) {
      // offline progress: run limited number of sim steps
      const dt = Math.min((nowMs - lastTs) * 0.001, 2 * 3600);
      const steps = clamp(Math.floor(dt * 20), 0, 800); // ~20 steps/sec offline, capped
      for (let i = 0; i < steps; i++) {
        simStep();
        state.t += state.simStep;
      }
      flash(`Offline sim: ${steps} steps`);
    }
    return ok;
  }

  // ---------------- loop hooks ----------------
  function update(dt) {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    state.t += dt;

    // fps ema (for border overlay subsampling)
    const fps = dt > 0 ? 1 / dt : 60;
    state.perf.fpsEMA = lerp(state.perf.fpsEMA, clamp(fps, 5, 240), 0.06);

    // fixed-step sim
    state.simAcc += dt;
    let sub = 0;
    while (state.simAcc >= state.simStep && sub < state.simMaxSub) {
      simStep();
      state.simAcc -= state.simStep;
      sub++;
    }

    // stats occasionally
    const tNow = nowSec();
    if (tNow >= state.statsAt) {
      computeStats();
      state.statsAt = tNow + 1.0;
      if (ui) updateUI();
    }

    // autosave
    if (tNow >= state.autosaveAt) {
      saveNow();
      state.autosaveAt = tNow + 10.0;
    }
  }

  // ---------------- boot ----------------
  chooseGrid();
  allocBuffers();
  buildPayoffMatrix();
  initFields();
  scheduleNextShock();

  doLoadAndOffline();

  state.statsAt = nowSec() + 0.3;
  state.autosaveAt = nowSec() + 10.0;

  ui = (function initUI() {
    const u = buildUI();
    if (u) {
      // initialise toggles text
      u.bordersBtn.textContent = state.borders ? "On" : "Off";
      u.crispBtn.textContent = state.crisp ? "On" : "Off";
      updateUI();
    }
    return u;
  })();

  Engine.on("onClick", onClick);
  Engine.on("onKeyDown", onKeyDown);

  Engine.on("onResize", () => {
    // rebuild everything on resize (grid depends on size)
    chooseGrid();
    allocBuffers();
    buildPayoffMatrix();
    initFields();
    scheduleNextShock();
    flash("Resized: simulation reset.");
    saveSoon();
  });

  Engine.on("update", (dt) => update(dt));
  Engine.on("render", () => render());

  window.addEventListener("beforeunload", () => {
    try {
      saveNow();
    } catch (_) {}
  });
}
