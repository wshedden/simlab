import { Engine } from "../engine/engine.js";

export function startGame(ctx) {
  Engine.init({ canvasId: (ctx && ctx.canvasId) || "c" });

  const SAVE_KEY = "simlab.signalChain.v1";
  const TAU = Math.PI * 2;

  const uiRoot =
    ctx && ctx.uiRoot && typeof ctx.uiRoot === "object" && ctx.uiRoot.appendChild
      ? ctx.uiRoot
      : null;

  // ----------------------- helpers -----------------------
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmt = (n) => {
    if (!isFinite(n)) return "0";
    const abs = Math.abs(n);
    if (abs < 1000) return n.toFixed(0);
    if (abs < 1e6) return (n / 1e3).toFixed(2) + "k";
    if (abs < 1e9) return (n / 1e6).toFixed(2) + "m";
    if (abs < 1e12) return (n / 1e9).toFixed(2) + "b";
    return (n / 1e12).toFixed(2) + "t";
  };
  const nowSec = () => performance.now() * 0.001;

  function safeTanh(x) {
    // mild nonlinearity, stable for large x
    if (x > 8) return 0.9999998;
    if (x < -8) return -0.9999998;
    const e2x = Math.exp(2 * x);
    return (e2x - 1) / (e2x + 1);
  }

  function softClip(x, strength) {
    // strength ~ 0.6..2.2, higher = harder limiting
    return safeTanh(x * strength) / strength;
  }

  // fast RNG (LCG) for stable per-frame noise without allocations
  let rng = 0x1234567 ^ ((Date.now() >>> 0) & 0xffffffff);
  function rand01() {
    rng = (1664525 * rng + 1013904223) >>> 0;
    return rng / 4294967296;
  }
  function randSigned() {
    return rand01() * 2 - 1;
  }

  // ----------------------- state -----------------------
  const state = {
    paused: false,
    t: 0,

    credits: 0,
    totalEarned: 0,

    stageCount: 3,
    baseGain: 1.05,

    gainLevel: 0,
    stageLevel: 0,
    stabiliserLevel: 0,
    limiterLevel: 0,

    noiseLevel: 0.055,
    limiterStrength: 1.0,

    prestigeMultiplier: 1.0,
    lastKnownCPS: 0,

    // impulse injection (click fun)
    impulse: 0,
    impulseDecay: 0.9,

    // sampling / perf
    sampleCount: 600,
    samples: new Float32Array(600),
    yScale: 1,
    xStep: 1,

    // RMS and earnings
    rms: 0,
    power: 0,
    cps: 0,
    earnScale: 0.28, // tuned for quick ramp

    // dynamic perf mode
    perf: {
      fpsEMA: 60,
      acc: 0,
      frames: 0,
      lastT: nowSec(),
    },

    // stage marker pulse
    stagePulse: 0,

    // status line
    status: "",
    statusUntil: 0,

    // autosave
    autosaveAt: 0,
  };

  // ----------------------- UI -----------------------
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

  function buildUI() {
    if (!uiRoot) return null;
    uiRoot.innerHTML = "";

    const panel = document.createElement("div");
    panel.style.position = "absolute";
    panel.style.left = "12px";
    panel.style.top = "12px";
    panel.style.width = "280px";
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
    title.textContent = "Signal Amplifier Chain";
    title.style.fontWeight = "800";
    title.style.fontSize = "16px";
    title.style.letterSpacing = "0.2px";
    title.style.marginBottom = "8px";
    panel.appendChild(title);

    const creditsLine = document.createElement("div");
    creditsLine.style.display = "flex";
    creditsLine.style.justifyContent = "space-between";
    creditsLine.style.alignItems = "baseline";
    creditsLine.style.marginBottom = "10px";

    const creditsLabel = document.createElement("div");
    creditsLabel.textContent = "Credits";
    creditsLabel.style.opacity = "0.9";
    creditsLabel.style.fontWeight = "700";

    const creditsValue = document.createElement("div");
    creditsValue.textContent = "0";
    creditsValue.style.fontWeight = "900";
    creditsValue.style.fontSize = "18px";
    creditsValue.style.color = "#3dfcff";

    creditsLine.appendChild(creditsLabel);
    creditsLine.appendChild(creditsValue);
    panel.appendChild(creditsLine);

    const meta = document.createElement("div");
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.95";
    meta.style.lineHeight = "1.35";
    meta.style.marginBottom = "8px";
    panel.appendChild(meta);

    const btnGain = makeButton("Upgrade Gain");
    const btnStage = makeButton("Add Stage");
    const btnStab = makeButton("Stabiliser");
    const btnLim = makeButton("Limiter Tuning");
    const btnPrestige = makeButton("Recalibrate (Prestige)");

    const muteToggle = makeToggle("Mute");
    muteToggle.row.style.marginTop = "8px";

    const help = document.createElement("div");
    help.textContent = "Click canvas: inject impulse • Space: pause • R: reset";
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

    panel.appendChild(btnGain);
    panel.appendChild(btnStage);
    panel.appendChild(btnStab);
    panel.appendChild(btnLim);
    panel.appendChild(btnPrestige);
    panel.appendChild(muteToggle.row);
    panel.appendChild(help);
    panel.appendChild(status);
    panel.appendChild(back);

    uiRoot.appendChild(panel);

    return {
      panel,
      creditsValue,
      meta,
      status,
      btnGain,
      btnStage,
      btnStab,
      btnLim,
      btnPrestige,
      muteBtn: muteToggle.button,
    };
  }

  // ----------------------- audio (optional) -----------------------
  const audio = {
    enabled: false,
    muted: true,
    ctx: null,
    osc: null,
    gain: null,
    filter: null,
    // smoothing
    freq: 110,
    vol: 0,
  };

  function ensureAudio() {
    if (audio.enabled) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ac = new AC();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const filter = ac.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 800;

      osc.type = "sine";
      osc.frequency.value = 110;

      gain.gain.value = 0;

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ac.destination);

      osc.start();

      audio.ctx = ac;
      audio.osc = osc;
      audio.gain = gain;
      audio.filter = filter;
      audio.enabled = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function setMuted(m) {
    audio.muted = !!m;
    if (ui) ui.muteBtn.textContent = audio.muted ? "Off" : "On";
    if (audio.gain) audio.gain.gain.value = 0;
  }

  // ----------------------- economy / upgrades -----------------------
  function gainCost() {
    return Math.floor(15 * Math.pow(1.35, state.gainLevel));
  }
  function stageCost() {
    return Math.floor(80 * Math.pow(1.65, state.stageLevel));
  }
  function stabiliserCost() {
    return Math.floor(45 * Math.pow(1.5, state.stabiliserLevel));
  }
  function limiterCost() {
    return Math.floor(55 * Math.pow(1.55, state.limiterLevel));
  }
  function prestigeThreshold() {
    // Not grindy: grows gently with multiplier
    return 1500 * Math.pow(2.0, Math.max(0, Math.log2(state.prestigeMultiplier)));
  }

  function canAfford(c) {
    return state.credits >= c - 1e-9;
  }

  function spend(c) {
    if (!canAfford(c)) return false;
    state.credits -= c;
    return true;
  }

  function flash(msg) {
    state.status = msg || "";
    state.statusUntil = nowSec() + 1.1;
  }

  function applyUpgrades() {
    // baseGain: small but exponential across stages
    state.baseGain = 1.05 + state.gainLevel * 0.012;
    // stabiliser reduces noise; also small earnings bump via clarity
    state.noiseLevel = clamp(0.055 * Math.pow(0.86, state.stabiliserLevel), 0.002, 0.08);
    // limiter tuning: nudges strength around 1.0..2.1
    state.limiterStrength = clamp(1.0 + state.limiterLevel * 0.12, 0.7, 2.3);
    state.stageCount = clamp(3 + state.stageLevel, 1, 60); // keep reasonable
  }

  function doPrestige() {
    const thresh = prestigeThreshold();
    if (state.credits < thresh) {
      flash(`Need £${fmt(thresh)} to recalibrate.`);
      return false;
    }

    // Simple formula: based on totalEarned and current credits
    const score = Math.max(0, state.totalEarned + state.credits);
    const gain = 1 + 0.12 * Math.log10(1 + score / 2000);
    const newMult = clamp(state.prestigeMultiplier * gain, 1, 1e6);

    state.credits = 0;
    state.totalEarned = 0;

    state.gainLevel = 0;
    state.stageLevel = 0;
    state.stabiliserLevel = 0;
    state.limiterLevel = 0;

    state.prestigeMultiplier = newMult;

    state.impulse = 0;
    state.stagePulse = 1;

    applyUpgrades();
    flash(`Recalibrated. Multiplier x${newMult.toFixed(2)}`);
    return true;
  }

  // ----------------------- save/load + offline -----------------------
  function serialise() {
    return {
      v: 1,
      credits: state.credits,
      totalEarned: state.totalEarned,
      gainLevel: state.gainLevel,
      stageLevel: state.stageLevel,
      stabiliserLevel: state.stabiliserLevel,
      limiterLevel: state.limiterLevel,
      prestigeMultiplier: state.prestigeMultiplier,
      lastKnownCPS: state.lastKnownCPS,
    };
  }

  function applySave(obj) {
    if (!obj || typeof obj !== "object") return false;

    state.credits = typeof obj.credits === "number" && isFinite(obj.credits) ? Math.max(0, obj.credits) : 0;
    state.totalEarned =
      typeof obj.totalEarned === "number" && isFinite(obj.totalEarned) ? Math.max(0, obj.totalEarned) : 0;

    state.gainLevel = typeof obj.gainLevel === "number" ? clamp(Math.floor(obj.gainLevel), 0, 9999) : 0;
    state.stageLevel = typeof obj.stageLevel === "number" ? clamp(Math.floor(obj.stageLevel), 0, 9999) : 0;
    state.stabiliserLevel =
      typeof obj.stabiliserLevel === "number" ? clamp(Math.floor(obj.stabiliserLevel), 0, 9999) : 0;
    state.limiterLevel = typeof obj.limiterLevel === "number" ? clamp(Math.floor(obj.limiterLevel), 0, 9999) : 0;

    state.prestigeMultiplier =
      typeof obj.prestigeMultiplier === "number" && isFinite(obj.prestigeMultiplier)
        ? clamp(obj.prestigeMultiplier, 1, 1e9)
        : 1.0;

    state.lastKnownCPS =
      typeof obj.lastKnownCPS === "number" && isFinite(obj.lastKnownCPS) ? clamp(obj.lastKnownCPS, 0, 1e12) : 0;

    applyUpgrades();
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
      const capSec = 2 * 3600;
      const dtSec = Math.min((nowMs - lastTs) * 0.001, capSec);
      const cps = clamp(state.lastKnownCPS || 0, 0, 1e9);
      const add = cps * dtSec;
      if (add > 0.01) {
        state.credits += add;
        state.totalEarned += add;
        flash(`Offline: +${fmt(add)} credits`);
      }
    } else {
      applyUpgrades();
    }
    return ok;
  }

  // ----------------------- sampling / render -----------------------
  function resizeBuffers() {
    const { w, h } = Engine.getSize();
    const target = clamp(Math.floor(Math.min(900, Math.max(240, w))), 240, 900);

    // If we already have correct length, just update scale
    if (!state.samples || state.samples.length !== target) {
      state.sampleCount = target;
      state.samples = new Float32Array(target);
    } else {
      state.sampleCount = target;
    }

    state.xStep = w / (state.sampleCount - 1);
    state.yScale = Math.max(20, h * 0.33);
  }

  function updatePerf(dt) {
    // FPS EMA based on dt
    const fps = dt > 0 ? 1 / dt : 60;
    state.perf.fpsEMA = lerp(state.perf.fpsEMA, clamp(fps, 5, 240), 0.05);

    // Adaptive sample count (rebuild buffer if needed)
    const { w } = Engine.getSize();
    let target = clamp(Math.floor(Math.min(900, Math.max(240, w))), 240, 900);
    if (state.perf.fpsEMA < 45) target = clamp(Math.floor(target * 0.65), 240, 700);
    else if (state.perf.fpsEMA < 52) target = clamp(Math.floor(target * 0.8), 240, 800);

    if (!state.samples || state.samples.length !== target) {
      state.sampleCount = target;
      state.samples = new Float32Array(target);
      state.xStep = w / (target - 1);
    }
  }

  function computeWaveform(dt) {
    // Base signal: few sines + gentle noise + click impulse as an extra harmonic burst.
    const n = state.sampleCount;
    const buf = state.samples;

    // Frequencies drift slowly to feel alive
    const t = state.t;
    const f1 = 1.2 + 0.12 * Math.sin(t * 0.23);
    const f2 = 2.4 + 0.18 * Math.cos(t * 0.17);
    const f3 = 3.6 + 0.25 * Math.sin(t * 0.11 + 1.7);

    const phase1 = t * 1.15;
    const phase2 = t * 0.92 + 1.3;
    const phase3 = t * 0.72 + 2.4;

    // impulse envelope decays
    state.impulse *= Math.pow(state.impulseDecay, dt * 60);
    const imp = state.impulse;

    const noise = state.noiseLevel;
    const limiter = state.limiterStrength;
    const gain = state.baseGain;

    // stage shaping: multiply + softclip per stage, but keep it cheap:
    // we do per-sample per-stage; stageCount kept capped to 60.
    const stages = state.stageCount;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);

      // base mixture
      let s =
        Math.sin(TAU * (x * f1 + phase1)) * 0.55 +
        Math.sin(TAU * (x * f2 + phase2)) * 0.28 +
        Math.sin(TAU * (x * f3 + phase3)) * 0.18;

      // impulse adds a short-lived “wobble” and slight DC push
      if (imp > 1e-4) {
        const burst = Math.sin(TAU * (x * (6.0 + 1.2 * Math.sin(t * 0.7)) + t * 1.6));
        s += burst * (0.25 * imp);
        s += (x - 0.5) * (0.18 * imp);
      }

      // noise: stable pseudo-random each sample
      s += randSigned() * noise;

      // amplifier chain: gain + nonlinearity per stage (soft clip)
      // to avoid runaway, we keep clip each stage.
      let y = s;
      for (let k = 0; k < stages; k++) {
        y *= gain;
        // slight asymmetry that increases richness (cheap)
        y += 0.008 * (k + 1) * y * y * (y > 0 ? 1 : -1);
        y = softClip(y, limiter);
      }

      // final clamp (safety)
      y = clamp(y, -2.0, 2.0);

      buf[i] = y;
      sumSq += y * y;
    }

    const rms = Math.sqrt(sumSq / Math.max(1, n));
    state.rms = rms;
    state.power = rms * rms;
  }

  function updateEarnings(dt) {
    // Effective power influenced by clarity (lower noise) a bit
    const clarity = 1 + (0.06 * state.stabiliserLevel);
    const effPower = state.power * clarity;

    // A mild curve so early game feels active, late game still ramps
    const cps = effPower * state.earnScale * state.prestigeMultiplier;
    state.cps = cps;

    const earn = cps * dt;
    if (earn > 0 && isFinite(earn)) {
      state.credits += earn;
      state.totalEarned += earn;
    }

    // store lastKnownCPS for offline
    state.lastKnownCPS = lerp(state.lastKnownCPS, clamp(cps, 0, 1e12), 0.08);
  }

  function renderGrid(ctx2d, w, h) {
    ctx2d.save();
    ctx2d.globalCompositeOperation = "source-over";
    ctx2d.strokeStyle = "rgba(42,162,255,0.06)";
    ctx2d.lineWidth = 1;

    const major = 80;
    const minor = 16;

    // minor
    ctx2d.beginPath();
    for (let x = 0; x <= w; x += minor) {
      ctx2d.moveTo(x + 0.5, 0);
      ctx2d.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += minor) {
      ctx2d.moveTo(0, y + 0.5);
      ctx2d.lineTo(w, y + 0.5);
    }
    ctx2d.stroke();

    // major
    ctx2d.strokeStyle = "rgba(61,252,255,0.08)";
    ctx2d.beginPath();
    for (let x = 0; x <= w; x += major) {
      ctx2d.moveTo(x + 0.5, 0);
      ctx2d.lineTo(x + 0.5, h);
    }
    for (let y = 0; y <= h; y += major) {
      ctx2d.moveTo(0, y + 0.5);
      ctx2d.lineTo(w, y + 0.5);
    }
    ctx2d.stroke();

    ctx2d.restore();
  }

  function drawStageMarkers(ctx2d, w, h) {
    const n = state.stageCount;
    const y = h - 18;
    const pad = 18;
    const span = Math.max(1, w - pad * 2);
    const step = span / Math.max(1, n);

    const pulse = state.stagePulse;
    state.stagePulse = Math.max(0, state.stagePulse - 0.8 / 60);

    ctx2d.save();
    ctx2d.globalCompositeOperation = "source-over";
    for (let i = 0; i < n; i++) {
      const x = pad + (i + 0.5) * step;
      const a = 0.12 + 0.08 * (i / Math.max(1, n - 1));
      ctx2d.strokeStyle = `rgba(176,75,255,${a})`;
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(x, y);
      ctx2d.lineTo(x, y - 10);
      ctx2d.stroke();

      if (pulse > 0) {
        ctx2d.strokeStyle = `rgba(255,75,216,${0.12 * pulse})`;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(x, y);
        ctx2d.lineTo(x, y - 14);
        ctx2d.stroke();
      }
    }
    ctx2d.restore();
  }

  function renderWaveform() {
    const g = Engine.gfx;
    const ctx2d = Engine.getCtx();
    const { w, h } = Engine.getSize();

    g.clearBlack();

    renderGrid(ctx2d, w, h);

    const midY = h * 0.52;
    const buf = state.samples;
    const n = state.sampleCount;
    const xStep = state.xStep;
    const yScale = state.yScale;

    // Colour shifts mildly with power; keep it cheap with two strokes.
    const p = clamp(state.power * 2.2, 0, 1);
    const underCol = `rgba(61,252,255,${0.10 + 0.10 * p})`;
    const brightCol = `rgba(255,75,216,${0.65 - 0.18 * (1 - p)})`;

    // Understroke (glow-ish)
    ctx2d.save();
    ctx2d.globalCompositeOperation = "source-over";
    ctx2d.lineJoin = "round";
    ctx2d.lineCap = "round";

    ctx2d.strokeStyle = underCol;
    ctx2d.lineWidth = 6;
    ctx2d.beginPath();
    ctx2d.moveTo(0, midY - buf[0] * yScale);
    for (let i = 1; i < n; i++) {
      ctx2d.lineTo(i * xStep, midY - buf[i] * yScale);
    }
    ctx2d.stroke();

    // Bright line
    ctx2d.strokeStyle = brightCol;
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(0, midY - buf[0] * yScale);
    for (let i = 1; i < n; i++) {
      ctx2d.lineTo(i * xStep, midY - buf[i] * yScale);
    }
    ctx2d.stroke();

    // Center line
    ctx2d.strokeStyle = "rgba(223,246,255,0.10)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, midY + 0.5);
    ctx2d.lineTo(w, midY + 0.5);
    ctx2d.stroke();

    ctx2d.restore();

    drawStageMarkers(ctx2d, w, h);

    // Canvas HUD if no UI
    if (!uiRoot) {
      ctx2d.save();
      ctx2d.fillStyle = "rgba(223,246,255,0.95)";
      ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx2d.fillText(
        `Credits: ${fmt(state.credits)}   CPS: ${fmt(state.cps)}   Stages: ${state.stageCount}   Gain: ${state.baseGain.toFixed(
          3
        )}   x${state.prestigeMultiplier.toFixed(2)}`,
        14,
        h - 40
      );
      ctx2d.fillStyle = "rgba(61,252,255,0.85)";
      ctx2d.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx2d.fillText("Click: impulse • Space: pause • R: reset", 14, h - 20);
      if (nowSec() < state.statusUntil && state.status) {
        ctx2d.fillStyle = "rgba(255,75,216,0.9)";
        ctx2d.fillText(state.status, 14, 22);
      }
      ctx2d.restore();
    } else if (nowSec() < state.statusUntil && state.status) {
      ctx2d.save();
      ctx2d.fillStyle = "rgba(255,75,216,0.85)";
      ctx2d.font = "700 13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx2d.fillText(state.status, 14, 22);
      ctx2d.restore();
    }
  }

  // ----------------------- UI update -----------------------
  function updateUI() {
    if (!ui) return;

    const gc = gainCost();
    const sc = stageCost();
    const stc = stabiliserCost();
    const lc = limiterCost();
    const pt = prestigeThreshold();

    ui.creditsValue.textContent = fmt(state.credits);

    const noisePct = (state.noiseLevel * 100).toFixed(2);
    ui.meta.innerHTML =
      `CPS: <b>${fmt(state.cps)}</b><br>` +
      `Stages: <b>${state.stageCount}</b><br>` +
      `Gain/stage: <b>${state.baseGain.toFixed(3)}</b><br>` +
      `Noise: <b>${noisePct}%</b><br>` +
      `Limiter: <b>${state.limiterStrength.toFixed(2)}</b><br>` +
      `Multiplier: <b>x${state.prestigeMultiplier.toFixed(2)}</b>`;

    ui.btnGain.textContent = `Upgrade Gain (£${fmt(gc)})`;
    ui.btnStage.textContent = `Add Stage (£${fmt(sc)})`;
    ui.btnStab.textContent = `Stabiliser (£${fmt(stc)})`;
    ui.btnLim.textContent = `Limiter Tuning (£${fmt(lc)})`;
    ui.btnPrestige.textContent = `Recalibrate (Prestige) (£${fmt(pt)})`;

    ui.btnGain.disabled = !canAfford(gc);
    ui.btnStage.disabled = !canAfford(sc) || state.stageCount >= 60;
    ui.btnStab.disabled = !canAfford(stc);
    ui.btnLim.disabled = !canAfford(lc);
    ui.btnPrestige.disabled = state.credits < pt;

    const dim = (b) => (b.style.opacity = b.disabled ? "0.55" : "1");
    dim(ui.btnGain);
    dim(ui.btnStage);
    dim(ui.btnStab);
    dim(ui.btnLim);
    dim(ui.btnPrestige);

    ui.status.textContent = nowSec() < state.statusUntil ? state.status : "";
  }

  // ----------------------- input -----------------------
  function onClick(ev, pos) {
    // user gesture: enable audio if toggle used later
    if (!audio.enabled) ensureAudio();

    // impulse injection (tiny earning bump via visual, but mostly for fun)
    state.impulse = clamp(state.impulse + 0.85, 0, 3.0);
    flash("Impulse injected.");
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
      const ok = confirm("Reset run? (Credits, upgrades, multiplier reset)");
      if (!ok) return;
      // hard reset but keep save overwritten
      state.credits = 0;
      state.totalEarned = 0;
      state.gainLevel = 0;
      state.stageLevel = 0;
      state.stabiliserLevel = 0;
      state.limiterLevel = 0;
      state.prestigeMultiplier = 1.0;
      state.lastKnownCPS = 0;
      state.impulse = 0;
      state.stagePulse = 1;
      applyUpgrades();
      flash("Reset.");
      doSave();
    }
  }

  // ----------------------- boot -----------------------
  applyUpgrades();
  doLoadAndOffline();

  resizeBuffers();

  ui = buildUI();
  if (ui) {
    ui.btnGain.onclick = () => {
      const c = gainCost();
      if (!spend(c)) return flash("Not enough credits.");
      state.gainLevel++;
      applyUpgrades();
      flash("Gain upgraded.");
    };
    ui.btnStage.onclick = () => {
      const c = stageCost();
      if (!spend(c)) return flash("Not enough credits.");
      state.stageLevel++;
      applyUpgrades();
      state.stagePulse = 1;
      flash("Stage added.");
    };
    ui.btnStab.onclick = () => {
      const c = stabiliserCost();
      if (!spend(c)) return flash("Not enough credits.");
      state.stabiliserLevel++;
      applyUpgrades();
      flash("Stabiliser improved.");
    };
    ui.btnLim.onclick = () => {
      const c = limiterCost();
      if (!spend(c)) return flash("Not enough credits.");
      state.limiterLevel++;
      applyUpgrades();
      flash("Limiter tuned.");
    };
    ui.btnPrestige.onclick = () => {
      if (doPrestige()) doSave();
    };

    ui.muteBtn.onclick = () => {
      if (!audio.enabled) ensureAudio();
      setMuted(!audio.muted);
      flash(audio.muted ? "Muted." : "Audio on (quiet).");
    };

    // initial toggle state
    setMuted(true);
  }

  state.autosaveAt = nowSec() + 5.0;

  Engine.on("onResize", () => {
    resizeBuffers();
  });

  Engine.on("onClick", onClick);
  Engine.on("onKeyDown", onKeyDown);

  Engine.on("update", (dt) => {
    state.paused = Engine.isPaused();
    if (state.paused) return;

    state.t += dt;
    // keep t bounded
    if (state.t > 1e9) state.t = state.t % 10000;

    updatePerf(dt);

    // compute waveform at full frame rate (cheap); buffer reused
    computeWaveform(dt);
    updateEarnings(dt);

    // subtle audio hum (only if enabled AND unmuted)
    if (audio.enabled && !audio.muted && audio.ctx && audio.osc && audio.gain) {
      // derive frequency from RMS/power; keep quiet
      const targetF = 80 + clamp(state.rms * 240, 0, 420);
      audio.freq = lerp(audio.freq, targetF, 0.08);

      const targetV = clamp(0.004 + state.rms * 0.012, 0.003, 0.02);
      audio.vol = lerp(audio.vol, targetV, 0.06);

      try {
        audio.osc.frequency.setValueAtTime(audio.freq, audio.ctx.currentTime);
        audio.gain.gain.setValueAtTime(audio.vol, audio.ctx.currentTime);
      } catch (_) {}
    }

    if (ui) updateUI();

    const t = nowSec();
    if (t >= state.autosaveAt) {
      doSave();
      state.autosaveAt = t + 5.0;
    }
  });

  Engine.on("render", () => {
    renderWaveform();
  });

  window.addEventListener("beforeunload", () => {
    try {
      doSave();
    } catch (_) {}
    try {
      if (audio.gain) audio.gain.gain.value = 0;
    } catch (_) {}
  });
}
