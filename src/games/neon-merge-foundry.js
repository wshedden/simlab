import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.mergeFoundry.v1";
  const TAU = Math.PI * 2;

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild
      ? ctx.uiRoot
      : null;

  // ----------------- util -----------------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const hypot = Math.hypot;

  function fmt(n) {
    if (!isFinite(n)) return "0";
    const abs = Math.abs(n);
    if (abs < 1000) return n.toFixed(0);
    if (abs < 1e6) return (n / 1e3).toFixed(2) + "K";
    if (abs < 1e9) return (n / 1e6).toFixed(2) + "M";
    if (abs < 1e12) return (n / 1e9).toFixed(2) + "B";
    if (abs < 1e15) return (n / 1e12).toFixed(2) + "T";
    return (n / 1e15).toFixed(2) + "Q";
  }

  // Deterministic fast RNG for cheap jitter/noise
  let rng = (Date.now() ^ 0x9e3779b9) >>> 0;
  function rand01() {
    rng = (1664525 * rng + 1013904223) >>> 0;
    return rng / 4294967296;
  }
  function randSigned() {
    return rand01() * 2 - 1;
  }
  function randRange(a, b) {
    return a + (b - a) * rand01();
  }

  // ----------------- config -----------------
  const CFG = {
    tierCap: 22,

    // economy
    baseValue: 0.12,
    growth: 2.55,

    // caps
    maxTokensNormal: 500,
    maxTokensPerf: 300,
    maxSparksNormal: 300,
    maxSparksPerf: 180,

    // trail
    trailLenNormal: 6,
    trailLenPerf: 4,

    // physics
    damp: 0.990,
    wander: 16.0, // px/s^2 scale
    centrePull: 12.0, // px/s^2
    bounce: 0.92,

    // arena
    margin: 42,
    boundaryWidth: 2,

    // merge
    mergeFactor: 0.92, // distance threshold multiplier for (r1+r2)
    mergeCooldown: 0.12, // seconds, per token to avoid re-colliding post-merge

    // grid
    baseCell: 28, // px, adjusted with perf/trails, good for neighbour checks

    // spawning
    initialTokens: 20,
    emitterCount: 2,
    spawnImpulse: 70, // px/s initial inward speed
    spawnJitter: 38, // px/s
    clickCostBase: 0, // free early; cost rises with spawnerLevel
    clickCostScale: 8,

    // upgrades scaling
    costSpawnerBase: 40,
    costSpawnerMul: 1.55,

    costMagnetBase: 70,
    costMagnetMul: 1.6,

    costTierBase: 120,
    costTierMul: 1.7,

    costCompressorBase: 180,
    costCompressorMul: 1.75,

    costForgeBase: 2500,

    autosaveEvery: 5.0,
    offlineCapSec: 2 * 3600,

    // perf auto
    autoPerfFps: 45,
    autoPerfHold: 2.0,
  };

  const COL = {
    cyan: "#3dfcff",
    blue: "#2aa2ff",
    purple: "#b04bff",
    magenta: "#ff4bd8",
    white: "#e8f7ff",
  };

  // ----------------- state -----------------
  const state = {
    paused: false,
    t: 0,

    money: 0,
    forgeMultiplier: 1.0,

    // upgrades
    spawnerLevel: 0,
    magnetLevel: 0,
    tierChanceLevel: 0,
    compressorLevel: 0,

    // derived
    spawnRate: 1.2, // tokens/sec
    magnetStrength: 0, // px/s^2 scale
    tierChance1: 0,
    tierChance2: 0,
    compressorPayoutMul: 0.10,

    // bookkeeping
    incomePerSec: 0,
    lastKnownIncome: 0,

    // arena geometry
    cx: 0,
    cy: 0,
    arenaR: 240,

    // tokens
    tokens: [],
    freeIdx: [],
    nextId: 1,

    // flags
    showTrails: true,
    perfMode: false,

    // interaction
    stir: {
      down: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    },

    // status
    status: "",
    statusUntil: 0,

    // stars
    stars: [],

    // effects
    rings: [],

    sparks: {
      x: new Float32Array(CFG.maxSparksNormal),
      y: new Float32Array(CFG.maxSparksNormal),
      vx: new Float32Array(CFG.maxSparksNormal),
      vy: new Float32Array(CFG.maxSparksNormal),
      life: new Float32Array(CFG.maxSparksNormal),
      max: new Float32Array(CFG.maxSparksNormal),
      hue: new Uint16Array(CFG.maxSparksNormal),
      n: 0,
      head: 0,
      cap: CFG.maxSparksNormal,
    },

    // grid (spatial hash)
    grid: {
      cell: CFG.baseCell,
      cols: 1,
      rows: 1,
      head: null, // Int32Array size cols*rows
      next: null, // Int32Array size maxTokens
    },

    // perf monitor
    perf: {
      fpsEMA: 60,
      belowT: 0,
    },

    // cheat mode
    cheatModeEnabled: false,
    cheatAmount: 1000,

    autosaveAt: 0,
  };

  function nowSec() {
    return performance.now() * 0.001;
  }
  function flash(msg) {
    state.status = msg || "";
    state.statusUntil = nowSec() + 1.1;
  }

  // ----------------- derived upgrades -----------------
  function applyUpgrades() {
    state.spawnRate = 1.2 * Math.pow(1.22, state.spawnerLevel);
    state.magnetStrength = state.magnetLevel > 0 ? 18 * Math.pow(1.25, state.magnetLevel - 1) : 0;

    // Tier chance: ramp gently; keep probabilities sane
    const tc = state.tierChanceLevel;
    state.tierChance1 = clamp(0.05 + tc * 0.03, 0, 0.35);
    state.tierChance2 = clamp(tc >= 3 ? 0.02 + (tc - 3) * 0.02 : 0, 0, 0.20);

    // Compressor: deletes lowest-tier near cap, pays small amount
    state.compressorPayoutMul = clamp(0.10 + 0.05 * state.compressorLevel, 0.10, 0.60);
  }

  // ----------------- costs -----------------
  function costSpawner() {
    return Math.floor(CFG.costSpawnerBase * Math.pow(CFG.costSpawnerMul, state.spawnerLevel));
  }
  function costMagnet() {
    return Math.floor(CFG.costMagnetBase * Math.pow(CFG.costMagnetMul, state.magnetLevel));
  }
  function costTierChance() {
    return Math.floor(CFG.costTierBase * Math.pow(CFG.costTierMul, state.tierChanceLevel));
  }
  function costCompressor() {
    return Math.floor(CFG.costCompressorBase * Math.pow(CFG.costCompressorMul, state.compressorLevel));
  }
  function costForge() {
    // prestige threshold grows with current forge multiplier
    return Math.floor(CFG.costForgeBase * Math.pow(4.0, Math.max(0, Math.log2(state.forgeMultiplier))));
  }
  function clickSpawnCost() {
    // mostly free early; later costs a bit to prevent infinite spam
    const lvl = state.spawnerLevel;
    return Math.floor(CFG.clickCostBase + CFG.clickCostScale * Math.max(0, lvl - 4));
  }

  function canAfford(c) {
    return state.money >= c - 1e-9;
  }
  function spend(c) {
    if (!canAfford(c)) return false;
    state.money -= c;
    return true;
  }
  function earn(x) {
    if (!isFinite(x) || x <= 0) return;
    state.money += x;
  }

  // ----------------- token pool -----------------
  function trailLen() {
    return state.perfMode ? CFG.trailLenPerf : CFG.trailLenNormal;
  }

  function tokenRadius(tier) {
    return 5.5 + tier * 0.95;
  }

  function tierHue(tier) {
    // map tiers through cyan -> purple -> magenta with cohesive range
    // hue in degrees, for hsl()
    const t = clamp(tier / CFG.tierCap, 0, 1);
    // 185..305
    return Math.floor(185 + 120 * t);
  }

  function allocToken() {
    let idx = -1;
    if (state.freeIdx.length) idx = state.freeIdx.pop();
    else idx = state.tokens.length;

    let tok = state.tokens[idx];
    if (!tok) {
      const tl = trailLen();
      tok = {
        id: 0,
        alive: 1,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        tier: 0,
        r: 0,
        hue: 200,
        mergeCD: 0,
        th: 0,
        tx: new Float32Array(tl),
        ty: new Float32Array(tl),
      };
      state.tokens[idx] = tok;
    } else {
      tok.alive = 1;
      tok.mergeCD = 0;
      // ensure trail arrays match current mode
      const tl = trailLen();
      if (!tok.tx || tok.tx.length !== tl) {
        tok.tx = new Float32Array(tl);
        tok.ty = new Float32Array(tl);
      }
    }
    tok.id = state.nextId++;
    tok.th = 0;
    return idx;
  }

  function freeToken(idx) {
    const tok = state.tokens[idx];
    if (!tok) return;
    tok.alive = 0;
    state.freeIdx.push(idx);
  }

  function initTrail(tok) {
    for (let i = 0; i < tok.tx.length; i++) {
      tok.tx[i] = tok.x;
      tok.ty[i] = tok.y;
    }
    tok.th = 0;
  }

  function spawnToken(x, y, tier, vx, vy) {
    const maxTokens = state.perfMode ? CFG.maxTokensPerf : CFG.maxTokensNormal;
    if (aliveCount() >= maxTokens) return -1;

    const idx = allocToken();
    const tok = state.tokens[idx];

    tok.x = x;
    tok.y = y;
    tok.vx = vx;
    tok.vy = vy;

    tok.tier = clamp(tier | 0, 0, CFG.tierCap);
    tok.r = tokenRadius(tok.tier);
    tok.hue = tierHue(tok.tier);
    tok.mergeCD = 0;

    initTrail(tok);
    return idx;
  }

  function aliveCount() {
    // cheap-ish (O(N)) but N capped; used sparingly
    let c = 0;
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t && t.alive) c++;
    }
    return c;
  }

  // ----------------- arena / geometry -----------------
  function ensureGeometry() {
    const { w, h } = Engine.getSize();
    state.cx = w * 0.5;
    state.cy = h * 0.54;

    const minDim = Math.max(1, Math.min(w, h));
    state.arenaR = clamp(minDim * 0.36, 160, minDim * 0.48);

    // update grid sizing
    state.grid.cell = CFG.baseCell;
    const cell = state.grid.cell;

    state.grid.cols = Math.max(1, Math.floor(w / cell));
    state.grid.rows = Math.max(1, Math.floor(h / cell));
    const cells = state.grid.cols * state.grid.rows;

    // head arrays; -1 indicates empty
    if (!state.grid.head || state.grid.head.length !== cells) {
      state.grid.head = new Int32Array(cells);
    }
    // next array sized to token array length; ensure >= max tokens possible
    const maxTok = CFG.maxTokensNormal + 64;
    if (!state.grid.next || state.grid.next.length !== maxTok) {
      state.grid.next = new Int32Array(maxTok);
    }

    regenStars();
  }

  function regenStars() {
    state.stars.length = 0;
    const { w, h } = Engine.getSize();
    const n = 120;
    for (let i = 0; i < n; i++) {
      state.stars.push({
        x: rand01() * w,
        y: rand01() * h,
        r: rand01() < 0.85 ? 1 : 2,
        a: randRange(0.18, 0.55),
      });
    }
  }

  // ----------------- grid ops -----------------
  function gridClear() {
    const head = state.grid.head;
    if (!head) return;
    head.fill(-1);
  }

  function gridIndexFor(x, y) {
    const { w, h } = Engine.getSize();
    const cell = state.grid.cell;
    let cx = (x / cell) | 0;
    let cy = (y / cell) | 0;
    cx = cx < 0 ? 0 : cx >= state.grid.cols ? state.grid.cols - 1 : cx;
    cy = cy < 0 ? 0 : cy >= state.grid.rows ? state.grid.rows - 1 : cy;
    return cy * state.grid.cols + cx;
  }

  function gridInsert(idx) {
    const tok = state.tokens[idx];
    const gi = gridIndexFor(tok.x, tok.y);
    const head = state.grid.head;
    const next = state.grid.next;
    next[idx] = head[gi];
    head[gi] = idx;
  }

  // ----------------- effects -----------------
  function addRipple(x, y, r0, hue) {
    state.rings.push({
      x,
      y,
      r: r0,
      v: 210,
      life: 0.55,
      max: 0.55,
      hue,
    });
    if (state.rings.length > 24) state.rings.shift();
  }

  function ensureSparkBuffers() {
    const cap = state.perfMode ? CFG.maxSparksPerf : CFG.maxSparksNormal;
    const s = state.sparks;
    if (s.cap === cap) return;
    // reallocate once on mode switch; not in hot loops
    state.sparks = {
      x: new Float32Array(cap),
      y: new Float32Array(cap),
      vx: new Float32Array(cap),
      vy: new Float32Array(cap),
      life: new Float32Array(cap),
      max: new Float32Array(cap),
      hue: new Uint16Array(cap),
      n: Math.min(s.n, cap),
      head: 0,
      cap,
    };
  }

  function emitSparks(x, y, hue, count, speed) {
    const s = state.sparks;
    const cap = s.cap;
    const n = count | 0;

    for (let i = 0; i < n; i++) {
      const a = rand01() * TAU;
      const v = speed * randRange(0.35, 1.0);
      const idx = s.n < cap ? s.n++ : (s.head++ % cap);

      s.x[idx] = x;
      s.y[idx] = y;
      s.vx[idx] = Math.cos(a) * v;
      s.vy[idx] = Math.sin(a) * v;
      const life = randRange(0.18, 0.40);
      s.life[idx] = life;
      s.max[idx] = life;
      s.hue[idx] = hue;
    }
  }

  function updateEffects(dt) {
    // ripples
    for (let i = 0; i < state.rings.length; i++) {
      const r = state.rings[i];
      r.life -= dt;
      if (r.life <= 0) {
        state.rings.splice(i, 1);
        i--;
        continue;
      }
      r.r += r.v * dt;
      r.v *= 0.94;
    }

    // sparks
    const s = state.sparks;
    for (let i = 0; i < s.n; i++) {
      let life = s.life[i];
      if (life <= 0) continue;
      life -= dt;
      s.life[i] = life;
      if (life <= 0) continue;
      s.x[i] += s.vx[i] * dt;
      s.y[i] += s.vy[i] * dt;
      s.vx[i] *= 0.92;
      s.vy[i] *= 0.92;
    }
  }

  // ----------------- merging / magnet -----------------
  const mergeA = []; // reused arrays of merge pairs, store indices
  const mergeB = [];

  function findNearestSameTier(idx, searchR) {
    // returns best neighbour index or -1
    const tok = state.tokens[idx];
    const tier = tok.tier;
    const cell = state.grid.cell;
    const cols = state.grid.cols;
    const rows = state.grid.rows;
    const head = state.grid.head;
    const next = state.grid.next;

    const gx = (tok.x / cell) | 0;
    const gy = (tok.y / cell) | 0;

    let best = -1;
    let bestD2 = searchR * searchR;

    for (let oy = -1; oy <= 1; oy++) {
      const y = gy + oy;
      if (y < 0 || y >= rows) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const x = gx + ox;
        if (x < 0 || x >= cols) continue;
        let j = head[y * cols + x];
        while (j !== -1) {
          if (j !== idx) {
            const t2 = state.tokens[j];
            if (t2 && t2.alive && t2.tier === tier) {
              const dx = t2.x - tok.x;
              const dy = t2.y - tok.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < bestD2) {
                bestD2 = d2;
                best = j;
              }
            }
          }
          j = next[j];
        }
      }
    }
    return best;
  }

  function collectMerges() {
    // build merge pairs without mutating tokens; then apply once to avoid double merges
    mergeA.length = 0;
    mergeB.length = 0;

    const cell = state.grid.cell;
    const cols = state.grid.cols;
    const rows = state.grid.rows;
    const head = state.grid.head;
    const next = state.grid.next;

    // We'll do per-token neighbour checks in adjacent cells only.
    // To reduce duplicates, we only merge if neighbour index > idx.
    for (let i = 0; i < state.tokens.length; i++) {
      const a = state.tokens[i];
      if (!a || !a.alive) continue;
      if (a.mergeCD > 0) continue;
      if (a.tier >= CFG.tierCap) continue;

      const gx = (a.x / cell) | 0;
      const gy = (a.y / cell) | 0;

      for (let oy = -1; oy <= 1; oy++) {
        const y = gy + oy;
        if (y < 0 || y >= rows) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const x = gx + ox;
          if (x < 0 || x >= cols) continue;
          let j = head[y * cols + x];
          while (j !== -1) {
            if (j > i) {
              const b = state.tokens[j];
              if (b && b.alive && b.mergeCD <= 0 && b.tier === a.tier) {
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const rr = (a.r + b.r) * CFG.mergeFactor;
                if (dx * dx + dy * dy < rr * rr) {
                  mergeA.push(i);
                  mergeB.push(j);
                  // Only one merge per token per frame
                  ox = 99;
                  oy = 99;
                  break;
                }
              }
            }
            j = next[j];
          }
        }
      }
    }
  }

  function applyMerges() {
    for (let k = 0; k < mergeA.length; k++) {
      const ia = mergeA[k];
      const ib = mergeB[k];

      const a = state.tokens[ia];
      const b = state.tokens[ib];
      if (!a || !b || !a.alive || !b.alive) continue;
      if (a.tier !== b.tier) continue;
      if (a.tier >= CFG.tierCap) continue;

      // merge -> new token at midpoint
      const x = (a.x + b.x) * 0.5;
      const y = (a.y + b.y) * 0.5;
      const vx = (a.vx + b.vx) * 0.5;
      const vy = (a.vy + b.vy) * 0.5;
      const tier = a.tier + 1;

      // free old ones
      freeToken(ia);
      freeToken(ib);

      const idx = spawnToken(x, y, tier, vx, vy);
      if (idx !== -1) {
        const nt = state.tokens[idx];
        nt.mergeCD = CFG.mergeCooldown;

        const hue = nt.hue;
        addRipple(x, y, nt.r * 0.7, hue);
        emitSparks(x, y, hue, state.perfMode ? 10 : 14, 220 + 8 * tier);
      }
    }
    mergeA.length = 0;
    mergeB.length = 0;
  }

  // ----------------- token update -----------------
  function containCircle(tok) {
    const dx = tok.x - state.cx;
    const dy = tok.y - state.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxD = state.arenaR - tok.r;
    if (dist <= maxD || dist < 1e-6) return;

    // push back to boundary
    const nx = dx / dist;
    const ny = dy / dist;
    tok.x = state.cx + nx * maxD;
    tok.y = state.cy + ny * maxD;

    // reflect velocity
    const vn = tok.vx * nx + tok.vy * ny;
    if (vn > 0) return; // already heading inward (rare)
    tok.vx -= (1 + CFG.bounce) * vn * nx;
    tok.vy -= (1 + CFG.bounce) * vn * ny;
    tok.vx *= CFG.bounce;
    tok.vy *= CFG.bounce;
  }

  function pushTrail(tok) {
    if (!state.showTrails) return;
    const n = tok.tx.length;
    tok.th = (tok.th + 1) % n;
    tok.tx[tok.th] = tok.x;
    tok.ty[tok.th] = tok.y;
  }

  function updateTokens(dt) {
    const mx = Engine.mouse().x;
    const my = Engine.mouse().y;

    const stir = state.stir;
    const stirOn = stir.down;
    const sx = stir.x;
    const sy = stir.y;

    // global centre pull
    const cx = state.cx;
    const cy = state.cy;

    const wander = CFG.wander;
    const centrePull = CFG.centrePull;

    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (!tok || !tok.alive) continue;

      if (tok.mergeCD > 0) tok.mergeCD -= dt;

      // wander (cheap random accel)
      tok.vx += randSigned() * wander * dt;
      tok.vy += randSigned() * wander * dt;

      // gentle pull to centre
      tok.vx += (cx - tok.x) * (centrePull * 0.0009) * dt;
      tok.vy += (cy - tok.y) * (centrePull * 0.0009) * dt;

      // stir field: vortex that pushes around cursor
      if (stirOn) {
        const dx = tok.x - sx;
        const dy = tok.y - sy;
        const d2 = dx * dx + dy * dy;
        if (d2 > 1 && d2 < 220 * 220) {
          const inv = 1 / Math.sqrt(d2);
          const nx = dx * inv;
          const ny = dy * inv;
          // tangential
          const tx = -ny;
          const ty = nx;
          const strength = (1 - Math.sqrt(d2) / 220) * 240;
          tok.vx += tx * strength * dt;
          tok.vy += ty * strength * dt;
          // slight inward pull to keep it tight
          tok.vx -= nx * (strength * 0.18) * dt;
          tok.vy -= ny * (strength * 0.18) * dt;
        }
      }

      // magnet: nearest same-tier only (grid-based)
      if (state.magnetStrength > 0 && tok.mergeCD <= 0) {
        const j = findNearestSameTier(i, 180);
        if (j !== -1) {
          const t2 = state.tokens[j];
          const dx = t2.x - tok.x;
          const dy = t2.y - tok.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 4) {
            const inv = 1 / Math.sqrt(d2);
            const ax = dx * inv;
            const ay = dy * inv;
            const f = state.magnetStrength * (1 - Math.min(1, Math.sqrt(d2) / 180));
            tok.vx += ax * f * dt;
            tok.vy += ay * f * dt;
          }
        }
      }

      // damping
      tok.vx *= CFG.damp;
      tok.vy *= CFG.damp;

      // integrate
      tok.x += tok.vx * dt;
      tok.y += tok.vy * dt;

      containCircle(tok);
      pushTrail(tok);
    }
  }

  // ----------------- spawning -----------------
  const emitters = [];
  function initEmitters() {
    emitters.length = 0;
    const n = CFG.emitterCount;
    for (let i = 0; i < n; i++) {
      emitters.push({
        a: rand01() * TAU,
        da: randRange(-0.15, 0.15),
        acc: 0,
      });
    }
  }

  function sampleSpawnTier() {
    // base tier with chance
    const r = rand01();
    if (r < state.tierChance2) return 2;
    if (r < state.tierChance2 + state.tierChance1) return 1;
    return 0;
  }

  function doAutoSpawn(dt) {
    const maxTokens = state.perfMode ? CFG.maxTokensPerf : CFG.maxTokensNormal;
    const count = aliveCount();
    if (count >= maxTokens) return;

    const targetRate = state.spawnRate;
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      e.a += e.da * dt;
      e.da += randSigned() * 0.03 * dt;
      e.da = clamp(e.da, -0.25, 0.25);

      e.acc += targetRate * dt * (1 / emitters.length);
      if (e.acc < 1) continue;

      // spawn one
      e.acc -= 1;

      const x = state.cx + Math.cos(e.a) * (state.arenaR - 10);
      const y = state.cy + Math.sin(e.a) * (state.arenaR - 10);

      const nx = (state.cx - x);
      const ny = (state.cy - y);
      const inv = 1 / Math.max(1e-6, Math.sqrt(nx * nx + ny * ny));
      const ix = nx * inv;
      const iy = ny * inv;

      const vIn = CFG.spawnImpulse + randRange(-20, 20);
      const vx = ix * vIn + randSigned() * CFG.spawnJitter;
      const vy = iy * vIn + randSigned() * CFG.spawnJitter;

      const tier = sampleSpawnTier();

      const spawned = spawnToken(x, y, tier, vx, vy);
      if (spawned === -1) return;
      if (aliveCount() >= maxTokens) return;
    }
  }

  // ----------------- compressor -----------------
  function valuePerSecond(tier) {
    return CFG.baseValue * Math.pow(CFG.growth, tier);
  }

  function computeIncomePerSec() {
    let sum = 0;
    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (!tok || !tok.alive) continue;
      sum += valuePerSecond(tok.tier);
    }
    sum *= state.forgeMultiplier;
    state.incomePerSec = sum;
    state.lastKnownIncome = lerp(state.lastKnownIncome, sum, 0.08);
    return sum;
  }

  function runCompressor() {
    if (state.compressorLevel <= 0) return;

    const maxTokens = state.perfMode ? CFG.maxTokensPerf : CFG.maxTokensNormal;
    const count = aliveCount();
    const over = count - Math.floor(maxTokens * 0.92);
    if (over <= 0) return;

    // delete up to K lowest-tier tokens; small payout
    // K scales with compressor level, but keep bounded
    let k = Math.min(over, 4 + state.compressorLevel * 2);
    k = clamp(k, 1, 18);

    // find and delete tier-0 (prefer), else smallest tiers
    // O(N*k) but k small
    for (let pass = 0; pass < 3 && k > 0; pass++) {
      const targetTier = pass; // 0,1,2
      for (let i = 0; i < state.tokens.length && k > 0; i++) {
        const tok = state.tokens[i];
        if (!tok || !tok.alive) continue;
        if (tok.tier !== targetTier) continue;

        const payout = valuePerSecond(tok.tier) * state.compressorPayoutMul;
        earn(payout);
        freeToken(i);
        k--;
      }
    }

    // if still need, delete any lowest tiers up to 5
    for (let targetTier = 3; targetTier <= 5 && k > 0; targetTier++) {
      for (let i = 0; i < state.tokens.length && k > 0; i++) {
        const tok = state.tokens[i];
        if (!tok || !tok.alive) continue;
        if (tok.tier !== targetTier) continue;

        const payout = valuePerSecond(tok.tier) * state.compressorPayoutMul;
        earn(payout);
        freeToken(i);
        k--;
      }
    }
  }

  // ----------------- rendering -----------------
  function hsl(h, s, l, a) {
    return `hsla(${h},${s}%,${l}%,${a})`;
  }

  function drawStars(ctx2d) {
    ctx2d.save();
    for (let i = 0; i < state.stars.length; i++) {
      const s = state.stars[i];
      ctx2d.fillStyle = `rgba(220,245,255,${s.a})`;
      ctx2d.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx2d.restore();
  }

  function drawArena() {
    const g = Engine.gfx;
    const ctx2d = Engine.getCtx();

    // faint outer ring
    ctx2d.save();
    ctx2d.strokeStyle = "rgba(61,252,255,0.16)";
    ctx2d.lineWidth = CFG.boundaryWidth;
    ctx2d.beginPath();
    ctx2d.arc(state.cx, state.cy, state.arenaR, 0, TAU);
    ctx2d.stroke();

    // subtle inner ring
    ctx2d.strokeStyle = "rgba(176,75,255,0.08)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.arc(state.cx, state.cy, state.arenaR * 0.62, 0, TAU);
    ctx2d.stroke();
    ctx2d.restore();

    // rim emitters
    for (let i = 0; i < emitters.length; i++) {
      const e = emitters[i];
      const x = state.cx + Math.cos(e.a) * (state.arenaR - 8);
      const y = state.cy + Math.sin(e.a) * (state.arenaR - 8);
      g.glowCircle(x, y, 3.0, COL.blue, 16, 0.7);
    }
  }

  function drawTrails() {
    if (!state.showTrails) return;
    const g = Engine.gfx;
    const tl = trailLen();
    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (!tok || !tok.alive) continue;

      const hue = tok.hue;
      const col = hsl(hue, 100, 60, 0.55);

      const head = tok.th;
      for (let k = 0; k < tl - 1; k++) {
        const i0 = (head - k + tl) % tl;
        const i1 = (head - k - 1 + tl) % tl;
        const x0 = tok.tx[i0],
          y0 = tok.ty[i0];
        const x1 = tok.tx[i1],
          y1 = tok.ty[i1];
        const a = 0.26 * (1 - k / (tl - 1));
        g.line(x0, y0, x1, y1, col, 2, a);
      }
    }
  }

  function drawTokens() {
    const g = Engine.gfx;

    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (!tok || !tok.alive) continue;

      const hue = tok.hue;
      const col = hsl(hue, 100, 60, 0.95);

      const glow = 16 + tok.tier * 0.6;
      const alpha = tok.mergeCD > 0 ? 0.65 : 0.9;

      g.glowCircle(tok.x, tok.y, tok.r, col, glow, alpha);

      // core dot
      g.glowCircle(tok.x, tok.y, Math.max(2.0, tok.r * 0.33), COL.white, 10, 0.35);

      // tiny tier mark
      if (tok.tier >= 3) {
        const ctx2d = Engine.getCtx();
        ctx2d.save();
        ctx2d.fillStyle = "rgba(0,0,0,0.40)";
        ctx2d.beginPath();
        ctx2d.arc(tok.x, tok.y, tok.r * 0.45, 0, TAU);
        ctx2d.fill();
        ctx2d.fillStyle = "rgba(223,246,255,0.85)";
        ctx2d.font = "700 10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx2d.textAlign = "center";
        ctx2d.textBaseline = "middle";
        ctx2d.fillText(String(tok.tier), tok.x, tok.y + 0.5);
        ctx2d.restore();
      }
    }
  }

  function drawEffects() {
    const ctx2d = Engine.getCtx();
    const g = Engine.gfx;

    // ripples
    for (let i = 0; i < state.rings.length; i++) {
      const r = state.rings[i];
      const a = r.life / r.max;
      ctx2d.save();
      ctx2d.strokeStyle = hsl(r.hue, 100, 65, 0.30 * a);
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(r.x, r.y, r.r, 0, TAU);
      ctx2d.stroke();
      ctx2d.restore();
    }

    // sparks
    const s = state.sparks;
    for (let i = 0; i < s.n; i++) {
      const life = s.life[i];
      if (life <= 0) continue;
      const a = life / (s.max[i] || 1);
      const hue = s.hue[i];
      const col = hsl(hue, 100, 65, 0.20 + 0.55 * a);
      const r = 1.3 + (1 - a) * 1.2;
      g.glowCircle(s.x[i], s.y[i], r, col, 10, 0.35 + 0.45 * a);
    }
  }

  function drawHUD() {
    if (uiRoot) return;
    const ctx2d = Engine.getCtx();
    const { w, h } = Engine.getSize();

    ctx2d.save();
    ctx2d.fillStyle = "rgba(223,246,255,0.95)";
    ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx2d.fillText(
      `Money: ${fmt(state.money)}   +${fmt(state.incomePerSec)}/s   Tokens: ${aliveCount()}   x${state.forgeMultiplier.toFixed(
        2
      )}`,
      14,
      h - 42
    );
    ctx2d.fillStyle = "rgba(61,252,255,0.85)";
    ctx2d.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx2d.fillText("Click spawn • Drag stir • Space pause • R reset", 14, h - 22);
    if (nowSec() < state.statusUntil && state.status) {
      ctx2d.fillStyle = "rgba(255,75,216,0.9)";
      ctx2d.fillText(state.status, 14, 22);
    }
    ctx2d.restore();
  }

  function render() {
    Engine.gfx.clearBlack();
    drawStars(Engine.getCtx());
    drawArena();
    drawTrails();
    drawTokens();
    drawEffects();
    drawHUD();

    // canvas status overlay even with UI
    if (uiRoot && nowSec() < state.statusUntil && state.status) {
      const ctx2d = Engine.getCtx();
      ctx2d.save();
      ctx2d.fillStyle = "rgba(255,75,216,0.85)";
      ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx2d.fillText(state.status, 14, 22);
      ctx2d.restore();
    }
  }

  // ----------------- UI panel -----------------
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

  function buildUI() {
    if (!uiRoot) return null;
    uiRoot.innerHTML = "";

    const panel = document.createElement("div");
    panel.style.position = "absolute";
    panel.style.right = "12px";
    panel.style.top = "12px";
    panel.style.width = "290px";
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
    title.textContent = "Neon Merge Foundry";
    title.style.fontWeight = "800";
    title.style.fontSize = "16px";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const moneyLine = document.createElement("div");
    moneyLine.style.display = "flex";
    moneyLine.style.justifyContent = "space-between";
    moneyLine.style.alignItems = "baseline";
    moneyLine.style.marginBottom = "10px";

    const moneyLabel = document.createElement("div");
    moneyLabel.textContent = "Money";
    moneyLabel.style.opacity = "0.9";
    moneyLabel.style.fontWeight = "700";

    const moneyValue = document.createElement("div");
    moneyValue.textContent = "0";
    moneyValue.style.fontWeight = "900";
    moneyValue.style.fontSize = "18px";
    moneyValue.style.color = COL.cyan;

    moneyLine.appendChild(moneyLabel);
    moneyLine.appendChild(moneyValue);
    panel.appendChild(moneyLine);

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.95";
    meta.style.lineHeight = "1.35";
    meta.style.marginBottom = "8px";
    panel.appendChild(meta);

    const btnSpawner = makeButton("Upgrade Spawner");
    const btnMagnet = makeButton("Upgrade Magnet");
    const btnTier = makeButton("Upgrade Tier Chance");
    const btnCompressor = makeButton("Compressor");
    const btnForge = makeButton("Reforge (Prestige)");

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginTop = "6px";

    const btnPerf = makeButton("Performance Mode");
    btnPerf.style.flex = "1";
    btnPerf.style.margin = "0";

    const btnTrails = makeButton("Show Trails");
    btnTrails.style.flex = "1";
    btnTrails.style.margin = "0";

    row.appendChild(btnPerf);
    row.appendChild(btnTrails);

    const btnCheat = makeButton("Cheat Mode: Off");
    btnCheat.style.marginTop = "6px";

    const cheatPanel = document.createElement("div");
    cheatPanel.style.display = "none";
    cheatPanel.style.padding = "8px";
    cheatPanel.style.marginTop = "6px";
    cheatPanel.style.borderRadius = "10px";
    cheatPanel.style.border = "1px solid rgba(255,75,216,0.35)";
    cheatPanel.style.background = "rgba(0,0,0,0.45)";

    const cheatLabel = document.createElement("label");
    cheatLabel.textContent = "Cheat Amount:";
    cheatLabel.style.display = "block";
    cheatLabel.style.fontSize = "12px";
    cheatLabel.style.marginBottom = "4px";
    cheatLabel.style.opacity = "0.9";

    const cheatInput = document.createElement("input");
    cheatInput.type = "number";
    cheatInput.value = "1000";
    cheatInput.style.width = "100%";
    cheatInput.style.padding = "6px";
    cheatInput.style.marginBottom = "6px";
    cheatInput.style.borderRadius = "6px";
    cheatInput.style.border = "1px solid rgba(255,75,216,0.35)";
    cheatInput.style.background = "rgba(0,0,0,0.65)";
    cheatInput.style.color = COL.magenta;
    cheatInput.style.font = "13px monospace";
    cheatInput.style.boxSizing = "border-box";

    const btnCheatAdd = makeButton("Add Money");

    cheatPanel.appendChild(cheatLabel);
    cheatPanel.appendChild(cheatInput);
    cheatPanel.appendChild(btnCheatAdd);

    const help = document.createElement("div");
    help.textContent = "Click: spawn • Drag: stir • Space: pause • R: reset";
    help.style.marginTop = "10px";
    help.style.fontSize = "12px";
    help.style.opacity = "0.85";

    const status = document.createElement("div");
    status.style.marginTop = "8px";
    status.style.fontSize = "12px";
    status.style.color = COL.magenta;
    status.style.minHeight = "16px";

    const back = document.createElement("a");
    back.href = "/";
    back.textContent = "Back";
    back.style.display = "inline-block";
    back.style.marginTop = "10px";
    back.style.fontSize = "12px";
    back.style.color = COL.blue;
    back.style.textDecoration = "none";
    back.style.border = "1px solid rgba(42,162,255,0.25)";
    back.style.padding = "6px 10px";
    back.style.borderRadius = "10px";
    back.onmouseenter = () => (back.style.borderColor = "rgba(255,75,216,0.45)");
    back.onmouseleave = () => (back.style.borderColor = "rgba(42,162,255,0.25)");

    panel.appendChild(btnSpawner);
    panel.appendChild(btnMagnet);
    panel.appendChild(btnTier);
    panel.appendChild(btnCompressor);
    panel.appendChild(btnForge);
    panel.appendChild(row);
    panel.appendChild(btnCheat);
    panel.appendChild(cheatPanel);
    panel.appendChild(help);
    panel.appendChild(status);
    panel.appendChild(back);

    uiRoot.appendChild(panel);

    return {
      panel,
      moneyValue,
      meta,
      status,
      btnSpawner,
      btnMagnet,
      btnTier,
      btnCompressor,
      btnForge,
      btnPerf,
      btnTrails,
      btnCheat,
      cheatPanel,
      cheatInput,
      btnCheatAdd,
    };
  }

  function updateUI() {
    if (!ui) return;

    const tokCount = aliveCount();
    const maxTokens = state.perfMode ? CFG.maxTokensPerf : CFG.maxTokensNormal;

    ui.moneyValue.textContent = fmt(state.money);

    const income = state.incomePerSec;

    ui.meta.innerHTML =
      `Income: <b>${fmt(income)}/s</b><br>` +
      `Tokens: <b>${tokCount}/${maxTokens}</b><br>` +
      `Spawner L<b>${state.spawnerLevel}</b> (${state.spawnRate.toFixed(2)}/s)<br>` +
      `Magnet L<b>${state.magnetLevel}</b><br>` +
      `TierChance L<b>${state.tierChanceLevel}</b> (t1 ${(state.tierChance1 * 100).toFixed(0)}%, t2 ${(state.tierChance2 * 100).toFixed(
        0
      )}%)<br>` +
      `Forge x<b>${state.forgeMultiplier.toFixed(2)}</b>`;

    const cS = costSpawner();
    const cM = costMagnet();
    const cT = costTierChance();
    const cC = costCompressor();
    const cF = costForge();

    ui.btnSpawner.textContent = `Upgrade Spawner (£${fmt(cS)})`;
    ui.btnMagnet.textContent = `Upgrade Magnet (£${fmt(cM)})`;
    ui.btnTier.textContent = `Upgrade Tier Chance (£${fmt(cT)})`;
    ui.btnCompressor.textContent = `Compressor L${state.compressorLevel} (£${fmt(cC)})`;
    ui.btnForge.textContent = `Reforge (Prestige) (£${fmt(cF)})`;

    ui.btnPerf.textContent = state.perfMode ? "Performance: On" : "Performance: Off";
    ui.btnTrails.textContent = state.showTrails ? "Trails: On" : "Trails: Off";
    ui.btnCheat.textContent = state.cheatModeEnabled ? "Cheat Mode: On" : "Cheat Mode: Off";
    ui.cheatInput.value = state.cheatAmount;
    ui.cheatPanel.style.display = state.cheatModeEnabled ? "block" : "none";

    ui.btnSpawner.disabled = !canAfford(cS);
    ui.btnMagnet.disabled = !canAfford(cM);
    ui.btnTier.disabled = !canAfford(cT);
    ui.btnCompressor.disabled = !canAfford(cC);
    ui.btnForge.disabled = !canAfford(cF);

    const dim = (b) => (b.style.opacity = b.disabled ? "0.55" : "1");
    dim(ui.btnSpawner);
    dim(ui.btnMagnet);
    dim(ui.btnTier);
    dim(ui.btnCompressor);
    dim(ui.btnForge);

    ui.status.textContent = nowSec() < state.statusUntil ? state.status : "";
  }

  // ----------------- save/load -----------------
  function serialise() {
    // store only alive tokens; keep it compact
    const toks = [];
    toks.length = 0;
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (!t || !t.alive) continue;
      toks.push([t.x, t.y, t.vx, t.vy, t.tier]);
      if (toks.length >= CFG.maxTokensNormal) break;
    }

    return {
      v: 1,
      money: state.money,
      forgeMultiplier: state.forgeMultiplier,
      spawnerLevel: state.spawnerLevel,
      magnetLevel: state.magnetLevel,
      tierChanceLevel: state.tierChanceLevel,
      compressorLevel: state.compressorLevel,
      showTrails: state.showTrails ? 1 : 0,
      perfMode: state.perfMode ? 1 : 0,
      lastKnownIncome: state.lastKnownIncome,
      cheatModeEnabled: state.cheatModeEnabled ? 1 : 0,
      cheatAmount: state.cheatAmount,
      toks,
    };
  }

  function resetRun(quiet) {
    state.money = 0;
    state.forgeMultiplier = 1.0;

    state.spawnerLevel = 0;
    state.magnetLevel = 0;
    state.tierChanceLevel = 0;
    state.compressorLevel = 0;

    state.showTrails = true;
    state.perfMode = false;

    state.tokens.length = 0;
    state.freeIdx.length = 0;
    state.nextId = 1;

    state.rings.length = 0;
    state.sparks.n = 0;
    state.sparks.head = 0;

    applyUpgrades();
    ensureSparkBuffers();
    initEmitters();

    // start alive immediately
    for (let i = 0; i < CFG.initialTokens; i++) {
      const a = rand01() * TAU;
      const r = randRange(0, state.arenaR * 0.55);
      const x = state.cx + Math.cos(a) * r;
      const y = state.cy + Math.sin(a) * r;
      spawnToken(x, y, 0, randSigned() * 40, randSigned() * 40);
    }

    if (!quiet) {
      flash("Reset.");
    }
  }

  function applySave(obj) {
    if (!obj || typeof obj !== "object") return false;

    state.money = typeof obj.money === "number" && isFinite(obj.money) ? Math.max(0, obj.money) : 0;
    state.forgeMultiplier =
      typeof obj.forgeMultiplier === "number" && isFinite(obj.forgeMultiplier) ? clamp(obj.forgeMultiplier, 1, 1e9) : 1.0;

    state.spawnerLevel = typeof obj.spawnerLevel === "number" ? clamp(obj.spawnerLevel | 0, 0, 9999) : 0;
    state.magnetLevel = typeof obj.magnetLevel === "number" ? clamp(obj.magnetLevel | 0, 0, 9999) : 0;
    state.tierChanceLevel = typeof obj.tierChanceLevel === "number" ? clamp(obj.tierChanceLevel | 0, 0, 9999) : 0;
    state.compressorLevel = typeof obj.compressorLevel === "number" ? clamp(obj.compressorLevel | 0, 0, 9999) : 0;

    state.showTrails = !!obj.showTrails;
    state.perfMode = !!obj.perfMode;

    state.cheatModeEnabled = !!obj.cheatModeEnabled;
    state.cheatAmount = typeof obj.cheatAmount === "number" && isFinite(obj.cheatAmount) ? Math.max(0, obj.cheatAmount) : 1000;

    state.lastKnownIncome =
      typeof obj.lastKnownIncome === "number" && isFinite(obj.lastKnownIncome) ? clamp(obj.lastKnownIncome, 0, 1e12) : 0;

    applyUpgrades();
    ensureSparkBuffers();
    initEmitters();

    // rebuild tokens from save
    state.tokens.length = 0;
    state.freeIdx.length = 0;
    state.nextId = 1;

    const toks = Array.isArray(obj.toks) ? obj.toks : [];
    const maxTokens = state.perfMode ? CFG.maxTokensPerf : CFG.maxTokensNormal;

    for (let i = 0; i < toks.length && i < maxTokens; i++) {
      const it = toks[i];
      if (!Array.isArray(it) || it.length < 5) continue;
      const x = +it[0],
        y = +it[1],
        vx = +it[2],
        vy = +it[3],
        tier = it[4] | 0;
      if (!isFinite(x) || !isFinite(y) || !isFinite(vx) || !isFinite(vy)) continue;
      spawnToken(x, y, clamp(tier, 0, CFG.tierCap), clamp(vx, -500, 500), clamp(vy, -500, 500));
    }

    if (aliveCount() === 0) {
      for (let i = 0; i < CFG.initialTokens; i++) {
        const a = rand01() * TAU;
        const r = randRange(0, state.arenaR * 0.55);
        const x = state.cx + Math.cos(a) * r;
        const y = state.cy + Math.sin(a) * r;
        spawnToken(x, y, 0, randSigned() * 40, randSigned() * 40);
      }
    }

    return true;
  }

  function doSave() {
    Engine.save(SAVE_KEY, serialise());
  }

  function doLoadAndOffline() {
    const saved = Engine.load(SAVE_KEY, null);
    const ok = applySave(saved);

    const lastTs = Engine.loadTimestamp(SAVE_KEY);
    const nowMs = Date.now();
    if (ok && lastTs > 0 && nowMs > lastTs) {
      const dt = Math.min((nowMs - lastTs) * 0.001, CFG.offlineCapSec);
      const inc = clamp(state.lastKnownIncome, 0, 1e9);
      const add = inc * dt;
      if (add > 0.01) {
        state.money += add;
        flash(`Offline: +${fmt(add)}`);
      }
    }
    return ok;
  }

  // ----------------- input handlers -----------------
  function onClick(ev, pos) {
    if (!pos) return;
    const x = pos.x;
    const y = pos.y;

    // must be inside arena (or near)
    const dx = x - state.cx;
    const dy = y - state.cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > state.arenaR - 8) {
      flash("Click inside the vat.");
      return;
    }

    const cost = clickSpawnCost();
    if (cost > 0 && !spend(cost)) {
      flash("Not enough money.");
      return;
    }

    const tier = sampleSpawnTier();
    const vx = randSigned() * 70;
    const vy = randSigned() * 70;
    const idx = spawnToken(x, y, tier, vx, vy);
    if (idx === -1) {
      flash("Capacity reached.");
      return;
    }
    const tok = state.tokens[idx];
    addRipple(x, y, tok.r * 0.8, tok.hue);
    emitSparks(x, y, tok.hue, state.perfMode ? 8 : 10, 180);
  }

  function onMouseDown(ev, pos) {
    if (!pos) return;
    state.stir.down = true;
    state.stir.x = pos.x;
    state.stir.y = pos.y;
  }

  function onMouseUp() {
    state.stir.down = false;
  }

  function onMouseMove(ev, pos) {
    if (!pos) return;
    state.stir.x = pos.x;
    state.stir.y = pos.y;
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
      const ok = confirm("Reset run? (Money, upgrades, and forge multiplier reset)");
      if (!ok) return;
      resetRun(false);
      doSave();
      return;
    }
  }

  // ----------------- perf toggle -----------------
  function setPerfMode(on) {
    const newMode = !!on;
    if (state.perfMode === newMode) return;
    state.perfMode = newMode;
    ensureSparkBuffers();

    // shrink trails if needed (alloc once per token, not per frame)
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (!t) continue;
      const tl = trailLen();
      if (!t.tx || t.tx.length !== tl) {
        t.tx = new Float32Array(tl);
        t.ty = new Float32Array(tl);
        // reinit trail if alive
        if (t.alive) initTrail(t);
      }
    }

    // if we're over new cap, compressor will handle; also hard trim worst-case
    const maxTokens = state.perfMode ? CFG.maxTokensPerf : CFG.maxTokensNormal;
    while (aliveCount() > maxTokens) {
      // delete a tier-0 if possible
      let deleted = false;
      for (let i = 0; i < state.tokens.length; i++) {
        const tok = state.tokens[i];
        if (tok && tok.alive && tok.tier === 0) {
          freeToken(i);
          deleted = true;
          break;
        }
      }
      if (!deleted) {
        // delete any alive
        for (let i = 0; i < state.tokens.length; i++) {
          const tok = state.tokens[i];
          if (tok && tok.alive) {
            freeToken(i);
            break;
          }
        }
      }
    }

    flash(state.perfMode ? "Performance mode enabled." : "Performance mode disabled.");
  }

  // ----------------- main loop -----------------
  function update(dt) {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    state.t += dt;
    if (state.t > 1e9) state.t = state.t % 10000;

    // perf monitor + auto perf mode
    const fps = dt > 0 ? 1 / dt : 60;
    state.perf.fpsEMA = lerp(state.perf.fpsEMA, clamp(fps, 5, 240), 0.06);
    if (!state.perfMode) {
      if (state.perf.fpsEMA < CFG.autoPerfFps) state.perf.belowT += dt;
      else state.perf.belowT = Math.max(0, state.perf.belowT - dt * 0.75);

      if (state.perf.belowT > CFG.autoPerfHold) setPerfMode(true);
    }

    // grid rebuild
    gridClear();
    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (!tok || !tok.alive) continue;
      gridInsert(i);
    }

    // spawn
    doAutoSpawn(dt);

    // motion + magnet/stir
    updateTokens(dt);

    // grid rebuild post-motion for merge accuracy
    gridClear();
    for (let i = 0; i < state.tokens.length; i++) {
      const tok = state.tokens[i];
      if (!tok || !tok.alive) continue;
      gridInsert(i);
    }

    // merges
    collectMerges();
    applyMerges();

    // economy
    const inc = computeIncomePerSec();
    earn(inc * dt);

    // compressor (keeps board unclogged)
    runCompressor();

    // effects
    updateEffects(dt);

    // autosave
    const tNow = nowSec();
    if (tNow >= state.autosaveAt) {
      doSave();
      state.autosaveAt = tNow + CFG.autosaveEvery;
    }

    if (ui) updateUI();
  }

  // ----------------- prestige (reforge) -----------------
  function doForge() {
    const cost = costForge();
    if (!canAfford(cost)) {
      flash("Not enough money.");
      return false;
    }

    // multiplier increase based on current money and tiers achieved
    let bestTier = 0;
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t && t.alive && t.tier > bestTier) bestTier = t.tier;
    }

    const gain = 1 + 0.12 * Math.log10(1 + state.money / 2000) + 0.015 * bestTier;
    const newMult = clamp(state.forgeMultiplier * gain, 1, 1e9);

    // reset run but keep multiplier
    resetRun(true);
    state.forgeMultiplier = newMult;

    flash(`Reforged. Multiplier x${newMult.toFixed(2)}`);
    doSave();
    return true;
  }

  // ----------------- UI actions -----------------
  function attachUIHandlers() {
    if (!ui) return;

    ui.btnSpawner.onclick = () => {
      const c = costSpawner();
      if (!spend(c)) return flash("Not enough money.");
      state.spawnerLevel++;
      applyUpgrades();
      flash("Spawner upgraded.");
    };

    ui.btnMagnet.onclick = () => {
      const c = costMagnet();
      if (!spend(c)) return flash("Not enough money.");
      state.magnetLevel++;
      applyUpgrades();
      flash("Magnet upgraded.");
    };

    ui.btnTier.onclick = () => {
      const c = costTierChance();
      if (!spend(c)) return flash("Not enough money.");
      state.tierChanceLevel++;
      applyUpgrades();
      flash("Tier chance upgraded.");
    };

    ui.btnCompressor.onclick = () => {
      const c = costCompressor();
      if (!spend(c)) return flash("Not enough money.");
      state.compressorLevel++;
      applyUpgrades();
      flash("Compressor improved.");
    };

    ui.btnForge.onclick = () => {
      doForge();
    };

    ui.btnPerf.onclick = () => setPerfMode(!state.perfMode);
    ui.btnTrails.onclick = () => {
      state.showTrails = !state.showTrails;
      // reinit trails when enabling, so they don't streak from old zeros
      if (state.showTrails) {
        for (let i = 0; i < state.tokens.length; i++) {
          const t = state.tokens[i];
          if (t && t.alive) initTrail(t);
        }
      }
      flash(state.showTrails ? "Trails enabled." : "Trails disabled.");
    };

    ui.btnCheat.onclick = () => {
      state.cheatModeEnabled = !state.cheatModeEnabled;
      ui.btnCheat.textContent = state.cheatModeEnabled ? "Cheat Mode: On" : "Cheat Mode: Off";
      ui.cheatPanel.style.display = state.cheatModeEnabled ? "block" : "none";
      flash(state.cheatModeEnabled ? "Cheat mode enabled." : "Cheat mode disabled.");
    };

    ui.btnCheatAdd.onclick = () => {
      const amount = parseFloat(ui.cheatInput.value);
      if (!isFinite(amount) || amount < 0) {
        flash("Invalid cheat amount.");
        return;
      }
      state.cheatAmount = Math.max(0, amount);
      earn(state.cheatAmount);
      flash(`Added £${fmt(state.cheatAmount)}`);
    };

    ui.cheatInput.oninput = () => {
      const amount = parseFloat(ui.cheatInput.value);
      if (isFinite(amount) && amount >= 0) {
        state.cheatAmount = amount;
      } else {
        ui.cheatInput.value = state.cheatAmount;
      }
    };
  }

  // ----------------- boot -----------------
  applyUpgrades();
  ensureGeometry();
  initEmitters();
  resetRun(true);
  doLoadAndOffline();

  ui = buildUI();
  attachUIHandlers();
  if (ui) updateUI();

  state.autosaveAt = nowSec() + CFG.autosaveEvery;

  Engine.on("onResize", () => {
    ensureGeometry();
  });

  Engine.on("onClick", onClick);
  Engine.on("onMouseDown", onMouseDown);
  Engine.on("onMouseUp", onMouseUp);
  Engine.on("onMouseMove", onMouseMove);
  Engine.on("onKeyDown", onKeyDown);

  Engine.on("update", (dt) => update(dt));
  Engine.on("render", () => render());

  window.addEventListener("beforeunload", () => {
    try {
      doSave();
    } catch (_) {}
  });
}
