// src/games/firefly-shepherd.js
import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const gameId = (ctx && ctx.gameId) || "firefly-shepherd";
  const uiRoot = ctx && ctx.uiRoot ? ctx.uiRoot : null;

  // -----------------------------
  // Tuning (normal vs performance)
  // -----------------------------
  const NORMAL = {
    name: "Normal",
    maxFireflies: 1200,
    trailLen: 6,
    cellSize: 30,
    sepRadius: 22,
    sepStrength: 220, // accel (px/s^2) at full overlap
    neighbourCap: 28,
    alignRadius: 55,
    alignStrength: 35,
    cohesionStrength: 22,
    starCount: 120,
  };

  const PERF = {
    name: "Performance",
    maxFireflies: 700,
    trailLen: 4,
    cellSize: 32,
    sepRadius: 20,
    sepStrength: 190,
    neighbourCap: 18,
    alignRadius: 50,
    alignStrength: 26,
    cohesionStrength: 16,
    starCount: 70,
  };

  let mode = { ...NORMAL };

  // Auto switch to performance if FPS stays low for a bit (optional but useful).
  let lowFpsTimer = 0;
  let highFpsTimer = 0;

  // -----------------------------
  // State
  // -----------------------------
  const flies = []; // Array of Firefly objects
  let score = 0;
  let cohesion01 = 0; // 0..1
  let paused = false;

  // Fixed pseudo-random star field (cheap background)
  let stars = [];
  let lastSizeKey = "";

  // FPS tracking (updated ~2x/sec)
  let fps = 0;
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fpsTimer = 0;

  // UI
  let uiVisible = true;
  let uiEls = null;

  // -----------------------------
  // Helpers
  // -----------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const hypot = Math.hypot || ((x, y) => Math.sqrt(x * x + y * y));

  function rand01() {
    // Fast deterministic-ish LCG per call (not seeded; good enough)
    rand01._s = (rand01._s * 1664525 + 1013904223) >>> 0;
    return (rand01._s & 0xffffff) / 0x1000000;
  }
  rand01._s = (Date.now() ^ 0x9e3779b9) >>> 0;

  function makeFirefly(x, y) {
    const hue = 200 + rand01() * 90; // cyan->purple-ish
    const a = rand01() * Math.PI * 2;
    const sp = 20 + rand01() * 60;
    const trail = new Float32Array(mode.trailLen * 2);
    // Initialise trail at spawn point
    for (let i = 0; i < mode.trailLen; i++) {
      trail[i * 2] = x;
      trail[i * 2 + 1] = y;
    }
    return {
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      hue,
      // Smooth wander
      noiseA: rand01() * Math.PI * 2,
      noiseW: 0.7 + rand01() * 1.2, // how quickly noise angle evolves
      // Trail ring buffer
      trail,
      trailHead: 0, // points to most recent entry index (0..trailLen-1)
      trailCount: mode.trailLen,
    };
  }

  function resizeStarsIfNeeded() {
    const { w, h } = Engine.getSize();
    const key = `${w}|${h}|${mode.starCount}`;
    if (key === lastSizeKey) return;
    lastSizeKey = key;

    stars = new Array(mode.starCount);
    for (let i = 0; i < mode.starCount; i++) {
      const sx = rand01() * w;
      const sy = rand01() * h;
      const s = 0.6 + rand01() * 1.4;
      const a = 0.06 + rand01() * 0.10;
      stars[i] = { x: sx, y: sy, s, a };
    }
  }

  function ensureModeTrails() {
    // If mode changes, we need to adapt each firefly's trail buffer length.
    // Keep the most recent history; avoid heavy reallocs by doing it once per switch.
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      const oldLen = f.trail.length / 2;
      const newLen = mode.trailLen;
      if (oldLen === newLen) continue;

      const newTrail = new Float32Array(newLen * 2);
      const take = Math.min(newLen, f.trailCount, oldLen);

      // Copy most recent `take` points into new buffer.
      // The head points to most recent index in old buffer.
      for (let k = 0; k < take; k++) {
        const oldIdx = (f.trailHead - k + oldLen) % oldLen;
        const nx = f.trail[oldIdx * 2];
        const ny = f.trail[oldIdx * 2 + 1];
        // Place into new buffer so that head ends up at index 0 (recent), and we render backwards.
        newTrail[k * 2] = nx;
        newTrail[k * 2 + 1] = ny;
      }

      // Fill remaining with current position (prevents stray long lines)
      for (let k = take; k < newLen; k++) {
        newTrail[k * 2] = f.x;
        newTrail[k * 2 + 1] = f.y;
      }

      f.trail = newTrail;
      f.trailHead = 0;
      f.trailCount = newLen;
    }
  }

  function setMode(next) {
    mode = { ...next };
    ensureModeTrails();
    lastSizeKey = ""; // force regen stars
  }

  function spawnFireflies(n, x, y, spread = 18) {
    const { w, h } = Engine.getSize();
    const cx = x == null ? w * 0.5 : x;
    const cy = y == null ? h * 0.5 : y;

    const maxAdd = Math.max(0, mode.maxFireflies - flies.length);
    n = Math.min(n, maxAdd);
    if (n <= 0) return;

    for (let i = 0; i < n; i++) {
      const r = spread * Math.sqrt(rand01());
      const a = rand01() * Math.PI * 2;
      const fx = clamp(cx + Math.cos(a) * r, 6, w - 6);
      const fy = clamp(cy + Math.sin(a) * r, 6, h - 6);
      flies.push(makeFirefly(fx, fy));
    }
  }

  function clearTrails() {
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      const len = f.trail.length / 2;
      for (let k = 0; k < len; k++) {
        f.trail[k * 2] = f.x;
        f.trail[k * 2 + 1] = f.y;
      }
      f.trailHead = 0;
      f.trailCount = len;
    }
  }

  function reset() {
    flies.length = 0;
    score = 0;
    cohesion01 = 0;
    spawnInitial();
    clearTrails();
    updateUiNow();
  }

  function spawnInitial() {
    const { w, h } = Engine.getSize();
    const n = Math.min(250, mode.maxFireflies);
    spawnFireflies(n, w * 0.5, h * 0.55, Math.min(w, h) * 0.12);
  }

  // -----------------------------
  // Spatial hash (uniform grid)
  // -----------------------------
  // Map cellKey -> array of indices into flies
  const grid = new Map();
  const gridKeys = [];

  function gridKey(cx, cy) {
    // Screen cell counts are small; fit into 16-bit comfortably.
    // Pack signed cells via offset to avoid negative issues (still safe).
    const ox = cx + 2048;
    const oy = cy + 2048;
    return ((ox & 0xffff) << 16) | (oy & 0xffff);
  }

  function gridReset() {
    // Reuse arrays; clear them without realloc
    for (let i = 0; i < gridKeys.length; i++) {
      const k = gridKeys[i];
      const arr = grid.get(k);
      if (arr) arr.length = 0;
    }
    gridKeys.length = 0;
  }

  function gridInsert(i, x, y) {
    const cs = mode.cellSize;
    const cx = (x / cs) | 0;
    const cy = (y / cs) | 0;
    const k = gridKey(cx, cy);
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    if (arr.length === 0) gridKeys.push(k);
    arr.push(i);
  }

  function gridForEachNeighbour(x, y, radius, fn) {
    const cs = mode.cellSize;
    const cx = (x / cs) | 0;
    const cy = (y / cs) | 0;
    const rCells = ((radius / cs) | 0) + 1;

    for (let oy = -rCells; oy <= rCells; oy++) {
      for (let ox = -rCells; ox <= rCells; ox++) {
        const k = gridKey(cx + ox, cy + oy);
        const arr = grid.get(k);
        if (!arr || arr.length === 0) continue;
        fn(arr);
      }
    }
  }

  // -----------------------------
  // UI
  // -----------------------------
  function buildUI(root) {
    root.innerHTML = "";
    root.style.pointerEvents = "auto";

    const wrap = document.createElement("div");
    wrap.style.position = "absolute";
    wrap.style.top = "12px";
    wrap.style.left = "12px";
    wrap.style.maxWidth = "340px";
    wrap.style.padding = "10px 10px 8px";
    wrap.style.border = "1px solid rgba(120, 80, 255, 0.35)";
    wrap.style.background = "rgba(0,0,0,0.55)";
    wrap.style.backdropFilter = "blur(3px)";
    wrap.style.borderRadius = "10px";
    wrap.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    wrap.style.color = "rgba(230, 235, 255, 0.92)";
    wrap.style.userSelect = "none";

    const title = document.createElement("div");
    title.textContent = "Firefly Shepherd";
    title.style.fontWeight = "700";
    title.style.letterSpacing = "0.2px";
    title.style.marginBottom = "8px";
    title.style.fontSize = "14px";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexWrap = "wrap";
    row.style.gap = "6px";
    row.style.marginBottom = "8px";

    const btn = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.padding = "6px 8px";
      b.style.borderRadius = "8px";
      b.style.border = "1px solid rgba(80, 200, 255, 0.25)";
      b.style.background = "rgba(20, 20, 30, 0.65)";
      b.style.color = "rgba(230, 235, 255, 0.92)";
      b.style.cursor = "pointer";
      b.style.fontSize = "12px";
      b.onmouseenter = () => (b.style.borderColor = "rgba(180, 90, 255, 0.55)");
      b.onmouseleave = () => (b.style.borderColor = "rgba(80, 200, 255, 0.25)");
      b.onclick = (e) => {
        e.preventDefault();
        onClick();
      };
      return b;
    };

    const pauseBtn = btn("Pause", () => {
      Engine.togglePause();
      paused = Engine.isPaused();
      updateUiNow();
    });

    const resetBtn = btn("Reset", () => reset());

    const spawnBtn = btn("Spawn +50", () => {
      const { w, h } = Engine.getSize();
      spawnFireflies(50, w * 0.5, h * 0.55, Math.min(w, h) * 0.10);
      updateUiNow();
    });

    const trailsBtn = btn("Clear Trails", () => {
      clearTrails();
    });

    const back = document.createElement("a");
    back.textContent = "Back";
    back.href = "/";
    back.style.display = "inline-flex";
    back.style.alignItems = "center";
    back.style.justifyContent = "center";
    back.style.padding = "6px 8px";
    back.style.borderRadius = "8px";
    back.style.border = "1px solid rgba(255, 120, 220, 0.25)";
    back.style.background = "rgba(20, 20, 30, 0.65)";
    back.style.color = "rgba(230, 235, 255, 0.92)";
    back.style.textDecoration = "none";
    back.style.fontSize = "12px";
    back.onmouseenter = () => (back.style.borderColor = "rgba(255, 120, 220, 0.55)");
    back.onmouseleave = () => (back.style.borderColor = "rgba(255, 120, 220, 0.25)");

    row.appendChild(pauseBtn);
    row.appendChild(resetBtn);
    row.appendChild(spawnBtn);
    row.appendChild(trailsBtn);
    row.appendChild(back);

    const stats = document.createElement("div");
    stats.style.fontSize = "12px";
    stats.style.opacity = "0.92";
    stats.style.lineHeight = "1.35";
    stats.style.whiteSpace = "pre";

    const hint = document.createElement("div");
    hint.style.marginTop = "8px";
    hint.style.fontSize = "11px";
    hint.style.opacity = "0.75";
    hint.textContent = "Click: +10  •  Hold mouse: attract  •  Space: pause  •  R: reset  •  M: toggle UI";

    wrap.appendChild(title);
    wrap.appendChild(row);
    wrap.appendChild(stats);
    wrap.appendChild(hint);
    root.appendChild(wrap);

    return { wrap, pauseBtn, stats };
  }

  function updateUiNow() {
    if (!uiEls) return;
    uiEls.pauseBtn.textContent = Engine.isPaused() ? "Play" : "Pause";

    const cohPct = Math.round(cohesion01 * 100);
    uiEls.stats.textContent =
      `Fireflies: ${flies.length}/${mode.maxFireflies}\n` +
      `Score: ${score.toFixed(1)}\n` +
      `Cohesion: ${cohPct}%\n` +
      `FPS: ${Math.round(fps)}\n` +
      `Mode: ${mode.name}`;
  }

  function setUiVisible(v) {
    uiVisible = !!v;
    if (!uiRoot) return;
    uiRoot.style.display = uiVisible ? "" : "none";
  }

  // -----------------------------
  // Input bindings
  // -----------------------------
  Engine.on("onClick", (_ev, pos) => {
    spawnFireflies(10, pos.x, pos.y, 10);
    if (uiRoot) updateUiNow();
  });

  Engine.on("onKeyDown", (ev) => {
    const k = ev.key;
    if (k === " " || k === "Spacebar") {
      ev.preventDefault();
      Engine.togglePause();
      paused = Engine.isPaused();
      updateUiNow();
      return;
    }
    if (k === "r" || k === "R") {
      reset();
      return;
    }
    if (k === "m" || k === "M") {
      setUiVisible(!uiVisible);
      return;
    }
  });

  // -----------------------------
  // Main update
  // -----------------------------
  function computeCohesionAndScore(dt) {
    const n = flies.length;
    if (n <= 0) {
      cohesion01 = 0;
      return;
    }
    let sx = 0,
      sy = 0;
    for (let i = 0; i < n; i++) {
      sx += flies[i].x;
      sy += flies[i].y;
    }
    const cx = sx / n;
    const cy = sy / n;

    let sumD = 0;
    for (let i = 0; i < n; i++) {
      const dx = flies[i].x - cx;
      const dy = flies[i].y - cy;
      sumD += Math.sqrt(dx * dx + dy * dy);
    }
    const avgDist = sumD / n;

    const { w, h } = Engine.getSize();
    const threshold = Math.min(w, h) * 0.18;
    cohesion01 = clamp(1 - avgDist / Math.max(1, threshold), 0, 1);

    // Score ramps when you keep the swarm cohesive.
    if (cohesion01 > 0.55) {
      const gain = 10 * cohesion01; // points per second
      score += dt * gain;
    } else if (cohesion01 > 0.35) {
      score += dt * (1.2 * cohesion01);
    }
  }

  Engine.on("update", (dt) => {
    if (Engine.isPaused()) return;

    const { w, h } = Engine.getSize();
    const mouse = Engine.mouse();

    // Prepare spatial hash
    gridReset();
    for (let i = 0; i < flies.length; i++) {
      gridInsert(i, flies[i].x, flies[i].y);
    }

    // Mouse attraction field
    const fieldOn = !!mouse.down;
    const fieldX = mouse.x;
    const fieldY = mouse.y;
    const fieldR = 220;
    const fieldR2 = fieldR * fieldR;

    // Motion constants
    const maxSpeed = 240; // px/s
    const maxSpeed2 = maxSpeed * maxSpeed;
    const damping = 0.990; // per tick (dt ~1/60)

    const sepR = mode.sepRadius;
    const sepR2 = sepR * sepR;

    const alignR = mode.alignRadius;
    const alignR2 = alignR * alignR;

    // Update each firefly
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];

      // Wander: smooth random-ish turning
      // Update noise angle slowly; steer in that direction.
      f.noiseA += (rand01() * 2 - 1) * f.noiseW * dt;
      const wx = Math.cos(f.noiseA);
      const wy = Math.sin(f.noiseA);

      let ax = wx * 26;
      let ay = wy * 26;

      // Attraction to mouse field (when held)
      if (fieldOn) {
        const dx = fieldX - f.x;
        const dy = fieldY - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < fieldR2) {
          const d = Math.sqrt(d2) + 0.0001;
          // Stronger when closer; clamp.
          const t = 1 - d / fieldR; // 0..1
          const strength = 420 * (t * t);
          ax += (dx / d) * strength;
          ay += (dy / d) * strength;
        }
      }

      // Separation + subtle alignment/cohesion from local neighbours
      let sx = 0,
        sy = 0;
      let avx = 0,
        avy = 0;
      let cx = 0,
        cy = 0;
      let nAlign = 0;
      let nCoh = 0;
      let checks = 0;

      gridForEachNeighbour(f.x, f.y, alignR, (bucket) => {
        for (let bi = 0; bi < bucket.length; bi++) {
          const j = bucket[bi];
          if (j === i) continue;

          const o = flies[j];
          const dx = f.x - o.x;
          const dy = f.y - o.y;
          const d2 = dx * dx + dy * dy;

          // Separation (close)
          if (d2 > 0.0001 && d2 < sepR2) {
            const d = Math.sqrt(d2);
            const overlap = 1 - d / sepR; // 0..1
            // Push away; scale by overlap; soft clamp
            const push = mode.sepStrength * overlap;
            sx += (dx / d) * push;
            sy += (dy / d) * push;
          }

          // Alignment/cohesion (subtle, local)
          if (d2 > 0.0001 && d2 < alignR2) {
            avx += o.vx;
            avy += o.vy;
            nAlign++;

            cx += o.x;
            cy += o.y;
            nCoh++;
          }

          checks++;
          if (checks >= mode.neighbourCap) return;
        }
      });

      ax += sx;
      ay += sy;

      if (nAlign > 0) {
        const inv = 1 / nAlign;
        const tvx = avx * inv;
        const tvy = avy * inv;
        // Nudge velocity towards local avg (alignment)
        ax += (tvx - f.vx) * mode.alignStrength;
        ay += (tvy - f.vy) * mode.alignStrength;
      }

      if (nCoh > 0) {
        const inv = 1 / nCoh;
        const tx = cx * inv;
        const ty = cy * inv;
        const dx = tx - f.x;
        const dy = ty - f.y;
        // Mild pull to local centre (cohesion)
        ax += dx * mode.cohesionStrength * 0.02;
        ay += dy * mode.cohesionStrength * 0.02;
      }

      // Integrate
      f.vx += ax * dt;
      f.vy += ay * dt;

      // Damping (stable, keeps it "firefly" not "particles")
      f.vx *= damping;
      f.vy *= damping;

      // Speed cap
      const v2 = f.vx * f.vx + f.vy * f.vy;
      if (v2 > maxSpeed2) {
        const s = maxSpeed / Math.sqrt(v2);
        f.vx *= s;
        f.vy *= s;
      }

      // Move
      f.x += f.vx * dt;
      f.y += f.vy * dt;

      // Bounds: soft bounce with some energy loss
      const pad = 6;
      if (f.x < pad) {
        f.x = pad;
        f.vx = Math.abs(f.vx) * 0.9;
      } else if (f.x > w - pad) {
        f.x = w - pad;
        f.vx = -Math.abs(f.vx) * 0.9;
      }
      if (f.y < pad) {
        f.y = pad;
        f.vy = Math.abs(f.vy) * 0.9;
      } else if (f.y > h - pad) {
        f.y = h - pad;
        f.vy = -Math.abs(f.vy) * 0.9;
      }

      // Trail update: write current position into ring buffer
      const len = f.trail.length / 2;
      const head = (f.trailHead + 1) % len;
      f.trailHead = head;
      f.trail[head * 2] = f.x;
      f.trail[head * 2 + 1] = f.y;
      if (f.trailCount < len) f.trailCount++;
    }

    // Cohesion + score
    computeCohesionAndScore(dt);

    // Update UI stats at low frequency
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fpsTimer = 0;
      updateUiNow();
    }
  });

  // -----------------------------
  // Render
  // -----------------------------
  Engine.on("render", (realDt) => {
    // FPS smoothing
    fpsAcc += realDt;
    fpsFrames++;
    if (fpsAcc >= 0.5) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;

      // Optional auto-switch logic
      if (mode.name !== PERF.name) {
        if (fps < 45) lowFpsTimer += 0.5;
        else lowFpsTimer = Math.max(0, lowFpsTimer - 0.5);

        if (lowFpsTimer >= 3.0) {
          setMode(PERF);
          lowFpsTimer = 0;
          highFpsTimer = 0;
          updateUiNow();
        }
      } else {
        if (fps > 57) highFpsTimer += 0.5;
        else highFpsTimer = Math.max(0, highFpsTimer - 0.5);

        // Only switch back if consistently high FPS and we're not too many entities.
        if (highFpsTimer >= 4.0 && flies.length <= NORMAL.maxFireflies * 0.8) {
          setMode(NORMAL);
          highFpsTimer = 0;
          lowFpsTimer = 0;
          updateUiNow();
        }
      }
    }

    // Clear (HARD RULE)
    Engine.gfx.clearBlack();

    resizeStarsIfNeeded();

    // Background stars (cheap and subtle)
    const c2d = Engine.getCtx();
    c2d.save();
    c2d.globalCompositeOperation = "source-over";
    c2d.fillStyle = "rgba(180, 210, 255, 0.08)";
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      c2d.globalAlpha = s.a;
      c2d.fillRect(s.x, s.y, s.s, s.s);
    }
    c2d.restore();

    // Trails first
    // Draw as small segments with decreasing alpha (explicit history, no smearing).
    const trailColourCache = new Array(12); // small cache to avoid string churn
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      const len = f.trail.length / 2;
      const count = f.trailCount;

      // Colour string (cache by coarse hue bucket)
      const bucket = ((f.hue - 200) / 8) | 0;
      let col = trailColourCache[bucket];
      if (!col) {
        col = `hsl(${f.hue.toFixed(0)} 100% 65%)`;
        trailColourCache[bucket] = col;
      }

      // Draw from oldest to newest so it "points" nicely
      // Oldest is head - (count-1)
      let prevX = 0,
        prevY = 0;
      for (let k = count - 1; k >= 0; k--) {
        const idx = (f.trailHead - k + len) % len;
        const x = f.trail[idx * 2];
        const y = f.trail[idx * 2 + 1];
        if (k === count - 1) {
          prevX = x;
          prevY = y;
          continue;
        }
        const t = 1 - k / Math.max(1, count - 1); // 0..1 (newer -> higher)
        const a = 0.05 + t * 0.22;
        Engine.gfx.line(prevX, prevY, x, y, col, 1.0, a);
        prevX = x;
        prevY = y;
      }
    }

    // Fireflies
    for (let i = 0; i < flies.length; i++) {
      const f = flies[i];
      const col = `hsl(${f.hue.toFixed(0)} 100% 65%)`;
      Engine.gfx.glowCircle(f.x, f.y, 2.1, col, 10, 0.95);
      // Tiny core
      Engine.gfx.glowCircle(f.x, f.y, 0.9, "rgba(255,255,255,0.85)", 4, 0.7);
    }

    // Mouse field indicator
    const m = Engine.mouse();
    if (m.down) {
      const ringCol = "rgba(80, 220, 255, 0.75)";
      // Inner glow + ring
      Engine.gfx.glowCircle(m.x, m.y, 6, "rgba(160,80,255,0.65)", 18, 0.35);
      // Approx ring via multiple thin circles (keep cheap)
      const ctx2 = Engine.getCtx();
      ctx2.save();
      ctx2.globalCompositeOperation = "lighter";
      ctx2.strokeStyle = ringCol;
      ctx2.lineWidth = 1;
      ctx2.globalAlpha = 0.35;
      ctx2.beginPath();
      ctx2.arc(m.x, m.y, 220, 0, Math.PI * 2);
      ctx2.stroke();
      ctx2.globalAlpha = 0.12;
      ctx2.beginPath();
      ctx2.arc(m.x, m.y, 160, 0, Math.PI * 2);
      ctx2.stroke();
      ctx2.restore();
    }

    // Minimal HUD text if no UI root
    if (!uiRoot) {
      const { w, h } = Engine.getSize();
      const cohPct = Math.round(cohesion01 * 100);
      const text =
        `Firefly Shepherd  |  ` +
        `Fireflies: ${flies.length}/${mode.maxFireflies}  ` +
        `Score: ${score.toFixed(1)}  ` +
        `Cohesion: ${cohPct}%  ` +
        `FPS: ${Math.round(fps)}  ` +
        `(${mode.name})`;

      const ctx2 = Engine.getCtx();
      ctx2.save();
      ctx2.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
      ctx2.textBaseline = "alphabetic";
      ctx2.fillStyle = "rgba(230,235,255,0.80)";
      ctx2.fillText(text, 12, h - 12);
      ctx2.fillStyle = "rgba(230,235,255,0.45)";
      ctx2.fillText("Click: +10  •  Hold mouse: attract  •  Space: pause  •  R: reset", 12, h - 28);
      ctx2.restore();
    }
  });

  // -----------------------------
  // Resize behaviour
  // -----------------------------
  Engine.on("onResize", () => {
    lastSizeKey = "";
  });

  // -----------------------------
  // Boot
  // -----------------------------
  if (uiRoot) {
    uiEls = buildUI(uiRoot);
    setUiVisible(true);
  }

  spawnInitial();
  updateUiNow();
}

